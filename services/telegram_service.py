import os
import asyncio
import logging
import concurrent.futures
from datetime import datetime
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError, FloodWaitError
from database import SessionLocal
from models import (
    TelegramAccount, TelegramMessage,
    TelegramMediaFolder, TelegramMediaFile, TelegramMediaFolderAccount
)
from config import IS_SQLITE, MEDIA_UPLOAD_DIR
import cache
from db_session import DbSession

logger = logging.getLogger(__name__)

_telethon_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)


def _get_session(phone_number):
    """Return a DB-backed Telethon session for the given phone number."""
    return DbSession(phone_number)


async def _ensure_entity_cache(client, chat_id):
    """If the entity for chat_id isn't cached, fetch dialogs to populate it."""
    try:
        await client.get_input_entity(chat_id)
    except ValueError:
        # Entity not in cache — fetch dialogs to populate it
        logger.info(f"Entity cache miss for chat {chat_id}, fetching dialogs...")
        await client.get_dialogs()


def _run_telethon(coro):
    def _execute():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()
    future = _telethon_pool.submit(_execute)
    return future.result(timeout=60)


class TelegramService:

    def get_all_accounts(self):
        try:
            accounts = TelegramAccount.query.order_by(
                TelegramAccount.created_at.desc()
            ).all()
            result = []
            for a in accounts:
                d = a.to_dict()
                total = cache.get_total_unread(a.id)
                if total is not None:
                    d['total_unread_count'] = max(0, total)
                result.append(d)
            return result
        finally:
            SessionLocal.remove()

    def get_account(self, account_id):
        try:
            return TelegramAccount.query.get(account_id)
        finally:
            SessionLocal.remove()

    def create_account(self, phone_number, api_id, api_hash, display_name=None):
        try:
            existing = TelegramAccount.query.filter_by(phone_number=phone_number).first()
            if existing:
                return {'error': 'Phone number already registered', 'account': existing.to_dict()}

            account = TelegramAccount(
                phone_number=phone_number,
                api_id=api_id,
                api_hash=api_hash,
                display_name=display_name
            )
            SessionLocal.add(account)
            SessionLocal.commit()
            return {'account': account.to_dict()}
        except Exception as e:
            SessionLocal.rollback()
            return {'error': str(e)}
        finally:
            SessionLocal.remove()

    def delete_account(self, account_id):
        try:
            account = TelegramAccount.query.get(account_id)
            if not account:
                return {'error': 'Account not found'}

            if account.is_connected:
                try:
                    import listeners
                    listeners.stop_listener(account_id)
                except Exception:
                    pass

            phone = account.phone_number
            SessionLocal.delete(account)
            SessionLocal.commit()
            cache.delete_chat_meta(account_id)
            # Clean up DB session
            try:
                _get_session(phone).delete()
            except Exception:
                pass
            return {'success': True}
        except Exception as e:
            SessionLocal.rollback()
            return {'error': str(e)}
        finally:
            SessionLocal.remove()

    def send_code_sync(self, account_id):
        try:
            account = TelegramAccount.query.get(account_id)
            if not account:
                return {'success': False, 'error': 'Account not found'}

            api_id = account.api_id
            api_hash = account.api_hash
            phone = account.phone_number
        finally:
            SessionLocal.remove()

        session = _get_session(phone)

        async def _send_code():
            client = TelegramClient(session, api_id, api_hash, receive_updates=False)
            await client.connect()
            try:
                result = await client.send_code_request(phone)
                return {'success': True,
                        'phone_code_hash': result.phone_code_hash}
            except FloodWaitError as e:
                return {'success': False, 'error': f'Too many attempts. Wait {e.seconds} seconds.'}
            except Exception as e:
                logger.error(f"Failed to send code to {phone}: {e}")
                return {'success': False, 'error': str(e)}
            finally:
                await client.disconnect()

        result = _run_telethon(_send_code())

        if result.get('success'):
            try:
                account = TelegramAccount.query.get(account_id)
                account.phone_code_hash = result['phone_code_hash']
                SessionLocal.commit()
            finally:
                SessionLocal.remove()
        return {'success': result.get('success', False),
                'error': result.get('error')}

    def verify_code_sync(self, account_id, code, password=None):
        try:
            account = TelegramAccount.query.get(account_id)
            if not account:
                return {'success': False, 'error': 'Account not found'}

            api_id = account.api_id
            api_hash = account.api_hash
            phone = account.phone_number
            phone_code_hash = account.phone_code_hash
        finally:
            SessionLocal.remove()

        session = _get_session(phone)

        async def _verify():
            client = TelegramClient(session, api_id, api_hash, receive_updates=False)
            await client.connect()
            try:
                await client.sign_in(
                    phone=phone, code=code,
                    phone_code_hash=phone_code_hash
                )
            except SessionPasswordNeededError:
                if password:
                    await client.sign_in(password=password)
                else:
                    await client.disconnect()
                    return {'success': False, 'error': '2FA password required', 'needs_2fa': True}
            except PhoneCodeInvalidError:
                await client.disconnect()
                return {'success': False, 'error': 'Invalid verification code'}
            except Exception as e:
                await client.disconnect()
                return {'success': False, 'error': str(e)}

            # Export session as StringSession backup for recovery/migration
            backup_ss = StringSession()
            backup_ss.set_dc(client.session.dc_id, client.session.server_address, client.session.port)
            backup_ss.auth_key = client.session.auth_key
            backup_str = backup_ss.save()
            me = await client.get_me()
            display_name = None
            if me:
                name_parts = [me.first_name or '', me.last_name or '']
                display_name = ' '.join(name_parts).strip()
            await client.disconnect()
            return {'success': True, 'session_string_backup': backup_str,
                    'display_name': display_name}

        result = _run_telethon(_verify())

        if result.get('success'):
            try:
                account = TelegramAccount.query.get(account_id)
                account.session_string = result.get('session_string_backup')
                account.is_authorized = True
                account.phone_code_hash = None
                if result.get('display_name'):
                    account.display_name = result['display_name']
                SessionLocal.commit()
                return {'success': True, 'account': account.to_dict()}
            finally:
                SessionLocal.remove()
        return result

    def cancel_verification(self, account_id):
        try:
            account = TelegramAccount.query.get(account_id)
            if not account:
                return {'error': 'Account not found'}
            phone = account.phone_number
            account.phone_code_hash = None
            account.session_string = None
            SessionLocal.commit()
            # Clean up DB session
            try:
                _get_session(phone).delete()
            except Exception:
                pass
            return {'success': True}
        finally:
            SessionLocal.remove()

    def fetch_chats_sync(self, account_id):
        try:
            account = TelegramAccount.query.get(account_id)
            if not account or not account.is_authorized:
                return {'success': False, 'error': 'Account not found or not authorized'}
            api_id = account.api_id
            api_hash = account.api_hash
            phone = account.phone_number
        finally:
            SessionLocal.remove()

        session = _get_session(phone)

        async def _fetch():
            client = TelegramClient(session, api_id, api_hash, receive_updates=False)
            await client.connect()

            if not await client.is_user_authorized():
                await client.disconnect()
                return {'success': False, 'error': 'Session expired, re-authorize',
                        'session_expired': True}

            try:
                dialogs = []
                async for dialog in client.iter_dialogs():
                    chat_type = 'private'
                    if dialog.is_group:
                        chat_type = 'group'
                    elif dialog.is_channel:
                        chat_type = 'channel'

                    preview = None
                    if dialog.message:
                        preview = (dialog.message.text or '[media]')[:200]

                    dialogs.append({
                        'chat_id': str(dialog.id),
                        'chat_title': dialog.title or dialog.name or 'Unknown',
                        'chat_type': chat_type,
                        'unread_count': dialog.unread_count,
                        'last_message_preview': preview,
                        'last_message_at': dialog.message.date.isoformat() if dialog.message and dialog.message.date else None,
                        'is_pinned': dialog.pinned,
                    })

                await client.disconnect()
                return {'success': True, 'dialogs': dialogs}
            except Exception as e:
                await client.disconnect()
                logger.error(f"Failed to fetch chats for account {account_id}: {e}")
                return {'success': False, 'error': str(e)}

        result = _run_telethon(_fetch())

        if result.get('session_expired'):
            try:
                account = TelegramAccount.query.get(account_id)
                if account:
                    account.is_authorized = False
                    SessionLocal.commit()
            finally:
                SessionLocal.remove()
            return result

        if result.get('success'):
            total_unread = 0
            existing = cache.get_all_chat_meta(account_id)

            for d in result['dialogs']:
                cid = d['chat_id']
                prev = existing.get(cid, {})
                chat_data = {
                    'account_id': account_id,
                    'chat_id': cid,
                    'chat_title': d['chat_title'],
                    'chat_type': d['chat_type'],
                    'unread_count': d['unread_count'],
                    'last_message_preview': d['last_message_preview'],
                    'last_message_at': d['last_message_at'],
                    'is_pinned': d['is_pinned'],
                    'is_manually_pinned': prev.get('is_manually_pinned', False),
                    'cta_sent': prev.get('cta_sent', False),
                }
                cache.set_chat_meta(account_id, cid, chat_data)
                total_unread += d['unread_count']

            cache.set_total_unread(account_id, total_unread)
            return {'success': True, 'total_unread': total_unread}

        return result

    def connect_account(self, account_id):
        try:
            account = TelegramAccount.query.get(account_id)
            if not account:
                return {'error': 'Account not found'}
            if not account.is_authorized:
                return {'error': 'Account not authorized'}
            if account.is_connected:
                return {'error': 'Account already connected'}
        finally:
            SessionLocal.remove()

        chat_result = self.fetch_chats_sync(account_id)
        if not chat_result.get('success'):
            return {'error': chat_result.get('error', 'Failed to fetch chats')}

        try:
            account = TelegramAccount.query.get(account_id)
            account.is_connected = True
            account.last_heartbeat = datetime.utcnow()
            SessionLocal.commit()
        finally:
            SessionLocal.remove()

        import listeners
        listeners.start_listener(account_id)

        return {'success': True}

    def disconnect_acct(self, account_id):
        try:
            import listeners
            listeners.stop_listener(account_id)
        except Exception:
            pass

        try:
            account = TelegramAccount.query.get(account_id)
            if not account:
                return {'error': 'Account not found'}
            account.is_connected = False
            account.celery_task_id = None
            account.last_heartbeat = None
            SessionLocal.commit()
            return {'success': True}
        finally:
            SessionLocal.remove()

    def refresh_chats(self, account_id):
        return self.fetch_chats_sync(account_id)

    def get_chats(self, account_id):
        all_meta = cache.get_all_chat_meta(account_id)
        if all_meta:
            chats = list(all_meta.values())
            chats.sort(key=lambda c: c.get('last_message_at') or '', reverse=True)
            chats.sort(key=lambda c: (
                0 if c.get('is_manually_pinned') else 1,
                0 if c.get('is_pinned') else 1,
            ))
            return chats
        return []

    def toggle_chat_pin(self, account_id, chat_id):
        chat_data = cache.get_chat_meta(account_id, chat_id)
        if not chat_data:
            return {'error': 'Chat not found'}
        chat_data['is_manually_pinned'] = not chat_data.get('is_manually_pinned', False)
        cache.set_chat_meta(account_id, chat_id, chat_data)
        return {'success': True, 'is_manually_pinned': chat_data['is_manually_pinned']}

    def get_messages(self, account_id, chat_id, limit=50, before_id=0):
        return self.fetch_messages_from_telegram(account_id, chat_id, limit, before_id)

    def fetch_messages_from_telegram(self, account_id, chat_id, limit=50, offset_id=0):
        try:
            account = TelegramAccount.query.get(account_id)
            if not account or not account.is_authorized:
                return []
            api_id = account.api_id
            api_hash = account.api_hash
            phone = account.phone_number
        finally:
            SessionLocal.remove()

        session = _get_session(phone)

        async def _fetch():
            client = TelegramClient(session, api_id, api_hash, receive_updates=False)
            await client.connect()

            if not await client.is_user_authorized():
                await client.disconnect()
                return []

            await _ensure_entity_cache(client, chat_id)

            try:
                messages_data = []
                kwargs = {'limit': limit}
                if offset_id:
                    kwargs['offset_id'] = offset_id

                async for msg in client.iter_messages(chat_id, **kwargs):
                    sender_name = ''
                    if msg.sender:
                        if hasattr(msg.sender, 'first_name'):
                            sender_name = f"{msg.sender.first_name or ''} {msg.sender.last_name or ''}".strip()
                        elif hasattr(msg.sender, 'title'):
                            sender_name = msg.sender.title

                    media_type = None
                    if msg.photo:
                        media_type = 'photo'
                    elif msg.video:
                        media_type = 'video'
                    elif msg.document:
                        media_type = 'document'
                    elif msg.sticker:
                        media_type = 'sticker'
                    elif msg.voice:
                        media_type = 'voice'

                    messages_data.append({
                        'id': msg.id,
                        'message_id': msg.id,
                        'sender_name': sender_name,
                        'sender_id': str(msg.sender_id) if msg.sender_id else None,
                        'text': msg.text,
                        'media_type': media_type,
                        'is_incoming': not msg.out,
                        'is_auto_reply': False,
                        'timestamp': msg.date.isoformat() if msg.date else None,
                    })

                await client.disconnect()
                return list(reversed(messages_data))
            except Exception as e:
                await client.disconnect()
                logger.error(f"Failed to fetch messages from Telegram: {e}")
                return []

        try:
            result = _run_telethon(_fetch())
            # Reset unread count in cache when chat is opened
            chat_data = cache.get_chat_meta(account_id, chat_id)
            if chat_data and chat_data.get('unread_count'):
                chat_data['unread_count'] = 0
                cache.set_chat_meta(account_id, chat_id, chat_data)
            return result
        except Exception as e:
            logger.error(f"fetch_messages_from_telegram error: {e}")
            return []

    def send_message_sync(self, account_id, chat_id, text):
        try:
            account = TelegramAccount.query.get(account_id)
            if not account or not account.is_authorized:
                return {'success': False, 'error': 'Account not found'}
            api_id = account.api_id
            api_hash = account.api_hash
            phone = account.phone_number
            display_name = account.display_name or phone
        finally:
            SessionLocal.remove()

        session = _get_session(phone)

        async def _send():
            client = TelegramClient(session, api_id, api_hash, receive_updates=False)
            await client.connect()
            await _ensure_entity_cache(client, chat_id)
            try:
                msg = await client.send_message(chat_id, text)
                await client.disconnect()
                return {
                    'success': True,
                    'message_id': msg.id,
                    'timestamp': msg.date.isoformat()
                }
            except Exception as e:
                await client.disconnect()
                return {'success': False, 'error': str(e)}

        result = _run_telethon(_send())

        if result.get('success'):
            timestamp = result['timestamp']
            result['message'] = {
                'id': result['message_id'],
                'message_id': result['message_id'],
                'sender_name': display_name,
                'sender_id': None,
                'text': text,
                'media_type': None,
                'is_incoming': False,
                'is_auto_reply': False,
                'timestamp': timestamp,
            }
            cache.push_chat_msg(account_id, chat_id, result['message'])
            chat_data = cache.get_chat_meta(account_id, chat_id)
            if chat_data:
                chat_data['last_message_preview'] = text[:200]
                chat_data['last_message_at'] = timestamp
                cache.set_chat_meta(account_id, chat_id, chat_data)

        return result

    def send_file_sync(self, account_id, chat_id, file_path, caption=''):
        if not os.path.isfile(file_path):
            return {'success': False, 'error': f'File not found: {file_path}'}

        try:
            account = TelegramAccount.query.get(account_id)
            if not account or not account.is_authorized:
                return {'success': False, 'error': 'Account not found'}
            api_id = account.api_id
            api_hash = account.api_hash
            phone = account.phone_number
            display_name = account.display_name or phone
        finally:
            SessionLocal.remove()

        session = _get_session(phone)

        async def _send():
            client = TelegramClient(session, api_id, api_hash, receive_updates=False)
            await client.connect()
            await _ensure_entity_cache(client, chat_id)
            try:
                msg = await client.send_file(chat_id, file_path, caption=caption)
                await client.disconnect()
                return {
                    'success': True,
                    'message_id': msg.id,
                    'timestamp': msg.date.isoformat()
                }
            except Exception as e:
                await client.disconnect()
                return {'success': False, 'error': str(e)}

        result = _run_telethon(_send())

        if result.get('success'):
            timestamp = result['timestamp']
            result['message'] = {
                'id': result['message_id'],
                'message_id': result['message_id'],
                'sender_name': display_name,
                'sender_id': None,
                'text': caption or None,
                'media_type': 'photo',
                'is_incoming': False,
                'is_auto_reply': False,
                'timestamp': timestamp,
            }
            cache.push_chat_msg(account_id, chat_id, result['message'])
            chat_data = cache.get_chat_meta(account_id, chat_id)
            if chat_data:
                chat_data['last_message_preview'] = f'[Photo] {caption[:180]}' if caption else '[Photo]'
                chat_data['last_message_at'] = timestamp
                cache.set_chat_meta(account_id, chat_id, chat_data)

        return result

    def pick_photo_for_account(self, account_id):
        try:
            from sqlalchemy import func
            mapped_folder_ids = SessionLocal.query(TelegramMediaFolderAccount.folder_id).filter_by(
                account_id=account_id
            ).all()
            mapped_ids = [r[0] for r in mapped_folder_ids]

            all_scope_ids = SessionLocal.query(TelegramMediaFolder.id).filter_by(
                account_scope='all', is_active=True
            ).all()
            all_ids = [r[0] for r in all_scope_ids]

            folder_ids = list(set(mapped_ids + all_ids))
            if not folder_ids:
                return None

            rand_func = func.random() if IS_SQLITE else func.rand()
            file = TelegramMediaFile.query.filter(
                TelegramMediaFile.folder_id.in_(folder_ids),
                TelegramMediaFile.auto_send_enabled == True
            ).order_by(
                TelegramMediaFile.used_count.asc(),
                rand_func
            ).first()

            if not file:
                return None

            if not os.path.isfile(file.file_path):
                return None

            file.used_count = (file.used_count or 0) + 1
            file.is_used = True
            SessionLocal.commit()
            return file.file_path
        finally:
            SessionLocal.remove()

    # ============ Media Folder Methods ============

    def get_media_folders(self):
        try:
            folders = TelegramMediaFolder.query.order_by(
                TelegramMediaFolder.created_at.desc()
            ).all()
            return [f.to_dict() for f in folders]
        finally:
            SessionLocal.remove()

    def create_media_folder(self, name, folder_path=None, folder_type='local', description=None):
        try:
            folder = TelegramMediaFolder(
                name=name, folder_path=folder_path,
                folder_type=folder_type, description=description
            )
            SessionLocal.add(folder)
            SessionLocal.commit()
            return folder.to_dict()
        finally:
            SessionLocal.remove()

    def delete_media_folder(self, folder_id):
        try:
            folder = TelegramMediaFolder.query.get(folder_id)
            if not folder:
                return {'error': 'Folder not found'}
            SessionLocal.delete(folder)
            SessionLocal.commit()
            return {'success': True}
        finally:
            SessionLocal.remove()

    def scan_folder_files(self, folder_id):
        import mimetypes
        try:
            folder = TelegramMediaFolder.query.get(folder_id)
            if not folder or not folder.folder_path:
                return {'error': 'Folder not found or no path set'}
            if not os.path.isdir(folder.folder_path):
                return {'error': f'Directory not found: {folder.folder_path}'}

            image_extensions = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}
            count = 0
            for fname in os.listdir(folder.folder_path):
                ext = os.path.splitext(fname)[1].lower()
                if ext not in image_extensions:
                    continue
                fpath = os.path.join(folder.folder_path, fname)
                if not os.path.isfile(fpath):
                    continue
                existing = TelegramMediaFile.query.filter_by(
                    folder_id=folder_id, filename=fname
                ).first()
                if existing:
                    continue
                mime = mimetypes.guess_type(fpath)[0] or 'image/jpeg'
                size = os.path.getsize(fpath)
                mf = TelegramMediaFile(
                    folder_id=folder_id, filename=fname, original_name=fname,
                    file_path=fpath, file_size=size, mime_type=mime
                )
                SessionLocal.add(mf)
                count += 1
            SessionLocal.commit()
            return {'success': True, 'new_files': count}
        finally:
            SessionLocal.remove()

    def get_media_files(self, folder_id):
        try:
            files = TelegramMediaFile.query.filter_by(folder_id=folder_id).order_by(
                TelegramMediaFile.uploaded_at.desc()
            ).all()
            return [f.to_dict() for f in files]
        finally:
            SessionLocal.remove()

    def upload_media_file(self, src_path, folder_id):
        """Copy a file from src_path to media upload dir and register in DB."""
        import uuid
        import shutil
        import mimetypes
        from config import MEDIA_UPLOAD_DIR

        try:
            folder = TelegramMediaFolder.query.get(folder_id)
            if not folder:
                return {'error': 'Folder not found'}

            os.makedirs(MEDIA_UPLOAD_DIR, exist_ok=True)
            original_name = os.path.basename(src_path)
            ext = os.path.splitext(original_name)[1].lower()
            filename = f"{uuid.uuid4().hex}{ext}"
            filepath = os.path.join(MEDIA_UPLOAD_DIR, filename)
            shutil.copy2(src_path, filepath)

            mime = mimetypes.guess_type(filepath)[0] or 'application/octet-stream'
            size = os.path.getsize(filepath)

            mf = TelegramMediaFile(
                folder_id=folder_id, filename=filename, original_name=original_name,
                file_path=filepath, file_size=size, mime_type=mime
            )
            SessionLocal.add(mf)
            SessionLocal.commit()
            return mf.to_dict()
        finally:
            SessionLocal.remove()

    def delete_media_file(self, file_id):
        try:
            mf = TelegramMediaFile.query.get(file_id)
            if not mf:
                return {'error': 'File not found'}
            if mf.file_path and os.path.isfile(mf.file_path):
                try:
                    os.remove(mf.file_path)
                except Exception as e:
                    logger.warning(f"Could not delete file from disk: {e}")
            SessionLocal.delete(mf)
            SessionLocal.commit()
            return {'success': True}
        finally:
            SessionLocal.remove()

    def toggle_file_auto_send(self, file_id):
        try:
            mf = TelegramMediaFile.query.get(file_id)
            if not mf:
                return {'error': 'File not found'}
            mf.auto_send_enabled = not mf.auto_send_enabled
            SessionLocal.commit()
            return {'success': True, 'auto_send_enabled': mf.auto_send_enabled}
        finally:
            SessionLocal.remove()

    def set_folder_accounts(self, folder_id, account_ids, scope='selected'):
        try:
            folder = TelegramMediaFolder.query.get(folder_id)
            if not folder:
                return {'error': 'Folder not found'}
            folder.account_scope = scope
            TelegramMediaFolderAccount.query.filter_by(folder_id=folder_id).delete()
            if scope == 'selected' and account_ids:
                for aid in account_ids:
                    mapping = TelegramMediaFolderAccount(folder_id=folder_id, account_id=aid)
                    SessionLocal.add(mapping)
            SessionLocal.commit()
            return {'success': True, 'folder': folder.to_dict()}
        finally:
            SessionLocal.remove()

    def get_folder_accounts(self, folder_id):
        try:
            folder = TelegramMediaFolder.query.get(folder_id)
            if not folder:
                return {'error': 'Folder not found'}
            return {
                'scope': folder.account_scope or 'all',
                'account_ids': [ma.account_id for ma in folder.mapped_accounts.all()]
            }
        finally:
            SessionLocal.remove()

    def get_analytics(self, days=7):
        cached = cache.cache_get(f'analytics:{days}')
        if cached is not None:
            return cached

        try:
            from datetime import timedelta
            from sqlalchemy import func, case

            now = datetime.utcnow()
            today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            period_start = today_start - timedelta(days=days - 1)

            base_q = TelegramMessage.query.filter(TelegramMessage.timestamp >= period_start)
            total_messages = base_q.count()
            total_incoming = base_q.filter_by(is_incoming=True).count()
            total_outgoing = base_q.filter_by(is_incoming=False).count()
            auto_replies = base_q.filter_by(is_auto_reply=True).count()

            today_q = TelegramMessage.query.filter(TelegramMessage.timestamp >= today_start)
            today_total = today_q.count()

            unique_chats_today = SessionLocal.query(
                func.count(func.distinct(TelegramMessage.chat_id))
            ).filter(
                TelegramMessage.timestamp >= today_start,
                TelegramMessage.is_incoming == True
            ).scalar() or 0

            daily = SessionLocal.query(
                func.date(TelegramMessage.timestamp).label('day'),
                func.count().label('total'),
                func.sum(case((TelegramMessage.is_incoming == True, 1), else_=0)).label('incoming'),
                func.sum(case((TelegramMessage.is_incoming == False, 1), else_=0)).label('outgoing'),
            ).filter(
                TelegramMessage.timestamp >= period_start
            ).group_by(
                func.date(TelegramMessage.timestamp)
            ).order_by(
                func.date(TelegramMessage.timestamp)
            ).all()

            daily_data = {}
            for row in daily:
                day_str = str(row.day)
                daily_data[day_str] = {
                    'total': int(row.total),
                    'incoming': int(row.incoming),
                    'outgoing': int(row.outgoing),
                }

            chart_labels = []
            chart_incoming = []
            chart_outgoing = []
            for i in range(days):
                d = period_start + timedelta(days=i)
                day_str = d.strftime('%Y-%m-%d')
                chart_labels.append(d.strftime('%b %d'))
                entry = daily_data.get(day_str, {'incoming': 0, 'outgoing': 0})
                chart_incoming.append(entry['incoming'])
                chart_outgoing.append(entry['outgoing'])

            per_account = SessionLocal.query(
                TelegramAccount.id,
                TelegramAccount.phone_number,
                TelegramAccount.display_name,
                func.count(TelegramMessage.id).label('msg_count'),
                func.sum(case((TelegramMessage.is_incoming == True, 1), else_=0)).label('incoming'),
            ).join(
                TelegramMessage, TelegramMessage.account_id == TelegramAccount.id
            ).filter(
                TelegramMessage.timestamp >= period_start
            ).group_by(
                TelegramAccount.id
            ).order_by(
                func.count(TelegramMessage.id).desc()
            ).all()

            account_stats = []
            for row in per_account:
                account_stats.append({
                    'id': row.id,
                    'name': row.display_name or row.phone_number,
                    'total': int(row.msg_count),
                    'incoming': int(row.incoming),
                })

            result = {
                'period_days': days,
                'total_messages': total_messages,
                'total_incoming': total_incoming,
                'total_outgoing': total_outgoing,
                'auto_replies': auto_replies,
                'today_total': today_total,
                'unique_chats_today': unique_chats_today,
                'chart': {
                    'labels': chart_labels,
                    'incoming': chart_incoming,
                    'outgoing': chart_outgoing,
                },
                'account_stats': account_stats,
            }
            cache.cache_set(f'analytics:{days}', result, ttl=60)
            return result
        finally:
            SessionLocal.remove()

    # ============ Automation Helpers ============

    def pick_last_photo_for_account(self, account_id):
        """Return the last (highest used_count / most recently uploaded) photo for this account."""
        try:
            from sqlalchemy import func
            mapped_folder_ids = SessionLocal.query(TelegramMediaFolderAccount.folder_id).filter_by(
                account_id=account_id
            ).all()
            mapped_ids = [r[0] for r in mapped_folder_ids]

            all_scope_ids = SessionLocal.query(TelegramMediaFolder.id).filter_by(
                account_scope='all', is_active=True
            ).all()
            all_ids = [r[0] for r in all_scope_ids]

            folder_ids = list(set(mapped_ids + all_ids))
            if not folder_ids:
                return None

            file = TelegramMediaFile.query.filter(
                TelegramMediaFile.folder_id.in_(folder_ids),
                TelegramMediaFile.auto_send_enabled == True
            ).order_by(
                TelegramMediaFile.used_count.desc(),
                TelegramMediaFile.uploaded_at.desc()
            ).first()

            if not file or not os.path.isfile(file.file_path):
                return None

            return file.file_path
        finally:
            SessionLocal.remove()

    def prepare_personalized_namecard(self, account_id, chat_id, name, settings):
        """Generate a personalized namecard image. Returns file path or None."""
        try:
            import platform
            from utils.image_auto_edit import generate_name_card

            nc = settings.get('NAMECARD', {})
            if not nc.get('enabled'):
                return None

            if platform.system() == 'Windows':
                fmt = nc.get('date_format_windows', '%#d.%#m.%y')
            else:
                fmt = nc.get('date_format_linux', '%-d.%-m.%y')
            date_str = datetime.now().strftime(fmt)

            out_dir = os.path.join(MEDIA_UPLOAD_DIR, 'personalized')
            os.makedirs(out_dir, exist_ok=True)

            ts = datetime.now().strftime('%Y%m%d%H%M%S')
            out_filename = f"{account_id}_{chat_id}_{ts}.jpg"

            overrides = {}
            template = nc.get('template_path')
            if template and os.path.isfile(template):
                overrides['TEMPLATE_PATH'] = template

            path = generate_name_card(
                name=name,
                date_str=date_str,
                out_dir=out_dir,
                out_filename=out_filename,
                **overrides
            )
            return path if path and os.path.isfile(path) else None
        except Exception as e:
            logger.error(f"prepare_personalized_namecard error: {e}")
            return None

    def send_voice_note_sync(self, account_id, chat_id, file_path):
        """Send an audio file as a Telegram voice note."""
        if not os.path.isfile(file_path):
            return {'success': False, 'error': f'File not found: {file_path}'}

        try:
            account = TelegramAccount.query.get(account_id)
            if not account or not account.is_authorized:
                return {'success': False, 'error': 'Account not found'}
            api_id = account.api_id
            api_hash = account.api_hash
            phone = account.phone_number
            display_name = account.display_name or phone
        finally:
            SessionLocal.remove()

        session = _get_session(phone)

        async def _send():
            client = TelegramClient(session, api_id, api_hash, receive_updates=False)
            await client.connect()
            await _ensure_entity_cache(client, chat_id)
            try:
                msg = await client.send_file(
                    chat_id, file_path,
                    voice_note=True
                )
                await client.disconnect()
                return {
                    'success': True,
                    'message_id': msg.id,
                    'timestamp': msg.date.isoformat()
                }
            except Exception as e:
                await client.disconnect()
                return {'success': False, 'error': str(e)}

        result = _run_telethon(_send())

        if result.get('success'):
            timestamp = result['timestamp']
            result['message'] = {
                'id': result['message_id'],
                'message_id': result['message_id'],
                'sender_name': display_name,
                'sender_id': None,
                'text': None,
                'media_type': 'voice',
                'is_incoming': False,
                'is_auto_reply': False,
                'timestamp': timestamp,
            }
            cache.push_chat_msg(account_id, chat_id, result['message'])
            chat_data = cache.get_chat_meta(account_id, chat_id)
            if chat_data:
                chat_data['last_message_preview'] = '[Voice Note]'
                chat_data['last_message_at'] = timestamp
                cache.set_chat_meta(account_id, chat_id, chat_data)

        return result
