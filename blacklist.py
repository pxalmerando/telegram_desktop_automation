"""Blacklist: in-memory set + async DB persistence.

Tracks "account X already sent feature Y to user Z" without hitting DB
on every message check.  Bulk-loaded at startup, flushed to MySQL in
background batches.
"""
import threading
import logging
import time
from collections import deque
from datetime import datetime

logger = logging.getLogger(__name__)

# ---------- In-memory store ----------
# Key: "{feature}:{account_id}"   Value: set of chat_id (int)
_store = {}
_lock = threading.Lock()

# ---------- Write-ahead queue ----------
# Each entry: (account_id, chat_id, feature, created_at)
_pending = deque()
_pending_lock = threading.Lock()

# ---------- Config ----------
FLUSH_INTERVAL_S = 5
FLUSH_BATCH_SIZE = 500

# ---------- Stats ----------
_stats_loaded = 0
_stats_flushed = 0


def _make_key(account_id, feature):
    return f"{feature}:{account_id}"


# ==================== PUBLIC API ====================

def has_sent(account_id, chat_id, feature='cta'):
    """O(1) in-memory check. No DB query. Thread-safe."""
    key = _make_key(account_id, feature)
    chat_id = int(chat_id)
    with _lock:
        bucket = _store.get(key)
        if bucket is None:
            return False
        return chat_id in bucket


def mark_sent(account_id, chat_id, feature='cta'):
    """Immediate in-memory mark + queue async DB write. Thread-safe."""
    key = _make_key(account_id, feature)
    chat_id = int(chat_id)
    now = datetime.utcnow()

    with _lock:
        if key not in _store:
            _store[key] = set()
        bucket = _store[key]
        if chat_id in bucket:
            return  # Already marked, skip duplicate queue entry
        bucket.add(chat_id)

    # Queue for DB persistence (outside _lock to minimize contention)
    with _pending_lock:
        _pending.append((account_id, chat_id, feature, now))


def load_from_db():
    """Bulk SELECT at startup to populate in-memory set. Returns count loaded."""
    global _stats_loaded
    from database import SessionLocal
    from sqlalchemy import text

    count = 0
    try:
        rows = SessionLocal.execute(
            text("SELECT account_id, chat_id, feature FROM blacklist_entries")
        ).fetchall()

        with _lock:
            _store.clear()
            for account_id, chat_id, feature in rows:
                key = _make_key(account_id, feature)
                if key not in _store:
                    _store[key] = set()
                _store[key].add(int(chat_id))
                count += 1

        _stats_loaded = count
        logger.info(f"Blacklist loaded {count} entries from DB")
    except Exception as e:
        logger.error(f"Blacklist load_from_db failed: {e}")
    finally:
        SessionLocal.remove()

    return count


def migrate_from_cta_sent():
    """One-time migration: copy cta_sent=True rows from telegram_chats to blacklist_entries."""
    from database import SessionLocal
    from config import IS_SQLITE
    from sqlalchemy import text

    try:
        if IS_SQLITE:
            stmt = text(
                "INSERT OR IGNORE INTO blacklist_entries (account_id, chat_id, feature, created_at) "
                "SELECT account_id, chat_id, 'cta', datetime('now') "
                "FROM telegram_chats WHERE cta_sent = 1"
            )
        else:
            stmt = text(
                "INSERT IGNORE INTO blacklist_entries (account_id, chat_id, feature, created_at) "
                "SELECT account_id, chat_id, 'cta', NOW() "
                "FROM telegram_chats WHERE cta_sent = 1"
            )
        result = SessionLocal.execute(stmt)
        SessionLocal.commit()
        count = result.rowcount
        if count:
            logger.info(f"Blacklist migrated {count} existing cta_sent entries")
        return count
    except Exception as e:
        SessionLocal.rollback()
        logger.warning(f"Blacklist migration from cta_sent skipped: {e}")
        return 0
    finally:
        SessionLocal.remove()


def start_flush_thread():
    """Start background daemon that batch-writes queued entries to DB."""
    t = threading.Thread(target=_flush_loop, daemon=True, name="blacklist-flush")
    t.start()
    logger.info(f"Blacklist flush thread started (interval={FLUSH_INTERVAL_S}s)")
    return t


def get_stats():
    """Return counts per feature for monitoring."""
    with _lock:
        per_feature = {}
        total = 0
        for key, bucket in _store.items():
            feature = key.split(":", 1)[0]
            size = len(bucket)
            per_feature[feature] = per_feature.get(feature, 0) + size
            total += size

    with _pending_lock:
        pending_count = len(_pending)

    return {
        'total_entries': total,
        'per_feature': per_feature,
        'pending_flush': pending_count,
        'total_loaded_at_startup': _stats_loaded,
        'total_flushed': _stats_flushed,
    }


# ==================== INTERNAL ====================

def _flush_loop():
    """Background loop: drain _pending deque and batch INSERT into DB."""
    while True:
        time.sleep(FLUSH_INTERVAL_S)
        try:
            _flush_batch()
        except Exception as e:
            logger.error(f"Blacklist flush error: {e}")


def _flush_batch():
    """Drain up to FLUSH_BATCH_SIZE entries from _pending and write to DB."""
    global _stats_flushed
    from database import SessionLocal
    from sqlalchemy import text

    # Drain queue
    batch = []
    with _pending_lock:
        for _ in range(min(FLUSH_BATCH_SIZE, len(_pending))):
            batch.append(_pending.popleft())

    if not batch:
        return

    try:
        from config import IS_SQLITE
        if IS_SQLITE:
            stmt = text(
                "INSERT OR IGNORE INTO blacklist_entries "
                "(account_id, chat_id, feature, created_at) "
                "VALUES (:account_id, :chat_id, :feature, :created_at)"
            )
        else:
            stmt = text(
                "INSERT IGNORE INTO blacklist_entries "
                "(account_id, chat_id, feature, created_at) "
                "VALUES (:account_id, :chat_id, :feature, :created_at)"
            )
        for account_id, chat_id, feature, created_at in batch:
            SessionLocal.execute(stmt, {
                'account_id': account_id,
                'chat_id': chat_id,
                'feature': feature,
                'created_at': created_at,
            })
        SessionLocal.commit()
        _stats_flushed += len(batch)
        logger.debug(f"Blacklist flushed {len(batch)} entries")
    except Exception as e:
        SessionLocal.rollback()
        logger.error(f"Blacklist flush DB write failed ({len(batch)} entries): {e}")
        # Re-queue failed entries at the front so they're retried
        with _pending_lock:
            for item in reversed(batch):
                _pending.appendleft(item)
    finally:
        SessionLocal.remove()
