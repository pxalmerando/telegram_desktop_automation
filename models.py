import json as _json
from datetime import datetime
from sqlalchemy import (
    Column, Integer, BigInteger, String, Text, Boolean, Float, DateTime,
    LargeBinary, ForeignKey, UniqueConstraint, Index
)
from sqlalchemy.orm import relationship
from sqlalchemy import inspect as sa_inspect
from database import Base


class TelegramAccount(Base):
    __tablename__ = 'telegram_accounts'

    id = Column(Integer, primary_key=True)
    phone_number = Column(String(20), nullable=False, unique=True)
    display_name = Column(String(100), nullable=True)
    api_id = Column(Integer, nullable=False)
    api_hash = Column(String(64), nullable=False)
    session_string = Column(Text, nullable=True)
    is_connected = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    is_authorized = Column(Boolean, default=False)
    total_unread_count = Column(Integer, default=0)
    last_seen = Column(DateTime, nullable=True)
    celery_task_id = Column(String(255), nullable=True)
    last_heartbeat = Column(DateTime, nullable=True)
    phone_code_hash = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    chats = relationship('TelegramChat', backref='account', lazy='dynamic',
                         cascade='all, delete-orphan')
    messages = relationship('TelegramMessage', backref='account', lazy='dynamic',
                            cascade='all, delete-orphan')

    def to_dict(self):
        return {
            'id': self.id,
            'phone_number': self.phone_number,
            'display_name': self.display_name or self.phone_number,
            'api_id': self.api_id,
            'is_connected': self.is_connected,
            'is_active': self.is_active,
            'is_authorized': self.is_authorized,
            'has_pending_code': bool(self.phone_code_hash),
            'total_unread_count': self.total_unread_count,
            'last_seen': self.last_seen.isoformat() if self.last_seen else None,
            'last_heartbeat': self.last_heartbeat.isoformat() if self.last_heartbeat else None,
            'created_at': self.created_at.isoformat()
        }


class TelegramChat(Base):
    __tablename__ = 'telegram_chats'

    id = Column(Integer, primary_key=True)
    account_id = Column(Integer, ForeignKey('telegram_accounts.id'), nullable=False)
    chat_id = Column(BigInteger, nullable=False)
    chat_title = Column(String(255), nullable=True)
    chat_type = Column(String(20), default='private')
    unread_count = Column(Integer, default=0)
    last_message_preview = Column(String(200), nullable=True)
    last_message_at = Column(DateTime, nullable=True)
    is_pinned = Column(Boolean, default=False)
    is_manually_pinned = Column(Boolean, default=False)
    cta_sent = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint('account_id', 'chat_id', name='uq_account_chat'),
    )

    messages = relationship('TelegramMessage', backref='chat', lazy='dynamic',
                            cascade='all, delete-orphan')

    def to_dict(self):
        return {
            'id': self.id,
            'account_id': self.account_id,
            'chat_id': str(self.chat_id),
            'chat_title': self.chat_title or 'Unknown',
            'chat_type': self.chat_type,
            'unread_count': self.unread_count,
            'last_message_preview': self.last_message_preview,
            'last_message_at': self.last_message_at.isoformat() if self.last_message_at else None,
            'is_pinned': self.is_pinned,
            'is_manually_pinned': self.is_manually_pinned,
            'cta_sent': self.cta_sent,
            'created_at': self.created_at.isoformat()
        }


class TelegramMessage(Base):
    __tablename__ = 'telegram_messages'

    id = Column(Integer, primary_key=True)
    account_id = Column(Integer, ForeignKey('telegram_accounts.id'), nullable=False)
    chat_db_id = Column(Integer, ForeignKey('telegram_chats.id'), nullable=False)
    chat_id = Column(BigInteger, nullable=False)
    message_id = Column(Integer, nullable=False)
    sender_name = Column(String(255), nullable=True)
    sender_id = Column(BigInteger, nullable=True)
    text = Column(Text, nullable=True)
    media_type = Column(String(50), nullable=True)
    is_incoming = Column(Boolean, default=True)
    is_auto_reply = Column(Boolean, default=False)
    timestamp = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint('account_id', 'chat_id', 'message_id', name='uq_account_chat_message'),
        Index('ix_telegram_messages_lookup', 'account_id', 'chat_id', 'timestamp'),
    )

    def to_dict(self):
        return {
            'id': self.id,
            'account_id': self.account_id,
            'chat_id': str(self.chat_id),
            'message_id': self.message_id,
            'sender_name': self.sender_name,
            'sender_id': str(self.sender_id) if self.sender_id else None,
            'text': self.text,
            'media_type': self.media_type,
            'is_incoming': self.is_incoming,
            'is_auto_reply': self.is_auto_reply,
            'timestamp': self.timestamp.isoformat()
        }


