#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import stat
import sys
from pathlib import Path


def parse_env_file(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip()
    return result


def validate_local_config(config_path: Path) -> None:
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    if payload.get("httpApiEnabled") is not True:
        raise RuntimeError("WeFlow HTTP API service is not enabled")
    if payload.get("messagePushEnabled") is not True:
        raise RuntimeError("WeFlow message push is not enabled")
 

def read_local_token_file(token_path: Path) -> str:
    token = token_path.read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError("WeFlow HTTP API Token is not configured")
    return token


def build_launch_agent(run_script: Path, stdout_path: Path, stderr_path: Path) -> dict[str, object]:
    return {
        "Label": "com.weflow.cloud-sync",
        "ProgramArguments": ["/bin/sh", str(run_script)],
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 15,
        "StandardOutPath": str(stdout_path),
        "StandardErrorPath": str(stderr_path),
        "ProcessType": "Background",
    }


def install(
    source_agent: Path,
    cloud_env_path: Path,
    local_config_path: Path,
    local_token_path: Path,
    cloud_url: str,
    install_dir: Path,
    launch_agent_path: Path,
    python_executable: Path,
) -> None:
    cloud_env = parse_env_file(cloud_env_path)
    cloud_token = cloud_env.get("WEFLOW_SYNC_TOKEN", "")
    if not cloud_token:
        raise RuntimeError("cloud environment does not contain WEFLOW_SYNC_TOKEN")
    validate_local_config(local_config_path)
    local_token = read_local_token_file(local_token_path)

    install_dir.mkdir(parents=True, exist_ok=True)
    logs_dir = install_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    agent_path = install_dir / "sync_agent.py"
    shutil.copy2(source_agent, agent_path)
    agent_path.chmod(0o700)

    env_path = install_dir / ".env"
    previous_umask = os.umask(0o077)
    try:
        env_path.write_text(
            "\n".join(
                [
                    f"WEFLOW_LOCAL_API_TOKEN={local_token}",
                    "WEFLOW_LOCAL_URL=http://127.0.0.1:5031",
                    f"WEFLOW_CLOUD_URL={cloud_url.rstrip('/')}",
                    f"WEFLOW_CLOUD_SYNC_TOKEN={cloud_token}",
                    "WEFLOW_BOOTSTRAP_DAYS=30",
                    "WEFLOW_SYNC_INTERVAL=30",
                    "",
                ]
            ),
            encoding="utf-8",
        )
    finally:
        os.umask(previous_umask)
    env_path.chmod(0o600)

    run_path = install_dir / "run.sh"
    run_path.write_text(
        "#!/bin/sh\n"
        "set -a\n"
        f". '{env_path}'\n"
        "set +a\n"
        f"exec '{python_executable}' '{agent_path}'\n",
        encoding="utf-8",
    )
    run_path.chmod(0o700)

    launch_agent_path.parent.mkdir(parents=True, exist_ok=True)
    plist_payload = build_launch_agent(
        run_path,
        logs_dir / "stdout.log",
        logs_dir / "stderr.log",
    )
    with launch_agent_path.open("wb") as handle:
        plistlib.dump(plist_payload, handle, sort_keys=True)
    launch_agent_path.chmod(0o600)

    if stat.S_IMODE(env_path.stat().st_mode) != 0o600:
        raise RuntimeError("failed to protect local sync environment")


def main() -> None:
    home = Path.home()
    parser = argparse.ArgumentParser(description="Install the WeFlow macOS cloud sync agent")
    parser.add_argument("--cloud-env", required=True, type=Path)
    parser.add_argument("--local-token-file", required=True, type=Path)
    parser.add_argument("--cloud-url", required=True)
    parser.add_argument(
        "--weflow-config",
        type=Path,
        default=home / "Library" / "Application Support" / "weflow" / "WeFlow-config.json",
    )
    parser.add_argument(
        "--install-dir",
        type=Path,
        default=home / "Library" / "Application Support" / "weflow" / "cloud-sync",
    )
    parser.add_argument(
        "--launch-agent",
        type=Path,
        default=home / "Library" / "LaunchAgents" / "com.weflow.cloud-sync.plist",
    )
    args = parser.parse_args()
    install(
        Path(__file__).with_name("sync_agent.py"),
        args.cloud_env,
        args.weflow_config,
        args.local_token_file,
        args.cloud_url,
        args.install_dir,
        args.launch_agent,
        Path(sys.executable),
    )
    print("Installed WeFlow cloud sync agent without exposing credentials.")


if __name__ == "__main__":
    main()
