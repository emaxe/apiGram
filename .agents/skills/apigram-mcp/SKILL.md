---
name: apigram-mcp
description: Use when an AI agent needs to drive a Telegram account through apiGram's MCP server — connecting an MCP client to it, or calling its tools (list_dialogs, get_chat, get_history, send_message, edit_message, delete_messages, mark_as_read, react, forward_messages, send_files, download_file) to read or send Telegram messages. Covers the Streamable HTTP handshake, MCP client config, the full tool reference, and the error shape.
---

# apiGram MCP

[apiGram](https://github.com/emaxe/apiGram) is a multi-user Telegram API
gateway (MTProto). Besides REST and WebSocket, it exposes an
[MCP](https://modelcontextprotocol.io) server so an agent can drive one
Telegram account directly — read chats, send messages and files, react,
forward — without a custom integration layer.

## Prerequisites

MCP does not create or authorize accounts — that stays REST-only. Before
connecting, you need an apiGram account that is already `authorized`
(phone + code, and 2FA password if enabled) and its `accountId` +
`apiToken`. See apiGram's README "Quick start" for the REST login flow
(`POST /accounts` → `auth/send-code` → `auth/verify-code` → optional
`auth/password`).

## Endpoint & auth

```
POST/GET/DELETE http://<host>:<port>/v1/accounts/<accountId>/mcp
Authorization: Bearer <apiToken>
```

Streamable HTTP transport. Same bearer token and account scoping as the
REST API — one MCP session always acts as one account. There is nothing
MCP-specific to provision beyond that token.

## Connect an MCP client

Any client that speaks Streamable HTTP and can send a custom header
works. For Claude Desktop / Claude Code, add to the client's MCP config:

```json
{
  "mcpServers": {
    "apigram": {
      "type": "http",
      "url": "http://127.0.0.1:3111/v1/accounts/acc_.../mcp",
      "headers": { "Authorization": "Bearer tok_..." }
    }
  }
}
```

## Manual handshake (no MCP client)

Plain JSON-RPC 2.0 over HTTP — useful to sanity-check a deployment:

```bash
MCP=http://127.0.0.1:3111/v1/accounts/$ACC/mcp
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
