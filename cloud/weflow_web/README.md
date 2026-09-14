# WeFlow Cloud Read-only Mirror

This service stores a normalized, read-only cloud mirror of WeFlow sessions and
messages. The desktop sync agent sends data outward; browsers never connect to
the local WeChat database.

Security boundaries:

- `WEFLOW_SYNC_TOKEN` authorizes only `/api/v1/sync/*` ingestion routes.
- `WEFLOW_WEB_PASSWORD` creates an HttpOnly, Secure, SameSite cookie for read routes.
- There is intentionally no message-send API.
- The SQLite database is persisted in `./data` and is not exposed directly.

Copy `.env.example` to `.env`, create `cloudflared.config.yml` from
`cloudflared.yml.example`, place
the tunnel credential at `tunnel-credentials.json`, then run:

```sh
docker compose up -d --build
```

The origin remains bound to `127.0.0.1:18080`; Cloudflare Tunnel is the public
entry point.
