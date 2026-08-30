# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-08-30

First public release.

### Added

- **REST API** over Express: accounts, step-by-step authorization, profile, dialogs,
  chats, messages, media and presence. Every route lives under `/v1`.
- **Multi-account session pool** (`src/telegram/sessionManager.js`): one `TelegramClient`
  per account, created lazily and reused across requests and sockets. Concurrent
  `getClient` calls for the same account are guarded so only one client is built.
- **Step-auth state machine** (`src/telegram/auth.js`): `send-code` → `verify-code` →
  `password` (2FA) → `logout`, with the account status persisted between steps so a
  restart does not lose a half-finished login.
- **WebSocket stream** at `/v1/ws`: `new_message`, `edited_message`, `deleted_messages`,
  `typing`, `read_inbox`, `session_closed`. Several sockets may follow one account;
  connecting spins up the Telegram client if it is not running yet. Keepalive ping/pong
  drops dead sockets.
- **Bearer authorization**: an `apiToken` per account, plus `ADMIN_TOKEN` guarding
  registry operations (`POST /v1/accounts`).
- **HTTP error mapping** (`src/server/httpErrors.js`): MTProto failures become
  400/401/403/404/409/429 with `step`, `hint` and `seconds` instead of a blanket 500.
  Long `FLOOD_WAIT` is reported as 429 rather than held inside the request.
- **JSONL update log** with size-based rotation, off by default
  (`LOG_UPDATES`, `UPDATES_MAX_MB`).
- **Atomic registry writes** (tmp file + rename) with mode `0600` on
  `data/accounts.json`.
- **Graceful shutdown** on SIGINT/SIGTERM: sockets closed, clients disconnected
  (disconnect, never logout — logout would revoke the Telegram sessions).
- **`run.sh`** — interactive helper: `install`, `start`, `dev`, `test`, `smoke`, `env`,
  `health`, `doctor`, `clean`. Reads the address from `.env`, masks secrets on screen.
- **`scripts/smoke.mjs`** — end-to-end check against a live account: login, send,
  update stream, file upload and download.
- **`GET /v1/health`** liveness probe.
- 11 unit tests (`npm test`) covering the error mapper, serialization and the session
  channel contract.

### Fixed

- `verifyCode` / `verifyPassword` rewritten onto raw TL calls (`Api.auth.SignIn`,
  `account.GetPassword` + `computeCheck` + `auth.CheckPassword`). The high-level
  `signInUser` intercepts `SESSION_PASSWORD_NEEDED` itself and always threw
  "Account has 2FA enabled" without a password callback, while `signInWithPassword`
  expects a function rather than a string — the 2FA steps did not work at all. A missing
  mandatory `onError` also turned a wrong code into a `TypeError` instead of
  `PHONE_CODE_INVALID`.
- `sendFiles` wraps `{name, buffer}` into `CustomFile`; `sendFile` rejects a plain object
  and failed with "Cannot use [object Object] as file".
- WebSocket connections now build the client through `sessionManager.getClient`. The
  update listener is registered only there, so a freshly started server emitted no events
  into the socket until the first REST request arrived.
- `sessionManager.release()` emits `session_closed` instead of dropping the account
  channel, so subscribed sockets are not left on an emitter nobody uses after re-login.
- `registerAuthorized` no longer destroys the client it just promoted.
- `markAsRead(entity, maxId)` replaces the non-existent `sendReadAcknowledge`.
- Entities are serialized JSON-safe (`BigInt` → string) before reaching the wire.
- Re-registering an account stops the previous update listener instead of stacking a
  second one.
- `downloadMedia` returns the real MIME type and a `Content-Disposition` filename.

[Unreleased]: https://github.com/emaxe/apiGram/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/emaxe/apiGram/releases/tag/v1.0.0
