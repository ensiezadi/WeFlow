import base64
import hashlib
import http.client
import json
import os
import tempfile
import threading
import unittest
from http.cookies import SimpleCookie
from pathlib import Path

from server import CloudStore, create_server


class CloudStoreTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = CloudStore(Path(self.tempdir.name) / "weflow.sqlite3")

    def tearDown(self):
        self.store.close()
        self.tempdir.cleanup()

    def test_official_session_filter_rejects_gh_prefix(self):
        written = self.store.upsert_sessions([
            {"username": "gh_abc123def", "displayName": "Some Official", "lastTimestamp": 1},
            {"username": "gh_xyz", "displayName": "Another Official", "lastTimestamp": 2},
        ])
        self.assertEqual(written, 0)
        self.assertEqual(self.store.list_sessions(limit=100), [])

    def test_official_session_filter_rejects_openim_substring(self):
        written = self.store.upsert_sessions([
            {"username": "service@openim.com", "displayName": "Service Bot", "lastTimestamp": 5},
            {"username": "robot@openim", "displayName": "Robot", "lastTimestamp": 6},
        ])
        self.assertEqual(written, 0)
        self.assertEqual(self.store.list_sessions(limit=100), [])

    def test_official_session_filter_keeps_normal_wxid_and_groups(self):
        written = self.store.upsert_sessions([
            {"username": "wxid_abc123", "displayName": "Alice", "lastTimestamp": 1},
            {"username": "12345678@chatroom", "displayName": "Group Chat", "sessionType": "group", "lastTimestamp": 2},
            {"username": "ghelper_wxid", "displayName": "Helper", "lastTimestamp": 3},  # contains gh but not prefix
            {"username": "service@openheart", "displayName": "Heart Bot", "lastTimestamp": 4},  # not @openim
            {"username": "wxid_ghelper", "displayName": "Helper2", "lastTimestamp": 5},  # contains gh_ but not prefix
        ])
        self.assertEqual(written, 5)
        usernames = {row["username"] for row in self.store.list_sessions(limit=100)}
        self.assertEqual(usernames, {
            "wxid_abc123",
            "12345678@chatroom",
            "ghelper_wxid",
            "service@openheart",
            "wxid_ghelper",
        })

    def test_upsert_messages_defensively_filters_official_sessions(self):
        written = self.store.upsert_messages("gh_abc123", [
            {"localId": 1, "createTime": 1, "content": "should not store"},
        ])
        self.assertEqual(written, 0)
        written = self.store.upsert_messages("bot@openim.io", [
            {"localId": 2, "createTime": 2, "content": "also filtered"},
        ])
        self.assertEqual(written, 0)
        self.assertEqual(self.store.list_sessions(limit=100), [])

        # A normal session should still upsert
        written = self.store.upsert_messages("wxid_alice", [
            {"localId": 3, "createTime": 3, "content": "kept"},
        ])
        self.assertEqual(written, 1)

    def test_message_upsert_is_idempotent_and_ordered(self):
        self.store.upsert_sessions([
            {"username": "alice", "displayName": "Alice", "lastTimestamp": 100, "unreadCount": 1}
        ])
        batch = [
            {"localId": 2, "serverId": "s2", "createTime": 102, "isSend": 0, "content": "second"},
            {"localId": 1, "serverId": "s1", "createTime": 101, "isSend": 1, "content": "first"},
        ]
        self.store.upsert_messages("alice", batch)
        self.store.upsert_messages("alice", batch)

        result = self.store.list_messages("alice", limit=20, offset=0)
        self.assertEqual([item["content"] for item in result["messages"]], ["first", "second"])
        self.assertEqual(result["count"], 2)

    def test_revoke_event_marks_matching_message(self):
        self.store.upsert_messages("alice", [
            {"localId": 1, "serverId": "9988", "createTime": 101, "isSend": 0, "content": "hello"}
        ])

        self.store.apply_events([{
            "event": "message.revoke",
            "sessionId": "alice",
            "rawid": "9988",
            "content": "对方撤回了一条消息",
            "timestamp": 102,
        }])

        message = self.store.list_messages("alice", limit=20, offset=0)["messages"][0]
        self.assertTrue(message["revoked"])


