#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
env_path="$script_dir/.env"

if [ -e "$env_path" ]; then
  echo "Refusing to overwrite existing $env_path" >&2
  exit 1
fi

umask 077
{
  printf 'WEFLOW_SYNC_TOKEN=%s\n' "$(openssl rand -hex 32)"
  printf 'WEFLOW_WEB_PASSWORD=%s\n' "$(openssl rand -base64 24 | tr -d '\n')"
  printf 'WEFLOW_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)"
  printf 'WEFLOW_ACCESS_LOG=1\n'
} > "$env_path"

chmod 600 "$env_path"
echo "Created protected server credentials."
