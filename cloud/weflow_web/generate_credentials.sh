#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
env_path="$script_dir/.env"

if [ -e "$env_path" ]; then
  echo "Refusing to overwrite existing $env_path" >&2
  exit 1
fi

sync_token=$(openssl rand -hex 32)
web_password=$(openssl rand -base64 24 | tr -d '\n')
session_secret=$(openssl rand -hex 32)

umask 077
{
  printf 'WEFLOW_SYNC_TOKEN=%s\n' "$sync_token"
  printf 'WEFLOW_WEB_PASSWORD=%s\n' "$web_password"
  printf 'WEFLOW_SESSION_SECRET=%s\n' "$session_secret"
  printf 'WEFLOW_ACCESS_LOG=1\n'
} > "$env_path"

security add-generic-password \
  -U \
  -a 'wechat.ensiezadi.lol' \
  -s 'WeFlow Cloud Web' \
  -w "$web_password" >/dev/null

chmod 600 "$env_path"
echo "Created protected service credentials and stored the web password in macOS Keychain."
