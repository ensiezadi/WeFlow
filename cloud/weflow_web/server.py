#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import hmac
import json
import mimetypes
import os
import queue
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


# ---- Password verifier (PBKDF2-HMAC-SHA256, random salt per record) ----

PASSWORD_VERIFIER_KEY = "auth.password_verifier"
AUTH_GENERATION_KEY = "auth.generation"
PASSWORD_VERIFIER_VERSION = 1
PBKDF2_ALGORITHM = "pbkdf2_hmac_sha256"
PBKDF2_DEFAULT_ITERATIONS = 310_000
PBKDF2_SALT_BYTES = 16
PBKDF2_HASH_BYTES = 32
MIN_PASSWORD_LENGTH = 12


class PasswordVerifier:
    """Stateless PBKDF2 verifier used to compare plaintext passwords safely.

    Each call to :meth:`create` generates a fresh, cryptographically random
    salt so that the same password produces a different stored record each
    time. Verification runs in constant time relative to ``iterations``.
    """

    def __init__(self, iterations: int = PBKDF2_DEFAULT_ITERATIONS):
        if iterations < 310_000:
            raise ValueError("PBKDF2 iteration count must be at least 310000")
        self.iterations = iterations

    def create(self, password: str) -> dict[str, Any]:
        if not isinstance(password, str) or not password:
            raise ValueError("password must be a non-empty string")
        salt = secrets.token_bytes(PBKDF2_SALT_BYTES)
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt,
            self.iterations,
            dklen=PBKDF2_HASH_BYTES,
        )
        return {
            "algorithm": PBKDF2_ALGORITHM,
            "version": PASSWORD_VERIFIER_VERSION,
            "iterations": self.iterations,
            "salt": base64.b64encode(salt).decode("ascii"),
            "hash": base64.b64encode(digest).decode("ascii"),
        }

    def verify(self, password: str, record: dict[str, Any] | None) -> bool:
        if not record or not isinstance(password, str):
            return False
        try:
            algorithm = str(record.get("algorithm") or "")
            iterations = int(record.get("iterations") or 0)
            salt = base64.b64decode(str(record.get("salt") or ""))
            stored = base64.b64decode(str(record.get("hash") or ""))
        except (TypeError, ValueError):
            return False
        if algorithm != PBKDF2_ALGORITHM or iterations <= 0 or not salt or not stored:
            return False
        candidate = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt,
            iterations,
            dklen=len(stored),
        )
        return hmac.compare_digest(candidate, stored)


