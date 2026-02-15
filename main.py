"""Eel desktop app entry point — Telegram Dashboard."""
import os
import sys
import json
import time
import base64
import logging
import threading
from collections import deque
from datetime import datetime

import eel
from config import DATA_DIR

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(levelname)s: %(message)s')
logger = logging.getLogger(__name__)


# ==================== LIVE LOG HANDLER ====================

_log_buffer = deque(maxlen=500)
_log_lock = threading.Lock()


class EelLogHandler(logging.Handler):
    """Captures log entries into a ring buffer and pushes to the Eel UI."""

    def emit(self, record):
        try:
            entry = {
                'timestamp': datetime.fromtimestamp(record.created).strftime('%H:%M:%S'),
                'level': record.levelname,
                'logger': record.name,
                'message': self.format(record),
            }
            with _log_lock:
                _log_buffer.append(entry)
            # Push to UI (non-blocking, ignore if no browser connected)
            try:
                eel.on_log_entry(entry)
            except Exception:
                pass
        except Exception:
            pass


# Attach handler to root logger so all modules are captured
_eel_handler = EelLogHandler()
_eel_handler.setFormatter(logging.Formatter('%(message)s'))
_eel_handler.setLevel(logging.DEBUG)
logging.getLogger().addHandler(_eel_handler)


# Init Eel with web folder
_web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')
eel.init(_web_dir)

# Init DB + services
from database import SessionLocal, engine, Base
from models import *
from services.telegram_service import TelegramService
from services.ai_service import AIService
import listeners, cache, blacklist

telegram_service = TelegramService()
ai_service = AIService()


# ==================== ACCOUNT ENDPOINTS ====================

@eel.expose
def get_accounts():
    try:
        return telegram_service.get_all_accounts()
    except Exception as e:
        logger.error(f"get_accounts error: {e}")
        return []


@eel.expose
def add_account(phone_number, api_id, api_hash, display_name=None):
    try:
        return telegram_service.create_account(phone_number, int(api_id), api_hash, display_name)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def delete_account(account_id):
    try:
        return telegram_service.delete_account(account_id)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def send_code(account_id):
    try:
        return telegram_service.send_code_sync(account_id)
    except Exception as e:
        return {'success': False, 'error': str(e)}


@eel.expose
def verify_code(account_id, code, password=None):
    try:
        return telegram_service.verify_code_sync(account_id, code, password)
    except Exception as e:
        return {'success': False, 'error': str(e)}


@eel.expose
def cancel_verification(account_id):
    try:
        return telegram_service.cancel_verification(account_id)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def connect_account(account_id):
    try:
        return telegram_service.connect_account(account_id)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def disconnect_account(account_id):
    try:
        return telegram_service.disconnect_acct(account_id)
    except Exception as e:
        return {'error': str(e)}


# ==================== CHAT ENDPOINTS ====================

@eel.expose
def get_chats(account_id, refresh=False):
    try:
        if refresh:
            telegram_service.refresh_chats(account_id)
        return telegram_service.get_chats(account_id)
    except Exception as e:
        logger.error(f"get_chats error: {e}")
        return []


@eel.expose
def get_messages(account_id, chat_id, limit=50, before_id=0):
    try:
        msgs = telegram_service.get_messages(account_id, int(chat_id), limit, before_id)
        return {'messages': msgs, 'fetching': False}
    except Exception as e:
        logger.error(f"get_messages error: {e}")
        return {'messages': [], 'fetching': False}


@eel.expose
def send_message(account_id, chat_id, text):
    try:
        return telegram_service.send_message_sync(account_id, int(chat_id), text)
    except Exception as e:
        return {'success': False, 'error': str(e)}


@eel.expose
def toggle_chat_pin(account_id, chat_id):
    try:
        return telegram_service.toggle_chat_pin(account_id, chat_id)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def mark_read(account_id, chat_id):
    try:
        chat_data = cache.get_chat_meta(account_id, chat_id)
        if chat_data:
            old_unread = chat_data.get('unread_count', 0)
            chat_data['unread_count'] = 0
            cache.set_chat_meta(account_id, chat_id, chat_data)
            if old_unread > 0:
                cache.decr_total_unread(account_id, old_unread)
        return {'success': True}
    except Exception as e:
        return {'error': str(e)}


# ==================== AI CONFIG ====================

