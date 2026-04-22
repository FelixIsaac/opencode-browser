# OpenCode Browser — Claude Code Instructions

See [AGENTS.md](./AGENTS.md) for full agent behavioral guidance.

## Quick Setup (Claude Code global)

```bash
claude mcp add -s user browser -- node /path/to/opencode-browser/src/server.js
```

That's it — available in every Claude Code session.

## Key Reminders
- `browser_snapshot` before `browser_screenshot` — saves tokens
- `browser_wait_for_selector` before `browser_click` on any SPA
- Agent tabs open in a separate Chrome window — user's window is untouched
- Never switch to user's tabs without being asked
