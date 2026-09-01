# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A ranged request could be rejected with `LIMIT_INVALID`, taking the whole process
  with it** (`chunkPlan`). `upload.getFile` demands more than a 4096-aligned offset:
  the requested part must lie entirely inside one megabyte of the file. Offsets were
  aligned to 4096, so a seek into the middle of a video — `Range: bytes=5000000-`
  became offset 4997120 — asked for bytes 4997120..5521407 and straddled the 5 MB
  mark. Telegram answers that on the socket read loop rather than in reply to the
  call, so it never reached the route's try/catch: it surfaced as an unhandled
  rejection and killed the gateway for every account. Parts are now aligned to the
  part size, which divides a megabyte, so no request can straddle one. The cost is at
  most one extra part at the head of a range — bytes that were fetched anyway, since
  a part is the smallest thing Telegram will hand over.
- **An abandoned part could crash the gateway the same way** (`orderedParts`). Several
  parts travel at once; when the client hangs up, or the first one fails, the rest are
  dropped. Their rejections are ordinary — that is how every interrupted download
  ends — but a rejection with no handler ends the process. The handler is now attached
  when the request is made, not when it is dropped: the answer can arrive first.

### Changed

- **File streaming now pulls several parts at once** (`streamMedia`, `orderedParts`).
  `client.iterDownload()` issues one `upload.GetFile` at a time and waits for the
  answer before asking for the next, so throughput was capped at 512 KB per round
  trip to the data centre — never mind how wide the pipe is. Behind a proxy a round
  trip costs hundreds of milliseconds, and opening a video took as long as the
  round trips, not as long as the bytes. Four parts now travel at once and are
  handed out strictly in order (a reordered MP4 is not a slightly damaged video,
  it is a file no player opens). Measured end to end against Telegram through a
  proxy, the same 8.9 MB video went from 10.3 s (0.8 MB/s) to 1.6-2.9 s
  (3.0-5.3 MB/s). Eight parts in flight was tried and is slower than four, so
  four it is. Memory is unchanged: the queue holds four parts, not the file.
- **The media description is cached for two minutes** (`openMediaCached`). A player
  sends dozens of requests for one video — a probe, the start, every seek — and each
  one paid `getEntity` plus `getMessages` before the first byte could move: measured
  at 1.5-1.7 s per request through a proxy, gone on every repeat. The Telegram file
  reference outlives that window by hours, so the only thing the cache can go stale
  on is a message edited mid-playback.
- **Six simultaneous downloads per account instead of two** (`DOWNLOADS_PER_ACCOUNT`).
  A single player holds two connections by itself, so the third request — a seek, the
  next frame in the viewer — waited in a queue with nothing on screen to say so.

### Added

- **`LOG_MEDIA_TIMING`** writes one line per file response: how long the description
  took, when the first byte moved, and the resulting rate. The three numbers fail for
  different reasons and are fixed in different places; without the split, "video is
  slow" is a guess.
- **Read boundaries on every dialog** (`normalizeDialog`): `readInboxMaxId` and
  `readOutboxMaxId`. Telegram ships both inside the `messages.getDialogs` response
  already, so this costs no extra call — the fields simply were not passed on. Until
  now the only word a client ever got about the peer having read its messages was the
  `read_outbox` event, which fires once: miss it while the socket is reconnecting, or
  open the app on another device, and the second checkmark can never be drawn again.
  Note that teleproto's `Dialog` wrapper lifts only `unreadCount` to the top level;
  both boundaries live on the raw TL object at `dialog.dialog`.

## [1.1.0] - 2026-08-31

### Added

- **Media descriptions on every message** (`src/telegram/media.js`): `describeMedia()`
  returns `kind`, `mimeType`, `fileName`, `size`, `width`/`height`, `duration`,
  a decoded `waveform`, `thumbs[]` and the inline `stripped` preview. Without sizes
  known before the first byte, a client cannot draw a placeholder of the right shape,
  and the message list jumps as every image loads. `kind` is decided by document
  attributes rather than the mime type: a Telegram GIF is `video/mp4`, and a video
  sticker carries both video and sticker attributes.
