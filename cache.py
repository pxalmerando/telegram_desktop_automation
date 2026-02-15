"""In-memory cache replacing Redis — thread-safe, single-process desktop app."""
import threading
import time
import json
import logging
import fnmatch

logger = logging.getLogger(__name__)
_lock = threading.Lock()

# Chat metadata: {account_id: {chat_id_str: {title, unread_count, ...}}}
_chat_meta = {}

# Message buffers: {"account_id:chat_id": [msg_dict, ...]} (newest first, max 50)
_chat_msgs = {}

# Total unread per account: {account_id: int}
_total_unread = {}

# Incoming message count per chat: {"account_id:chat_id": int}
_msg_count_incoming = {}

# Generic TTL cache: {key: (value, expire_timestamp)}
_ttl_cache = {}


# --- Generic cache (replaces Redis cache_get/cache_set/cache_delete) ---

def cache_get(key):
    with _lock:
        entry = _ttl_cache.get(key)
        if entry is None:
            return None
        value, expires = entry
        if time.time() > expires:
            del _ttl_cache[key]
            return None
        return value


def cache_set(key, value, ttl=300):
    with _lock:
        _ttl_cache[key] = (value, time.time() + ttl)


def cache_delete(*keys):
    with _lock:
        for pattern in keys:
            if '*' in pattern:
                to_del = [k for k in _ttl_cache if fnmatch.fnmatch(k, pattern)]
                for k in to_del:
                    del _ttl_cache[k]
            else:
                _ttl_cache.pop(pattern, None)


# --- Chat metadata ---

def set_chat_meta(account_id, chat_id, data):
    chat_id = str(chat_id)
    with _lock:
        if account_id not in _chat_meta:
            _chat_meta[account_id] = {}
        _chat_meta[account_id][chat_id] = data


def get_chat_meta(account_id, chat_id):
    chat_id = str(chat_id)
    with _lock:
        return _chat_meta.get(account_id, {}).get(chat_id)


def get_all_chat_meta(account_id):
    with _lock:
        return dict(_chat_meta.get(account_id, {}))


def delete_chat_meta(account_id):
    with _lock:
        _chat_meta.pop(account_id, None)


# --- Message buffers ---

def push_chat_msg(account_id, chat_id, msg_dict):
    key = f"{account_id}:{chat_id}"
    with _lock:
        if key not in _chat_msgs:
            _chat_msgs[key] = []
        _chat_msgs[key].insert(0, msg_dict)
        _chat_msgs[key] = _chat_msgs[key][:50]


def get_chat_msgs(account_id, chat_id, limit=50):
    key = f"{account_id}:{chat_id}"
    with _lock:
        return list(_chat_msgs.get(key, [])[:limit])


# --- Unread counts ---

def get_total_unread(account_id):
    with _lock:
        return _total_unread.get(account_id, 0)


def set_total_unread(account_id, value):
    with _lock:
        _total_unread[account_id] = max(0, value)


def incr_total_unread(account_id, amount=1):
    with _lock:
        _total_unread[account_id] = _total_unread.get(account_id, 0) + amount


def decr_total_unread(account_id, amount=1):
    with _lock:
        _total_unread[account_id] = max(0, _total_unread.get(account_id, 0) - amount)


# --- Incoming message counters ---

def get_incoming_count(account_id, chat_id):
    key = f"{account_id}:{chat_id}"
    with _lock:
        return _msg_count_incoming.get(key, 0)


def incr_incoming_count(account_id, chat_id, amount=1):
    key = f"{account_id}:{chat_id}"
    with _lock:
        _msg_count_incoming[key] = _msg_count_incoming.get(key, 0) + amount


# --- Per-chat automation state ---
# Tracks CTA progress, photo plan, namecard state, etc. per chat.

_chat_state = {}

_DEFAULT_CHAT_STATE = {
    "message_count": 0,
    "cta_started": False,
    "cta_running": False,
    "cta_step": 0,
    "photo_plan": [],
    "photo_idx": 0,
    "sent_photos": [],
    "opener_photo_sent": False,
    "mismatch_explained": False,
    "personalized_name": "",
    "personalized_media_path": "",
    "personalized_media_ready": False,
    "personalized_media_sent": False,
    "ask_name_next": False,
}


def get_chat_state(account_id, chat_id):
    key = f"{account_id}:{chat_id}"
    with _lock:
        if key not in _chat_state:
            _chat_state[key] = dict(_DEFAULT_CHAT_STATE)
        return dict(_chat_state[key])


def set_chat_state(account_id, chat_id, state):
    key = f"{account_id}:{chat_id}"
    with _lock:
        _chat_state[key] = dict(state)


def update_chat_state(account_id, chat_id, **kwargs):
    key = f"{account_id}:{chat_id}"
    with _lock:
        if key not in _chat_state:
            _chat_state[key] = dict(_DEFAULT_CHAT_STATE)
        _chat_state[key].update(kwargs)
