# apiGram

[![npm version](https://img.shields.io/npm/v/apigram.svg)](https://www.npmjs.com/package/apigram)
[![node](https://img.shields.io/node/v/apigram.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/apigram.svg)](./LICENSE)

Multi-user Telegram API gateway (MTProto) — REST + WebSocket.

A single process keeps a pool of `TelegramClient` instances, one per account. Any client
application talks to it over plain HTTP and receives a realtime stream over WebSocket.

**Русская версия: [README.ru.md](./README.ru.md)**

---

## Table of contents

- [Install](#install)
- [The `run.sh` helper](#the-runsh-helper)
- [Environment variables](#environment-variables)
- [Quick start](#quick-start)
- [Endpoints](#endpoints)
- [WebSocket](#websocket)
- [Errors](#errors)
- [Security](#security)
- [Limitations](#limitations)
- [Tests](#tests)
- [Changelog](#changelog)

## Install

```bash
npm install apigram
```

Or clone and run from source:

```bash
git clone https://github.com/emaxe/apiGram.git
cd apiGram
npm install
cp .env.example .env      # set TELEGRAM_API_ID / TELEGRAM_API_HASH
npm start
```

API credentials come from https://my.telegram.org → API development tools.

Installed as a package, the gateway is also available as a binary:

```bash
npx apigram
```

Requires Node.js >= 18.

### The `run.sh` helper

The repository ships an interactive helper that covers every mode:

```bash
./run.sh              # menu
./run.sh <command>    # direct call, e.g. ./run.sh dev
```

| Command | Action |
|---|---|
| `install` | `npm ci` (from the lock file) or `npm install` |
| `start` | start the server, checking `.env`, dependencies and port availability |
| `dev` | start with auto-reload (`node --watch src/index.js`) |
| `test` | unit tests |
| `smoke` | end-to-end check against a live account (`scripts/smoke.mjs`) |
| `env` | print the configuration with secrets masked, create `.env` from the example |
| `health` | `GET /v1/health` against the address from `.env` |
| `doctor` | diagnostics: Node version, dependencies, credentials, data directory, port |
| `clean` | remove `node_modules` or the updates log |

The address used by `start` / `health` / `smoke` is read from `.env` rather than hard-coded.
`clean` never touches `data/accounts.json` — that file holds the Telegram sessions.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | — | required |
| `HOST` / `PORT` | `127.0.0.1` / `3111` | listen address |
| `ADMIN_TOKEN` | empty | required for `POST /v1/accounts`; empty = the endpoint is open (localhost only) |
| `DATA_DIR` | `./data` | account registry and updates log (mode `0600`) |
| `LOG_UPDATES` | `false` | write the update stream to `data/updates.jsonl` |
| `UPDATES_MAX_MB` | `50` | log rotation threshold |

## Quick start

```bash
BASE=http://127.0.0.1:3111/v1

# 1. Create an account — apiToken is shown exactly once
curl -X POST $BASE/accounts -H 'content-type: application/json' -d '{"name":"my"}'
# -> { "accountId": "acc_…", "apiToken": "tok_…", "status": "no_session" }

ACC=acc_…; TOKEN=tok_…
AUTH="Authorization: Bearer $TOKEN"

# 2. Log in: phone → code → (2FA, if enabled)
curl -X POST $BASE/accounts/$ACC/auth/send-code   -H "$AUTH" -H 'content-type: application/json' -d '{"phone":"+79991234567"}'
curl -X POST $BASE/accounts/$ACC/auth/verify-code -H "$AUTH" -H 'content-type: application/json' -d '{"code":"12345"}'
# -> { "next": "done", "me": {…} }  or  { "next": "password" }
curl -X POST $BASE/accounts/$ACC/auth/password    -H "$AUTH" -H 'content-type: application/json' -d '{"password":"…"}'

# 3. Send a message
curl -X POST $BASE/accounts/$ACC/chat/@username/messages -H "$AUTH" -H 'content-type: application/json' -d '{"text":"hello"}'

# 4. Send files (up to 10 at a time, form field is `files`)
curl -X POST $BASE/accounts/$ACC/chat/@username/files -H "$AUTH" -F files=@photo.jpg -F caption=Hi
```

## Endpoints

Everything except `POST /v1/accounts` and `GET /v1/health` requires
`Authorization: Bearer <apiToken>`.

```
GET    /v1/health                                     liveness probe

# Accounts and authorization
POST   /v1/accounts                                   create an account (ADMIN_TOKEN, if set)
GET    /v1/accounts                                   your own accounts
DELETE /v1/accounts/:id                               delete an account
POST   /v1/accounts/:id/auth/send-code                { phone } → code
POST   /v1/accounts/:id/auth/verify-code              { code } → { next: "done"|"password" }
POST   /v1/accounts/:id/auth/password                 { password } — 2FA
POST   /v1/accounts/:id/auth/logout                   log out (the session is revoked in Telegram)
GET    /v1/accounts/:id/auth/status                   { status, next?, me? }

# Profile
GET    /v1/accounts/:id/me                            getMe
POST   /v1/accounts/:id/me                            JSON { firstName, lastName, about }
                                                      or multipart with an `avatar` field
GET    /v1/accounts/:id/status                        { online, status }
POST   /v1/accounts/:id/status                        { online } — presence

# Dialogs and chats
GET    /v1/accounts/:id/dialogs?limit&archived&query
GET    /v1/accounts/:id/chat/:peer                    chat info
GET    /v1/accounts/:id/chat/:peer/history?limit&offsetId&reverse

# Messages
POST   /v1/accounts/:id/chat/:peer/messages           { text, replyTo? }
POST   /v1/accounts/:id/chat/:peer/files              multipart: files[], caption, replyTo, forceDocument
PATCH  /v1/accounts/:id/chat/:peer/messages/:msgId    { text }
DELETE /v1/accounts/:id/chat/:peer/messages?ids=1,2&revoke=true
POST   /v1/accounts/:id/chat/:peer/messages/:msgId/react   { emoji }
POST   /v1/accounts/:id/chat/:peer/read               { maxId }
POST   /v1/accounts/:id/chat/:peer/forward            { ids, fromPeer }
GET    /v1/accounts/:id/chat/:peer/messages/:msgId/file    download media
```

`:peer` is `@username`, `username`, a numeric ID (`-1001234567890`) or `me`.
Always pass it through `encodeURIComponent`.

## WebSocket

```
ws://127.0.0.1:3111/v1/ws?accountId=<id>&token=<apiToken>
```

Connecting spins up the Telegram client for the account if it is not running yet.
One account may hold several sockets — all of them receive the stream.

Events (`JSON`, every one carries `accountEvent: true`):

| `type` | Payload |
|---|---|
| `connected` | `accountId` — subscription confirmed |
| `new_message` / `edited_message` | `message` — normalized message |
| `deleted_messages` | `peerId`, `deletedIds` |
| `typing` | `chatId`, `userId`, `action` |
| `read_inbox` | `peerId`, `maxId` |
| `session_closed` | `reason` — logged out, the socket closes with code `4003` |
| `error` | `error` — session unavailable, the socket closes with code `4002` |

Close codes: `4001` — bad token or the account is not authorized,
`4002` — session unavailable, `4003` — logged out.

## Errors

`{ error, message, step?, hint?, seconds? }`.

| Status | When |
|---|---|
| 400 | invalid payload, or the login steps are out of order (`step` names the expected one) |
| 401 | missing or wrong `apiToken` |
| 403 | no access to the chat |
| 404 | chat, message or media not found |
| 409 | the account is not authorized, or the session was revoked |
| 429 | `flood_wait`, `seconds` says how long to wait |

## Security

- **Sessions are credentials.** `data/accounts.json` holds `sessionString` values that grant
  full access to the Telegram accounts. The file is written with mode `0600` and the whole
  `data/` directory is git-ignored. Never commit it, never move it into a synced folder.
- **`ADMIN_TOKEN` gates account creation.** While it is empty, `POST /v1/accounts` is open to
  anyone who can reach the port. That is acceptable only on `127.0.0.1`; the server prints a
  warning at startup if it listens elsewhere without the token.
- **`apiToken` is shown exactly once**, in the `POST /v1/accounts` response. It is not
  recoverable — a lost token means deleting and recreating the account.
- **`LOG_UPDATES=true` writes message text to disk** (`data/updates.jsonl`). It is off by
  default; keep it that way unless you actually need the audit trail.
- **No TLS, no CORS.** Put the gateway behind a reverse proxy before exposing it.

## Limitations

- Sessions are stored as a `StringSession` with no entity cache: after a restart, addressing a
  chat by numeric ID may return `peer_not_found` — call `GET /dialogs` first to warm the cache.
- Registering new phone numbers, calls, secret chats and email login are not supported.
- CORS is not configured: a browser client needs a proxy.

## Tests

```bash
npm test
```

Note: the registry tests currently write to the live `data/accounts.json` (see
`test/unit.test.js`).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

ISC
