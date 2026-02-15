"""PyInstaller build script for Telegram Desktop app."""
import os
import sys
import PyInstaller.__main__

# Paths
HERE = os.path.dirname(os.path.abspath(__file__))
MAIN = os.path.join(HERE, 'main.py')
WEB_DIR = os.path.join(HERE, 'web')

# Separator for --add-data (';' on Windows, ':' on Unix)
sep = ';' if sys.platform == 'win32' else ':'

PyInstaller.__main__.run([
    MAIN,
    '--name=TelegramDesktop',
    '--onefile',
    '--windowed',
    f'--add-data={WEB_DIR}{sep}web',
    '--hidden-import=pymysql',
    '--hidden-import=cryptography',
    '--hidden-import=telethon',
    '--hidden-import=eel',
    '--hidden-import=PIL',
    '--hidden-import=bottle',
    '--hidden-import=engineio',
    '--hidden-import=gevent',
    '--icon=NONE',
    '--noconfirm',
])
