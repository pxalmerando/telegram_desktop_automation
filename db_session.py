"""Custom Telethon session backed by the app's main database.

Stores auth credentials (dc_id, server_address, port, auth_key) in the
telegram_sessions_db table, keyed by phone number.  The entity cache is
shared across all DbSession instances for the same phone via a module-level
dict so that short-lived TelegramClients can resolve entities seen by
earlier clients (e.g. from get_dialogs).
"""
import threading
from telethon.sessions import MemorySession
from telethon.crypto import AuthKey


# Shared entity cache: {phone_number: set of (id, hash, username, phone, name)}
# MemorySession._entities is a set of these 5-tuples.  We mirror it here so
# that newly created sessions for the same phone instantly have all entities
# that any prior client discovered (via get_dialogs, received messages, etc.).
_shared_entities_lock = threading.Lock()
_shared_entities = {}


class DbSession(MemorySession):
    """Telethon session that persists to the app DB instead of a .session file."""

    def __init__(self, phone_number):
        super().__init__()
        self._phone = phone_number
        self._load()
        # Pre-populate entity cache from shared storage so this client can
        # resolve entities discovered by previous clients for the same phone.
        with _shared_entities_lock:
            shared = _shared_entities.get(self._phone)
            if shared:
                self._entities |= shared

    def _load(self):
        """Load session credentials from DB (if they exist)."""
        from database import SessionLocal
        from models import TelegramSessionStore

        try:
            row = TelegramSessionStore.query.filter_by(
                phone_number=self._phone
            ).first()
            if row and row.auth_key:
                self._dc_id = row.dc_id
                self._server_address = row.server_address
                self._port = row.port
                self._auth_key = AuthKey(row.auth_key)
        finally:
            SessionLocal.remove()

    def process_entities(self, tlo):
        """Store entities from API responses and share across sessions."""
        super().process_entities(tlo)
        # Persist to shared cache so future sessions for this phone get them
        if self._entities:
            with _shared_entities_lock:
                existing = _shared_entities.get(self._phone)
                if existing is None:
                    _shared_entities[self._phone] = set(self._entities)
                else:
                    existing |= self._entities

    def save(self):
        """Persist current session credentials to DB."""
        from database import SessionLocal
        from models import TelegramSessionStore
        from datetime import datetime

        auth_key_bytes = self._auth_key.key if self._auth_key else None

        try:
            row = TelegramSessionStore.query.filter_by(
                phone_number=self._phone
            ).first()

            if row:
                row.dc_id = self._dc_id
                row.server_address = self._server_address
                row.port = self._port
                row.auth_key = auth_key_bytes
                row.updated_at = datetime.utcnow()
            else:
                row = TelegramSessionStore(
                    phone_number=self._phone,
                    dc_id=self._dc_id,
                    server_address=self._server_address,
                    port=self._port,
                    auth_key=auth_key_bytes,
                )
                SessionLocal.add(row)

            SessionLocal.commit()
        finally:
            SessionLocal.remove()

    def delete(self):
        """Remove this session from DB."""
        from database import SessionLocal
        from models import TelegramSessionStore

        try:
            TelegramSessionStore.query.filter_by(
                phone_number=self._phone
            ).delete()
            SessionLocal.commit()
        finally:
            SessionLocal.remove()

    def close(self):
        """No file handle to close."""
        pass
