#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterable, Iterator

_LOG = logging.getLogger("weflow.sync")


# ---------------------------------------------------------------------------
# Official-service / public-account classifier.
#
# This function is intentionally duplicated here instead of being imported
# from a sibling module: the macOS installer copies a single ``sync_agent.py``
# file alongside a ``.env`` and runs it directly with the system Python, so
# the installed agent does NOT have access to a ``server`` package. Reusing
# the implementation would silently break the installed copy with a
# ModuleNotFoundError the first time ``sync_once`` ran.
#
# The rule itself is strict and narrow on purpose: only the *username* field
# is inspected, never ``displayName`` (which a contact or group owner can set
# arbitrarily). A session is treated as an official / public-account chat iff
# its username starts with the WeChat public-account prefix ``gh_`` (case
# insensitive) or contains the substring ``@openim`` (case insensitive).
# Plain wxid/chatroom/email-style usernames are *never* filtered out.
def is_official_service_session(username: str | None) -> bool:
    """Return True iff *username* identifies a WeChat public account or
    other backend service that should not be mirrored to the cloud.

    The rule deliberately looks at the canonical session identifier
    (``username``) only — not at ``displayName``, which can be set by users
    and is therefore not a reliable signal.
    """

    if not username:
        return False
    value = str(username).strip().lower()
    if not value:
        return False
    if value.startswith("gh_"):
        return True
    return "@openim" in value


# Local-API error codes that the sync agent must treat as "this single
# session is unavailable, continue with the rest". Network / auth failures
# are intentionally *not* in this set: they should bubble up so the caller
# (and the run-forever loop) can decide whether to back off or stop.
_LOCAL_SESSION_UNAVAILABLE_FRAGMENTS = (
    "消息数据库未找到",
    "message database not found",
    "database not found",
)


def _is_session_unavailable_error(error: BaseException) -> bool:
    """Return True iff *error* means "this one session's data is gone"."""

    if not isinstance(error, ApiError):
        return False
    message = str(error)
    if " -3" in message or "(-3)" in message:
        return True
    return any(fragment in message for fragment in _LOCAL_SESSION_UNAVAILABLE_FRAGMENTS)


# Media helpers ----------------------------------------------------------------
#
# The cloud mirror mirrors *only* WeChat's custom-emoji media. Two
# different shapes in the local WeFlow payload identify the same
# thing:
#
# * ``mediaType == "emoji"`` in the API JSON envelope, or
# * ``localType == 47`` (WeChat's internal enum value for custom
#   emoji) when the envelope doesn't carry the explicit mediaType
#   string. This dual shape is why we can't pick a single key.

def _is_emoji_message(message: dict[str, Any]) -> bool:
    """Return True iff *message* is a custom-emoji media item that
    must be downloaded and uploaded to the cloud."""
    if not isinstance(message, dict):
        return False
    media_type = str(message.get("mediaType") or "").strip().lower()
    if media_type == "emoji":
        return True
    try:
        local_type = int(message.get("localType") or 0)
    except (TypeError, ValueError):
        local_type = 0
    return local_type == 47


# Map of URL file extension to the content type we should declare when
# uploading. We deliberately keep this list short — anything we don't
# recognise falls through to ``image/png`` as a safe default because
# the *server* will reject unknown types via its own whitelist.
_MEDIA_CONTENT_TYPE_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


def _content_type_from_url(url: str) -> str:
    """Best-effort content type lookup by URL extension. Falls back to
    ``image/png`` so callers always have a valid value to send."""
    try:
        path = urllib.parse.urlparse(str(url or "")).path.lower()
    except ValueError:
        path = ""
    for ext, content_type in _MEDIA_CONTENT_TYPE_BY_EXT.items():
        if path.endswith(ext):
            return content_type
    return "image/png"


def _default_port(scheme: str) -> int | None:
    if scheme == "http":
        return 80
    if scheme == "https":
        return 443
    return None


