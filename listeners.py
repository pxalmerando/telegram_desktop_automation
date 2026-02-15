"""Telegram listeners using native threading (replaces Celery tasks)."""
import os
import asyncio
import logging
import threading
import concurrent.futures
from datetime import datetime, timedelta
from telethon import TelegramClient, events
from database import SessionLocal
from models import TelegramAccount
import cache
import blacklist
from db_session import DbSession


def _get_session(phone_number):
    """Return a DB-backed Telethon session for the given phone number."""
    return DbSession(phone_number)

logger = logging.getLogger(__name__)

MAX_RECONNECT_RETRIES = 10
RECONNECT_BASE_DELAY = 5
RECONNECT_MAX_DELAY = 300
HEARTBEAT_INTERVAL = 60

_listener_threads = {}       # account_id -> Future
_listener_stop_events = {}   # account_id -> threading.Event
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=50)


def start_listener(account_id):
    if account_id in _listener_threads:
        logger.info(f"Listener already running for account {account_id}")
        return

    stop_event = threading.Event()
    _listener_stop_events[account_id] = stop_event

    future = _executor.submit(_run_listener, account_id, stop_event)
    _listener_threads[account_id] = future

    def _on_done(fut):
        _listener_threads.pop(account_id, None)
        _listener_stop_events.pop(account_id, None)
        try:
            fut.result()
        except Exception as e:
            logger.error(f"Listener thread for account {account_id} ended with error: {e}")

    future.add_done_callback(_on_done)
    logger.info(f"Started listener thread for account {account_id}")


def stop_listener(account_id):
    stop_event = _listener_stop_events.get(account_id)
    if stop_event:
        stop_event.set()
    _listener_threads.pop(account_id, None)
    _listener_stop_events.pop(account_id, None)
    logger.info(f"Stop signal sent to listener for account {account_id}")


