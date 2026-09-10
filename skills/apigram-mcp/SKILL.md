---
name: apigram-mcp
description: Use when an AI agent needs to set up, configure, or drive a Telegram account through apiGram's MCP server — walking a user through locating their apiGram instance, creating/authorizing an account, and wiring up an MCP client, or calling its tools (list_dialogs, get_chat, get_history, send_message, edit_message, delete_messages, mark_as_read, react, forward_messages, send_files, download_file) to read or send Telegram messages. Covers the interactive setup wizard, the Streamable HTTP handshake, MCP client config, the full tool reference, and the error shape. apiGram has no fixed host — never assume localhost.
---

# apiGram MCP

[apiGram](https://github.com/emaxe/apiGram) is a multi-user Telegram API
gateway (MTProto). Besides REST and WebSocket, it exposes an
[MCP](https://modelcontextprotocol.io) server so an agent can drive one
Telegram account directly — read chats, send messages and files, react,
forward — without a custom integration layer.

## apiGram has no fixed address

apiGram can run anywhere: `localhost` on the same machine as the agent, a
box on the LAN, or a public host behind TLS with its own domain. **Never
assume `http://127.0.0.1:3111`.** Treat the base URL as unknown until the
user states it (or it's already visible in project config, an `.env`, or
an existing MCP client config) — same for `accountId` and `apiToken`,
which are always specific to one deployment and one Telegram account. The
setup wizard below is how to get all three when you don't have them yet.

## Setup wizard

Run this when the user asks to set up, connect, or configure apiGram MCP
and you don't already have a working base URL + `accountId` + `apiToken`
for their instance. Ask one question at a time — don't batch them, and
don't default to localhost or any other guess.

### 1. Locate the instance

Ask: "Where is your apiGram gateway running?" — a local address like
`http://127.0.0.1:3111`, or a full `https://` URL for anything remote.
Call this `BASE_URL` for the rest of the flow.

If you have shell/tool access, confirm it's reachable before going further:

```bash
curl -s $BASE_URL/v1/health
```

Expect `{"ok":true,"version":"..."}`. If that fails, the URL, port, or
network path is wrong — ask again rather than guessing a fix.

### 2. Get or create an account

Ask: "Do you already have an `accountId` and `apiToken` for this apiGram
instance?"

- **Yes** — collect both (call them `ACC` and `TOKEN`), skip to step 4.
- **No** — create one:

  ```bash
  curl -s -X POST $BASE_URL/v1/accounts -H 'content-type: application/json' -d '{"name":"my-agent"}'
  ```

  If the instance has `ADMIN_TOKEN` set, this returns `401
  admin_token_required` — ask the user for that admin token and retry with
  `-H "Authorization: Bearer $ADMIN_TOKEN"`. The response's `apiToken` is
  shown exactly once and never again: tell the user to save it somewhere
  durable (a password manager, not a chat transcript) before moving on.

### 3. Authorize the Telegram account

Skip this step if the account is already `authorized` — check with:

```bash
curl -s $BASE_URL/v1/accounts/$ACC/auth/status -H "Authorization: Bearer $TOKEN"
```

Otherwise this is a live, interactive login — the confirmation code comes
from Telegram to the user's phone, so it cannot be scripted around:

1. Ask for the phone number (`PHONE`), then:
   ```bash
   curl -s -X POST $BASE_URL/v1/accounts/$ACC/auth/send-code \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d "{\"phone\":\"$PHONE\"}"
   ```
2. Ask the user for the code they just received, then:
   ```bash
   curl -s -X POST $BASE_URL/v1/accounts/$ACC/auth/verify-code \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d "{\"code\":\"$CODE\"}"
   ```
3. If that response is `{"next":"password"}`, the account has 2FA enabled
   — ask for the password and:
   ```bash
   curl -s -X POST $BASE_URL/v1/accounts/$ACC/auth/password \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d "{\"password\":\"$PASSWORD\"}"
   ```
4. Success looks like `{"next":"done","me":{...}}`.

### 4. Wire up the MCP connection

You now have `BASE_URL`, `ACC`, `TOKEN`. The endpoint is:

```
$BASE_URL/v1/accounts/$ACC/mcp
```

Ask how the user wants to connect:

- **Through an MCP client's config** (Claude Desktop, Claude Code, Cursor,
  etc.) — fill in the real values in the "Connect an MCP client" template
  below. If you have write access to that client's config file and the
  user confirms the exact path, offer to write it yourself — but always
  show the change and get an explicit yes first, since it embeds a bearer
  token in a file.
- **No MCP client available** — use "Manual handshake" below as-is, with
  `BASE_URL`/`ACC`/`TOKEN` substituted for the real values.

### 5. Verify

Before declaring the setup done, run the manual handshake's steps 1-3
(`initialize` → `notifications/initialized` → `tools/list`) against the
real values. A `tools/list` response listing all 11 tools means the
connection works end to end.

Treat `TOKEN` like any other credential: don't print it in full more than
once, don't commit it to a repo, don't log it.

## Endpoint & auth

```
POST/GET/DELETE $BASE_URL/v1/accounts/$ACC/mcp
Authorization: Bearer $TOKEN
```

Streamable HTTP transport. Same bearer token and account scoping as the
REST API — one MCP session always acts as one account. There is nothing
MCP-specific to provision beyond the three values from the setup wizard
above.

## Connect an MCP client

Any client that speaks Streamable HTTP and can send a custom header
works. For Claude Desktop / Claude Code, add to the client's MCP config —
replace `<BASE_URL>`, `<ACC>`, `<TOKEN>` with the real values, never with
`127.0.0.1` or a placeholder account by default:

```json
{
  "mcpServers": {
    "apigram": {
      "type": "http",
      "url": "<BASE_URL>/v1/accounts/<ACC>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

## Manual handshake (no MCP client)

Plain JSON-RPC 2.0 over HTTP — useful to sanity-check a deployment. `ACC`
and `TOKEN` are whatever the setup wizard produced above:

```bash
MCP=$BASE_URL/v1/accounts/$ACC/mcp
AUTH="Authorization: Bearer $TOKEN"
ACCEPT='Accept: application/json, text/event-stream'
JSON='Content-Type: application/json'

# 1. Initialize — the response carries the session id in `mcp-session-id`
SID=$(curl -sD - -o /dev/null -X POST $MCP -H "$AUTH" -H "$ACCEPT" -H "$JSON" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}' \
  | tr -d '\r' | grep -i '^mcp-session-id:' | cut -d' ' -f2)

# 2. Acknowledge the handshake — required by the protocol, no response body
curl -s -o /dev/null -X POST $MCP -H "$AUTH" -H "$ACCEPT" -H "$JSON" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. List the available tools
curl -s -X POST $MCP -H "$AUTH" -H "$ACCEPT" -H "$JSON" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 4. Call one
curl -s -X POST $MCP -H "$AUTH" -H "$ACCEPT" -H "$JSON" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_message","arguments":{"peer":"me","text":"hello from MCP"}}}'

# 5. Close the session when done — apiGram keeps a session open until this
#    or the process restarts, there is no idle timeout
curl -s -X DELETE $MCP -H "$AUTH" -H "mcp-session-id: $SID"
```

## Tools

| Tool | Arguments | Description |
|---|---|---|
| `list_dialogs` | `limit?`, `archived?`, `query?` | List chats: private, group, channel |
| `get_chat` | `peer` | Chat/user card |
| `get_history` | `peer`, `limit?`, `offsetId?`, `reverse?` | Message history, paginated |
| `send_message` | `peer`, `text`, `replyTo?`, `topMsgId?`, `parseMode?`, `silent?`, `linkPreview?` | Send text |
| `edit_message` | `peer`, `messageId`, `text`, `parseMode?`, `linkPreview?` | Edit a sent message |
| `delete_messages` | `peer`, `ids[]`, `revoke?` | Delete messages |
| `mark_as_read` | `peer`, `maxId?` | Mark read up to `maxId` (0 or omitted = everything) |
| `react` | `peer`, `messageId`, `emoji?` | Emoji reaction |
| `forward_messages` | `toPeer`, `ids[]`, `fromPeer?` | Forward messages |
| `send_files` | `peer`, `files[]` (`{name, base64}`, up to 10), `caption?`, `replyTo?`, `forceDocument?` | Send one file or an album |
| `download_file` | `peer`, `messageId` | Metadata + a REST download link for an attachment — not the bytes |

`peer` accepts the same values everywhere: `@username`, a bare username, a
numeric ID, or `me`.

`download_file` never returns raw bytes inside the MCP response — that
would bloat the agent's context for no reason. It points back at apiGram's
own `GET /v1/accounts/:accountId/chat/:peer/messages/:msgId/file` endpoint,
which already streams with `Range` support, together with the bearer token
needed to fetch it.

## Errors

Tool failures come back as `isError: true` in the tool result, with the
body `{ error, message, step?, hint?, seconds? }` — the same shape apiGram's
REST API uses. A `not_authorized` error means the account has no active
Telegram session (re-run the REST login flow); `peer_not_found` means the
`peer` value doesn't resolve — for a numeric chat ID that was never seen
before, call `list_dialogs` first so apiGram can resolve it.