@eel.expose
def get_ai_config():
    try:
        return ai_service.get_config_dict()
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def save_ai_config(data):
    try:
        return ai_service.save_config(
            provider=data.get('provider', 'openai'),
            api_key=data.get('api_key', ''),
            model=data.get('model', ''),
            system_prompt=data.get('system_prompt', ''),
            auto_reply_enabled=data.get('auto_reply_enabled', False),
            auto_reply_scope=data.get('auto_reply_scope', 'all'),
            account_ids=data.get('selected_account_ids', []),
            max_tokens=data.get('max_tokens', 500),
            temperature=data.get('temperature', 0.7),
        )
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def test_ai_prompt(data):
    try:
        system_prompt = data.get('system_prompt', '')
        profile_id = data.get('profile_id')

        # If a profile is selected, use the dynamic build_system_prompt
        if profile_id:
            profile = ai_service.get_profile(profile_id)
            if profile:
                system_prompt = ai_service.build_system_prompt(profile)

        # Use stored API key from config if not provided (UI shows masked key)
        api_key = data.get('api_key', '')
        if not api_key or '...' in api_key or api_key == '****':
            config = ai_service.get_config()
            if config and config.api_key:
                api_key = config.api_key

        return ai_service.test_prompt(
            provider=data.get('provider', 'openai'),
            api_key=api_key,
            model=data.get('model', ''),
            system_prompt=system_prompt,
            test_message=data.get('test_message', ''),
            history=data.get('conversation_history'),
            temperature=data.get('temperature'),
        )
    except Exception as e:
        return {'success': False, 'error': str(e)}


