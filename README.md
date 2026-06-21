> ⚠️ **EDUCATIONAL PURPOSE ONLY** — This project is provided **as-is** for research and educational purposes. The author is **not responsible** for any misuse, ToS violations, or consequences resulting from the use of this software. Use at your own risk.

# postman2api

Standalone Postman AI proxy — converts Postman's agent chat API into an OpenAI + Anthropic-compatible endpoint with multi-account pooling, round-robin load balancing, and Camoufox browser-automated login.

## Quick Start

```bash
bun install
cd dashboard && bun install && bun run build && cd ..
cp .env.example .env
bun src/db/migrate.ts
bun start
```

- **Dashboard**: http://localhost:1930
- **API key**: set via `API_KEY` in `.env`
- **OpenAI**: `http://localhost:1930/v1/chat/completions`
- **Anthropic**: `http://localhost:1930/v1/messages`

## Login

```bash
python3 -m venv scripts/auth/.venv
source scripts/auth/.venv/bin/activate
pip install -r scripts/auth/requirements.txt

python3 scripts/auth/postman_login.py --email you@gmail.com --password pass
```

Or via dashboard: **Logs** panel → enter credentials → click **Login**.

## API Usage

```bash
# OpenAI
curl http://localhost:1930/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"Hello!"}],"stream":true}'

# Anthropic
curl http://localhost:1930/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'
```

## Models

`claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`, `gpt-5.5`, `gpt-5.4`, `gpt-5.2`, `auto`

Antropik `/v1/messages` accepts official Claude model IDs and normalizes them automatically.

## Features

- OpenAI `/v1/chat/completions` + Anthropic `/v1/messages` protocol
- SSE streaming with thinking/reasoning tokens
- Multi-account pool with round-robin
- Auto-switch on quota exhaustion
- WebSocket real-time dashboard
- Camoufox browser-automated Google OAuth login
- Postman signup onboarding automation (fill form, start trial)
- SQLite request logging

## Architecture

```
Client → Hono API → Account Pool (round-robin) → Postman Provider → Postman API
                         ↕
                    Dashboard (React) ← WebSocket
```

Bun + TypeScript + Hono + Drizzle/SQLite + React/Vite. Python + Camoufox for browser auth.

---

> ⚠️ **EDUCATIONAL PURPOSE ONLY** — This project is provided **as-is** for research and educational purposes. The author is **not responsible** for any misuse, ToS violations, or consequences resulting from the use of this software. Use at your own risk.
