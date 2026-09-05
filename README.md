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
- [Browser clients](#browser-clients)
- [Proxy](#proxy)
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
| `start:proxy` | start the server via proxy (cached in `data/.proxy`) |
| `dev` | start with auto-reload (`node --watch src/index.js`) |
| `dev:proxy` | start with auto-reload via proxy |
| `test` | unit tests |
| `smoke` | end-to-end check against a live account (`scripts/smoke.mjs`) |
| `proxy` | configure, show or reset the cached proxy |
| `env` | print the configuration with secrets masked, create `.env` from the example |
| `health` | `GET /v1/health` against the address from `.env` |
| `doctor` | diagnostics: Node version, dependencies, credentials, data directory, port |
| `clean` | remove `node_modules`, updates log, or proxy cache |

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
| `LOG_MEDIA_TIMING` | `false` | log one timing line per file response: description, first byte, rate |
| `CORS_ORIGINS` | empty | origins allowed to make browser requests (comma-separated); empty = CORS disabled |
| `PROXY_URL` | empty | proxy for the MTProto connection: `socks5://`, `socks4://`, `http://`, `https://`, `mtproxy://`; empty = direct connection |
| `PROXY_TIMEOUT` | `5` | proxy connection timeout, seconds |
| `PROXY_FROM_ENV` | `false` | when `PROXY_URL` is empty, take the proxy from `https_proxy` → `all_proxy` → `http_proxy` (either case) |

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
POST   /v1/accounts/:id/chat/:peer/messages           { text, replyTo?, topMsgId?, quoteText?, quoteOffset?, parseMode?, silent?, linkPreview?, schedule? }
POST   /v1/accounts/:id/chat/:peer/files              multipart: files[], caption, replyTo, topMsgId, forceDocument, parseMode, silent
PATCH  /v1/accounts/:id/chat/:peer/messages/:msgId    { text, parseMode?, linkPreview? }
DELETE /v1/accounts/:id/chat/:peer/messages?ids=1,2&revoke=true
POST   /v1/accounts/:id/chat/:peer/messages/:msgId/react   { emoji }
POST   /v1/accounts/:id/chat/:peer/messages/:msgId/pin     { silent?, oneSide? } — pin message
DELETE /v1/accounts/:id/chat/:peer/messages/:msgId/pin     unpin message
DELETE /v1/accounts/:id/chat/:peer/pin?topMsgId=           unpin all messages (or in topic)
POST   /v1/accounts/:id/chat/:peer/read               { maxId }
POST   /v1/accounts/:id/chat/:peer/forward            { ids, fromPeer }
GET    /v1/accounts/:id/chat/:peer/avatar?size=small|big   download avatar (ETag)
GET    /v1/accounts/:id/chat/:peer/messages/:msgId/file    download media (Range)
GET    /v1/accounts/:id/chat/:peer/messages/:msgId/thumb?size=s|m   thumbnail (ETag)
```

`:peer` is `@username`, `username`, a numeric ID (`-1001234567890`) or `me`.
Always pass it through `encodeURIComponent`.

### Media

`GET …/messages/:msgId/file` streams and honours `Range`: a range yields `206`
with `Content-Range`, a request past the end of file yields `416`. Parts are
pulled from Telegram several at a time — behind a proxy that is several times
faster than one round trip per part. At most six concurrent downloads per
account; the rest queue. A dropped connection stops the download from Telegram
too.

`GET …/messages/:msgId/thumb?size=s|m` returns a JPEG crop: `s` — the smallest,
`m` — the smallest preview sharp enough for a bubble (long side ≥ 1280 px). The
response carries a strong `ETag`; a matching `If-None-Match` returns `304`
without downloading from Telegram at all. Media without crops answers
`404 no_thumb`; an instant blurry preview then lives in the message itself, in
`media.stripped`.

Every message describes its attachment: `media.{kind, mimeType, fileName, size,
width, height, duration, waveform, thumbs, stripped, downloadable}` — sizes are
known before the download, so a placeholder can be drawn right away. Alongside it
came `chatId` (always marked), `groupedId` (albums), `fwdFrom`, `viaBotId` and
`senderName`.

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
| `reactions` | `chatId`, `msgId`, `topMsgId`, `reactions[]` — message reactions |
| `pinned_messages` | `chatId`, `pinned`, `messages[]` — pinned/unpinned messages |
| `user_status` | `userId`, `status`, `online`, `wasOnline`, `expires` — online status |
| `read_inbox` | `peerId`, `maxId` — we read the peer's messages |
| `read_outbox` | `peerId`, `maxId` — the peer read our messages |
| `session_closed` | `reason` — logged out, the socket closes with code `4003` |
| `error` | `error` — session unavailable, the socket closes with code `4002` |

Both read boundaries also come with every dialog in `GET /dialogs`
(`readInboxMaxId`, `readOutboxMaxId`). An update fires once: a client that was
not listening at that moment — or was not installed yet — has no other way to
learn what the peer has already read.

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
| 502 | the proxy refused or dropped the tunnel (`proxy_unreachable`, `proxy_auth_required`, `proxy_forbidden`, `proxy_connect_failed`, `proxy_protocol_error`) |
| 504 | `proxy_timeout` — the proxy did not answer within `PROXY_TIMEOUT` |

## Browser clients

CORS is disabled by default, so no web page can reach the gateway. That default is
deliberate: the gateway holds live Telegram sessions.

To allow a web client, list the origins:

```bash
CORS_ORIGINS=http://127.0.0.1:8080
```

A list, not `*`. With an empty `ADMIN_TOKEN` the `POST /v1/accounts` endpoint is
open, so a wildcard would let any page the user visits create accounts on their
local gateway. `*` is supported but warns on startup.

The `Origin` check also covers WebSocket: CORS rules do not apply to the handshake,
so the origin is verified manually. Clients that send no `Origin` (`curl`, mobile
and desktop builds, `scripts/smoke.mjs`) are unaffected.

## Proxy

MTProto can be routed through a proxy. One variable covers every scheme; authentication is
optional everywhere, and special characters in the password are percent-encoded
(`@` → `%40`, `:` → `%3A`):

```bash
PROXY_URL=socks5://user:pass@127.0.0.1:1080   # also socks4://
PROXY_URL=http://user:pass@127.0.0.1:3128     # HTTP CONNECT
PROXY_URL=https://127.0.0.1:8443              # the same, TLS to the proxy itself
PROXY_URL=mtproxy://<secret>@1.2.3.4:443      # Telegram's own proxy (or ?secret=…)
PROXY_TIMEOUT=5                               # connection timeout, seconds
```

`socks4`/`socks5` and `mtproxy` use teleproto's own transport. `http`/`https` are implemented
here — the library supports neither — as a `CONNECT` tunnel over `node:net` / `node:tls`, with
no extra dependency. A self-signed proxy certificate is accepted only with an explicit
`https://host:8443?insecure=1`.

The proxy is global: every account shares it, and media downloads from other data centres go
through it too. A malformed value aborts startup rather than silently falling back to a direct
connection, which would leak the real IP. Passwords and MTProxy secrets never reach the log.

The system `https_proxy` / `all_proxy` / `http_proxy` variables are read only with
`PROXY_FROM_ENV=true`, in that order and in either case; `PROXY_URL` always wins. They are
opt-in because such variables are routinely set in a shell for unrelated tasks, and a gateway
holding live Telegram sessions must not follow them silently. The startup line names the
variable the settings came from:

```
apiGram proxy: socks5://10.0.0.9:1080 (without auth) (from all_proxy, timeout 5 s)
```

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
- **No TLS.** Put the gateway behind a reverse proxy before exposing it.
  CORS exists but is disabled by default — see "Browser clients".

## Limitations

- Sessions are stored as a `StringSession` with no entity cache: after a restart, addressing a
  chat by numeric ID may return `peer_not_found` — call `GET /dialogs` first to warm the cache.
- Registering new phone numbers, calls, secret chats and email login are not supported.
- The proxy is global: all accounts share the same connection, there is no per-account setting.
- The system `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY` variables are ignored unless
  `PROXY_FROM_ENV=true`. They are often set in a shell for unrelated tasks, and live Telegram
  sessions should not follow them silently; `PROXY_URL` always wins. The startup line names the
  variable the settings came from.
- An HTTP proxy must support `CONNECT`; proxies that only allow it on port 443 answer with
  `proxy_forbidden`. Proxy errors surface as `502` (`504` on timeout).
- `mtproxy://` has no connection timeout of its own: teleproto ignores `PROXY_TIMEOUT` on that path,
  so a dead MTProxy stalls until the OS timeout (~75 s).
- CORS is off by default: a browser client cannot reach the gateway until its origin is
  listed in `CORS_ORIGINS` — see "Browser clients".

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