def _resolve_same_origin(base_url: str, target: str) -> str:
    """Resolve *target* against *base_url* and verify the result is
    same-origin (scheme + host + port). Raises ``ValueError`` if the
    target would escape the configured local origin.

    The local API's Bearer token is privileged and must never be
    forwarded to a third party; this helper is the single chokepoint
    that decides whether a media fetch is allowed to proceed."""
    if not target:
        raise ValueError("media URL is empty")
    absolute = urllib.parse.urljoin(base_url, str(target))
    base = urllib.parse.urlparse(base_url)
    resolved = urllib.parse.urlparse(absolute)
    if resolved.scheme not in {"http", "https"}:
        raise ValueError("media URL must use http or https")
    if not resolved.hostname:
        raise ValueError("media URL is missing a host")
    if base.scheme != resolved.scheme:
        raise ValueError("media URL scheme does not match local base")
    if base.hostname != resolved.hostname:
        raise ValueError("media URL host does not match local base")
    base_port = base.port if base.port is not None else _default_port(base.scheme)
    resolved_port = resolved.port if resolved.port is not None else _default_port(resolved.scheme)
    if base_port != resolved_port:
        raise ValueError("media URL port does not match local base")
    return absolute


def parse_sse_events(lines: Iterable[bytes]) -> Iterator[dict[str, Any]]:
    event_name = "message"
    data_lines: list[str] = []
    for raw_line in lines:
        line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
        if not line:
            if data_lines:
                try:
                    payload = json.loads("\n".join(data_lines))
                except json.JSONDecodeError:
                    payload = None
                if isinstance(payload, dict):
                    if event_name not in {"message", "ready"}:
                        payload["event"] = event_name
                    yield payload
            event_name = "message"
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if field == "event":
            event_name = value.strip() or "message"
        elif field == "data":
            data_lines.append(value)


class ApiError(RuntimeError):
    pass


@dataclass
class JsonHttpClient:
    base_url: str
    bearer_token: str
    timeout: float = 30.0

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")
        if not self.base_url.startswith(("http://", "https://")):
            raise ValueError("base_url must use http or https")
        if not self.bearer_token:
            raise ValueError("bearer token is required")

    def request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        if query:
            url += "?" + urllib.parse.urlencode({key: value for key, value in query.items() if value is not None})
        data = None if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self.bearer_token}",
                "User-Agent": "WeFlow-Cloud-Sync/1.0",
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout, context=ssl.create_default_context()) as response:
                body = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:800]
            raise ApiError(f"{method} {path} failed: HTTP {error.code} {detail}") from error
        except urllib.error.URLError as error:
            raise ApiError(f"{method} {path} failed: {error.reason}") from error
        try:
            parsed = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ApiError(f"{method} {path} returned invalid JSON") from error
        if not isinstance(parsed, dict):
            raise ApiError(f"{method} {path} returned an invalid payload")
        return parsed


class LocalWeFlowClient:
    def __init__(self, base_url: str, token: str, page_limit: int = 1000):
        self.http = JsonHttpClient(base_url, token, timeout=60)
        self.page_limit = max(1, min(5000, page_limit))

    def list_sessions(self) -> list[dict[str, Any]]:
        payload = self.http.request_json("GET", "/api/v1/sessions", query={"limit": 10000})
        sessions = payload.get("sessions")
        return [item for item in sessions if isinstance(item, dict)] if isinstance(sessions, list) else []

    def list_messages(self, session_id: str, *, start: int, limit: int) -> dict[str, Any]:
        messages: list[dict[str, Any]] = []
        offset = 0
        has_more = True
        page_limit = max(1, min(self.page_limit, limit))
        while has_more:
            payload = self.http.request_json(
                "GET",
                "/api/v1/messages",
                query={
                    "talker": session_id,
                    "start": max(0, start),
                    "limit": page_limit,
                    "offset": offset,
                    "media": 1,
                },
            )
            batch = payload.get("messages")
            batch = [item for item in batch if isinstance(item, dict)] if isinstance(batch, list) else []
            messages.extend(batch)
            has_more = payload.get("hasMore") is True and len(batch) > 0
            offset += len(batch)
        return {"messages": messages, "hasMore": False}

    def fetch_media(self, media_url: str) -> bytes:
        """Download a media asset from the local WeFlow API.

        The local API is reached over the loopback interface and its
        Bearer token is privileged; this method therefore enforces a
        strict same-origin policy on *media_url* before issuing any
        request. Absolute URLs that point to a different scheme, host
        or port than ``self.http.base_url`` are rejected with
        ``ValueError`` *before* ``urlopen`` is called, so a malicious
        mediaUrl in a chat message can never cause the token to be
        forwarded to a third-party host."""
        absolute = _resolve_same_origin(self.http.base_url, media_url)
        request = urllib.request.Request(
            absolute,
            headers={
                "Authorization": f"Bearer {self.http.bearer_token}",
                "User-Agent": "WeFlow-Cloud-Sync/1.0",
            },
        )
        try:
            with urllib.request.urlopen(
                request,
                timeout=self.http.timeout,
                context=ssl.create_default_context(),
            ) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            # 404 and similar are surfaced as ``FileNotFoundError`` so
            # the caller's per-message error handling can keep going.
            if error.code == 404 or error.code == 410:
                raise FileNotFoundError(media_url) from error
            raise ApiError(f"local media fetch failed: HTTP {error.code}") from error
        except urllib.error.URLError as error:
            raise ApiError(f"local media fetch failed: {error.reason}") from error

    def event_stream(self) -> Iterator[dict[str, Any]]:
        token = urllib.parse.quote(self.http.bearer_token, safe="")
        request = urllib.request.Request(
            f"{self.http.base_url}/api/v1/push/messages?access_token={token}",
            headers={"Accept": "text/event-stream", "User-Agent": "WeFlow-Cloud-Sync/1.0"},
        )
        with urllib.request.urlopen(request, timeout=90) as response:
            yield from parse_sse_events(response)


