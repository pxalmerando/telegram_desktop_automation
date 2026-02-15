import os
import sys
from dotenv import load_dotenv

# Load .env from project root
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# When frozen as .exe, use appdata for writable dirs
if getattr(sys, 'frozen', False):
    DATA_DIR = os.path.join(os.environ.get('APPDATA', BASE_DIR), 'TelegramDesktop')
else:
    DATA_DIR = BASE_DIR

SESSIONS_DIR = os.path.join(DATA_DIR, 'telegram_sessions')
MEDIA_UPLOAD_DIR = os.path.join(DATA_DIR, 'media_uploads')
os.makedirs(SESSIONS_DIR, exist_ok=True)
os.makedirs(MEDIA_UPLOAD_DIR, exist_ok=True)


def _fix_database_url(url):
    if not url:
        return url
    if url.startswith('mysql://'):
        url = 'mysql+pymysql://' + url[len('mysql://'):]
    if '?ssl-mode=' in url:
        url = url.split('?ssl-mode=')[0]
    return url


# Default: local SQLite file in project dir.  Set DATABASE_URL in .env for MySQL.
_DB_DEFAULT = f"sqlite:///{os.path.join(DATA_DIR, 'app.db')}"
DATABASE_URL = _fix_database_url(os.environ.get('DATABASE_URL')) or _DB_DEFAULT

IS_SQLITE = DATABASE_URL.startswith('sqlite')

if IS_SQLITE:
    ENGINE_OPTIONS = {}
else:
    ENGINE_OPTIONS = {
        'pool_size': 1,
        'max_overflow': 0,
        'pool_recycle': 300,
        'pool_pre_ping': True,
    }
    if os.environ.get('DB_SSL_REQUIRED'):
        ENGINE_OPTIONS['connect_args'] = {'ssl': {'ssl_mode': 'REQUIRED'}}

# AI defaults
AI_API_KEY = os.environ.get('AI_API_KEY', '')
AI_PROVIDER = os.environ.get('AI_PROVIDER', 'grok')
AI_MODEL = os.environ.get('AI_MODEL', 'grok-4-fast-non-reasoning')

# Allowed image extensions
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
