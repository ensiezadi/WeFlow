import base64
import hashlib
import importlib.util
import inspect
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sync_agent import (
    ApiError,
    CloudMirrorClient,
    LocalWeFlowClient,
    SyncAgent,
    is_official_service_session,
    parse_sse_events,
)


class FakeLocalClient:
    def __init__(self):
        self.message_calls = []

    def list_sessions(self):
        return [
            {"username": "alice", "displayName": "Alice", "lastTimestamp": 120},
            {"username": "bob", "displayName": "Bob", "lastTimestamp": 80},
        ]

    def list_messages(self, session_id, *, start, limit):
        self.message_calls.append((session_id, start, limit))
        return {
            "messages": [{"serverId": f"{session_id}-1", "createTime": start + 1, "content": session_id}],
            "hasMore": False,
        }


class FakeCloudClient:
    def __init__(self):
        self.sessions = []
        self.message_batches = []
        self.events = []

    def sync_state(self):
        return {"alice": {"maxMessageTime": 100}}

    def push_sessions(self, sessions):
        self.sessions.extend(sessions)

    def push_messages(self, session_id, messages):
        self.message_batches.append((session_id, messages))

    def push_events(self, events):
        self.events.extend(events)


class SyncAgentTests(unittest.TestCase):
    def test_sync_uses_cloud_watermark_and_recent_bootstrap_for_new_sessions(self):
        local = FakeLocalClient()
        cloud = FakeCloudClient()
        agent = SyncAgent(local, cloud, bootstrap_seconds=7 * 24 * 60 * 60, batch_limit=500)

        result = agent.sync_once(now=1_000_000)

        self.assertEqual(result["sessions"], 2)
        self.assertEqual(local.message_calls, [
            ("alice", 100, 500),
            ("bob", 1_000_000 - 7 * 24 * 60 * 60, 500),
        ])
        self.assertEqual([batch[0] for batch in cloud.message_batches], ["alice", "bob"])

    def test_sync_once_requests_media_flag_set_to_one(self):
        """`LocalWeFlowClient.list_messages` must call the local API with
        media=1 so the response includes ``mediaUrl`` for emoji rows.
        The previous default (media=0) silently dropped every emoji
        and broke the cloud mirror's preview rendering."""

        class CapturingClient:
            def __init__(self):
                self.calls = []

            def request_json(self, method, path, payload=None, query=None):
                self.calls.append((method, path, dict(query or {})))
                return {"messages": [], "hasMore": False}

        http_stub = CapturingClient()
        local = LocalWeFlowClient.__new__(LocalWeFlowClient)
        local.http = http_stub  # type: ignore[assignment]
        local.page_limit = 1000
        local.list_messages("alice", start=0, limit=10)
        self.assertEqual(http_stub.calls[0][0], "GET")
        self.assertEqual(http_stub.calls[0][1], "/api/v1/messages")
        self.assertEqual(http_stub.calls[0][2].get("media"), 1)

    def test_sse_event_is_forwarded_to_cloud(self):
        cloud = FakeCloudClient()
        agent = SyncAgent(FakeLocalClient(), cloud)
        event = {"event": "message.new", "sessionId": "alice", "rawid": "7", "content": "hello"}

        agent.forward_event(event)

        self.assertEqual(cloud.events, [event])

    def test_sse_parser_preserves_named_event(self):
        lines = [
            b"event: message.revoke\n",
            b"data: {\"sessionId\":\"alice\",\"rawid\":\"7\"}\n",
            b"\n",
        ]

        self.assertEqual(list(parse_sse_events(lines)), [{
            "event": "message.revoke",
            "sessionId": "alice",
            "rawid": "7",
        }])

    def test_official_sessions_are_filtered_before_cloud_upload(self):
        class FilterLocalClient:
            def list_sessions(self):
                return [
                    {"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 100},
                    {"username": "gh_ghost", "displayName": "Ghost", "lastTimestamp": 200},
                    {"username": "bot@openim.io", "displayName": "Bot", "lastTimestamp": 300},
                    {"username": "12345@chatroom", "displayName": "Group", "lastTimestamp": 400},
                ]

            def list_messages(self, session_id, *, start, limit):
                return {"messages": [], "hasMore": False}

        class FilterCloudClient(FakeCloudClient):
            def __init__(self):
                super().__init__()
                self.state_map = {}

            def sync_state(self):
                return self.state_map

        local = FilterLocalClient()
        cloud = FilterCloudClient()
        agent = SyncAgent(local, cloud)

        result = agent.sync_once(now=2_000_000)

        self.assertEqual(result["sessions"], 2)
        uploaded = {s["username"] for s in cloud.sessions}
        self.assertEqual(uploaded, {"wxid_alice", "12345@chatroom"})
        message_session_ids = {batch[0] for batch in cloud.message_batches}
        self.assertEqual(message_session_ids, {"wxid_alice", "12345@chatroom"})
        self.assertNotIn("gh_ghost", message_session_ids)
        self.assertNotIn("bot@openim.io", message_session_ids)

    def test_sync_continues_when_single_session_reports_missing_message_db(self):
        class FlakyLocalClient:
            def list_sessions(self):
                return [
                    {"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 1},
                    {"username": "wxid_bob", "displayName": "Bob", "lastTimestamp": 2},
                    {"username": "wxid_carol", "displayName": "Carol", "lastTimestamp": 3},
                ]

            def list_messages(self, session_id, *, start, limit):
                if session_id == "wxid_bob":
                    raise ApiError("GET /api/v1/messages failed: 消息数据库未找到 (-3)")
                return {
                    "messages": [{"serverId": f"{session_id}-1", "createTime": 1, "content": session_id}],
                    "hasMore": False,
                }

        local = FlakyLocalClient()
        cloud = FakeCloudClient()
        agent = SyncAgent(local, cloud, batch_limit=100)

        result = agent.sync_once(now=5_000_000)

        self.assertEqual(result["sessions"], 3)
        self.assertEqual(result["skippedSessions"], 1)
        self.assertEqual(result["messages"], 2)
        uploaded = {batch[0] for batch in cloud.message_batches}
        self.assertEqual(uploaded, {"wxid_alice", "wxid_carol"})

    def test_sync_propagates_network_or_auth_errors(self):
        class NetworkLocalClient:
            def list_sessions(self):
                return [
                    {"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 1},
                ]

            def list_messages(self, session_id, *, start, limit):
                raise ApiError("connection refused")

        agent = SyncAgent(NetworkLocalClient(), FakeCloudClient())

        with self.assertRaises(ApiError) as context:
            agent.sync_once(now=1_000_000)
        self.assertIn("connection refused", str(context.exception))

    def test_sync_skipped_log_does_not_leak_session_id(self):
        class FlakyLocalClient:
            def list_sessions(self):
                return [
                    {"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 1},
                ]

            def list_messages(self, session_id, *, start, limit):
                raise ApiError("消息数据库未找到 (-3)")

        agent = SyncAgent(FlakyLocalClient(), FakeCloudClient())

        with self.assertLogs(level="WARNING") as captured:
            result = agent.sync_once(now=1_000_000)

        self.assertEqual(result["skippedSessions"], 1)
        joined = "\n".join(captured.output)
        self.assertNotIn("wxid_alice", joined)


class OfficialServiceSessionTests(unittest.TestCase):
    def test_gh_prefix_is_excluded(self):
        self.assertTrue(is_official_service_session("gh_abc123"))

    def test_openim_substring_is_excluded(self):
        self.assertTrue(is_official_service_session("bot@openim.io"))
        self.assertTrue(is_official_service_session("service@openim"))

    def test_normal_wxid_and_groups_are_kept(self):
        for username in [
            "wxid_abc123",
            "12345678@chatroom",
            "alice@example.com",
            "ghelper_wxid",
            "",
            "wxid_ghelper",
        ]:
            self.assertFalse(is_official_service_session(username), f"unexpectedly filtered: {username!r}")


class SyncAgentStandaloneImportTests(unittest.TestCase):
    """The macOS installer copies a single ``sync_agent.py`` next to a
    ``.env`` and runs it directly with the system Python. There is no
    ``server`` module on the target machine, so the agent must be a fully
    self-contained module that does not import anything from this package.
    """

    def test_sync_agent_imports_when_copied_into_an_isolated_directory(self):
        source = Path(__file__).with_name("sync_agent.py")
        self.assertTrue(source.is_file(), "sync_agent.py must exist next to this test")

        with tempfile.TemporaryDirectory() as tempdir:
            isolated = Path(tempdir) / "sync_agent.py"
            shutil.copy2(source, isolated)
            spec = importlib.util.spec_from_file_location("_isolated_sync_agent", isolated)
            self.assertIsNotNone(spec)
            module = importlib.util.module_from_spec(spec)
            # ``@dataclass`` looks the module up via ``sys.modules`` to inspect
            # type annotations, so the isolated copy must be registered there
            # before being executed.
            sys.modules["_isolated_sync_agent"] = module
            spec.loader.exec_module(module)  # type: ignore[union-attr]

            # The isolated copy must still expose the same public surface.
            self.assertTrue(callable(module.is_official_service_session))
            self.assertTrue(callable(module.SyncAgent))
            self.assertTrue(callable(module.parse_sse_events))

            # The classifier must be defined *inside* the module — it cannot
            # be re-exported from a sibling ``server`` module that wouldn't
            # be on the installed machine.
            source_file = Path(inspect.getfile(module.is_official_service_session)).resolve()
            self.assertEqual(source_file, isolated.resolve())

            # And it must classify exactly like the in-package copy.
            self.assertTrue(module.is_official_service_session("gh_abc"))
            self.assertTrue(module.is_official_service_session("bot@openim.io"))
            self.assertFalse(module.is_official_service_session("wxid_alice"))
            self.assertFalse(module.is_official_service_session("12345@chatroom"))

    def test_sync_agent_source_does_not_import_server_or_weflow_web_package(self):
        source = Path(__file__).with_name("sync_agent.py").read_text("utf-8")
        for forbidden in (
            "from server",
            "import server",
            "from weflow_web",
            "import weflow_web",
        ):
            self.assertNotIn(forbidden, source, f"sync_agent.py must not contain {forbidden!r}")


class LocalFetchMediaTests(unittest.TestCase):
    """``LocalWeFlowClient.fetch_media`` must only ever talk to the
    configured local base URL. A cross-origin ``https://cdn.example/...``
    must be rejected *before* any HTTP request is made — the local API
    Bearer token is privileged and must not be forwarded to a third
    party."""

    def _make_client(self) -> LocalWeFlowClient:
        # Build without going through __init__ so the test does not
        # accidentally hit the real network.
        client = LocalWeFlowClient.__new__(LocalWeFlowClient)
        client.page_limit = 1000
        client.http = mock.MagicMock()
        client.http.base_url = "http://127.0.0.1:5031"
        client.http.bearer_token = "secret-token"
        client.http.timeout = 5
        return client

    def test_relative_url_is_resolved_against_base(self):
        client = self._make_client()
        with mock.patch("sync_agent.urllib.request.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b"PNG-BYTES"
            data = client.fetch_media("/api/v1/media/emoji/abc.png")
        # Same-origin resolved target
        self.assertEqual(urlopen.call_args.args[0].full_url, "http://127.0.0.1:5031/api/v1/media/emoji/abc.png")
        # Bearer is sent for same-origin
        self.assertIn("Bearer secret-token", urlopen.call_args.args[0].headers.get("Authorization", ""))
        self.assertEqual(data, b"PNG-BYTES")

    def test_same_origin_absolute_url_is_allowed(self):
        client = self._make_client()
        with mock.patch("sync_agent.urllib.request.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b"OK"
            data = client.fetch_media("http://127.0.0.1:5031/api/v1/media/emoji/abc.png")
        self.assertEqual(data, b"OK")
        self.assertIn("Bearer secret-token", urlopen.call_args.args[0].headers.get("Authorization", ""))

    def test_cross_origin_url_is_rejected_without_request(self):
        client = self._make_client()
        with mock.patch("sync_agent.urllib.request.urlopen") as urlopen:
            with self.assertRaises(ValueError):
                client.fetch_media("https://cdn.example/abc.png")
        urlopen.assert_not_called()

    def test_cross_origin_with_matching_path_is_still_rejected(self):
        client = self._make_client()
        # Same path, different scheme: must still be rejected.
        with mock.patch("sync_agent.urllib.request.urlopen") as urlopen:
            with self.assertRaises(ValueError):
                client.fetch_media("https://127.0.0.1:5031/api/v1/media/emoji/abc.png")
        urlopen.assert_not_called()

    def test_cross_origin_different_port_is_rejected(self):
        client = self._make_client()
        with mock.patch("sync_agent.urllib.request.urlopen") as urlopen:
            with self.assertRaises(ValueError):
                client.fetch_media("http://127.0.0.1:8080/api/v1/media/emoji/abc.png")
        urlopen.assert_not_called()

    def test_protocol_relative_url_escapes_is_rejected(self):
        client = self._make_client()
        with mock.patch("sync_agent.urllib.request.urlopen") as urlopen:
            with self.assertRaises(ValueError):
                # ``urlopen`` would happily fetch this; the client must
                # refuse to forward the Bearer to an absolute URL it
                # cannot verify is same-origin.
                client.fetch_media("//cdn.example/abc.png")
        urlopen.assert_not_called()


class EmojiMediaSyncTests(unittest.TestCase):
    """``SyncAgent.sync_once`` must pick up emoji media, fetch the bytes
    safely from the local WeFlow, upload them to the cloud, and replace
    the placeholder ``mediaUrl`` with the cloud URL. 404 / missing URL
    on a single message must count as ``skippedMedia``, not as a sync
    failure. Network or auth errors from the cloud must propagate so
    the surrounding loop can decide whether to back off."""

    def _png(self) -> bytes:
        return base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg=="
        )

    def test_emoji_messages_are_uploaded_and_payload_url_is_replaced(self):
        png = self._png()
        sha = hashlib.sha256(png).hexdigest()

        class LocalWithEmoji:
            def __init__(self):
                self.fetch_calls = []

            def list_sessions(self):
                return [{"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 1}]

            def list_messages(self, session_id, *, start, limit):
                return {
                    "messages": [
                        {
                            "localId": 1,
                            "createTime": 100,
                            "content": "hi",
                            "mediaType": "emoji",
                            "mediaUrl": "/api/v1/media/emoji/abc.png",
                        },
                        {
                            "localId": 2,
                            "createTime": 101,
                            "content": "no-media-here",
                        },
                    ],
                    "hasMore": False,
                }

            def fetch_media(self, url):
                self.fetch_calls.append(url)
                return png

        class CloudWithMedia:
            def __init__(self):
                self.sessions = []
                self.message_batches = []
                self.uploads = []
                self.purges = 0

            def sync_state(self):
                return {}

            def push_sessions(self, sessions):
                self.sessions.extend(sessions)

            def push_messages(self, session_id, messages):
                self.message_batches.append((session_id, messages))

            def upload_media(self, data, content_type):
                self.uploads.append((content_type, data))
                return {"url": f"/media/{sha}.png", "sha256": sha, "contentType": content_type}

            def purge_official_sessions(self):
                self.purges += 1
                return {"sessions": 0, "messages": 0, "events": 0}

        local = LocalWithEmoji()
        cloud = CloudWithMedia()
        agent = SyncAgent(local, cloud, batch_limit=100)

        result = agent.sync_once(now=1_000_000)

        self.assertEqual(result["uploadedMedia"], 1)
        self.assertEqual(result["skippedMedia"], 0)
        # One cloud URL replacement for the emoji message
        pushed_messages = cloud.message_batches[0][1]
        emoji = next(m for m in pushed_messages if m.get("localId") == 1)
        self.assertEqual(emoji["mediaUrl"], f"/media/{sha}.png")
        # The non-emoji message keeps its placeholder content
        text = next(m for m in pushed_messages if m.get("localId") == 2)
        self.assertEqual(text.get("mediaUrl"), "")
        # upload was invoked exactly once with the right content type
        self.assertEqual(len(cloud.uploads), 1)
        self.assertEqual(cloud.uploads[0][0], "image/png")
        self.assertEqual(cloud.uploads[0][1], png)
        # local.fetch_media was called with the original URL
        self.assertEqual(local.fetch_calls, ["/api/v1/media/emoji/abc.png"])
        # First sync must trigger exactly one purge
        self.assertEqual(cloud.purges, 1)

    def test_local_type_47_emoji_also_triggers_upload(self):
        """localType=47 is the canonical WeChat ``emoji`` media type
        even when mediaType is missing from the payload."""

        png = self._png()
        sha = hashlib.sha256(png).hexdigest()

        class LocalLocalType47:
            def list_sessions(self):
                return [{"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 1}]

            def list_messages(self, session_id, *, start, limit):
                return {
                    "messages": [
                        {
                            "localId": 1,
                            "createTime": 100,
                            "content": "",
                            "localType": 47,
                            "mediaUrl": "/api/v1/media/emoji/x.gif",
                        },
                    ],
                    "hasMore": False,
                }

            def fetch_media(self, url):
                return png

        class CloudCapture:
            def __init__(self):
                self.message_batches = []
                self.uploads = 0
                self.last_content_type = None

            def sync_state(self):
                return {}

            def push_sessions(self, sessions):
                pass

            def push_messages(self, session_id, messages):
                self.message_batches.append((session_id, messages))

            def upload_media(self, data, content_type):
                self.uploads += 1
                # Caller must have provided the real content type, not
                # a hard-coded default.
                self.last_content_type = content_type
                return {"url": f"/media/{sha}.gif", "sha256": sha, "contentType": content_type}

            def purge_official_sessions(self):
                return {"sessions": 0, "messages": 0, "events": 0}

        cloud = CloudCapture()
        agent = SyncAgent(LocalLocalType47(), cloud)
        result = agent.sync_once(now=1_000_000)
        self.assertEqual(result["uploadedMedia"], 1)
        self.assertEqual(cloud.uploads, 1)
        self.assertEqual(cloud.last_content_type, "image/gif")

    def test_missing_local_media_url_counts_as_skipped(self):
        class LocalMissingUrl:
            def list_sessions(self):
                return [{"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 1}]

            def list_messages(self, session_id, *, start, limit):
                return {
                    "messages": [
                        {
                            "localId": 1,
                            "createTime": 100,
                            "content": "hi",
                            "mediaType": "emoji",
                            "mediaUrl": "",
                        },
                    ],
                    "hasMore": False,
                }

            def fetch_media(self, url):
                raise AssertionError("fetch_media must not be called when mediaUrl is empty")

        class CloudNoUpload:
            def __init__(self):
                self.message_batches = []

            def sync_state(self):
                return {}

            def push_sessions(self, sessions):
                pass

            def push_messages(self, session_id, messages):
                self.message_batches.append((session_id, messages))

            def upload_media(self, data, content_type):
                raise AssertionError("upload_media must not be called for empty mediaUrl")

            def purge_official_sessions(self):
                return {"sessions": 0, "messages": 0, "events": 0}

        cloud = CloudNoUpload()
        agent = SyncAgent(LocalMissingUrl(), cloud)
        result = agent.sync_once(now=1_000_000)
        self.assertEqual(result["uploadedMedia"], 0)
        self.assertEqual(result["skippedMedia"], 1)
        # Text message is still pushed
        self.assertEqual(len(cloud.message_batches), 1)
        self.assertEqual(cloud.message_batches[0][1][0]["content"], "hi")

    def test_local_404_on_media_does_not_block_session_sync(self):
        """A single 404 on a media URL must not stop the rest of the
        session from being mirrored."""

        class Local404:
            def list_sessions(self):
                return [{"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 1}]

            def list_messages(self, session_id, *, start, limit):
                return {
                    "messages": [
                        {
                            "localId": 1,
                            "createTime": 100,
                            "content": "text-only",
                            "mediaType": "emoji",
                            "mediaUrl": "/api/v1/media/emoji/missing.png",
                        },
                    ],
                    "hasMore": False,
                }

            def fetch_media(self, url):
                # Mirrors the production code's behaviour: a 404 from
                # the local media endpoint becomes a ``FileNotFoundError``.
                raise FileNotFoundError(url)

        class CloudNoUpload:
            def __init__(self):
                self.message_batches = []

            def sync_state(self):
                return {}

            def push_sessions(self, sessions):
                pass

            def push_messages(self, session_id, messages):
                self.message_batches.append((session_id, messages))

            def upload_media(self, data, content_type):
                raise AssertionError("upload_media must not be called after a 404")

            def purge_official_sessions(self):
                return {"sessions": 0, "messages": 0, "events": 0}

        cloud = CloudNoUpload()
        agent = SyncAgent(Local404(), cloud)
        result = agent.sync_once(now=1_000_000)
        self.assertEqual(result["skippedMedia"], 1)
        self.assertEqual(result["uploadedMedia"], 0)
        # Text message still uploaded
        self.assertEqual(len(cloud.message_batches), 1)
        # Placeholder URL is cleared so the web UI knows to skip it
        pushed = cloud.message_batches[0][1][0]
        self.assertEqual(pushed["mediaUrl"], "")

    def test_cloud_upload_auth_error_is_propagated_not_swallowed(self):
        """Network or auth errors from the cloud must NOT be silently
        swallowed; the run-forever loop relies on them to back off."""

        png = self._png()

        class LocalSimple:
            def list_sessions(self):
                return [{"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 1}]

            def list_messages(self, session_id, *, start, limit):
                return {
                    "messages": [
                        {
                            "localId": 1,
                            "createTime": 100,
                            "content": "x",
                            "mediaType": "emoji",
                            "mediaUrl": "/api/v1/media/emoji/y.png",
                        },
                    ],
                    "hasMore": False,
                }

            def fetch_media(self, url):
                return png

        class CloudFailing:
            def __init__(self):
                self.purges = 0

            def sync_state(self):
                return {}

            def push_sessions(self, sessions):
                pass

            def push_messages(self, session_id, messages):
                pass

            def upload_media(self, data, content_type):
                raise ApiError("HTTP 401 unauthorized")

            def purge_official_sessions(self):
                self.purges += 1
                return {"sessions": 0, "messages": 0, "events": 0}

        cloud = CloudFailing()
        agent = SyncAgent(LocalSimple(), cloud)
        with self.assertRaises(ApiError):
            agent.sync_once(now=1_000_000)
        # Purge must still have run before the failing upload.
        self.assertEqual(cloud.purges, 1)

    def test_purge_official_sessions_runs_only_once_per_process(self):
        """``CloudMirrorClient.purge_official_sessions`` must be invoked
        on the first successful sync only; subsequent rounds must not
        pay the cost (or, worse, re-delete freshly-ingested data)."""

        class LocalSimple:
            def __init__(self):
                self.calls = 0

            def list_sessions(self):
                self.calls += 1
                return [{"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 1}]

            def list_messages(self, session_id, *, start, limit):
                return {"messages": [], "hasMore": False}

        class CloudCounting:
            def __init__(self):
                self.purges = 0

            def sync_state(self):
                return {}

            def push_sessions(self, sessions):
                pass

            def push_messages(self, session_id, messages):
                pass

            def upload_media(self, data, content_type):
                raise AssertionError("no media here")

            def purge_official_sessions(self):
                self.purges += 1
                return {"sessions": 0, "messages": 0, "events": 0}

        cloud = CloudCounting()
        agent = SyncAgent(LocalSimple(), cloud)
        for _ in range(3):
            agent.sync_once(now=1_000_000)
        self.assertEqual(cloud.purges, 1)


class CloudMirrorClientUploadTests(unittest.TestCase):
    """``CloudMirrorClient.upload_media`` must POST a base64 payload
    together with the SHA-256 and content type, then return the JSON
    envelope from the server."""

    def test_upload_media_posts_base64_payload(self):
        client = CloudMirrorClient("http://cloud.example", "sync-token")
        captured = {}

        def fake_request_json(method, path, payload=None, query=None):
            captured["method"] = method
            captured["path"] = path
            captured["payload"] = payload
            return {"success": True, "url": "/media/abc.png", "sha256": "abc", "contentType": "image/png"}

        client.http.request_json = fake_request_json  # type: ignore[assignment]
        result = client.upload_media(b"PNGDATA", "image/png")
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["path"], "/api/v1/sync/media")
        self.assertEqual(captured["payload"]["contentType"], "image/png")
        self.assertEqual(captured["payload"]["sha256"], hashlib.sha256(b"PNGDATA").hexdigest())
        self.assertEqual(captured["payload"]["dataBase64"], base64.b64encode(b"PNGDATA").decode("ascii"))
        self.assertEqual(result["url"], "/media/abc.png")


class SyncMediaLogRedactionTests(unittest.TestCase):
    """The new emoji-sync path must not leak session ids, media URLs or
    media bytes into the structured warning logs. The existing rule on
    text messages is reused for media: an emoji that can't be fetched
    is logged with a generic explanation only."""

    def test_skipped_media_log_does_not_leak_url_or_session(self):
        png = b"\x89PNG\r\n\x1a\n"

        class LocalSimple:
            def list_sessions(self):
                return [{"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 1}]

            def list_messages(self, session_id, *, start, limit):
                return {
                    "messages": [
                        {
                            "localId": 1,
                            "createTime": 100,
                            "content": "x",
                            "mediaType": "emoji",
                            "mediaUrl": "/api/v1/media/emoji/leak-this-url",
                        },
                    ],
                    "hasMore": False,
                }

            def fetch_media(self, url):
                raise FileNotFoundError(url)

        class CloudSimple:
            def __init__(self):
                self.purges = 0

            def sync_state(self):
                return {}

            def push_sessions(self, sessions):
                pass

            def push_messages(self, session_id, messages):
                pass

            def upload_media(self, data, content_type):
                raise AssertionError("not reached")

            def purge_official_sessions(self):
                self.purges += 1
                return {"sessions": 0, "messages": 0, "events": 0}

        cloud = CloudSimple()
        agent = SyncAgent(LocalSimple(), cloud)
        with self.assertLogs(level="WARNING") as captured:
            agent.sync_once(now=1_000_000)
        joined = "\n".join(captured.output)
        self.assertNotIn("wxid_alice", joined)
        self.assertNotIn("leak-this-url", joined)
        self.assertNotIn("PNG", joined)


if __name__ == "__main__":
    unittest.main()