@eel.expose
def preview_system_prompt(profile_id=None):
    """Generate and return the system prompt for a given profile (or defaults)."""
    try:
        if profile_id:
            profile = ai_service.get_profile(profile_id)
        else:
            profile = None
        if profile:
            return {'success': True, 'prompt': ai_service.build_system_prompt(profile)}
        # No profile — return a basic default
        return {'success': True, 'prompt': '(No profile selected — create a profile to generate a system prompt)'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


# ==================== PROFILES ====================

@eel.expose
def get_profiles():
    try:
        return ai_service.get_profiles()
    except Exception as e:
        return []


@eel.expose
def create_profile(data):
    try:
        return ai_service.create_profile(data)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def update_profile(profile_id, data):
    try:
        return ai_service.update_profile(profile_id, data)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def delete_profile(profile_id):
    try:
        return ai_service.delete_profile(profile_id)
    except Exception as e:
        return {'error': str(e)}


# ==================== MEDIA ====================

@eel.expose
def get_media_folders():
    try:
        return telegram_service.get_media_folders()
    except Exception as e:
        return []


@eel.expose
def create_media_folder(name, folder_path=None, folder_type='local', description=None):
    try:
        return telegram_service.create_media_folder(name, folder_path, folder_type, description)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def delete_media_folder(folder_id):
    try:
        return telegram_service.delete_media_folder(folder_id)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def scan_media_folder(folder_id):
    try:
        return telegram_service.scan_folder_files(folder_id)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def get_media_files(folder_id):
    try:
        return telegram_service.get_media_files(folder_id)
    except Exception as e:
        return []


@eel.expose
def delete_media_file(file_id):
    try:
        return telegram_service.delete_media_file(file_id)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def toggle_file_auto_send(file_id):
    try:
        return telegram_service.toggle_file_auto_send(file_id)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def get_folder_accounts(folder_id):
    try:
        return telegram_service.get_folder_accounts(folder_id)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def set_folder_accounts(folder_id, account_ids, scope='selected'):
    try:
        return telegram_service.set_folder_accounts(folder_id, account_ids, scope)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def serve_media_file(file_id):
    """Return media file as base64 data URL."""
    try:
        from models import TelegramMediaFile
        try:
            mf = TelegramMediaFile.query.get(file_id)
            if not mf or not mf.file_path or not os.path.isfile(mf.file_path):
                return None
            file_path = mf.file_path
            mime = mf.mime_type or 'image/jpeg'
        finally:
            SessionLocal.remove()

        with open(file_path, 'rb') as f:
            data = base64.b64encode(f.read()).decode()
        return f"data:{mime};base64,{data}"
    except Exception as e:
        logger.error(f"serve_media_file error: {e}")
        return None


@eel.expose
def open_file_dialog():
    """Open native file picker and return selected file paths."""
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    files = filedialog.askopenfilenames(
        filetypes=[('Images', '*.png *.jpg *.jpeg *.gif *.webp')]
    )
    root.destroy()
    return list(files)


@eel.expose
def upload_files_from_paths(folder_id, file_paths):
    """Upload files from local paths to a media folder."""
    results = []
    for path in file_paths:
        r = telegram_service.upload_media_file(path, folder_id)
        results.append(r)
    return results


# ==================== ANALYTICS & HEALTH ====================

@eel.expose
def get_analytics(days=7):
    try:
        return telegram_service.get_analytics(days)
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def get_listener_health():
    try:
        result = []
        try:
            accounts = TelegramAccount.query.filter_by(is_connected=True).all()
            for a in accounts:
                result.append({
                    'id': a.id,
                    'display_name': a.display_name or a.phone_number,
                    'last_heartbeat': a.last_heartbeat.isoformat() if a.last_heartbeat else None,
                    'listener_active': a.id in listeners._listener_threads,
                })
        finally:
            SessionLocal.remove()
        return result
    except Exception as e:
        return []


@eel.expose
def get_blacklist_stats():
    try:
        return blacklist.get_stats()
    except Exception as e:
        return {'error': str(e)}


# ==================== LIVE LOGS ====================

@eel.expose
def get_recent_logs(limit=200):
    with _log_lock:
        entries = list(_log_buffer)
    return entries[-limit:]


@eel.expose
def clear_logs():
    with _log_lock:
        _log_buffer.clear()
    return {'success': True}


# ==================== DB TRANSFER ====================

@eel.expose
def test_db_connection(url):
    try:
        from services.transfer_service import test_connection
        return test_connection(url)
    except Exception as e:
        return {'success': False, 'error': str(e)}


@eel.expose
def start_db_transfer(url):
    try:
        from services.transfer_service import start_transfer
        return start_transfer(url)
    except Exception as e:
        return {'success': False, 'error': str(e)}


@eel.expose
def get_transfer_status():
    try:
        from services.transfer_service import get_status
        return get_status()
    except Exception as e:
        return {'error': str(e)}


@eel.expose
def cancel_db_transfer():
    try:
        from services.transfer_service import cancel_transfer
        return cancel_transfer()
    except Exception as e:
        return {'error': str(e)}


# ==================== STARTUP ====================

def _run_migrations():
    """Add new columns to existing tables."""
    alter_statements = [
        "ALTER TABLE telegram_chats ADD COLUMN is_manually_pinned BOOLEAN DEFAULT FALSE",
        "ALTER TABLE telegram_messages ADD COLUMN is_auto_reply BOOLEAN DEFAULT FALSE",
        "ALTER TABLE telegram_media_files ADD COLUMN auto_send_enabled BOOLEAN DEFAULT TRUE",
        "ALTER TABLE telegram_media_folders ADD COLUMN account_scope VARCHAR(20) DEFAULT 'all'",
        "ALTER TABLE telegram_profiles ADD COLUMN settings_json TEXT",
        "ALTER TABLE telegram_profiles ADD COLUMN cta_json TEXT",
        "ALTER TABLE telegram_chats ADD COLUMN cta_sent BOOLEAN DEFAULT FALSE",
        "ALTER TABLE telegram_accounts ADD COLUMN last_heartbeat DATETIME",
    ]
    from sqlalchemy import text
    for stmt in alter_statements:
        try:
            SessionLocal.execute(text(stmt))
            SessionLocal.commit()
        except Exception:
            SessionLocal.rollback()
    SessionLocal.remove()


def _migrate_sessions():
    """Migrate existing .session files and session_string backups into DB-backed sessions."""
    from config import SESSIONS_DIR
    from models import TelegramSessionStore

    try:
        accounts = TelegramAccount.query.filter_by(is_authorized=True).all()
        for a in accounts:
            # Skip if already in DB
            existing = TelegramSessionStore.query.filter_by(
                phone_number=a.phone_number
            ).first()
            if existing and existing.auth_key:
                continue

            # Try .session file first
            session_file = os.path.join(SESSIONS_DIR, f'account_{a.id}.session')
            if os.path.exists(session_file):
                try:
                    from telethon.sessions import SQLiteSession
                    fs = SQLiteSession(os.path.join(SESSIONS_DIR, f'account_{a.id}'))
                    if fs.auth_key:
                        row = existing or TelegramSessionStore(phone_number=a.phone_number)
                        row.dc_id = fs.dc_id
                        row.server_address = fs.server_address
                        row.port = fs.port
                        row.auth_key = fs.auth_key.key
                        if not existing:
                            SessionLocal.add(row)
                        SessionLocal.commit()
                        logger.info(f"Migrated file session for {a.phone_number}")
                    fs.close()
                    continue
                except Exception as e:
                    logger.warning(f"Failed to migrate file session for {a.phone_number}: {e}")

            # Fall back to session_string backup
            if a.session_string:
                try:
                    from telethon.sessions import StringSession
                    ss = StringSession(a.session_string)
                    row = existing or TelegramSessionStore(phone_number=a.phone_number)
                    row.dc_id = ss.dc_id
                    row.server_address = ss.server_address
                    row.port = ss.port
                    row.auth_key = ss.auth_key.key
                    if not existing:
                        SessionLocal.add(row)
                    SessionLocal.commit()
                    logger.info(f"Migrated StringSession for {a.phone_number}")
                except Exception as e:
                    logger.warning(f"Failed to migrate StringSession for {a.phone_number}: {e}")
    finally:
        SessionLocal.remove()


def _seed_defaults():
    """Seed default AI config and profile if DB is empty."""
    from services.ai_service import DEFAULT_SETTINGS, DEFAULT_CTA
    from config import AI_API_KEY, AI_PROVIDER, AI_MODEL

    try:
        if not AIConfig.query.first():
            config = AIConfig(
                provider=AI_PROVIDER,
                api_key=AI_API_KEY,
                model=AI_MODEL,
                auto_reply_enabled=True,
                auto_reply_scope='all',
                max_tokens=500,
                temperature=0.5,
            )
            SessionLocal.add(config)
            SessionLocal.commit()
            logger.info(f"Seeded AI config (provider={config.provider})")

        if not TelegramProfile.query.first():
            profile = TelegramProfile(
                name='Linea', username='Linea', age='24',
                city='Berlin', job='im Einzelhandel',
                flirt_level='hardcore', location_mode='near_user',
                is_active=True,
                settings_json=json.dumps(DEFAULT_SETTINGS),
                cta_json=json.dumps(DEFAULT_CTA),
            )
            SessionLocal.add(profile)
            SessionLocal.commit()
            logger.info("Seeded default profile 'Linea'")
    finally:
        SessionLocal.remove()


def _start_periodic_tasks():
    """Start background health check and auto-connect loops."""
    def _health_loop():
        while True:
            time.sleep(60)
            try:
                listeners.check_listener_health()
            except Exception as e:
                logger.error(f"Health check error: {e}")

    def _autoconnect_loop():
        while True:
            time.sleep(120)
            try:
                listeners.auto_connect_accounts()
            except Exception as e:
                logger.error(f"Auto-connect error: {e}")

    threading.Thread(target=_health_loop, daemon=True).start()
    threading.Thread(target=_autoconnect_loop, daemon=True).start()


def startup():
    """Initialize DB, run migrations, seed defaults, auto-connect accounts."""
    logger.info("Starting Telegram Desktop...")

    # Create tables if needed
    Base.metadata.create_all(engine)
    _run_migrations()

    # Load blacklist from DB and start flush thread
    blacklist.migrate_from_cta_sent()
    blacklist.load_from_db()
    blacklist.start_flush_thread()

    _migrate_sessions()
    _seed_defaults()

    # Reset stale connection flags from previous session (unclean shutdown),
    # then auto-connect all authorized accounts.
    try:
        stale = TelegramAccount.query.filter_by(is_connected=True).all()
        for a in stale:
            a.is_connected = False
            a.celery_task_id = None
        if stale:
            SessionLocal.commit()
            logger.info(f"Reset {len(stale)} stale connection flag(s) from previous session")
    except Exception:
        SessionLocal.rollback()
    finally:
        SessionLocal.remove()

    listeners.auto_connect_accounts()

    # Start periodic tasks
    _start_periodic_tasks()

    logger.info("Startup complete")


def _find_app_browser():
    """Find a Chromium browser for app mode (standalone window, no URL bar)."""
    import shutil

    # Chrome paths
    chrome_paths = [
        shutil.which('chrome'),
        shutil.which('google-chrome'),
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    ]
    for p in chrome_paths:
        if p and os.path.isfile(p):
            return p

    # Edge paths (always present on Windows 10/11)
    edge_paths = [
        r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
        shutil.which('msedge'),
        shutil.which('microsoft-edge'),
    ]
    for p in edge_paths:
        if p and os.path.isfile(p):
            return p

    return None


if __name__ == '__main__':
    startup()

    # Launch as standalone app window (no browser tab, no URL bar)
    app_browser = _find_app_browser()

    if app_browser:
        # Tell Eel where Chrome/Edge is so it can launch in app mode
        import eel.browsers as _brw
        _brw.set_path('chrome', app_browser)

        # Dedicated user-data-dir forces a separate Chrome process so --app
        # opens a standalone window even when Chrome is already running.
        _app_profile = os.path.join(DATA_DIR, 'app_browser_profile')
        os.makedirs(_app_profile, exist_ok=True)

        eel.start('index.html', size=(1400, 900), mode='chrome',
                  app_mode=True, port=0,
                  cmdline_args=[
                      f'--user-data-dir={_app_profile}',
                      '--disable-extensions',
                      '--disable-default-apps',
                      '--no-first-run',
                  ])
    else:
        logger.warning("No Chromium browser found — opening in default browser")
        eel.start('index.html', size=(1400, 900), port=0)
