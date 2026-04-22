# OpenCode Browser

Browser automation for AI agents via Chrome extension + Native Messaging. Works with [OpenCode](https://github.com/opencode-ai/opencode), [Claude Code](https://claude.ai/code), and any MCP-compatible agent.

**Inspired by Claude in Chrome** — automation that runs inside your existing Chrome session, sharing your logins, cookies, and bookmarks. No separate profiles, no security prompts.

> Agent tabs open in a dedicated **OpenCode Agent** window (cyan tab group) so your browsing is never interrupted.

## Why not Playwright / DevTools?

Chrome 136+ blocks `--remote-debugging-port` on your default profile. DevTools-based tools trigger a security prompt every time. This project uses Chrome's Native Messaging API — the same approach Anthropic uses for Claude in Chrome — so automation works silently against your live session.

## Installation

```bash
npx @felixisaac/opencode-browser install
```

The installer will:
1. Copy the extension to `~/.opencode-browser/extension/`
2. Open Chrome so you can load the unpacked extension
3. Register the native messaging host (registry on Windows, NativeMessagingHosts dir on macOS/Linux)
4. Optionally update your `opencode.json` or `~/.claude/.mcp.json`

## Agent Setup

### OpenCode

Add to `opencode.json`:
```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["node", "/path/to/opencode-browser/src/server.js"],
      "enabled": true
    }
  }
}
```

### Claude Code (global)

Create `~/.claude/.mcp.json`:
```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/opencode-browser/src/server.js"],
      "type": "stdio"
    }
  }
}
```

Add to `~/.claude/settings.json`:
```json
{
  "enabledMcpjsonServers": ["browser"]
}
```

### Other MCP clients

Point your client at `src/server.js` as a stdio MCP server. No other configuration needed.

## Available Tools

| Tool | Description |
|------|-------------|
| `browser_snapshot` | **Start here.** Accessibility tree with CSS selectors — low token cost |
| `browser_screenshot` | Visual capture — use only when layout matters |
| `browser_navigate` | Navigate to a URL |
| `browser_click` | Click an element by CSS selector |
| `browser_type` | Type text into an input |
| `browser_keyboard` | Send key events (Enter, Escape, Tab, ctrl+a, …) |
| `browser_wait_for_selector` | Wait for element to appear (essential for SPAs) |
| `browser_scroll` | Scroll page or element into view |
| `browser_wait` | Wait for a fixed duration |
| `browser_execute` | Run JavaScript in page context |
| `browser_get_tabs` | List all open tabs |
| `browser_new_tab` | Open a new tab in the agent window |
| `browser_close_tab` | Close a tab |
| `browser_switch_tab` | Focus a tab (use to hand off to user) |
| `browser_new_window` | Open a new browser window |

## Agent Instructions

See [AGENTS.md](./AGENTS.md) for full behavioral guidance including:
- Snapshot-first workflow (token efficiency)
- Waiting for dynamic elements before clicking
- Hand-off pattern for login walls / CAPTCHAs
- Error recovery table
- Security blocklist behavior

Claude Code users: see [CLAUDE.md](./CLAUDE.md).

## Architecture

```
Agent ──MCP (stdio)──> src/server.js ──Named Pipe──> src/host.js ──Native Messaging──> extension/
                                                                                              │
                                                                         ┌────────────────────┤
                                                                         ▼                    ▼
                                                                   chrome.tabs         chrome.scripting
                                                                   chrome.windows      chrome.tabGroups
```

- **src/server.js** — MCP server; exposes tools to the agent
- **src/host.js** — Native messaging host; bridges pipe ↔ Chrome
- **extension/background.js** — Service worker; executes Chrome APIs

Multiple agents (Claude Code + OpenCode) can share one browser session simultaneously.

## Platform Support

| Platform | Status |
|----------|--------|
| Windows | ✓ (named pipe, registry) |
| macOS | ✓ |
| Linux | ✓ |

## Uninstall

```bash
npx opencode-browser uninstall
```

Then remove the extension from Chrome and optionally delete `~/.opencode-browser/`.

## Logs

```
~/.opencode-browser/logs/host.log
```

## License

MIT — forked from [benjaminshafii/opencode-browser](https://github.com/benjaminshafii/opencode-browser)
