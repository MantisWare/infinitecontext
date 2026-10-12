# Phase 1 account auth

Phase 1 adds **account-based authentication** alongside existing `ic_live_` / `ic_test_` API keys. Login passwords are hashed with **Argon2id on the server** for authentication only; they are intentionally **separate** from the future vault key derivation described in [plan §7.1](/docs/plan/infinitecontext-plan.md).

## Server environment

| Variable | Purpose |
|----------|---------|
| `INFINITECONTEXT_JWT_SECRET` | HS256 secret for access JWTs (≥32 bytes; required for auth routes) |
| `INFINITECONTEXT_JWT_ISSUER` / `INFINITECONTEXT_JWT_AUDIENCE` | Access token `iss` / `aud` validation |
| `INFINITECONTEXT_MAIL_PROVIDER` | `resend` (Workers + Node) or `smtp` (Node only) |
| `INFINITECONTEXT_ALLOW_CONSOLE_MAILER` | Set `true` in dev/test to log verification links to stdout (ignored in production) |
| `INFINITECONTEXT_TRUSTED_PROXY` | Set `true` on Node when behind a reverse proxy so rate limits use `X-Forwarded-For` / `X-Real-IP` |
| `INFINITECONTEXT_ACCESS_TOKEN_TTL_SEC` | Access token lifetime (default `900`) |
| `INFINITECONTEXT_REFRESH_TOKEN_TTL_SEC` | Refresh/session lifetime (default `604800` = 7 days) |
| `INFINITECONTEXT_AUTH_PUBLIC_BASE_URL` | Public API URL used in verification/reset links |
| `INFINITECONTEXT_GOOGLE_CLIENT_ID` | Google OAuth client id |
| `INFINITECONTEXT_GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

Email verification and password reset use a pluggable mailer. In dev/test, enable the console mailer with `INFINITECONTEXT_ALLOW_CONSOLE_MAILER=true` or configure Resend/SMTP.

## Database

Auth tables live in Postgres (`users`, `identities`, `sessions`, `auth_tokens`, OAuth helper tables, and a placeholder `user_crypto` row set for Phase 2). Apply via:

```bash
pnpm infinitecontext:db:migrate
```

## CLI

```bash
infinitecontext login                      # email + password
infinitecontext login --google             # Google device authorization flow
infinitecontext login --google --localhost # Google OAuth via http://127.0.0.1:53682/callback
infinitecontext logout
infinitecontext whoami
```

Session tokens are stored in `~/.infinitecontext/credentials.json` with file mode `0600`. The sync daemon accepts either a saved session or `INFINITECONTEXT_API_KEY`.

## API surface

- `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`
- `GET /auth/me` (Bearer access JWT)
- `POST /auth/request-password-reset`, `POST /auth/reset-password`, `GET|POST /auth/verify-email`
- Google: `POST /auth/oauth/google/device/start`, `POST /auth/oauth/google/device/poll`, `GET /auth/oauth/google/authorize`, `POST /auth/oauth/google/callback`

Context routes accept **either** API keys or access JWTs; JWT auth maps to the user's dedicated project.