class CloudMirrorClient:
    def __init__(self, base_url: str, token: str):
        self.http = JsonHttpClient(base_url, token, timeout=90)

    def sync_state(self) -> dict[str, dict[str, Any]]:
        payload = self.http.request_json("GET", "/api/v1/sync/state")
        sessions = payload.get("sessions")
        if not isinstance(sessions, list):
            return {}
        return {
            str(item.get("sessionId")): item
            for item in sessions
            if isinstance(item, dict) and item.get("sessionId")
        }

    def push_sessions(self, sessions: list[dict[str, Any]]) -> None:
        self.http.request_json("POST", "/api/v1/sync/sessions", {"sessions": sessions})

    def push_messages(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        if messages:
            self.http.request_json(
                "POST",
                "/api/v1/sync/messages",
                {"sessionId": session_id, "messages": messages},
            )

    def push_events(self, events: list[dict[str, Any]]) -> None:
        if events:
            self.http.request_json("POST", "/api/v1/sync/events", {"events": events})

    def upload_media(self, data: bytes, content_type: str) -> dict[str, Any]:
        """Upload a single media asset to the cloud and return the
        JSON envelope the server hands back. The payload is base64'd
        server-side anyway, so we send it as ``dataBase64`` + the
        content type + the SHA-256 the server is expected to verify."""
        if not isinstance(data, (bytes, bytearray)):
            raise TypeError("media data must be bytes")
        encoded = base64.b64encode(bytes(data)).decode("ascii")
        sha = hashlib.sha256(bytes(data)).hexdigest()
        return self.http.request_json(
            "POST",
            "/api/v1/sync/media",
            {"dataBase64": encoded, "contentType": content_type, "sha256": sha},
        )

    def purge_official_sessions(self) -> dict[str, int]:
        """One-shot cleanup of legacy official / public-account rows
        on the cloud side. Returns the deletion counts as a dict."""
        payload = self.http.request_json("POST", "/api/v1/sync/purge-official")
        return {
            "sessions": int(payload.get("sessions", 0) or 0),
            "messages": int(payload.get("messages", 0) or 0),
            "events": int(payload.get("events", 0) or 0),
        }


class SyncAgent:
    def __init__(
        self,
        local_client: Any,
        cloud_client: Any,
        *,
        bootstrap_seconds: int = 30 * 24 * 60 * 60,
        batch_limit: int = 1000,
        media_batch_limit: int = 20,
        media_total_bytes: int = 50 * 1024 * 1024,
    ):
        self.local = local_client
        self.cloud = cloud_client
        self.bootstrap_seconds = max(60, bootstrap_seconds)
        self.batch_limit = max(1, min(5000, batch_limit))
        self.media_batch_limit = max(1, media_batch_limit)
        self.media_total_bytes = max(1024, media_total_bytes)
        self._sync_lock = threading.Lock()
        self._first_sync_purge_done = False

    def _maybe_purge_official_sessions(self) -> None:
        """Run the cloud's official-session purge exactly once per
        process. The cleanup is idempotent server-side, but skipping
        it on subsequent rounds saves an HTTP call *and* protects
        freshly-ingested public-account sessions (which the cloud
        stops accepting anyway) from being repeatedly re-deleted."""
        if self._first_sync_purge_done:
            return
        try:
            counts = self.cloud.purge_official_sessions()
        except AttributeError:
            # The cloud client doesn't support purge (e.g. an older
            # deployment or a mock in a test) — treat that as a no-op
            # so the rest of the sync still proceeds.
            self._first_sync_purge_done = True
            return
        _LOG.info(
            "first-sync purge of official / public-account rows: %s",
            {"sessions": counts.get("sessions", 0), "messages": counts.get("messages", 0), "events": counts.get("events", 0)},
        )
        self._first_sync_purge_done = True

    def _process_message_media(
        self,
        message: dict[str, Any],
        *,
        uploaded: list[dict[str, Any]],
        skipped: list[dict[str, Any]],
        bytes_used: list[int],
    ) -> dict[str, Any]:
        """Return a copy of *message* with its ``mediaUrl`` updated.

        Emoji messages with a non-empty mediaUrl are downloaded from
        the local WeFlow, uploaded to the cloud and the placeholder
        URL is replaced with the cloud URL. Emoji messages with no
        URL, or whose URL 404s locally, are kept but their mediaUrl
        is cleared so the web UI knows to skip rendering. Network
        errors other than 404 bubble up so the run-forever loop can
        back off and retry the whole round."""
        cloned = dict(message)
        if not _is_emoji_message(message):
            cloned.setdefault("mediaUrl", "")
            return cloned
        original_url = str(message.get("mediaUrl") or "").strip()
        if not original_url:
            skipped.append(message)
            cloned["mediaUrl"] = ""
            return cloned
        if len(uploaded) >= self.media_batch_limit:
            skipped.append(message)
            cloned["mediaUrl"] = ""
            return cloned
        if sum(bytes_used) >= self.media_total_bytes:
            skipped.append(message)
            cloned["mediaUrl"] = ""
            return cloned
        try:
            data = self.local.fetch_media(original_url)
        except FileNotFoundError:
            # The local WeFlow lost the asset (deleted chat, rolled
            # database, ...). Count it and keep the text in the cloud
            # but drop the broken URL.
            skipped.append(message)
            cloned["mediaUrl"] = ""
            _LOG.warning(
                "skipping media: local media endpoint returned 404 "
                "for one emoji message"
            )
            return cloned
        # fetch_media raises ApiError for non-404 HTTP / network
        # errors; let those propagate so the caller can decide.
        content_type = _content_type_from_url(original_url)
        result = self.cloud.upload_media(data, content_type)
        cloud_url = str(result.get("url") or "").strip()
        if not cloud_url:
            # Server accepted the bytes but didn't return a URL —
            # treat this as a hard error rather than silently dropping
            # the asset.
            raise ApiError(
                "cloud upload_media returned an empty url; "
                "the server response was incomplete"
            )
        uploaded.append({"message": message, "url": cloud_url, "size": len(data)})
        bytes_used.append(len(data))
        cloned["mediaUrl"] = cloud_url
        return cloned

    def sync_once(self, *, now: int | None = None) -> dict[str, int]:
        if not self._sync_lock.acquire(blocking=False):
            return {"sessions": 0, "messages": 0, "skippedSessions": 0, "uploadedMedia": 0, "skippedMedia": 0}
        try:
            self._maybe_purge_official_sessions()
            current_time = int(now if now is not None else time.time())
            sessions = self.local.list_sessions()
            accepted_sessions = [
                session for session in sessions
                if not is_official_service_session(
                    str(session.get("username") or session.get("sessionId") or "")
                )
            ]
            self.cloud.push_sessions(accepted_sessions)
            cloud_state = self.cloud.sync_state()
            message_count = 0
            skipped = 0
            uploaded_media: list[dict[str, Any]] = []
            skipped_media: list[dict[str, Any]] = []
            bytes_used: list[int] = []
            for session in accepted_sessions:
                session_id = str(session.get("username") or "").strip()
                if not session_id:
                    continue
                existing = cloud_state.get(session_id, {})
                max_message_time = int(existing.get("maxMessageTime") or 0)
                start = max_message_time if max_message_time > 0 else max(0, current_time - self.bootstrap_seconds)
                try:
                    result = self.local.list_messages(session_id, start=start, limit=self.batch_limit)
                except Exception as error:  # noqa: BLE001 - per-session policy
                    if _is_session_unavailable_error(error):
                        skipped += 1
                        # NOTE: the session id is intentionally *not* emitted in
                        # the log: it can be a real wxid we don't want to leak
                        # to stderr, where log aggregators tend to scrape freely.
                        _LOG.warning(
                            "skipping session: local API reported unavailable "
                            "message database for one session (error code: -3 or "
                            "semantic equivalent)"
                        )
                        continue
                    raise
                messages = result.get("messages") if isinstance(result, dict) else []
                messages = [item for item in messages if isinstance(item, dict)] if isinstance(messages, list) else []
                processed: list[dict[str, Any]] = []
                for message in messages:
                    processed.append(
                        self._process_message_media(
                            message,
                            uploaded=uploaded_media,
                            skipped=skipped_media,
                            bytes_used=bytes_used,
                        )
                    )
                self.cloud.push_messages(session_id, processed)
                message_count += len(processed)
            return {
                "sessions": len(accepted_sessions),
                "messages": message_count,
                "skippedSessions": skipped,
                "uploadedMedia": len(uploaded_media),
                "skippedMedia": len(skipped_media),
            }
        finally:
            self._sync_lock.release()

    def forward_event(self, event: dict[str, Any]) -> None:
        if event.get("event") in {"message.new", "message.revoke"}:
            self.cloud.push_events([event])


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


def run_forever(agent: SyncAgent, local_client: LocalWeFlowClient, sync_interval: int) -> None:
    stop_event = threading.Event()

    def periodic_sync() -> None:
        while not stop_event.is_set():
            try:
                result = agent.sync_once()
                print(
                    f"[sync] sessions={result['sessions']} messages={result['messages']}",
                    flush=True,
                )
            except Exception as error:
                print(f"[sync] failed: {error}", file=sys.stderr, flush=True)
            stop_event.wait(sync_interval)

    worker = threading.Thread(target=periodic_sync, daemon=True)
    worker.start()
    backoff = 2
    try:
        while True:
            try:
                print("[sse] connecting to local WeFlow", flush=True)
                for event in local_client.event_stream():
                    if event.get("event") == "ready":
                        continue
                    agent.forward_event(event)
                backoff = 2
            except Exception as error:
                print(f"[sse] disconnected: {error}; retry in {backoff}s", file=sys.stderr, flush=True)
                time.sleep(backoff)
                backoff = min(60, backoff * 2)
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        worker.join(timeout=3)


def main() -> None:
    local = LocalWeFlowClient(
        os.environ.get("WEFLOW_LOCAL_URL", "http://127.0.0.1:5031"),
        _required_env("WEFLOW_LOCAL_API_TOKEN"),
        page_limit=int(os.environ.get("WEFLOW_SYNC_PAGE_LIMIT", "1000")),
    )
    cloud = CloudMirrorClient(
        _required_env("WEFLOW_CLOUD_URL"),
        _required_env("WEFLOW_CLOUD_SYNC_TOKEN"),
    )
    bootstrap_days = max(1, int(os.environ.get("WEFLOW_BOOTSTRAP_DAYS", "30")))
    agent = SyncAgent(
        local,
        cloud,
        bootstrap_seconds=bootstrap_days * 24 * 60 * 60,
        batch_limit=int(os.environ.get("WEFLOW_SYNC_BATCH_LIMIT", "1000")),
    )
    run_forever(agent, local, max(10, int(os.environ.get("WEFLOW_SYNC_INTERVAL", "30"))))


if __name__ == "__main__":
    main()
