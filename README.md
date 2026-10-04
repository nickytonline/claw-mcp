# claw-mcp

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that
wraps [OpenClaw](https://www.npmjs.com/package/openclaw)'s stdio MCP bridge
(`openclaw mcp serve`) and serves the OpenClaw agent workspace read-only, over
stateless Streamable HTTP. It is meant to sit behind an identity-aware proxy
such as [Pomerium](https://www.pomerium.com), which handles MCP OAuth and
per-tool policy.

Started from [mcp-typescript-template](https://github.com/nickytonline/mcp-typescript-template);
its history is kept here as the starting point.

## Tools

| Tool | Source | What it does |
|------|--------|--------------|
| `workspace_list` | wrapper | List files in the agent workspace (skips `.git`, `node_modules`) |
| `workspace_read` | wrapper | Read a text file, optionally a line range (max 1 MB, no binaries) |
| `workspace_search` | wrapper | Line search across workspace files (substring or regex) |
| `conversations_list`, `conversation_get` | bridge | Channel-routed OpenClaw conversations (Discord, Slack, Telegram...) |
| `messages_read`, `attachments_fetch` | bridge | Transcript and attachments for a session key |
| `events_poll`, `events_wait` | bridge | Live event queue since the bridge connected |
| `messages_send` | bridge | Reply through a conversation's existing channel route |
| `permissions_list_open`, `permissions_respond` | bridge | Pending exec/plugin approvals |

Bridge conversation tools only cover sessions with a channel route (a channel
plus a recipient). Web UI chats such as `agent:main:main` are not listed, but
`messages_read` works on them by session key.

## How it works

- **One shared bridge.** The HTTP side is stateless (MCP 2026-07-28: a fresh
  server per request), but the bridge's event queue only exists while it stays
  connected. So one `openclaw mcp serve` child is shared by all requests and
  respawned lazily if it exits (`src/openclaw.ts`).
- **Loopback + password.** A Gateway in `trusted-proxy` auth mode accepts only
  proxy-forwarded identity, plus `gateway.auth.password` from loopback callers.
  So the server runs in the Gateway's network namespace (a compose
  `network_mode: service:<gateway>` sidecar) and the bridge dials
  `ws://127.0.0.1:18789` with the password file.
- **Workspace tools run in the wrapper itself** (`src/workspace.ts`), reading
  a read-only mount of `~/.openclaw/workspace`. Paths are realpath-checked to
  stay inside the root.

Future direction: one bridge per proxy-authenticated user rather than one
shared bridge, so OpenClaw's own per-user scopes apply.

## Running

Build `Dockerfile.openclaw` with `OPENCLAW_VERSION` matching the Gateway and
`APP_UID` matching the Gateway's user (workspace files are mode 600):

```yaml
clawmcp:
  build:
    context: ../claw-mcp
    dockerfile: Dockerfile.openclaw
    args: [OPENCLAW_VERSION=2026.9.8, APP_UID=1001]
  environment:
    OPENCLAW_GATEWAY_PASSWORD_FILE: /run/clawmcp/gateway-password
    OPENCLAW_WORKSPACE_DIR: /workspace
  volumes:
    - ./gateway-password:/run/clawmcp/gateway-password:ro
    - ./state:/home/clawmcp/.openclaw
    - ./openclaw-home/.openclaw/workspace:/workspace:ro
  network_mode: service:openclaw-gateway
```

The MCP endpoint is `http://<gateway-host>:3000/mcp`; `GET /health` is a
liveness check.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `SERVER_NAME` / `SERVER_VERSION` | from `package.json` | MCP server identity |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `OPENCLAW_BIN` | `openclaw` | CLI used to spawn `openclaw mcp serve` |
| `OPENCLAW_GATEWAY_URL` | `ws://127.0.0.1:18789` | Gateway WebSocket (loopback for the password fallback) |
| `OPENCLAW_GATEWAY_PASSWORD_FILE` | — | File holding `gateway.auth.password` |
| `OPENCLAW_WORKSPACE_DIR` | — | Workspace to serve read-only; empty disables `workspace_*` |
| `OPENCLAW_EXCLUDED_TOOLS` | — | Comma-separated bridge tools to hide and refuse; prefer proxy tool policy |
| `OPENCLAW_CALL_TIMEOUT_MS` | `310000` | Per-call bridge timeout (`events_wait` can take 300s) |

## Development

```bash
npm install
npm run dev        # watch mode (needs the openclaw CLI on PATH)
npm run lint && npm run format:check && npm run build && npm run test:ci
```

See `AGENTS.md` for project structure and conventions.