- **`GET …/messages/:msgId/thumb?size=s|m`**: JPEG thumbnail with a strong `ETag` and
  a long `Cache-Control`. `If-None-Match` is checked before the download, so a cached
  thumbnail costs nothing on the Telegram side either.
- **New message fields** (`normalizeMessage`): `chatId` — always marked, the single
  honest chat key, closing the `peerId`/`fromId` ambiguity on the server side;
  `groupedId` (albums, kept as a string — a `long` of ~10^18 loses digits as a
  `Number`), `media`, `fwdFrom`, `viaBotId` and `senderName`.
- **`read_outbox` WebSocket event** (`src/telegram/listener.js`): fires when the peer
  reads our messages, carrying `peerId` and `maxId`. Without it a client cannot tell
  "delivered" from "read" and has to omit the second checkmark entirely.
- **CORS support** (`src/server/cors.js`), disabled by default and enabled through
  `CORS_ORIGINS`. An explicit origin allowlist rather than a wildcard: with an empty
  `ADMIN_TOKEN` the `POST /v1/accounts` endpoint is open, so a wildcard would let any
  page the user visits create accounts on their local gateway. The `Origin` check also
  covers the WebSocket handshake, which CORS rules do not reach.
- **Proxy support for the MTProto connection** (`src/telegram/proxyUrl.js`,
  `src/telegram/proxySocket.js`), configured with a single `PROXY_URL` plus
  `PROXY_TIMEOUT`. `socks5://`, `socks4://` and `mtproxy://` go through teleproto's own
  `proxy` option; `http://` and `https://` are implemented here, because the library
  supports neither — `PromisedNetSockets` rejects any descriptor without `socksType`.
  The HTTP transport plugs into the documented `networkSocket` extension point and
  speaks `CONNECT` over `node:net` / `node:tls`, with no new dependency. It subclasses
  `PromisedNetSockets` and overrides `connect` alone: the read machinery there is
  subtle, and a copy of it would drift from upstream. The proxy response header is
  read one byte at a time — bytes that arrive in the same TCP segment after the blank
  line are already MTProto frames and must not be swallowed. `Proxy-Authorization` is
  sent up front rather than after a `407`, since every data centre opens its own
  tunnel. A malformed `PROXY_URL` aborts startup instead of silently falling back to a
  direct connection, which would leak the real IP; passwords and MTProxy secrets never
  reach the log. Proxy failures map to `502`/`504` instead of `500`.
  `PROXY_FROM_ENV=true` additionally accepts the conventional `https_proxy` → `all_proxy` →
  `http_proxy` variables (either case, `PROXY_URL` still wins). It is opt-in on purpose: those
  variables are routinely set in a shell for unrelated tasks — `run.sh` already passes
  `--noproxy '*'` to `curl` because of them — and a gateway holding live Telegram sessions must
  not follow them silently. The startup line names the variable the settings came from.

### Changed

- **`GET …/messages/:msgId/file` streams instead of buffering** (`streamMedia`):
  `downloadMedia` used to build the whole file in memory, so a 200 MB video meant
  200 MB of gateway RSS — shared by every account on the process. The route now pulls
  chunks through `client.iterDownload()`, honours `Range` (`206` with `Content-Range`,
  `416` beyond the end), applies backpressure, and stops downloading as soon as the
  client disconnects. At most two concurrent downloads per account; the rest queue.
  Memory use no longer depends on file size: a test streams 512 MB and watches RSS —
  the buffered version grew by a full gigabyte on the same input.
- Raw-update classification extracted into the pure `classifyRawUpdate()` function so
  it can be tested without a live Telegram connection.

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

[Unreleased]: https://github.com/emaxe/apiGram/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/emaxe/apiGram/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/emaxe/apiGram/releases/tag/v1.0.0
