import unittest
from pathlib import Path


class WebAssetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.static_dir = Path(__file__).resolve().parents[2] / "electron" / "web-client"
        cls.html = (cls.static_dir / "index.html").read_text("utf-8")
        cls.script = (cls.static_dir / "app.js").read_text("utf-8")
        cls.css = (cls.static_dir / "styles.css").read_text("utf-8")

    def test_browser_uses_cookie_login_without_persisting_privileged_tokens(self):
        self.assertIn("/api/v1/auth/login", self.script)
        self.assertIn('credentials: "same-origin"', self.script)
        self.assertNotIn("localStorage", self.script)
        self.assertNotIn("sessionStorage", self.script)

    def test_browser_reads_sessions_messages_and_realtime_events(self):
        self.assertIn("/api/v1/sessions", self.script)
        self.assertIn("/api/v1/messages", self.script)
        self.assertIn("/api/v1/push/messages", self.script)
        self.assertIn("EventSource", self.script)
        self.assertNotIn("/api/v1/messages/send", self.script)
        self.assertNotIn("sendMessage", self.script)
        self.assertIn("只读模式", self.html)

    def test_change_password_entry_and_modal_exist(self):
        # Visible entry point in the sidebar
        self.assertIn('id="account-button"', self.html)
        self.assertIn("账户", self.html)
        # Modal markup with current/new/confirm fields
        self.assertIn('id="change-password-overlay"', self.html)
        self.assertIn('id="current-password-input"', self.html)
        self.assertIn('id="new-password-input"', self.html)
        self.assertIn('id="confirm-password-input"', self.html)
        # Script wires the open/close/submit flow
        self.assertIn("/api/v1/auth/change-password", self.script)
        self.assertIn("openChangePassword", self.script)
        self.assertIn("submitChangePassword", self.script)
        # CSS gives the modal overlay / card real styles
        self.assertIn(".modal-overlay", self.css)
        self.assertIn(".modal-card", self.css)

    def test_passwords_never_touch_local_or_session_storage(self):
        # The script must not store or read any password from web storage.
        self.assertNotIn("localStorage", self.script)
        self.assertNotIn("sessionStorage", self.script)
        # And the change-password form must not persist anything either.
        self.assertNotIn("setItem", self.script)
        self.assertNotIn("getItem", self.script)


if __name__ == "__main__":
    unittest.main()