class CloudHttpTests(unittest.TestCase):
    # The env-var tests below mutate ``WEFLOW_WEB_PASSWORD``; the original
    # value (which may belong to the developer or a higher-level test runner)
    # must be restored on teardown so we never poison neighbouring suites.
    _WEFLOW_WEB_PASSWORD_ENV = "WEFLOW_WEB_PASSWORD"

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        static_dir = Path(__file__).resolve().parents[2] / "electron" / "web-client"
        self._original_web_password = os.environ.get(self._WEFLOW_WEB_PASSWORD_ENV)
        os.environ[self._WEFLOW_WEB_PASSWORD_ENV] = "web-secret"
        self.server = create_server(
            host="127.0.0.1",
            port=0,
            db_path=Path(self.tempdir.name) / "weflow.sqlite3",
            static_dir=static_dir,
            sync_token="sync-secret",
            session_secret="session-secret",
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        # Restore (or remove) the env var so we never leak ``web-secret`` to
        # any later test that reads the process environment.
        if self._original_web_password is None:
            os.environ.pop(self._WEFLOW_WEB_PASSWORD_ENV, None)
        else:
            os.environ[self._WEFLOW_WEB_PASSWORD_ENV] = self._original_web_password
        self.tempdir.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request_headers = dict(headers or {})
        if payload is not None:
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, body=payload, headers=request_headers)
        response = connection.getresponse()
        data = response.read()
        result = response.status, dict(response.getheaders()), data
        connection.close()
        return result

    def login_cookie(self):
        status, headers, _ = self.request("POST", "/api/v1/auth/login", {"password": "web-secret"})
        self.assertEqual(status, 200)
        cookie = SimpleCookie()
        cookie.load(headers["Set-Cookie"])
        return f"weflow_session={cookie['weflow_session'].value}"

    def test_static_web_is_public_but_data_requires_login(self):
        status, _, html = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("只读模式".encode("utf-8"), html)

        status, _, _ = self.request("GET", "/api/v1/sessions")
        self.assertEqual(status, 401)

    def test_sync_token_and_web_cookie_have_separate_permissions(self):
        sync_headers = {"Authorization": "Bearer sync-secret"}
        status, _, _ = self.request("POST", "/api/v1/sync/sessions", {
            "sessions": [{"username": "alice", "displayName": "Alice", "lastTimestamp": 100}]
        }, sync_headers)
        self.assertEqual(status, 200)

        status, _, _ = self.request("GET", "/api/v1/sessions", headers=sync_headers)
        self.assertEqual(status, 401)

        cookie = self.login_cookie()
        status, _, payload = self.request("GET", "/api/v1/sessions", headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload)["sessions"][0]["displayName"], "Alice")

        status, _, _ = self.request("POST", "/api/v1/sync/sessions", {"sessions": []}, {"Cookie": cookie})
        self.assertEqual(status, 401)

    def test_sync_endpoint_filters_official_sessions_over_http(self):
        sync_headers = {"Authorization": "Bearer sync-secret"}
        status, _, body = self.request("POST", "/api/v1/sync/sessions", {
            "sessions": [
                {"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 1},
                {"username": "gh_abcdef", "displayName": "Ghost", "lastTimestamp": 2},
                {"username": "bot@openim.io", "displayName": "Bot", "lastTimestamp": 3},
            ]
        }, sync_headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["written"], 1)

        status, _, _ = self.request("POST", "/api/v1/sync/messages", {
            "sessionId": "gh_abcdef",
            "messages": [{"localId": 1, "createTime": 1, "content": "blocked"}],
        }, sync_headers)
        self.assertEqual(status, 200)

        cookie = self.login_cookie()
        status, _, payload = self.request("GET", "/api/v1/sessions", headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        usernames = {row["username"] for row in json.loads(payload)["sessions"]}
        self.assertIn("wxid_alice", usernames)
        self.assertNotIn("gh_abcdef", usernames)
        self.assertNotIn("bot@openim.io", usernames)

    def test_no_message_sending_route_exists(self):
        cookie = self.login_cookie()
        status, _, _ = self.request(
            "POST",
            "/api/v1/messages/send",
            {"sessionId": "alice", "content": "not allowed"},
            {"Cookie": cookie},
        )
        self.assertEqual(status, 404)

    def test_login_is_rate_limited_after_repeated_failures(self):
        for _ in range(5):
            status, _, _ = self.request(
                "POST",
                "/api/v1/auth/login",
                {"password": "wrong"},
                {"CF-Connecting-IP": "203.0.113.8"},
            )
            self.assertEqual(status, 401)

        status, headers, _ = self.request(
            "POST",
            "/api/v1/auth/login",
            {"password": "web-secret"},
            {"CF-Connecting-IP": "203.0.113.8"},
        )
        self.assertEqual(status, 429)
        self.assertIn("Retry-After", headers)

    def test_change_password_requires_login(self):
        status, _, body = self.request("POST", "/api/v1/auth/change-password", {
            "currentPassword": "web-secret",
            "newPassword": "another-secret-12",
        })
        self.assertEqual(status, 401)
        self.assertNotIn("another-secret-12", body.decode("utf-8"))

    def test_change_password_rejects_weak_and_equal_passwords(self):
        cookie = self.login_cookie()
        status, _, _ = self.request("POST", "/api/v1/auth/change-password", {
            "currentPassword": "web-secret",
            "newPassword": "short",
        }, {"Cookie": cookie})
        self.assertEqual(status, 400)

        status, _, _ = self.request("POST", "/api/v1/auth/change-password", {
            "currentPassword": "web-secret",
            "newPassword": "web-secret",
        }, {"Cookie": cookie})
        self.assertEqual(status, 400)

        # Original password must still work because the change was rejected
        status, _, _ = self.request("POST", "/api/v1/auth/login", {"password": "web-secret"})
        self.assertEqual(status, 200)

    def test_change_password_rejects_wrong_current_and_keeps_old_working(self):
        cookie = self.login_cookie()
        status, _, _ = self.request("POST", "/api/v1/auth/change-password", {
            "currentPassword": "definitely-wrong",
            "newPassword": "a-new-strong-12chars",
        }, {"Cookie": cookie})
        self.assertEqual(status, 401)

        status, _, _ = self.request("POST", "/api/v1/auth/login", {"password": "web-secret"})
        self.assertEqual(status, 200)

    def test_change_password_persists_db_verifier_and_invalidates_cookies(self):
        cookie = self.login_cookie()
        new_password = "a-new-strong-12chars"

        status, response_headers, body = self.request(
            "POST",
            "/api/v1/auth/change-password",
            {"currentPassword": "web-secret", "newPassword": new_password},
            {"Cookie": cookie},
        )
        self.assertEqual(status, 200)
        # Body and Set-Cookie must never include the new password
        self.assertNotIn(new_password, body.decode("utf-8"))
        set_cookie = response_headers.get("Set-Cookie", "")
        self.assertIn("Max-Age=0", set_cookie)

        # Old env seed must no longer log the user in
        status, _, _ = self.request("POST", "/api/v1/auth/login", {"password": "web-secret"})
        self.assertEqual(status, 401)

        # The cookie we used for the change request must now be rejected
        status, _, _ = self.request("GET", "/api/v1/sessions", headers={"Cookie": cookie})
        self.assertEqual(status, 401)

        # Fresh login with the new password must succeed and issue a new cookie
        status, login_headers, _ = self.request("POST", "/api/v1/auth/login", {"password": new_password})
        self.assertEqual(status, 200)
        new_cookie = SimpleCookie()
        new_cookie.load(login_headers["Set-Cookie"])
        new_cookie_value = f"weflow_session={new_cookie['weflow_session'].value}"

        status, _, payload = self.request("GET", "/api/v1/sessions", headers={"Cookie": new_cookie_value})
        self.assertEqual(status, 200)
        self.assertIn("success", json.loads(payload))

    def test_change_password_persists_pbkdf2_hash_not_plaintext(self):
        from server import PasswordVerifier

        with tempfile.TemporaryDirectory() as tempdir:
            store = CloudStore(Path(tempdir) / "weflow.sqlite3")
            try:
                verifier = PasswordVerifier(iterations=310_000)
                record = verifier.create("a-new-strong-12chars")
                store.set_password_verifier(record)
                loaded = store.get_password_verifier()
                self.assertIsNotNone(loaded)
                self.assertEqual(loaded["iterations"], 310_000)
                self.assertEqual(loaded["algorithm"], "pbkdf2_hmac_sha256")
                self.assertNotIn("a-new-strong-12chars", str(loaded))
                self.assertTrue(verifier.verify("a-new-strong-12chars", loaded))
                self.assertFalse(verifier.verify("a-new-strong-12charz", loaded))
            finally:
                store.close()

    def test_password_verifier_uses_random_salt_per_record(self):
        from server import PasswordVerifier

        verifier = PasswordVerifier()
        salt_a = verifier.create("same-strong-password-12")["salt"]
        salt_b = verifier.create("same-strong-password-12")["salt"]
        self.assertNotEqual(salt_a, salt_b)

    def test_login_prefers_db_verifier_after_first_change(self):
        new_password = "rotated-strong-12chars"
        cookie = self.login_cookie()

        status, _, _ = self.request(
            "POST",
            "/api/v1/auth/change-password",
            {"currentPassword": "web-secret", "newPassword": new_password},
            {"Cookie": cookie},
        )
        self.assertEqual(status, 200)

        # Restart semantics: build a fresh server against the same DB.
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.server = create_server(
            host="127.0.0.1",
            port=0,
            db_path=Path(self.tempdir.name) / "weflow.sqlite3",
            static_dir=Path(__file__).resolve().parents[2] / "electron" / "web-client",
            sync_token="sync-secret",
            session_secret="session-secret",
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

        # Env seed must not work; new DB-backed password must work
        status, _, _ = self.request("POST", "/api/v1/auth/login", {"password": "web-secret"})
        self.assertEqual(status, 401)
        status, _, _ = self.request("POST", "/api/v1/auth/login", {"password": new_password})
        self.assertEqual(status, 200)

    def test_no_sending_route_even_after_password_change(self):
        cookie = self.login_cookie()
        status, _, _ = self.request(
            "POST",
            "/api/v1/auth/change-password",
            {"currentPassword": "web-secret", "newPassword": "new-strong-12chars"},
            {"Cookie": cookie},
        )
        self.assertEqual(status, 200)
        new_cookie = self.login_cookie_with_password("new-strong-12chars")
        status, _, _ = self.request(
            "POST",
            "/api/v1/messages/send",
            {"sessionId": "alice", "content": "still not allowed"},
            {"Cookie": new_cookie},
        )
        self.assertEqual(status, 404)

    def login_cookie_with_password(self, password):
        status, headers, _ = self.request("POST", "/api/v1/auth/login", {"password": password})
        self.assertEqual(status, 200)
        cookie = SimpleCookie()
        cookie.load(headers["Set-Cookie"])
        return f"weflow_session={cookie['weflow_session'].value}"

    def test_change_password_response_does_not_expose_internal_generation(self):
        cookie = self.login_cookie()
        status, _, body = self.request(
            "POST",
            "/api/v1/auth/change-password",
            {"currentPassword": "web-secret", "newPassword": "another-strong-12chars"},
            {"Cookie": cookie},
        )
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload, {"success": True})


class FailClosedTests(unittest.TestCase):
    """The server must refuse to start with a fresh DB if no password seed is
    available — otherwise the operator would deploy a service that no one
    can ever log in to. Once a verifier is in the DB, however, the server
    must boot cleanly without any seed."""

    _ENV = "WEFLOW_WEB_PASSWORD"

    def setUp(self):
        self._original = os.environ.get(self._ENV)
        # Always start from "no seed" for these tests.
        os.environ.pop(self._ENV, None)
        self.tempdir = tempfile.TemporaryDirectory()
        self.static_dir = Path(__file__).resolve().parents[2] / "electron" / "web-client"

    def tearDown(self):
        if self._original is None:
            os.environ.pop(self._ENV, None)
        else:
            os.environ[self._ENV] = self._original
        self.tempdir.cleanup()

    def test_fresh_db_without_seed_raises_value_error(self):
        with self.assertRaises(ValueError) as ctx:
            create_server(
                host="127.0.0.1",
                port=0,
                db_path=Path(self.tempdir.name) / "weflow.sqlite3",
                static_dir=self.static_dir,
                sync_token="sync-secret",
                session_secret="session-secret",
            )
        self.assertIn("password", str(ctx.exception).lower())

    def test_fresh_db_with_env_seed_starts(self):
        os.environ[self._ENV] = "env-seed-strong-12"
        server = create_server(
            host="127.0.0.1",
            port=0,
            db_path=Path(self.tempdir.name) / "weflow.sqlite3",
            static_dir=self.static_dir,
            sync_token="sync-secret",
            session_secret="session-secret",
        )
        try:
            self.assertIsNotNone(server.store.get_password_verifier())
        finally:
            # ``server.shutdown()`` blocks until ``serve_forever`` returns,
            # and we never started that loop — so just close the listening
            # socket + store directly.
            server.server_close()

    def test_existing_db_verifier_lets_server_start_without_seed(self):
        db_path = Path(self.tempdir.name) / "weflow.sqlite3"
        # Pre-populate the DB with a verifier as if a previous deployment
        # had already gone through the env-seed path.
        from server import PasswordVerifier
        seed_store = CloudStore(db_path)
        seed_store.set_password_verifier(PasswordVerifier().create("preexisting-pw-12"))
        seed_store.close()

        # No env seed set; the server must still come up.
        server = create_server(
            host="127.0.0.1",
            port=0,
            db_path=db_path,
            static_dir=self.static_dir,
            sync_token="sync-secret",
            session_secret="session-secret",
        )
        try:
            record = server.store.get_password_verifier()
            self.assertIsNotNone(record)
            self.assertTrue(server.password_verifier.verify("preexisting-pw-12", record))
        finally:
            server.server_close()


class CreateServerCompatibilityTests(unittest.TestCase):
    """The create_server API must stay backward-compatible for embedded /
    test callers that still pass an explicit ``web_password=`` keyword.
    main() continues to read the env var; the parameter is only used as a
    one-shot runtime seed whose plaintext is never persisted."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.static_dir = Path(__file__).resolve().parents[2] / "electron" / "web-client"

    def tearDown(self):
        self.tempdir.cleanup()

    def test_web_password_kwarg_seeds_db_and_never_persists_plaintext(self):
        db_path = Path(self.tempdir.name) / "weflow.sqlite3"
        server = create_server(
            host="127.0.0.1",
            port=0,
            db_path=db_path,
            static_dir=self.static_dir,
            sync_token="sync-secret",
            session_secret="session-secret",
            web_password="explicit-pw-12345",
        )
        try:
            record = server.store.get_password_verifier()
            self.assertIsNotNone(record)
            self.assertTrue(server.password_verifier.verify("explicit-pw-12345", record))
            # Plaintext must not appear anywhere on disk.
            raw_db_bytes = db_path.read_bytes()
            self.assertNotIn(b"explicit-pw-12345", raw_db_bytes)
        finally:
            server.server_close()

    def test_web_password_kwarg_takes_precedence_over_env(self):
        os.environ["WEFLOW_WEB_PASSWORD"] = "env-pw-should-be-ignored"
        try:
            db_path = Path(self.tempdir.name) / "weflow.sqlite3"
            server = create_server(
                host="127.0.0.1",
                port=0,
                db_path=db_path,
                static_dir=self.static_dir,
                sync_token="sync-secret",
                session_secret="session-secret",
                web_password="param-pw-1234567",
            )
            try:
                record = server.store.get_password_verifier()
                self.assertTrue(server.password_verifier.verify("param-pw-1234567", record))
                self.assertFalse(server.password_verifier.verify("env-pw-should-be-ignored", record))
            finally:
                server.server_close()
        finally:
            os.environ.pop("WEFLOW_WEB_PASSWORD", None)


class RotatePasswordVerifierTests(unittest.TestCase):
    """``rotate_password_verifier`` must update the password record *and*
    bump the auth generation atomically: if anything between the two
    operations fails, the DB must be left exactly as it was."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = CloudStore(Path(self.tempdir.name) / "weflow.sqlite3")

    def tearDown(self):
        self.store.close()
        self.tempdir.cleanup()

    def test_rotate_updates_both_records_and_returns_new_generation(self):
        from server import PasswordVerifier

        verifier = PasswordVerifier()
        self.store.set_password_verifier(verifier.create("initial-pw-1234"))
        new_generation = self.store.rotate_password_verifier(verifier.create("rotated-pw-5678"))
        self.assertEqual(new_generation, self.store.get_auth_generation())

        record = self.store.get_password_verifier()
        self.assertIsNotNone(record)
        self.assertTrue(verifier.verify("rotated-pw-5678", record))
        self.assertFalse(verifier.verify("initial-pw-1234", record))

    def test_rotate_does_not_persist_plaintext(self):
        from server import PasswordVerifier

        verifier = PasswordVerifier()
        self.store.set_password_verifier(verifier.create("initial-pw-1234"))
        self.store.rotate_password_verifier(verifier.create("rotated-pw-5678"))
        raw = Path(self.tempdir.name, "weflow.sqlite3").read_bytes()
        self.assertNotIn(b"rotated-pw-5678", raw)
        self.assertNotIn(b"initial-pw-1234", raw)

    def test_rotate_is_atomic_when_write_fails(self):
        from server import PasswordVerifier

        verifier = PasswordVerifier()
        old_record = verifier.create("initial-pw-1234")
        self.store.set_password_verifier(old_record)
        original_generation = self.store.get_auth_generation()

        # Wrap the connection so the *third* SQL call (the auth-generation
        # write that follows the verifier write) raises. The transaction
        # context manager must roll the rotation back so the DB stays
        # exactly as it was before the call.
        real_connection = self.store._connection
        state = {"execute_calls": 0}

        class _FailingConnection:
            def __getattr__(self, name):
                return getattr(real_connection, name)

            def __enter__(self):
                return real_connection.__enter__()

            def __exit__(self, exc_type, exc, tb):
                return real_connection.__exit__(exc_type, exc, tb)

            def execute(self, sql, *args, **kwargs):
                state["execute_calls"] += 1
                if state["execute_calls"] == 3:
                    raise RuntimeError("simulated mid-rotation failure")
                return real_connection.execute(sql, *args, **kwargs)

        self.store._connection = _FailingConnection()  # type: ignore[assignment]
        try:
            with self.assertRaises(RuntimeError):
                self.store.rotate_password_verifier(verifier.create("rotated-pw-5678"))
        finally:
            self.store._connection = real_connection  # type: ignore[assignment]

        # The transaction must have rolled back. The verifier and the
        # generation must both be exactly what they were before.
        self.assertEqual(self.store.get_auth_generation(), original_generation)
        record = self.store.get_password_verifier()
        self.assertIsNotNone(record)
        self.assertTrue(verifier.verify("initial-pw-1234", record))
        self.assertFalse(verifier.verify("rotated-pw-5678", record))


class PurgeOfficialSessionsTests(unittest.TestCase):
    """``purge_official_sessions`` must delete only sessions whose
    ``username``/``session_id`` starts with ``gh_`` (case-insensitive) or
    contains ``@openim``. Plain wxids and group chats must be untouched,
    even when the username happens to contain the letters "gh" or the
    substring "openim" outside the strict prefixes.
    """

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = CloudStore(Path(self.tempdir.name) / "weflow.sqlite3")

    def tearDown(self):
        self.store.close()
        self.tempdir.cleanup()

    def _insert_official_session(self, username: str, last_ts: int = 1) -> None:
        """Bypass ``upsert_sessions``' defensive filter to write an
        official / Open IM row directly. The test only needs the row
        to exist so ``purge_official_sessions`` can find and remove it;
        the production upsert path is forbidden from ever creating
        these rows in the first place."""
        with self.store._lock, self.store._connection:
            self.store._connection.execute(
                "INSERT INTO sessions(username, display_name, last_timestamp, updated_at) VALUES (?, ?, ?, ?)",
                (username, username, last_ts, 0),
            )

    def _insert_message_for_session(
        self, session_id: str, local_id: int, create_time: int, content: str = "x"
    ) -> None:
        """Bypass ``upsert_messages``' defensive filter for the same
        reason as ``_insert_official_session``: the test needs a
        message row attached to a session that the production code
        would normally refuse to write to. The production invariant
        — never *ingest* data for an official session — is unchanged."""
        import json
        key = f"{session_id}:local:{local_id}:{create_time}"
        payload = json.dumps(
            {"localId": local_id, "createTime": create_time, "content": content},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        with self.store._lock, self.store._connection:
            self.store._connection.execute(
                "INSERT INTO messages("
                "message_key, session_id, server_id, local_id, create_time, is_send, "
                "sender_username, content, media_type, media_url, revoked, payload_json, updated_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    key, session_id, "", str(local_id), create_time, 0,
                    "", content, "", "", 0, payload, 0,
                ),
            )

    def _insert_event(self, session_id: str, rawid: str) -> None:
        """Bypass ``apply_events``' filter for an official session —
        same rationale as the other helpers. The production code path
        would never produce such a row, but the purge must still
        handle it correctly when cleaning up legacy data."""
        import json
        payload = json.dumps(
            {"event": "message.new", "sessionId": session_id, "rawid": rawid},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        with self.store._lock, self.store._connection:
            self.store._connection.execute(
                "INSERT INTO events(event_name, session_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
                ("message.new", session_id, payload, 0),
            )

    def test_purge_deletes_official_sessions_messages_and_events(self):
        # Pre-populate: 2 official + 2 normal sessions, each with messages + events.
        # The official rows are inserted directly (upsert_sessions would
        # filter them, which is the production invariant we want to keep).
        self.store.upsert_sessions([
            {"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 3},
            {"username": "12345@chatroom", "displayName": "Group", "lastTimestamp": 4},
        ])
        for sid, n in [
            ("gh_official", 1),
            ("bot@openim.io", 2),
            ("wxid_alice", 3),
            ("12345@chatroom", 4),
        ]:
            if sid in {"gh_official", "bot@openim.io"}:
                self._insert_official_session(sid, last_ts=n)
                self._insert_message_for_session(sid, n, n, content=str(n))
            else:
                self.store.upsert_messages(sid, [
                    {"localId": n, "createTime": n, "content": str(n)},
                ])

        self.store.apply_events([
            {"event": "message.new", "sessionId": "wxid_alice", "rawid": "3", "content": "z"},
        ])
        # Direct inserts for the events we want to verify get purged.
        self._insert_event("gh_official", "1")
        self._insert_event("bot@openim.io", "2")

        deleted = self.store.purge_official_sessions()
        self.assertEqual(deleted["sessions"], 2)
        self.assertEqual(deleted["messages"], 2)
        self.assertEqual(deleted["events"], 2)

        remaining = {row["username"] for row in self.store.list_sessions(limit=100)}
        self.assertEqual(remaining, {"wxid_alice", "12345@chatroom"})

        # Surviving sessions still have their messages intact (the
        # "3" content from upsert_messages and the "z" content from
        # apply_events are both still there).
        alice_messages = self.store.list_messages("wxid_alice", limit=10, offset=0)["messages"]
        contents = {item.get("content") for item in alice_messages}
        self.assertIn("3", contents)

    def test_purge_does_not_touch_normal_wxid_or_group_sessions(self):
        # All four look like they might match the naive rule, but the strict
        # prefix / substring check must leave them alone.
        self.store.upsert_sessions([
            {"username": "wxid_abc", "displayName": "X", "lastTimestamp": 1},
            {"username": "12345@chatroom", "displayName": "G", "lastTimestamp": 2},
            {"username": "ghelper_id", "displayName": "H", "lastTimestamp": 3},
            {"username": "service@openheart.io", "displayName": "O", "lastTimestamp": 4},
        ])
        for sid, n in [
            ("wxid_abc", 1),
            ("12345@chatroom", 2),
            ("ghelper_id", 3),
            ("service@openheart.io", 4),
        ]:
            self.store.upsert_messages(sid, [{"localId": n, "createTime": n}])

        # GH_UpperCase is official by the prefix rule — insert directly
        self._insert_official_session("GH_UpperCase", last_ts=5)
        self._insert_message_for_session("GH_UpperCase", 5, 5)

        deleted = self.store.purge_official_sessions()
        self.assertEqual(deleted["sessions"], 1)  # only GH_UpperCase
        self.assertEqual(deleted["messages"], 1)
        self.assertEqual(deleted["events"], 0)

        remaining = {row["username"] for row in self.store.list_sessions(limit=100)}
        self.assertNotIn("GH_UpperCase", remaining)
        self.assertIn("ghelper_id", remaining)
        self.assertIn("service@openheart.io", remaining)

    def test_purge_is_idempotent_when_no_official_sessions_present(self):
        self.store.upsert_sessions([
            {"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 1},
        ])
        first = self.store.purge_official_sessions()
        second = self.store.purge_official_sessions()
        self.assertEqual(first["sessions"], 0)
        self.assertEqual(second["sessions"], 0)
        self.assertEqual(second["messages"], 0)
        self.assertEqual(second["events"], 0)

    def test_purge_returns_deletion_counts(self):
        # Run twice; the second call must return zeros even though the first
        # call already removed everything.
        self._insert_official_session("gh_a", last_ts=1)
        self._insert_official_session("gh_b", last_ts=2)
        self._insert_message_for_session("gh_a", 1, 1)
        self._insert_message_for_session("gh_b", 2, 2)

        result = self.store.purge_official_sessions()
        self.assertEqual(result, {"sessions": 2, "messages": 2, "events": 0})


class MediaSyncEndpointTests(unittest.TestCase):
    """POST /api/v1/sync/media stores an emoji image by SHA-256, serves it
    back at /media/<hash>.<ext>, and refuses to disclose it without a
    valid web cookie. Bearer tokens, unknown extensions, oversized
    payloads, and SHA mismatches must all be rejected without leaking
    bytes to disk."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.static_dir = Path(__file__).resolve().parents[2] / "electron" / "web-client"
        self._original_web_password = os.environ.get("WEFLOW_WEB_PASSWORD")
        os.environ["WEFLOW_WEB_PASSWORD"] = "web-secret"
        self.server = create_server(
            host="127.0.0.1",
            port=0,
            db_path=Path(self.tempdir.name) / "weflow.sqlite3",
            static_dir=self.static_dir,
            sync_token="sync-secret",
            session_secret="session-secret",
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        if self._original_web_password is None:
            os.environ.pop("WEFLOW_WEB_PASSWORD", None)
        else:
            os.environ["WEFLOW_WEB_PASSWORD"] = self._original_web_password
        self.tempdir.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request_headers = dict(headers or {})
        if payload is not None:
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, body=payload, headers=request_headers)
        response = connection.getresponse()
        data = response.read()
        result = response.status, dict(response.getheaders()), data
        connection.close()
        return result

    def login_cookie(self):
        status, headers, _ = self.request("POST", "/api/v1/auth/login", {"password": "web-secret"})
        self.assertEqual(status, 200)
        cookie = SimpleCookie()
        cookie.load(headers["Set-Cookie"])
        return f"weflow_session={cookie['weflow_session'].value}"

    def _sample_png(self) -> bytes:
        # 1x1 transparent PNG
        return base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg=="
        )

    def test_media_upload_requires_sync_token(self):
        body = {
            "dataBase64": base64.b64encode(self._sample_png()).decode("ascii"),
            "contentType": "image/png",
            "sha256": hashlib.sha256(self._sample_png()).hexdigest(),
        }
        status, _, _ = self.request("POST", "/api/v1/sync/media", body)
        self.assertEqual(status, 401)

    def test_media_upload_stores_file_and_returns_public_url(self):
        png_bytes = self._sample_png()
        body = {
            "dataBase64": base64.b64encode(png_bytes).decode("ascii"),
            "contentType": "image/png",
            "sha256": hashlib.sha256(png_bytes).hexdigest(),
        }
        status, _, payload = self.request(
            "POST",
            "/api/v1/sync/media",
            body,
            {"Authorization": "Bearer sync-secret"},
        )
        self.assertEqual(status, 200)
        body_json = json.loads(payload)
        expected_hash = hashlib.sha256(png_bytes).hexdigest()
        self.assertEqual(body_json["sha256"], expected_hash)
        self.assertEqual(body_json["contentType"], "image/png")
        self.assertTrue(body_json["url"].endswith(f"/media/{expected_hash}.png"))

        # File is on disk under the media_dir.
        media_dir = self.server.config.media_dir
        files = list(media_dir.iterdir())
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].name.endswith(".png"))
        self.assertEqual(files[0].read_bytes(), png_bytes)

    def test_media_upload_rejects_mismatched_sha256(self):
        png_bytes = self._sample_png()
        body = {
            "dataBase64": base64.b64encode(png_bytes).decode("ascii"),
            "contentType": "image/png",
            "sha256": "0" * 64,
        }
        status, _, _ = self.request(
            "POST",
            "/api/v1/sync/media",
            body,
            {"Authorization": "Bearer sync-secret"},
        )
        self.assertEqual(status, 400)
        # Nothing should have been written
        self.assertEqual(list(self.server.config.media_dir.iterdir()), [])

    def test_media_upload_rejects_disallowed_content_type(self):
        png_bytes = self._sample_png()
        body = {
            "dataBase64": base64.b64encode(png_bytes).decode("ascii"),
            "contentType": "image/svg+xml",
            "sha256": hashlib.sha256(png_bytes).hexdigest(),
        }
        status, _, _ = self.request(
            "POST",
            "/api/v1/sync/media",
            body,
            {"Authorization": "Bearer sync-secret"},
        )
        self.assertEqual(status, 400)

    def test_media_upload_rejects_oversized_payload(self):
        # 11 MiB worth of bytes; the limit is 10 MiB.
        big = b"\x00" * (11 * 1024 * 1024)
        body = {
            "dataBase64": base64.b64encode(big).decode("ascii"),
            "contentType": "image/png",
            "sha256": hashlib.sha256(big).hexdigest(),
        }
        status, _, _ = self.request(
            "POST",
            "/api/v1/sync/media",
            body,
            {"Authorization": "Bearer sync-secret"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(list(self.server.config.media_dir.iterdir()), [])

    def test_media_upload_is_idempotent_on_same_sha(self):
        png_bytes = self._sample_png()
        body = {
            "dataBase64": base64.b64encode(png_bytes).decode("ascii"),
            "contentType": "image/png",
            "sha256": hashlib.sha256(png_bytes).hexdigest(),
        }
        for _ in range(3):
            status, _, _ = self.request(
                "POST",
                "/api/v1/sync/media",
                body,
                {"Authorization": "Bearer sync-secret"},
            )
            self.assertEqual(status, 200)
        files = list(self.server.config.media_dir.iterdir())
        self.assertEqual(len(files), 1)

    def test_get_media_requires_web_cookie(self):
        png_bytes = self._sample_png()
        sha = hashlib.sha256(png_bytes).hexdigest()
        body = {
            "dataBase64": base64.b64encode(png_bytes).decode("ascii"),
            "contentType": "image/png",
            "sha256": sha,
        }
        status, _, _ = self.request(
            "POST",
            "/api/v1/sync/media",
            body,
            {"Authorization": "Bearer sync-secret"},
        )
        self.assertEqual(status, 200)

        # No cookie → 401
        status, _, _ = self.request("GET", f"/media/{sha}.png")
        self.assertEqual(status, 401)

        # Sync Bearer alone is *not* enough for /media
        status, _, _ = self.request("GET", f"/media/{sha}.png", headers={"Authorization": "Bearer sync-secret"})
        self.assertEqual(status, 401)

        # With cookie → 200, correct content type/length
        cookie = self.login_cookie()
        status, headers, data = self.request("GET", f"/media/{sha}.png", headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "image/png")
        self.assertEqual(headers.get("Content-Length"), str(len(png_bytes)))
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(headers.get("Cache-Control"), "private, max-age=300")
        self.assertEqual(data, png_bytes)

    def test_get_media_blocks_path_traversal(self):
        cookie = self.login_cookie()
        # 401 is the safe response: never leak traversal-blocked resource.
        for malicious in [
            "/media/..%2F..%2Fetc%2Fpasswd",
            "/media/..%2fserver.py",
            "/media/%2e%2e/server.py",
            "/media/.png",
        ]:
            status, _, _ = self.request("GET", malicious, headers={"Cookie": cookie})
            # Either 400 (bad path) or 404 (not found) is acceptable; the key
            # is that the literal file under static_dir is *never* disclosed.
            self.assertIn(status, (400, 404))

    def test_get_media_returns_404_for_unknown_hash(self):
        cookie = self.login_cookie()
        # Valid hex hash, but no file uploaded for it
        status, _, _ = self.request(
            "GET",
            "/media/" + "a" * 64 + ".png",
            headers={"Cookie": cookie},
        )
        self.assertEqual(status, 404)


class PurgeOfficialEndpointTests(unittest.TestCase):
    """POST /api/v1/sync/purge-official must require a sync Bearer, then
    call into ``CloudStore.purge_official_sessions`` and return the
    per-table deletion counts. Web cookies must not be enough."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.static_dir = Path(__file__).resolve().parents[2] / "electron" / "web-client"
        self._original_web_password = os.environ.get("WEFLOW_WEB_PASSWORD")
        os.environ["WEFLOW_WEB_PASSWORD"] = "web-secret"
        self.server = create_server(
            host="127.0.0.1",
            port=0,
            db_path=Path(self.tempdir.name) / "weflow.sqlite3",
            static_dir=self.static_dir,
            sync_token="sync-secret",
            session_secret="session-secret",
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        if self._original_web_password is None:
            os.environ.pop("WEFLOW_WEB_PASSWORD", None)
        else:
            os.environ["WEFLOW_WEB_PASSWORD"] = self._original_web_password
        self.tempdir.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request_headers = dict(headers or {})
        if payload is not None:
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, body=payload, headers=request_headers)
        response = connection.getresponse()
        data = response.read()
        result = response.status, dict(response.getheaders()), data
        connection.close()
        return result

    def login_cookie(self):
        status, headers, _ = self.request("POST", "/api/v1/auth/login", {"password": "web-secret"})
        self.assertEqual(status, 200)
        cookie = SimpleCookie()
        cookie.load(headers["Set-Cookie"])
        return f"weflow_session={cookie['weflow_session'].value}"

    def _seed_legacy_official_row(self, username: str) -> None:
        with self.server.store._lock, self.server.store._connection:
            self.server.store._connection.execute(
                "INSERT INTO sessions(username, display_name, last_timestamp, updated_at) "
                "VALUES (?, ?, ?, ?)",
                (username, username, 1, 0),
            )

    def test_purge_official_endpoint_requires_sync_token(self):
        # Web cookie alone is not enough.
        cookie = self.login_cookie()
        status, _, _ = self.request("POST", "/api/v1/sync/purge-official", {}, {"Cookie": cookie})
        self.assertEqual(status, 401)

    def test_purge_official_endpoint_removes_legacy_rows(self):
        self._seed_legacy_official_row("gh_legacy_one")
        self._seed_legacy_official_row("bot@openim.io")
        self.server.store.upsert_sessions([
            {"username": "wxid_alice", "displayName": "Alice", "lastTimestamp": 2},
        ])

        status, _, body = self.request(
            "POST",
            "/api/v1/sync/purge-official",
            {},
            {"Authorization": "Bearer sync-secret"},
        )
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["sessions"], 2)

        # /api/v1/sessions needs the web cookie + a query string.
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request("GET", "/api/v1/sessions?limit=100", headers={"Cookie": self.login_cookie()})
        response = connection.getresponse()
        data = response.read()
        connection.close()
        usernames = {row["username"] for row in json.loads(data)["sessions"]}
        self.assertIn("wxid_alice", usernames)
        self.assertNotIn("gh_legacy_one", usernames)
        self.assertNotIn("bot@openim.io", usernames)


class EnvironmentRestoreTests(unittest.TestCase):
    """The CloudHttpTests setUp writes ``WEFLOW_WEB_PASSWORD=web-secret``;
    tearDown must restore the previous value so we don't poison later
    test modules that share the same process."""

    def test_cloud_http_tests_teardown_restores_web_password_env(self):
        from test_server import CloudHttpTests

        sentinel = "env-restore-sentinel-12345"
        os.environ["WEFLOW_WEB_PASSWORD"] = sentinel
        try:
            suite = unittest.TestLoader().loadTestsFromTestCase(CloudHttpTests)
            # Must close the stream explicitly so the test process never
            # leaks the devnull TextIOWrapper (caught as a ResourceWarning).
            devnull_stream = open(os.devnull, "w")
            try:
                runner = unittest.TextTestRunner(stream=devnull_stream)
                runner.run(suite)
            finally:
                devnull_stream.close()
            self.assertEqual(os.environ.get("WEFLOW_WEB_PASSWORD"), sentinel)
        finally:
            os.environ.pop("WEFLOW_WEB_PASSWORD", None)


if __name__ == "__main__":
    unittest.main()