def _safe_int(value: Any, default: int = 0, minimum: int = 0, maximum: int = 2**63 - 1) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def _message_key(session_id: str, message: dict[str, Any]) -> str:
    server_id = str(message.get("serverId") or message.get("rawid") or "").strip()
    if server_id and server_id != "0":
        return f"{session_id}:server:{server_id}"
    local_id = str(message.get("localId") or "").strip()
    create_time = str(message.get("createTime") or message.get("timestamp") or "0").strip()
    if local_id:
        return f"{session_id}:local:{local_id}:{create_time}"
    digest = hashlib.sha256(
        json.dumps(message, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:32]
    return f"{session_id}:hash:{digest}"


# Strict, username-based classification. Display names are intentionally
# ignored so that the rule never confuses a human contact or a renamed
# group with an official / WeChat Open IM service.
_OFFICIAL_SERVICE_PREFIX = "gh_"
_OFFICIAL_SERVICE_SUBSTR = "@openim"


def is_official_service_session(session_id: Any) -> bool:
    """Return True iff the given identifier is an official / Open IM service.

    The check is intentionally strict: a session is excluded only when its
    username starts with the ``gh_`` prefix **or** contains ``@openim``.
    Group chats (``...@chatroom``), normal wxids (``wxid_...``) and any other
    identifier that merely contains letters like ``gh`` are left alone.
    """

    value = str(session_id or "").strip().lower()
    if not value:
        return False
    if value.startswith(_OFFICIAL_SERVICE_PREFIX):
        return True
    if _OFFICIAL_SERVICE_SUBSTR in value:
        return True
    return False


class CloudStore:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(str(db_path), check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._connection:
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=NORMAL")
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    username TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL DEFAULT '',
                    session_type TEXT NOT NULL DEFAULT 'other',
                    last_timestamp INTEGER NOT NULL DEFAULT 0,
                    unread_count INTEGER NOT NULL DEFAULT 0,
                    preview TEXT NOT NULL DEFAULT '',
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    message_key TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    server_id TEXT NOT NULL DEFAULT '',
                    local_id TEXT NOT NULL DEFAULT '',
                    create_time INTEGER NOT NULL DEFAULT 0,
                    is_send INTEGER NOT NULL DEFAULT 0,
                    sender_username TEXT NOT NULL DEFAULT '',
                    content TEXT,
                    media_type TEXT NOT NULL DEFAULT '',
                    media_url TEXT NOT NULL DEFAULT '',
                    revoked INTEGER NOT NULL DEFAULT 0,
                    payload_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_session_time
                    ON messages(session_id, create_time, message_key);
                CREATE INDEX IF NOT EXISTS idx_messages_server
                    ON messages(session_id, server_id);
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_name TEXT NOT NULL,
                    session_id TEXT NOT NULL DEFAULT '',
                    payload_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                """
            )

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def upsert_sessions(self, sessions: list[dict[str, Any]]) -> int:
        now = int(time.time())
        written = 0
        with self._lock, self._connection:
            for session in sessions:
                username = str(session.get("username") or session.get("sessionId") or "").strip()
                if not username or is_official_service_session(username):
                    continue
                display_name = str(session.get("displayName") or session.get("name") or username).strip()
                session_type = str(session.get("sessionType") or session.get("type") or "other").strip()
                last_timestamp = _safe_int(session.get("lastTimestamp"), 0)
                unread_count = _safe_int(session.get("unreadCount"), 0, 0, 1_000_000)
                preview = str(session.get("preview") or session.get("lastMessage") or "").strip()[:1000]
                self._connection.execute(
                    """
                    INSERT INTO sessions(username, display_name, session_type, last_timestamp, unread_count, preview, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(username) DO UPDATE SET
                        display_name = excluded.display_name,
                        session_type = excluded.session_type,
                        last_timestamp = MAX(sessions.last_timestamp, excluded.last_timestamp),
                        unread_count = excluded.unread_count,
                        preview = CASE WHEN excluded.preview != '' THEN excluded.preview ELSE sessions.preview END,
                        updated_at = excluded.updated_at
                    """,
                    (username, display_name, session_type, last_timestamp, unread_count, preview, now),
                )
                written += 1
        return written

    def list_sessions(self, keyword: str = "", limit: int = 500) -> list[dict[str, Any]]:
        keyword = keyword.strip()
        pattern = f"%{keyword}%"
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT username, display_name, session_type, last_timestamp, unread_count, preview
                FROM sessions
                WHERE (? = '' OR username LIKE ? OR display_name LIKE ?)
                ORDER BY last_timestamp DESC, updated_at DESC
                LIMIT ?
                """,
                (keyword, pattern, pattern, limit),
            ).fetchall()
        return [
            {
                "username": row["username"],
                "displayName": row["display_name"],
                "sessionType": row["session_type"],
                "lastTimestamp": row["last_timestamp"],
                "unreadCount": row["unread_count"],
                "preview": row["preview"],
            }
            for row in rows
        ]

    def upsert_messages(self, session_id: str, messages: list[dict[str, Any]]) -> int:
        session_id = str(session_id or "").strip()
        if not session_id or is_official_service_session(session_id):
            return 0
        now = int(time.time())
        written = 0
        newest_time = 0
        newest_preview = ""
        with self._lock, self._connection:
            for source in messages:
                message = dict(source)
                create_time = _safe_int(message.get("createTime") or message.get("timestamp"), 0)
                server_id = str(message.get("serverId") or message.get("rawid") or "").strip()
                local_id = str(message.get("localId") or "").strip()
                content_value = message.get("content")
                content = None if content_value is None else str(content_value)
                is_send = 1 if _safe_int(message.get("isSend"), 0) == 1 else 0
                sender_username = str(message.get("senderUsername") or message.get("sourceName") or "").strip()
                media_type = str(message.get("mediaType") or "").strip()
                media_url = str(message.get("mediaUrl") or "").strip()
                key = _message_key(session_id, message)
                message["sessionId"] = session_id
                message["messageKey"] = key
                self._connection.execute(
                    """
                    INSERT INTO messages(
                        message_key, session_id, server_id, local_id, create_time, is_send,
                        sender_username, content, media_type, media_url, revoked, payload_json, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(message_key) DO UPDATE SET
                        server_id = excluded.server_id,
                        local_id = excluded.local_id,
                        create_time = excluded.create_time,
                        is_send = excluded.is_send,
                        sender_username = excluded.sender_username,
                        content = excluded.content,
                        media_type = excluded.media_type,
                        media_url = excluded.media_url,
                        payload_json = excluded.payload_json,
                        updated_at = excluded.updated_at
                    """,
                    (
                        key, session_id, server_id, local_id, create_time, is_send,
                        sender_username, content, media_type, media_url, 0,
                        json.dumps(message, ensure_ascii=False, separators=(",", ":")), now,
                    ),
                )
                written += 1
                if create_time >= newest_time:
                    newest_time = create_time
                    newest_preview = (content or f"[{media_type or '消息'}]")[:1000]
            if messages:
                self._connection.execute(
                    """
                    INSERT INTO sessions(username, display_name, last_timestamp, preview, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(username) DO UPDATE SET
                        last_timestamp = MAX(sessions.last_timestamp, excluded.last_timestamp),
                        preview = CASE WHEN excluded.last_timestamp >= sessions.last_timestamp THEN excluded.preview ELSE sessions.preview END,
                        updated_at = excluded.updated_at
                    """,
                    (session_id, session_id, newest_time, newest_preview, now),
                )
        return written

    def list_messages(self, session_id: str, limit: int = 200, offset: int = 0) -> dict[str, Any]:
        with self._lock:
            total = self._connection.execute(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?", (session_id,)
            ).fetchone()[0]
            rows = self._connection.execute(
                """
                SELECT payload_json, revoked
                FROM messages
                WHERE session_id = ?
                ORDER BY create_time DESC, message_key DESC
                LIMIT ? OFFSET ?
                """,
                (session_id, limit, offset),
            ).fetchall()
        messages: list[dict[str, Any]] = []
        for row in reversed(rows):
            payload = json.loads(row["payload_json"])
            payload["revoked"] = bool(row["revoked"])
            messages.append(payload)
        return {
            "success": True,
            "talker": session_id,
            "count": len(messages),
            "hasMore": offset + len(rows) < total,
            "messages": messages,
        }

    def apply_events(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        now = int(time.time())
        accepted: list[dict[str, Any]] = []
        with self._lock, self._connection:
            for source in events:
                event = dict(source)
                event_name = str(event.get("event") or "message.new").strip()
                session_id = str(event.get("sessionId") or "").strip()
                if not session_id or is_official_service_session(session_id) or event_name not in {"message.new", "message.revoke"}:
                    continue
                if event_name == "message.new":
                    mapped = {
                        "rawid": event.get("rawid"),
                        "serverId": event.get("rawid"),
                        "createTime": event.get("timestamp"),
                        "timestamp": event.get("timestamp"),
                        "isSend": event.get("isSend", 0),
                        "senderUsername": event.get("sourceName", ""),
                        "content": event.get("content"),
                    }
                    self.upsert_messages(session_id, [mapped])
                else:
                    rawid = str(event.get("rawid") or "").strip()
                    if rawid:
                        self._connection.execute(
                            "UPDATE messages SET revoked = 1, updated_at = ? WHERE session_id = ? AND server_id = ?",
                            (now, session_id, rawid),
                        )
                self._connection.execute(
                    "INSERT INTO events(event_name, session_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
                    (event_name, session_id, json.dumps(event, ensure_ascii=False, separators=(",", ":")), now),
                )
                accepted.append(event)
        return accepted

    def _get_setting(self, key: str) -> str | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT value FROM settings WHERE key = ?", (key,)
            ).fetchone()
        return row["value"] if row else None

    def _set_setting(self, key: str, value: str) -> None:
        now = int(time.time())
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """,
                (key, value, now),
            )

    def get_password_verifier(self) -> dict[str, Any] | None:
        raw = self._get_setting(PASSWORD_VERIFIER_KEY)
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None

    def set_password_verifier(self, record: dict[str, Any]) -> None:
        self._set_setting(PASSWORD_VERIFIER_KEY, json.dumps(record, ensure_ascii=False, separators=(",", ":")))

    def clear_password_verifier(self) -> None:
        with self._lock, self._connection:
            self._connection.execute("DELETE FROM settings WHERE key = ?", (PASSWORD_VERIFIER_KEY,))

    def get_auth_generation(self) -> int:
        raw = self._get_setting(AUTH_GENERATION_KEY)
        if not raw:
            return 1
        try:
            return max(1, int(raw))
        except ValueError:
            return 1

    def bump_auth_generation(self) -> int:
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at
                """,
                (AUTH_GENERATION_KEY, "1", int(time.time())),
            )
            row = self._connection.execute(
                "SELECT value FROM settings WHERE key = ?", (AUTH_GENERATION_KEY,)
            ).fetchone()
        return max(1, int(row["value"])) if row else 1

    def rotate_password_verifier(self, new_record: dict[str, Any]) -> int:
        """Atomically replace the password verifier and bump the auth
        generation. The two writes happen inside a single SQLite
        transaction so that, if anything raises in between, neither
        change is persisted and the old verifier / old generation stay
        active.

        Returns the *new* auth generation.

        Generation semantics intentionally match the legacy
        ``bump_auth_generation`` behaviour: a fresh DB starts at
        generation 2 (so that a freshly-issued cookie, which is signed
        with the default generation 1 read from ``get_auth_generation``,
        is invalidated by the first password rotation).
        """

        if not isinstance(new_record, dict):
            raise TypeError("new_record must be a dict")
        now = int(time.time())
        payload = json.dumps(new_record, ensure_ascii=False, separators=(",", ":"))
        with self._lock, self._connection:
            current = self._connection.execute(
                "SELECT value FROM settings WHERE key = ?", (AUTH_GENERATION_KEY,)
            ).fetchone()
            # The first rotation goes 1 -> 2 so that cookies signed at
            # boot (gen=1) are immediately invalidated.
            if current is None:
                new_generation = 2
            else:
                new_generation = max(2, int(current["value"])) + 1
            self._connection.execute(
                """
                INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """,
                (PASSWORD_VERIFIER_KEY, payload, now),
            )
            self._connection.execute(
                """
                INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """,
                (AUTH_GENERATION_KEY, str(new_generation), now),
            )
        return new_generation

    def sync_state(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT s.username, s.last_timestamp, COUNT(m.message_key) AS message_count,
                       COALESCE(MAX(m.create_time), 0) AS max_message_time
                FROM sessions s
                LEFT JOIN messages m ON m.session_id = s.username
                GROUP BY s.username, s.last_timestamp
                """
            ).fetchall()
        return [
            {
                "sessionId": row["username"],
                "lastTimestamp": row["last_timestamp"],
                "messageCount": row["message_count"],
                "maxMessageTime": row["max_message_time"],
            }
            for row in rows
        ]

    def purge_official_sessions(self) -> dict[str, int]:
        """Delete every session that is an official / Open IM service along
        with its messages and its events, and return a per-table count of
        what was removed.

        The match is intentionally strict and identical to the rule used
        on the ingestion side (``is_official_service_session``): only a
        ``username``/``session_id`` starting with ``gh_`` (case
        insensitive) or containing ``@openim`` is treated as official.
        Plain wxids, group chats, and identifiers that merely contain
        the letters ``gh`` or the substring ``openim`` are left alone.
        The whole purge runs inside a single transaction so a failure
        in the middle cannot leave a half-cleaned DB behind.
        """

        with self._lock, self._connection:
            # We prefilter in Python against the existing strict helper so
            # the rule stays in one place; an empty result short-circuits
            # the SQL cascade without ever touching the database.
            all_rows = self._connection.execute("SELECT username FROM sessions").fetchall()
            official_ids = [
                row["username"] for row in all_rows
                if is_official_service_session(row["username"])
            ]
            if not official_ids:
                return {"sessions": 0, "messages": 0, "events": 0}

            placeholders = ",".join("?" for _ in official_ids)
            cur = self._connection.execute(
                f"DELETE FROM sessions WHERE username IN ({placeholders})",
                official_ids,
            )
            deleted_sessions = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
            cur = self._connection.execute(
                f"DELETE FROM messages WHERE session_id IN ({placeholders})",
                official_ids,
            )
            deleted_messages = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
            cur = self._connection.execute(
                f"DELETE FROM events WHERE session_id IN ({placeholders})",
                official_ids,
            )
            deleted_events = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        return {
            "sessions": deleted_sessions,
            "messages": deleted_messages,
            "events": deleted_events,
        }


class EventBroker:
    def __init__(self):
        self._clients: set[queue.Queue[dict[str, Any]]] = set()
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue[dict[str, Any]]:
        channel: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=200)
        with self._lock:
            self._clients.add(channel)
        return channel

    def unsubscribe(self, channel: queue.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._clients.discard(channel)

    def publish(self, event: dict[str, Any]) -> None:
        with self._lock:
            clients = list(self._clients)
        for channel in clients:
            try:
                channel.put_nowait(event)
            except queue.Full:
                try:
                    channel.get_nowait()
                    channel.put_nowait(event)
                except (queue.Empty, queue.Full):
                    pass


class LoginRateLimiter:
    def __init__(self, max_failures: int = 5, window_seconds: int = 15 * 60):
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self._failures: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, key: str, now: float) -> list[float]:
        cutoff = now - self.window_seconds
        return [timestamp for timestamp in self._failures.get(key, []) if timestamp >= cutoff]

    def is_blocked(self, key: str, now: float | None = None) -> bool:
        current = time.time() if now is None else now
        with self._lock:
            recent = self._recent(key, current)
            self._failures[key] = recent
            return len(recent) >= self.max_failures

    def record_failure(self, key: str, now: float | None = None) -> None:
        current = time.time() if now is None else now
        with self._lock:
            recent = self._recent(key, current)
            recent.append(current)
            self._failures[key] = recent

    def clear(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)


@dataclass(frozen=True)
class ServerConfig:
    static_dir: Path
    sync_token: str
    session_secret: str
    session_ttl_seconds: int = 7 * 24 * 60 * 60
    # One-shot plaintext seed used only when the DB has no password
    # verifier yet. Never persisted: we hash it (PBKDF2) and store only
    # the hash, salt, iterations, and algorithm identifier. ``main()``
    # leaves this empty and reads ``WEFLOW_WEB_PASSWORD`` from the
    # environment instead so that plaintext never enters the process
    # arguments of the long-running server.
    initial_password_seed: str = ""
    # On-disk directory where uploaded emoji media files are stored.
    # Defaults to ``<db_dir>/media`` in tests and embedded callers; main()
    # honors ``WEFLOW_MEDIA_DIR`` and falls back to ``/data/media`` so the
    # existing persistent volume backs the media store too. The directory
    # is auto-created on first upload with restrictive permissions; the
    # GET /media handler serves files from this directory only.
    media_dir: Path = Path("")


# MIME types that we are willing to mirror from the desktop sync agent.
# Anything outside this whitelist (e.g. SVG, executables, HTML) is rejected
# at the API boundary so a malicious local WeFlow could not use us as a
# file-store pivot.
ALLOWED_MEDIA_EXTENSIONS: dict[str, str] = {
    ".gif": "image/gif",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
# Maximum decoded payload size for a single emoji upload. Anything above
# 10 MiB is rejected — the local WeFlow emoji media we have observed in
# the wild is well under 1 MiB per file, and a hard cap protects the
# server's persistent volume from accidental or malicious filling.
MAX_MEDIA_BYTES = 10 * 1024 * 1024


class WeFlowCloudServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], store: CloudStore, config: ServerConfig):
        self.store = store
        self.config = config
        self.broker = EventBroker()
        self.login_limiter = LoginRateLimiter()
        self.password_verifier = PasswordVerifier()
        # Make sure the media directory exists before the listening
        # socket is opened. We never expose anything from this directory
        # directly; the GET /media handler validates the hash + extension
        # and serves only files placed by the /api/v1/sync/media endpoint.
        # ``create_server`` / ``main`` are responsible for picking a
        # non-empty value; a missing value is a programmer error and we
        # surface it loudly here rather than papering over it.
        if not self.config.media_dir:
            raise ValueError("ServerConfig.media_dir must be set")
        self.config.media_dir.mkdir(parents=True, exist_ok=True)
        # Seed the DB verifier on first boot. The seed may come from the
        # ``ServerConfig.initial_password_seed`` parameter (used by tests
        # and embedded callers) or from the ``WEFLOW_WEB_PASSWORD``
        # environment variable (used by ``main()``).
        #
        # The server is fail-closed: if the DB has no verifier and no
        # seed is available, we refuse to start — otherwise the operator
        # would deploy a service that no one could ever log in to. A
        # re-deploy against an existing DB with a verifier already in
        # place is allowed to come up without any seed.
        if self.store.get_password_verifier() is None:
            seed = (
                self.config.initial_password_seed
                or os.environ.get("WEFLOW_WEB_PASSWORD", "")
            ).strip()
            if not seed:
                raise ValueError(
                    "Refusing to start without a password: no verifier in the "
                    "database and WEFLOW_WEB_PASSWORD (or the web_password= "
                    "kwarg) was not provided. Set WEFLOW_WEB_PASSWORD to a "
                    "strong initial password before the first launch, or "
                    "restore the existing database which already has a "
                    "verifier configured."
                )
            self.store.set_password_verifier(self.password_verifier.create(seed))
        super().__init__(address, WeFlowCloudHandler)

    def server_close(self) -> None:
        super().server_close()
        self.store.close()


class WeFlowCloudHandler(BaseHTTPRequestHandler):
    server: WeFlowCloudServer
    protocol_version = "HTTP/1.1"
    max_body_size = 25 * 1024 * 1024

    def log_message(self, fmt: str, *args: Any) -> None:
        if os.environ.get("WEFLOW_ACCESS_LOG", "1") != "0":
            super().log_message(fmt, *args)

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; "
            "media-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )

    def _send_bytes(self, status: int, body: bytes, content_type: str, extra_headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: dict[str, Any], extra_headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8", extra_headers)

    def _read_json(self) -> dict[str, Any] | None:
        length = _safe_int(self.headers.get("Content-Length"), 0, 0, self.max_body_size + 1)
        if length <= 0 or length > self.max_body_size:
            return None
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def _has_sync_auth(self) -> bool:
        expected = self.server.config.sync_token.encode("utf-8")
        header = self.headers.get("Authorization", "")
        supplied = header[7:].strip().encode("utf-8") if header.lower().startswith("bearer ") else b""
        return bool(expected and supplied and hmac.compare_digest(expected, supplied))

    def _session_token(self, expires_at: int, generation: int) -> str:
        nonce = secrets.token_urlsafe(18)
        payload = f"{expires_at}.{generation}.{nonce}"
        signature = hmac.new(
            self.server.config.session_secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        return f"{payload}.{signature}"

    def _has_web_auth(self) -> bool:
        cookie_header = self.headers.get("Cookie", "")
        if not cookie_header:
            return False
        cookie = SimpleCookie()
        try:
            cookie.load(cookie_header)
        except Exception:
            return False
        morsel = cookie.get("weflow_session")
        if morsel is None:
            return False
        parts = morsel.value.split(".")
        if len(parts) != 4:
            return False
        expires_raw, generation_raw, nonce, supplied_signature = parts
        expires_at = _safe_int(expires_raw, 0)
        if expires_at <= int(time.time()):
            return False
        generation = _safe_int(generation_raw, 0)
        if generation != self.server.store.get_auth_generation():
            return False
        payload = f"{expires_raw}.{generation_raw}.{nonce}"
        expected_signature = hmac.new(
            self.server.config.session_secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(expected_signature, supplied_signature)

    def _require_sync_auth(self) -> bool:
        if self._has_sync_auth():
            return True
        self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "Unauthorized sync client"})
        return False

    def _require_web_auth(self) -> bool:
        if self._has_web_auth():
            return True
        self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "Login required"})
        return False

    def _client_key(self) -> str:
        forwarded = self.headers.get("CF-Connecting-IP", "").strip()
        return forwarded or str(self.client_address[0])

    def _serve_static(self, pathname: str) -> bool:
        routes = {
            "/": "index.html",
            "/index.html": "index.html",
            "/web": "index.html",
            "/web/": "index.html",
            "/web/app.js": "app.js",
            "/web/styles.css": "styles.css",
        }
        name = routes.get(pathname)
        if not name:
            return False
        full_path = (self.server.config.static_dir / name).resolve()
        if full_path.parent != self.server.config.static_dir.resolve() or not full_path.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Static asset not found"})
            return True
        content_type = mimetypes.guess_type(full_path.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type += "; charset=utf-8"
        self._send_bytes(HTTPStatus.OK, full_path.read_bytes(), content_type)
        return True

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        pathname = unquote(parsed.path)
        query = parse_qs(parsed.query)
        if self._serve_static(pathname):
            return
        if pathname == "/health" or pathname == "/api/v1/health":
            self._send_json(HTTPStatus.OK, {"status": "ok", "mode": "read-only"})
            return
        if pathname == "/api/v1/sync/state":
            if not self._require_sync_auth():
                return
            self._send_json(HTTPStatus.OK, {"success": True, "sessions": self.server.store.sync_state()})
            return
        if pathname == "/api/v1/sessions":
            if not self._require_web_auth():
                return
            keyword = str(query.get("keyword", [""])[0])
            limit = _safe_int(query.get("limit", [500])[0], 500, 1, 2000)
            sessions = self.server.store.list_sessions(keyword, limit)
            self._send_json(HTTPStatus.OK, {"success": True, "count": len(sessions), "sessions": sessions})
            return
        if pathname == "/api/v1/messages":
            if not self._require_web_auth():
                return
            talker = str(query.get("talker", [""])[0]).strip()
            if not talker:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Missing talker"})
                return
            limit = _safe_int(query.get("limit", [200])[0], 200, 1, 1000)
            offset = _safe_int(query.get("offset", [0])[0], 0, 0, 2**31 - 1)
            self._send_json(HTTPStatus.OK, self.server.store.list_messages(talker, limit, offset))
            return
        if pathname == "/api/v1/push/messages":
            if not self._require_web_auth():
                return
            self._serve_sse()
            return
        if pathname.startswith("/media/"):
            self._serve_media(pathname)
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def _serve_media(self, pathname: str) -> None:
        """Serve a previously uploaded emoji file by ``<sha256>.<ext>``.

        Authentication is a strict web cookie — never the sync Bearer,
        which exists only to ingest new files. The hash component is
        validated against ``[0-9a-f]{64}`` and the extension against
        the ``ALLOWED_MEDIA_EXTENSIONS`` whitelist. We also resolve the
        requested path and verify it lives directly under the configured
        ``media_dir`` so a crafted request like ``/media/..%2Fserver.py``
        can never escape the media directory.
        """
        if not self._has_web_auth():
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "Login required"})
            return
        # Strip the leading "/media/" exactly once and split on the
        # last dot so multi-dot names ("a.png.bak") are still rejected
        # by the extension whitelist.
        tail = pathname[len("/media/"):]
        if not tail or "/" in tail or "\\" in tail:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Media not found"})
            return
        stem, dot, ext = tail.rpartition(".")
        if not dot or not stem or not ext:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Media not found"})
            return
        # Hash must be lowercase hex of length 64.
        if len(stem) != 64 or any(c not in "0123456789abcdef" for c in stem):
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Media not found"})
            return
        ext_lower = "." + ext.lower()
        if ext_lower not in ALLOWED_MEDIA_EXTENSIONS:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Media not found"})
            return
        target = (self.server.config.media_dir / f"{stem}{ext_lower}").resolve()
        media_root = self.server.config.media_dir.resolve()
        if target.parent != media_root or not target.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Media not found"})
            return
        body = target.read_bytes()
        # We hash the bytes on the way out too: if a file is found at
        # the requested path but its bytes don't actually match the
        # hash in the URL, treat the whole thing as a miss so a
        # half-overwritten file (broken atomic write) is never served.
        if hashlib.sha256(body).hexdigest() != stem:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Media not found"})
            return
        self.send_response(HTTPStatus.OK)
        self._security_headers()
        self.send_header("Content-Type", ALLOWED_MEDIA_EXTENSIONS[ext_lower])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "private, max-age=300")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        pathname = unquote(urlparse(self.path).path)
        payload = self._read_json()
        if payload is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON body"})
            return
        if pathname == "/api/v1/auth/login":
            client_key = self._client_key()
            if self.server.login_limiter.is_blocked(client_key):
                self._send_json(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    {"error": "登录尝试过多，请稍后再试"},
                    {"Retry-After": str(self.server.login_limiter.window_seconds)},
                )
                return
            supplied = str(payload.get("password") or "")
            record = self.server.store.get_password_verifier()
            if not supplied or not self.server.password_verifier.verify(supplied, record):
                self.server.login_limiter.record_failure(client_key)
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "密码错误"})
                return
            self.server.login_limiter.clear(client_key)
            generation = self.server.store.get_auth_generation()
            expires_at = int(time.time()) + self.server.config.session_ttl_seconds
            cookie = (
                f"weflow_session={self._session_token(expires_at, generation)}; Path=/; Max-Age={self.server.config.session_ttl_seconds}; "
                "HttpOnly; Secure; SameSite=Strict"
            )
            self._send_json(HTTPStatus.OK, {"success": True}, {"Set-Cookie": cookie})
            return
        if pathname == "/api/v1/auth/logout":
            self._send_json(
                HTTPStatus.OK,
                {"success": True},
                {"Set-Cookie": "weflow_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"},
            )
            return
        if pathname == "/api/v1/auth/change-password":
            if not self._has_web_auth():
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "Login required"})
                return
            current_password = str(payload.get("currentPassword") or "")
            new_password = str(payload.get("newPassword") or "")
            record = self.server.store.get_password_verifier()
            if not current_password or not self.server.password_verifier.verify(current_password, record):
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "当前密码错误"})
                return
            if len(new_password) < MIN_PASSWORD_LENGTH:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": f"新密码至少需要 {MIN_PASSWORD_LENGTH} 个字符"},
                )
                return
            if new_password == current_password:
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {"error": "新密码不能与当前密码相同"},
                )
                return
            new_record = self.server.password_verifier.create(new_password)
            # ``rotate_password_verifier`` writes the new PBKDF2 hash and
            # bumps the auth generation inside a single SQLite transaction,
            # so the cookie signed with the old generation can't be used to
            # authenticate against a verifier the server hasn't yet committed.
            self.server.store.rotate_password_verifier(new_record)
            clearing_cookie = (
                "weflow_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"
            )
            self._send_json(
                HTTPStatus.OK,
                {"success": True},
                {"Set-Cookie": clearing_cookie},
            )
            return
        if pathname == "/api/v1/sync/sessions":
            if not self._require_sync_auth():
                return
            sessions = payload.get("sessions")
            if not isinstance(sessions, list):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "sessions must be a list"})
                return
            written = self.server.store.upsert_sessions([item for item in sessions if isinstance(item, dict)])
            self._send_json(HTTPStatus.OK, {"success": True, "written": written})
            return
        if pathname == "/api/v1/sync/messages":
            if not self._require_sync_auth():
                return
            session_id = str(payload.get("sessionId") or "").strip()
            messages = payload.get("messages")
            if not session_id or not isinstance(messages, list):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "sessionId and messages are required"})
                return
            written = self.server.store.upsert_messages(session_id, [item for item in messages if isinstance(item, dict)])
            self._send_json(HTTPStatus.OK, {"success": True, "written": written})
            return
        if pathname == "/api/v1/sync/events":
            if not self._require_sync_auth():
                return
            events = payload.get("events")
            if not isinstance(events, list):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "events must be a list"})
                return
            accepted = self.server.store.apply_events([item for item in events if isinstance(item, dict)])
            for event in accepted:
                self.server.broker.publish(event)
            self._send_json(HTTPStatus.OK, {"success": True, "accepted": len(accepted)})
            return
        if pathname == "/api/v1/sync/purge-official":
            if not self._require_sync_auth():
                return
            counts = self.server.store.purge_official_sessions()
            # ``success`` plus the per-table counts let the operator
            # audit the cleanup without having to cross-reference logs.
            self._send_json(HTTPStatus.OK, {"success": True, **counts})
            return
        if pathname == "/api/v1/sync/media":
            if not self._require_sync_auth():
                return
            self._ingest_media(payload)
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def _ingest_media(self, payload: dict[str, Any]) -> None:
        """Validate and persist one emoji media file under
        ``<media_dir>/<sha256>.<ext>``.

        The body must carry a base64-encoded ``dataBase64``, the
        client-reported ``contentType``, and the lowercase hex
        ``sha256`` of the decoded bytes. The decoded payload must be
        under ``MAX_MEDIA_BYTES`` and its extension/content-type must
        fall inside ``ALLOWED_MEDIA_EXTENSIONS``. The hash is verified
        *before* anything touches disk so a single garbage upload
        never produces a half-written file. The file is written
        atomically via ``os.replace`` so a concurrent reader never sees
        a truncated or empty file. ``Ingested``/``duplicate`` runs
        return the same response shape.
        """
        if not isinstance(payload, dict):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid media payload"})
            return
        encoded = payload.get("dataBase64")
        content_type = str(payload.get("contentType") or "").strip().lower()
        sha = str(payload.get("sha256") or "").strip().lower()
        if not isinstance(encoded, str) or not content_type or not sha:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Missing dataBase64/contentType/sha256"})
            return
        if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid sha256"})
            return
        # Map the content type back to the canonical extension. We
        # support only the formats in ``ALLOWED_MEDIA_EXTENSIONS`` —
        # anything else is rejected before we spend CPU on the
        # base64 decode.
        ext_for_type = next(
            (ext for ext, mime in ALLOWED_MEDIA_EXTENSIONS.items() if mime == content_type),
            None,
        )
        if ext_for_type is None:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Unsupported content type"})
            return
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError, binascii.Error):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid base64 payload"})
            return
        if not decoded:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Empty payload"})
            return
        if len(decoded) > MAX_MEDIA_BYTES:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Payload too large"})
            return
        actual_sha = hashlib.sha256(decoded).hexdigest()
        if actual_sha != sha:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "SHA-256 mismatch"})
            return
        target = self.server.config.media_dir / f"{sha}{ext_for_type}"
        existed = target.is_file()
        if not existed:
            # ``os.replace`` is atomic on POSIX; we write to a temp
            # file in the same directory so the rename is a single
            # inode swap with no chance of cross-device copy.
            tmp = target.with_suffix(target.suffix + ".tmp")
            with tmp.open("wb") as handle:
                handle.write(decoded)
            os.replace(tmp, target)
        self._send_json(
            HTTPStatus.OK,
            {
                "success": True,
                "sha256": sha,
                "contentType": ALLOWED_MEDIA_EXTENSIONS[ext_for_type],
                "url": f"/media/{sha}{ext_for_type}",
                "duplicate": existed,
            },
        )

    def _serve_sse(self) -> None:
        channel = self.server.broker.subscribe()
        self.send_response(HTTPStatus.OK)
        self._security_headers()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            self.wfile.write(b"event: ready\ndata: {\"success\":true}\n\n")
            self.wfile.flush()
            while True:
                try:
                    event = channel.get(timeout=25)
                    event_name = str(event.get("event") or "message.new")
                    body = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
                    self.wfile.write(f"event: {event_name}\ndata: {body}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        finally:
            self.server.broker.unsubscribe(channel)


def create_server(
    host: str,
    port: int,
    db_path: Path,
    static_dir: Path,
    sync_token: str,
    web_password: str | None = None,
    session_secret: str = "",
    *,
    media_dir: str | os.PathLike[str] | None = None,
) -> WeFlowCloudServer:
    if not sync_token or not session_secret:
        raise ValueError("sync token and session secret are required")
    static_dir = static_dir.resolve()
    if not static_dir.is_dir():
        raise ValueError(f"static directory not found: {static_dir}")
    # Pick the media directory. ``WEFLOW_MEDIA_DIR`` overrides
    # everything when set; otherwise we fall back to a sibling of the
    # SQLite DB so the persistent volume that already holds the
    # database also backs the emoji store. The default of
    # ``/data/media`` (used by the Docker compose) is provided by
    # ``main()``; tests and embedded callers can pass ``media_dir=``
    # explicitly to pin the location.
    if media_dir is None:
        media_dir = os.environ.get("WEFLOW_MEDIA_DIR") or (Path(db_path).parent / "media")
    return WeFlowCloudServer(
        (host, port),
        CloudStore(db_path),
        ServerConfig(
            static_dir=static_dir,
            sync_token=sync_token,
            session_secret=session_secret,
            initial_password_seed=(web_password or ""),
            media_dir=Path(media_dir),
        ),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="WeFlow read-only cloud mirror")
    parser.add_argument("--host", default=os.environ.get("WEFLOW_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WEFLOW_PORT", "8080")))
    parser.add_argument("--db", default=os.environ.get("WEFLOW_DB_PATH", "/data/weflow.sqlite3"))
    parser.add_argument(
        "--static-dir",
        default=os.environ.get(
            "WEFLOW_STATIC_DIR",
            str(Path(__file__).resolve().parent / "web"),
        ),
    )
    parser.add_argument(
        "--media-dir",
        default=os.environ.get("WEFLOW_MEDIA_DIR", "/data/media"),
    )
    args = parser.parse_args()
    server = create_server(
        args.host,
        args.port,
        Path(args.db),
        Path(args.static_dir),
        os.environ.get("WEFLOW_SYNC_TOKEN", ""),
        os.environ.get("WEFLOW_WEB_PASSWORD", "") or None,
        os.environ.get("WEFLOW_SESSION_SECRET", ""),
        media_dir=args.media_dir,
    )
    print(f"WeFlow cloud mirror listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