def _run_listener(account_id, stop_event):
    """Run Telethon listener in a dedicated thread with its own event loop."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_listen(account_id, stop_event))
    finally:
        loop.close()


async def _listen(account_id, stop_event):
    try:
        account = TelegramAccount.query.get(account_id)
        if not account or not account.is_authorized:
            logger.warning(f"Listener {account_id}: account not found or not authorized")
            return
        api_id = account.api_id
        api_hash = account.api_hash
        phone_number = account.phone_number
    finally:
        SessionLocal.remove()

    session = _get_session(phone_number)

    for attempt in range(MAX_RECONNECT_RETRIES):
        if stop_event.is_set():
            break

        client = None
        try:
            client = TelegramClient(session, api_id, api_hash)
            await client.connect()

            if not await client.is_user_authorized():
                try:
                    acct = TelegramAccount.query.get(account_id)
                    if acct:
                        acct.is_connected = False
                        SessionLocal.commit()
                finally:
                    SessionLocal.remove()
                logger.warning(f"Listener {account_id}: session expired")
                return

            # Pre-populate entity caches so the listener can resolve
            # all known chats immediately, and share them with short-lived clients
            try:
                await client.get_dialogs()
                logger.debug(f"Listener {account_id}: entity cache populated via get_dialogs")
            except Exception as e:
                logger.warning(f"Listener {account_id}: failed to pre-populate entity cache: {e}")

            # Mark connected + heartbeat
            try:
                acct = TelegramAccount.query.get(account_id)
                if acct:
                    acct.is_connected = True
                    acct.last_heartbeat = datetime.utcnow()
                    SessionLocal.commit()
            finally:
                SessionLocal.remove()

            last_heartbeat_time = datetime.utcnow()

            @client.on(events.NewMessage(incoming=True))
            async def handler(event):
                nonlocal last_heartbeat_time
                try:
                    logger.info(f"Listener {account_id}: NewMessage event chat_id={event.chat_id}, has_text={bool(event.text)}")
                    now = datetime.utcnow()
                    if (now - last_heartbeat_time).total_seconds() > HEARTBEAT_INTERVAL:
                        try:
                            acct_hb = TelegramAccount.query.get(account_id)
                            if acct_hb:
                                acct_hb.last_heartbeat = now
                                SessionLocal.commit()
                        finally:
                            SessionLocal.remove()
                        last_heartbeat_time = now

                    sender_name = ''
                    try:
                        sender = await event.get_sender()
                        if sender:
                            if hasattr(sender, 'first_name'):
                                sender_name = f"{sender.first_name or ''} {sender.last_name or ''}".strip()
                            elif hasattr(sender, 'title'):
                                sender_name = sender.title
                    except (ValueError, Exception) as e:
                        logger.debug(f"Could not resolve sender entity: {e}")

                    evt_chat_id = event.chat_id
                    media_type = None
                    if event.photo:
                        media_type = 'photo'
                    elif event.video:
                        media_type = 'video'
                    elif event.document:
                        media_type = 'document'

                    msg_dict = {
                        'message_id': event.id,
                        'sender_name': sender_name,
                        'sender_id': str(event.sender_id) if event.sender_id else None,
                        'text': event.text,
                        'media_type': media_type,
                        'is_incoming': not event.out,
                        'is_auto_reply': False,
                        'timestamp': event.date.isoformat() if event.date else now.isoformat(),
                    }

                    # Store in in-memory cache
                    cache.push_chat_msg(account_id, evt_chat_id, msg_dict)

                    if not event.out:
                        cache.incr_incoming_count(account_id, evt_chat_id)

                    # Update chat metadata
                    chat_data = cache.get_chat_meta(account_id, evt_chat_id)
                    if not chat_data:
                        chat_type = 'private'
                        chat_title = sender_name or 'Unknown'
                        try:
                            chat_entity = await event.get_chat()
                            if hasattr(chat_entity, 'megagroup') and chat_entity.megagroup:
                                chat_type = 'supergroup'
                            elif hasattr(chat_entity, 'broadcast') and chat_entity.broadcast:
                                chat_type = 'channel'
                            elif hasattr(chat_entity, 'gigagroup'):
                                chat_type = 'group'
                            chat_title = getattr(chat_entity, 'title', None) or chat_title
                        except (ValueError, Exception) as e:
                            logger.debug(f"Could not resolve chat entity: {e}")
                        chat_data = {
                            'account_id': account_id,
                            'chat_id': str(evt_chat_id),
                            'chat_title': chat_title,
                            'chat_type': chat_type,
                            'unread_count': 0,
                            'is_pinned': False,
                            'is_manually_pinned': False,
                            'cta_sent': False,
                        }

                    chat_data['last_message_preview'] = (event.text or '[media]')[:200]
                    chat_data['last_message_at'] = event.date.isoformat() if event.date else now.isoformat()
                    if not event.out:
                        chat_data['unread_count'] = (chat_data.get('unread_count') or 0) + 1
                        cache.incr_total_unread(account_id)

                    cache.set_chat_meta(account_id, evt_chat_id, chat_data)
                    total_unread = cache.get_total_unread(account_id)

                    # Push to Eel UI
                    try:
                        import eel
                        eel.on_new_message({
                            'account_id': account_id,
                            'chat_id': str(evt_chat_id),
                            'message': msg_dict,
                            'chat': chat_data
                        })
                        eel.on_unread_update({
                            'account_id': account_id,
                            'total_unread': total_unread,
                            'chat_id': str(evt_chat_id),
                            'chat_unread': chat_data.get('unread_count', 0)
                        })
                    except Exception:
                        pass

                    # Trigger auto-reply for incoming text messages
                    if not event.out and event.text:
                        logger.info(f"Incoming message for account {account_id}, chat {evt_chat_id}: {event.text[:50]}...")
                        _executor.submit(_handle_auto_reply_safe, account_id, evt_chat_id, event.text)

                except Exception as e:
                    logger.error(f"Listener handler error for account {account_id}: {e}", exc_info=True)

            if attempt > 0:
                logger.info(f"Listener reconnected for account {account_id} (attempt {attempt + 1})")
            else:
                logger.info(f"Listener started for account {account_id}")

            # Run until disconnected, but check stop event periodically.
            # IMPORTANT: use asyncio.wait (not wait_for) so the task is NOT
            # cancelled on each timeout check — cancelling run_until_disconnected
            # tears down Telethon's internal connection.
            run_task = asyncio.ensure_future(client.run_until_disconnected())
            try:
                while not stop_event.is_set():
                    done, _ = await asyncio.wait({run_task}, timeout=5)
                    if done:
                        logger.warning(f"Listener {account_id}: run_until_disconnected returned (client disconnected)")
                        # Propagate any exception from run_until_disconnected
                        run_task.result()
                        break
            finally:
                if not run_task.done():
                    run_task.cancel()
                    try:
                        await run_task
                    except (asyncio.CancelledError, Exception):
                        pass

            if stop_event.is_set():
                logger.info(f"Listener {account_id}: stop event received")
                break

        except (ConnectionError, OSError) as e:
            delay = min(RECONNECT_BASE_DELAY * (2 ** attempt), RECONNECT_MAX_DELAY)
            logger.warning(f"Listener {account_id} connection lost (attempt {attempt + 1}), retrying in {delay}s: {e}")
            if stop_event.wait(delay):
                break
            continue

        except Exception as e:
            logger.error(f"Listener {account_id} fatal error: {e}")
            break

        finally:
            if client:
                try:
                    await client.disconnect()
                except Exception:
                    pass

    # All retries exhausted or stopped
    try:
        acct = TelegramAccount.query.get(account_id)
        if acct:
            acct.is_connected = False
            acct.celery_task_id = None
            SessionLocal.commit()
    except Exception:
        SessionLocal.rollback()
    finally:
        SessionLocal.remove()
    logger.info(f"Listener {account_id}: stopped")


def _handle_auto_reply_safe(account_id, chat_id, text):
    """Wrapper for auto-reply that catches all exceptions."""
    try:
        _handle_auto_reply(account_id, chat_id, text)
    except Exception as e:
        logger.error(f"Auto-reply error for account {account_id}, chat {chat_id}: {e}")


def _handle_auto_reply(account_id, chat_id, text):
    """Handle auto-reply logic: full automation pipeline."""
    import time
    import random

    from services.ai_service import AIService
    from services.telegram_service import TelegramService

    ai = AIService()
    tg = TelegramService()

    if not ai.is_auto_reply_enabled_for(account_id):
        logger.debug(f"Auto-reply disabled for account {account_id}")
        return

    logger.info(f"Auto-reply triggered for account {account_id}, chat {chat_id}")

    # Chat marked done — no more replies
    if blacklist.has_sent(account_id, chat_id, 'done'):
        return

    profile = ai.get_profile_for_account(account_id)
    settings = ai.get_profile_settings(profile)
    cta = settings.get('CTA', {})

    incoming_count = cache.get_incoming_count(account_id, chat_id)
    state = cache.get_chat_state(account_id, chat_id)

    # ── First-ask: intro message + opener photo + build photo plan ──
    if incoming_count <= 1 and settings.get('FIRST_ASK_ORIGIN'):
        first_text = settings.get('FIRST_ASK_TEXT', '')
        if first_text:
            _send_bubbles(tg, ai, account_id, chat_id, first_text, settings, is_auto_reply=True)

            # Send opener photo
            if not state.get('opener_photo_sent'):
                photo_path = tg.pick_photo_for_account(account_id)
                if photo_path:
                    captions = settings.get('PHOTO_CAPTIONS', [])
                    caption = random.choice(captions) if captions else ''
                    delay = random.uniform(*settings.get('BUBBLE_DELAY_RANGE_S', [5, 8]))
                    time.sleep(delay)
                    _send_photo_with_ui(tg, account_id, chat_id, photo_path, caption)
                    sent = state.get('sent_photos', [])
                    sent.append(os.path.basename(photo_path))
                    cache.update_chat_state(account_id, chat_id,
                                            opener_photo_sent=True, sent_photos=sent)
                else:
                    cache.update_chat_state(account_id, chat_id, opener_photo_sent=True)

            # Build photo plan for the conversation
            if not state.get('photo_plan'):
                start_at = cta.get('start_at', 20)
                plan = _build_photo_plan(settings, start_at)
                cache.update_chat_state(account_id, chat_id, photo_plan=plan)

            return

    # ── CTA check (blacklist-backed, survives restarts) ──
    if cta.get('enabled'):
        start_at = cta.get('start_at', 20)
        if incoming_count >= start_at:
            if not blacklist.has_sent(account_id, chat_id, 'cta'):
                blacklist.mark_sent(account_id, chat_id, 'cta')
                _executor.submit(_run_cta_sequence, account_id, chat_id,
                                 cta, tg, ai, settings)
                return

    # ── Name extraction (for personalized namecard) ──
    nc = settings.get('NAMECARD', {})
    if nc.get('enabled') and not state.get('personalized_name'):
        name = ai.extract_name_with_ai(account_id, chat_id, text)
        if name:
            cache.update_chat_state(account_id, chat_id, personalized_name=name)
            path = tg.prepare_personalized_namecard(account_id, chat_id, name, settings)
            if path:
                cache.update_chat_state(account_id, chat_id,
                                        personalized_media_path=path,
                                        personalized_media_ready=True)

    # ── Photo skepticism / mismatch classifier ──
    if settings.get('ENABLE_MISMATCH_CLASSIFIER') and not state.get('mismatch_explained'):
        if ai.detect_photo_skepticism(text):
            mismatch_reply = settings.get('MISMATCH_REPLY', '')
            if mismatch_reply:
                _send_bubbles(tg, ai, account_id, chat_id, mismatch_reply,
                              settings, is_auto_reply=True)
                cache.update_chat_state(account_id, chat_id, mismatch_explained=True)
                return

    # ── Generate AI reply ──
    state = cache.get_chat_state(account_id, chat_id)  # refresh
    ask_name_hint = ""
    if state.get('ask_name_next'):
        ask_name_hint = (
            "\n!! WICHTIG: Frage in deiner nächsten Antwort nach seinem Namen. "
            "Formuliere es locker, z.B. 'wie heißt du eigentlich?' oder "
            "'sag mal wie heißt du?'\n"
        )
        cache.update_chat_state(account_id, chat_id, ask_name_next=False)

    system_prompt = None
    if profile:
        system_prompt = ai.build_system_prompt(profile, ask_name_hint=ask_name_hint)

    history = ai.get_conversation_history(account_id, chat_id, limit=10)
    result = ai.generate_reply(text, system_prompt=system_prompt,
                               conversation_history=history, account_id=account_id)

    if not result.get('success'):
        logger.warning(f"Auto-reply AI failed for account {account_id}, chat {chat_id}: {result.get('error', 'unknown')}")
        return

    reply = result['reply']
    logger.info(f"Auto-reply sending to account {account_id}, chat {chat_id}: {reply[:60]}...")
    _send_bubbles(tg, ai, account_id, chat_id, reply, settings, is_auto_reply=True)

    # ── Photo sending (plan-based or percent-based) ──
    state = cache.get_chat_state(account_id, chat_id)  # refresh
    msg_count = state.get('message_count', 0)
    photo_sent_this_turn = False

    photo_plan = state.get('photo_plan', [])
    if photo_plan and msg_count in photo_plan:
        photo_path = tg.pick_photo_for_account(account_id)
        if photo_path:
            captions = settings.get('PHOTO_CAPTIONS', [])
            caption = random.choice(captions) if captions else ''
            delay = random.uniform(*settings.get('BUBBLE_DELAY_RANGE_S', [5, 8]))
            time.sleep(delay)
            _send_photo_with_ui(tg, account_id, chat_id, photo_path, caption)
            sent = state.get('sent_photos', [])
            sent.append(os.path.basename(photo_path))
            cache.update_chat_state(account_id, chat_id,
                                    sent_photos=sent,
                                    photo_idx=state.get('photo_idx', 0) + 1)
            photo_sent_this_turn = True
    elif not photo_plan and settings.get('PHOTO_MODE') == 'percent':
        prob = settings.get('PHOTO_PERCENT', 0.7)
        if random.random() < prob:
            photo_path = tg.pick_photo_for_account(account_id)
            if photo_path:
                captions = settings.get('PHOTO_CAPTIONS', [])
                caption = random.choice(captions) if captions else ''
                delay = random.uniform(*settings.get('BUBBLE_DELAY_RANGE_S', [5, 8]))
                time.sleep(delay)
                _send_photo_with_ui(tg, account_id, chat_id, photo_path, caption)
                photo_sent_this_turn = True

    # ── Personalized namecard late-send ──
    state = cache.get_chat_state(account_id, chat_id)  # refresh
    if (nc.get('late_send') == 'next_media_slot'
            and state.get('personalized_media_ready')
            and not state.get('personalized_media_sent')
            and photo_sent_this_turn):
        nc_path = state.get('personalized_media_path', '')
        if nc_path and os.path.isfile(nc_path):
            name = state.get('personalized_name', '')
            caption_tpl = nc.get('caption', 'nur für dich, {name} \U0001f609')
            caption = caption_tpl.replace('{name}', name) if name else caption_tpl
            delay = random.uniform(*settings.get('BUBBLE_DELAY_RANGE_S', [5, 8]))
            time.sleep(delay)
            _send_photo_with_ui(tg, account_id, chat_id, nc_path, caption)
            cache.update_chat_state(account_id, chat_id, personalized_media_sent=True)

    # ── Increment message count ──
    cache.update_chat_state(account_id, chat_id, message_count=msg_count + 1)

    # ── Prompt name-ask if we still don't have a name after a few messages ──
    if (nc.get('enabled')
            and not state.get('personalized_name')
            and msg_count + 1 >= 3
            and not state.get('ask_name_next')):
        cache.update_chat_state(account_id, chat_id, ask_name_next=True)


def _send_photo_with_ui(tg, account_id, chat_id, photo_path, caption=''):
    """Send a photo and push the result to the Eel UI."""
    send_result = tg.send_file_sync(account_id, chat_id, photo_path, caption)
    if send_result.get('success') and send_result.get('message'):
        msg = send_result['message']
        msg['is_auto_reply'] = True
        try:
            import eel
            eel.on_new_message({
                'account_id': account_id,
                'chat_id': str(chat_id),
                'message': msg,
                'chat': cache.get_chat_meta(account_id, chat_id) or {}
            })
        except Exception:
            pass
    return send_result


def _build_photo_plan(settings, start_at):
    """Build a list of message indices at which to send a photo.
    Distributes photo_count slots roughly evenly across the message range [1..start_at-1]."""
    import random

    photo_pct = settings.get('PHOTO_PERCENT', 0.7)
    total_msgs = max(start_at - 1, 5)
    photo_count = max(1, int(total_msgs * photo_pct))

    if photo_count >= total_msgs:
        return list(range(1, total_msgs + 1))

    step = total_msgs / photo_count
    plan = []
    for i in range(photo_count):
        base_idx = int(step * i) + 1
        offset = random.randint(-1, 1)
        idx = max(1, min(total_msgs, base_idx + offset))
        if idx not in plan:
            plan.append(idx)
    plan.sort()
    return plan


def _send_bubbles(tg, ai, account_id, chat_id, text, settings, is_auto_reply=False):
    """Split text by ||| and send as separate bubbles with delays."""
    import time
    import random

    bubbles = [b.strip() for b in text.split('|||') if b.strip()]
    max_bubbles = settings.get('MAX_BUBBLES', 3)
    max_chars = settings.get('MAX_CHARS_PER_BUBBLE', 999)
    delay_range = settings.get('BUBBLE_DELAY_RANGE_S', [5.0, 8.0])

    for i, bubble in enumerate(bubbles[:max_bubbles]):
        if len(bubble) > max_chars:
            bubble = bubble[:max_chars]

        if i > 0:
            delay = random.uniform(*delay_range)
            time.sleep(delay)

        result = tg.send_message_sync(account_id, chat_id, bubble)
        if result.get('success') and result.get('message'):
            msg = result['message']
            msg['is_auto_reply'] = is_auto_reply
            try:
                import eel
                eel.on_new_message({
                    'account_id': account_id,
                    'chat_id': str(chat_id),
                    'message': msg,
                    'chat': cache.get_chat_meta(account_id, chat_id) or {}
                })
            except Exception:
                pass


def _run_cta_sequence(account_id, chat_id, cta_config, tg, ai, settings):
    """Run CTA step sequence with delays, __PERSONALIZED__/__LAST__ support, done-marking."""
    import time
    import random

    steps = cta_config.get('steps', [])
    start_delay = cta_config.get('start_delay_range_s', [650, 800])
    step_delay = cta_config.get('step_delay_range_s', [300, 600])
    cta_vars = cta_config.get('vars', {})
    final_messages = settings.get('FINAL_MESSAGES', [])

    state = cache.get_chat_state(account_id, chat_id)
    name = state.get('personalized_name', '')

    # Initial delay before CTA starts
    time.sleep(random.uniform(*start_delay))

    for i, step in enumerate(steps):
        if i > 0:
            time.sleep(random.uniform(*step_delay))

        step_type = step.get('type', 'text')

        if step_type == 'text':
            content = ai.substitute_cta_vars(step.get('content', ''), cta_vars, name=name)
            result = tg.send_message_sync(account_id, chat_id, content)
            if result.get('success') and result.get('message'):
                msg = result['message']
                msg['is_auto_reply'] = True
                try:
                    import eel
                    eel.on_new_message({
                        'account_id': account_id,
                        'chat_id': str(chat_id),
                        'message': msg,
                        'chat': cache.get_chat_meta(account_id, chat_id) or {}
                    })
                except Exception:
                    pass

            # Check FINAL_MESSAGES trigger
            if _is_final_message(content, final_messages, cta_vars):
                blacklist.mark_sent(account_id, chat_id, 'done')
                return

        elif step_type == 'image':
            filename = step.get('filename', '')
            caption = ai.substitute_cta_vars(step.get('caption', ''), cta_vars, name=name)

            # Resolve image path
            photo_path = None
            if filename == '__PERSONALIZED__':
                state = cache.get_chat_state(account_id, chat_id)
                nc_path = state.get('personalized_media_path', '')
                if nc_path and os.path.isfile(nc_path):
                    photo_path = nc_path
                else:
                    # Fallback to regular photo if namecard not ready
                    photo_path = tg.pick_photo_for_account(account_id)
            elif filename == '__LAST__':
                photo_path = tg.pick_last_photo_for_account(account_id)
                if not photo_path:
                    photo_path = tg.pick_photo_for_account(account_id)
            else:
                photo_path = tg.pick_photo_for_account(account_id)

            if photo_path:
                result = tg.send_file_sync(account_id, chat_id, photo_path, caption)
                if result.get('success') and result.get('message'):
                    msg = result['message']
                    msg['is_auto_reply'] = True
                    try:
                        import eel
                        eel.on_new_message({
                            'account_id': account_id,
                            'chat_id': str(chat_id),
                            'message': msg,
                            'chat': cache.get_chat_meta(account_id, chat_id) or {}
                        })
                    except Exception:
                        pass

                # Check caption for FINAL_MESSAGES trigger
                if _is_final_message(caption, final_messages, cta_vars):
                    blacklist.mark_sent(account_id, chat_id, 'done')
                    return

    # Mark done after full CTA sequence completes
    blacklist.mark_sent(account_id, chat_id, 'done')


def _is_final_message(content, final_messages, cta_vars):
    """Check if content matches any FINAL_MESSAGES pattern (after var substitution)."""
    if not final_messages:
        return False
    for fm in final_messages:
        resolved = fm
        for k, v in cta_vars.items():
            resolved = resolved.replace('{' + k + '}', str(v))
        # Check if the resolved final message is a substring of the content
        if resolved.strip().lower() in content.strip().lower():
            return True
    return False


def check_listener_health():
    """Restart listeners with stale heartbeats (>3 min)."""
    try:
        threshold = datetime.utcnow() - timedelta(minutes=3)
        from sqlalchemy import or_
        stale = TelegramAccount.query.filter(
            TelegramAccount.is_connected == True,
            or_(
                TelegramAccount.last_heartbeat == None,
                TelegramAccount.last_heartbeat < threshold
            )
        ).all()

        for account in stale:
            logger.warning(f"Listener stale for account {account.id}, restarting")
            stop_listener(account.id)
            start_listener(account.id)

        if stale:
            logger.info(f"Health check: restarted {len(stale)} stale listener(s)")
    finally:
        SessionLocal.remove()


def auto_connect_accounts():
    """Start listeners for authorized but disconnected accounts, fetching chats first."""
    try:
        accounts = TelegramAccount.query.filter_by(
            is_authorized=True, is_connected=False
        ).all()
        account_ids = [a.id for a in accounts]
    finally:
        SessionLocal.remove()

    if not account_ids:
        return

    from services.telegram_service import TelegramService
    tg = TelegramService()

    started = 0
    for aid in account_ids:
        try:
            # Fetch chats so the UI has data immediately (same as manual connect)
            try:
                tg.fetch_chats_sync(aid)
            except Exception as e:
                logger.warning(f"Auto-connect: failed to fetch chats for account {aid}: {e}")

            try:
                acct = TelegramAccount.query.get(aid)
                if acct:
                    acct.is_connected = True
                    acct.last_heartbeat = datetime.utcnow()
                    SessionLocal.commit()
            finally:
                SessionLocal.remove()

            start_listener(aid)
            started += 1
            logger.info(f"Auto-connected account {aid}")
        except Exception as e:
            logger.error(f"Failed to auto-connect account {aid}: {e}")

    if started:
        logger.info(f"Auto-connect: started {started} listener(s)")
