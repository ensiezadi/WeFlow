import json
import plistlib
import stat
import tempfile
import unittest
from pathlib import Path

from macos_sync_installer import build_launch_agent, install, parse_env_file, read_local_token_file


class MacSyncInstallerTests(unittest.TestCase):
    def test_parse_env_preserves_values_after_first_equals(self):
        with tempfile.TemporaryDirectory() as tempdir:
            path = Path(tempdir) / ".env"
            path.write_text("TOKEN=abc=def\n# ignored\n", encoding="utf-8")
            self.assertEqual(parse_env_file(path), {"TOKEN": "abc=def"})

    def test_local_token_is_read_from_temporary_plaintext_file(self):
        with tempfile.TemporaryDirectory() as tempdir:
            token_path = Path(tempdir) / "local-token"
            token_path.write_text("plain-token-from-weflow\n", encoding="utf-8")
            self.assertEqual(read_local_token_file(token_path), "plain-token-from-weflow")

    def test_install_keeps_secrets_out_of_launch_agent(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            source_agent = root / "source_agent.py"
            source_agent.write_text("print('agent')\n", encoding="utf-8")
            cloud_env = root / "cloud.env"
            cloud_env.write_text("WEFLOW_SYNC_TOKEN=cloud-secret\n", encoding="utf-8")
            local_config = root / "WeFlow-config.json"
            local_config.write_text(json.dumps({
                "httpApiEnabled": True,
                "messagePushEnabled": True,
                "httpApiToken": "encrypted-value-must-not-be-used",
            }), encoding="utf-8")
            local_token = root / "local-token"
            local_token.write_text("local-secret\n", encoding="utf-8")
            install_dir = root / "install"
            plist_path = root / "LaunchAgents" / "com.weflow.cloud-sync.plist"

            install(
                source_agent,
                cloud_env,
                local_config,
                local_token,
                "https://wechat.example.test",
                install_dir,
                plist_path,
                Path("/opt/homebrew/bin/python3"),
            )

            plist_text = plist_path.read_text(encoding="utf-8")
            self.assertNotIn("cloud-secret", plist_text)
            self.assertNotIn("local-secret", plist_text)
            self.assertEqual(stat.S_IMODE((install_dir / ".env").stat().st_mode), 0o600)
            self.assertIn("WEFLOW_LOCAL_API_TOKEN=local-secret", (install_dir / ".env").read_text(encoding="utf-8"))
            self.assertNotIn("encrypted-value-must-not-be-used", (install_dir / ".env").read_text(encoding="utf-8"))
            with plist_path.open("rb") as handle:
                payload = plistlib.load(handle)
            self.assertEqual(payload["Label"], "com.weflow.cloud-sync")
            self.assertTrue(payload["RunAtLoad"])
            self.assertIn(
                "exec '/opt/homebrew/bin/python3'",
                (install_dir / "run.sh").read_text(encoding="utf-8"),
            )

    def test_launch_agent_restarts_only_after_failure(self):
        payload = build_launch_agent(Path("/tmp/run.sh"), Path("/tmp/out"), Path("/tmp/err"))
        self.assertEqual(payload["KeepAlive"], {"SuccessfulExit": False})


if __name__ == "__main__":
    unittest.main()
