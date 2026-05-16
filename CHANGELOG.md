# Changelog

## 1.2.0 — 2026-05-16

### Added

**History & Bookmarks** (`history` + `bookmarks` permissions)
- `browser_search_history` — search by keyword, URL, date range
- `browser_recent_browsing` — visits from last N hours
- `browser_history_stats` — total entries, date range, top 20 domains
- `browser_get_bookmarks` — full bookmarks tree (read-only)

**Tab Groups** (`tabGroups` permission, already granted)
- `browser_get_tab_groups` — list all groups with colors, titles, member tabs
- `browser_create_tab_group` — create group from tab IDs with title + color
- `browser_update_tab_group` — rename, recolor, collapse/expand
- `browser_move_to_group` — move tabs into an existing group

**CDP Tools** (`debugger` permission, already granted)
- `browser_print_to_pdf` — print page to PDF via `Page.printToPDF` (base64)
- `browser_performance` — CDP Performance domain metrics (heap, DOM nodes, layout count)
- `browser_device_emulate` — mobile viewport emulation via `Emulation.*`; reset to desktop with `reset=true`

**Page Utilities** (no new permissions)
- `browser_page_text` — extract `innerText` from a tab; cheaper than snapshot for reading tasks
- `browser_deduplicate_tabs` — find and close duplicate-URL tabs (supports `dryRun`)
- `browser_open_batch` — open up to 20 URLs as tabs in one call
- `browser_storage_inspect` — read `localStorage` or `sessionStorage` from a tab

**Session Management** (`storage` permission, already granted)
- `browser_session_save` — snapshot all open tab URLs to Chrome storage by name
- `browser_session_restore` — reopen a saved session (skips blocklisted URLs)

**Browser Utilities**
- `browser_notify` — send a Chrome desktop notification with optional buttons
- `browser_storage_read` — read Chrome extension storage (local or sync)
- `browser_downloads` — list recent downloads (`downloads` permission added)

## 1.1.0 — 2026-04-26

### Added
- Per-session tab ownership claims (ported from opencode-browser v4)
- New MCP tools: `browser_status`, `browser_list_claims`, `browser_claim_tab`, `browser_release_tab`, `browser_open_tab`
- Auto-create default agent tab per MCP client session
- OpenCode skill file (`.opencode/skills/tandem/SKILL.md`)
- MCP tool annotations on all tools (destructiveHint, readOnlyHint, idempotentHint, openWorldHint)

### Changed
- `browser_new_tab` default `active` changed from `true` to `false` (non-interference)
- Tab claims enforced on ALL explicit `tabId` tools including `close_tab`/`switch_tab`
- Session IDs now use `crypto.randomBytes()` instead of `Math.random()`
- Claim cleanup uses deterministic request tracking instead of regex parsing

### Security
- Fixed: claim enforcement bypass on tab management tools
- Fixed: insecure randomness for session IDs

## 1.0.0 — 2026-04-24

First published release. Fork of [benjaminshafii/opencode-browser](https://github.com/benjaminshafii/opencode-browser) rewritten for multi-agent support and production hardening.

### Added
- Auto-configure for Claude Code, OpenCode, Cursor, Windsurf, Gemini CLI, Codex
- User-extensible URL blocklist at `~/.opencode-browser/blocklist.txt`, pushed to extension on reconnect
- Token rotation on every host start (256-bit, `0o600`)
- Log redaction (`code`, `text`, password, URL query strings) with 5MB rotation; log dir `0o700`
- `AGENTS.md` as canonical agent instructions; `CLAUDE.md` imports via `@AGENTS.md`
- Zip-slip guard and symlink rejection in installer
- TOCTOU re-check on `browser_execute` and post-navigate URL check in `browser_new_tab`

### Changed
- Snapshot selectors use `data-opencode-snap` attribute for uniqueness (was class-based, collided)
- `browser_execute` trust boundary is URL-space only; regex/AST content filter dropped (security theater)
- Host wrapper points to installed `host.js`, not npx cache

### Fixed
- Server timeout handle leak on resolve/reject; reject on socket write failure
- `debuggerQueue` unbounded growth
- Version read when server.js copied outside package dir
