# Security

Open Media Explorer runs a local HTTP server bound to `127.0.0.1`.

The `/api/proxy` endpoint is restricted to a hard-coded allowlist for the
public media sources used by the app. It rejects non-HTTPS URLs, private or
loopback DNS targets, and redirects to hosts outside the allowlist.

Do not add broad proxy behavior or user-supplied arbitrary upstream hosts.