class TelegramMediaFolder(Base):
    __tablename__ = 'telegram_media_folders'

    id = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False)
    folder_path = Column(String(500), nullable=True)
    folder_type = Column(String(20), default='local')
    description = Column(String(255), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    account_scope = Column(String(20), default='all')

    files = relationship('TelegramMediaFile', backref='folder', lazy='dynamic',
                         cascade='all, delete-orphan')
    mapped_accounts = relationship('TelegramMediaFolderAccount', backref='folder',
                                   lazy='dynamic', cascade='all, delete-orphan')

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'folder_path': self.folder_path,
            'folder_type': self.folder_type,
            'description': self.description,
            'is_active': self.is_active,
            'account_scope': self.account_scope or 'all',
            'mapped_account_ids': [ma.account_id for ma in self.mapped_accounts.all()],
            'file_count': self.files.count(),
            'created_at': self.created_at.isoformat()
        }


class TelegramMediaFile(Base):
    __tablename__ = 'telegram_media_files'

    id = Column(Integer, primary_key=True)
    folder_id = Column(Integer, ForeignKey('telegram_media_folders.id'), nullable=False)
    filename = Column(String(255), nullable=False)
    original_name = Column(String(255), nullable=True)
    file_path = Column(String(500), nullable=False)
    file_size = Column(Integer, default=0)
    mime_type = Column(String(100), nullable=True)
    is_used = Column(Boolean, default=False)
    used_count = Column(Integer, default=0)
    auto_send_enabled = Column(Boolean, default=True)
    uploaded_at = Column(DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'folder_id': self.folder_id,
            'filename': self.filename,
            'original_name': self.original_name,
            'file_path': self.file_path,
            'file_size': self.file_size,
            'mime_type': self.mime_type,
            'is_used': self.is_used,
            'used_count': self.used_count,
            'auto_send_enabled': self.auto_send_enabled,
            'uploaded_at': self.uploaded_at.isoformat()
        }


class TelegramMediaFolderAccount(Base):
    __tablename__ = 'telegram_media_folder_accounts'

    id = Column(Integer, primary_key=True)
    folder_id = Column(Integer, ForeignKey('telegram_media_folders.id'), nullable=False)
    account_id = Column(Integer, ForeignKey('telegram_accounts.id'), nullable=False)

    __table_args__ = (
        UniqueConstraint('folder_id', 'account_id', name='uq_folder_account'),
    )


class TelegramProfile(Base):
    __tablename__ = 'telegram_profiles'

    id = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False)
    username = Column(String(100), nullable=False)
    age = Column(String(10), nullable=True)
    city = Column(String(100), nullable=True)
    job = Column(String(200), nullable=True)
    hobbies = Column(String(500), nullable=True)
    flirt_level = Column(String(20), default='hot')
    location_mode = Column(String(20), default='fixed')
    is_active = Column(Boolean, default=True)
    settings_json = Column(Text, nullable=True)
    cta_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    mapped_accounts = relationship('TelegramProfileAccount', backref='profile',
                                    lazy='dynamic', cascade='all, delete-orphan')

    def to_dict(self):
        settings = {}
        if self.settings_json:
            try:
                settings = _json.loads(self.settings_json)
            except Exception:
                pass
        cta = {}
        if self.cta_json:
            try:
                cta = _json.loads(self.cta_json)
            except Exception:
                pass
        return {
            'id': self.id,
            'name': self.name,
            'username': self.username,
            'age': self.age,
            'city': self.city,
            'job': self.job,
            'hobbies': self.hobbies,
            'flirt_level': self.flirt_level,
            'location_mode': self.location_mode,
            'is_active': self.is_active,
            'settings': settings,
            'cta': cta,
            'mapped_account_ids': [ma.account_id for ma in self.mapped_accounts.all()],
            'created_at': self.created_at.isoformat()
        }


class TelegramProfileAccount(Base):
    __tablename__ = 'telegram_profile_accounts'

    id = Column(Integer, primary_key=True)
    profile_id = Column(Integer, ForeignKey('telegram_profiles.id'), nullable=False)
    account_id = Column(Integer, ForeignKey('telegram_accounts.id'), nullable=False)

    __table_args__ = (
        UniqueConstraint('profile_id', 'account_id', name='uq_profile_account'),
    )


class AIConfig(Base):
    __tablename__ = 'ai_configs'

    id = Column(Integer, primary_key=True)
    provider = Column(String(20), default='openai')
    api_key = Column(String(255), nullable=True)
    model = Column(String(100), nullable=True)
    system_prompt = Column(Text, nullable=True)
    auto_reply_enabled = Column(Boolean, default=False)
    auto_reply_scope = Column(String(20), default='all')
    max_tokens = Column(Integer, default=500)
    temperature = Column(Float, default=0.7)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    selected_accounts = relationship('AIAutoReplyAccount', backref='config',
                                      lazy='dynamic', cascade='all, delete-orphan')

    def to_dict(self, mask_key=True):
        key = self.api_key
        if mask_key and key:
            key = key[:8] + '...' + key[-4:] if len(key) > 12 else '****'
        return {
            'id': self.id,
            'provider': self.provider,
            'api_key': key,
            'model': self.model,
            'system_prompt': self.system_prompt,
            'auto_reply_enabled': self.auto_reply_enabled,
            'auto_reply_scope': self.auto_reply_scope,
            'max_tokens': self.max_tokens,
            'temperature': self.temperature,
            'selected_account_ids': (
                getattr(self, '_selected_account_ids', [])
                if sa_inspect(self).detached
                else [sa.account_id for sa in self.selected_accounts.all()]
            ),
            'created_at': self.created_at.isoformat(),
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }


class AIAutoReplyAccount(Base):
    __tablename__ = 'ai_auto_reply_accounts'

    id = Column(Integer, primary_key=True)
    config_id = Column(Integer, ForeignKey('ai_configs.id'), nullable=False)
    account_id = Column(Integer, ForeignKey('telegram_accounts.id'), nullable=False)

    __table_args__ = (
        UniqueConstraint('config_id', 'account_id', name='uq_config_account'),
    )


class BlacklistEntry(Base):
    __tablename__ = 'blacklist_entries'

    id = Column(Integer, primary_key=True)
    account_id = Column(Integer, nullable=False)
    chat_id = Column(BigInteger, nullable=False)
    feature = Column(String(30), nullable=False, default='cta')
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint('account_id', 'chat_id', 'feature', name='uq_blacklist_account_chat_feature'),
        Index('ix_blacklist_feature', 'feature'),
    )


class TelegramSessionStore(Base):
    """Telethon session credentials stored in main DB, keyed by phone number."""
    __tablename__ = 'telegram_sessions_db'

    id = Column(Integer, primary_key=True)
    phone_number = Column(String(20), nullable=False, unique=True, index=True)
    dc_id = Column(Integer, nullable=True)
    server_address = Column(String(100), nullable=True)
    port = Column(Integer, nullable=True)
    auth_key = Column(LargeBinary, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class TransferProgress(Base):
    """Tracks per-table transfer progress for SQLite → MySQL migration. Local-only."""
    __tablename__ = 'transfer_progress'

    id = Column(Integer, primary_key=True)
    table_name = Column(String(100), nullable=False, unique=True)
    total_rows = Column(Integer, default=0)
    transferred_rows = Column(Integer, default=0)
    last_transferred_id = Column(Integer, default=0)
    status = Column(String(20), default='pending')
    target_url = Column(String(500), nullable=True)
    started_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
