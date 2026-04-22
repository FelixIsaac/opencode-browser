# OpenCode Browser — Agent Instructions

This MCP server gives you browser automation tools that run inside the user's existing Chrome session, sharing their logins and cookies. All agent tabs open in a dedicated **OpenCode Agent** window (cyan tab group) so the user's window is never disturbed.

## Core Workflow

### Always start with a snapshot, not a screenshot
```
browser_snapshot → read the accessibility tree → act
browser_screenshot → only when you need visual layout
```
Snapshots return structured JSON (roles, selectors, text). Screenshots cost 5-10× more tokens and require the agent window to be visible. Use screenshots only when layout or visual state matters.

### Wait before you click on dynamic pages
SPAs and JS-heavy pages render elements asynchronously. Always wait before acting:
```
browser_navigate(url)
browser_wait_for_selector(selector, timeout=10000)
browser_click(selector)
```
Without the wait, clicks silently fail on elements that haven't rendered yet.

### Form submission
Prefer `browser_keyboard(key="Enter")` over clicking submit buttons — more reliable across frameworks:
```
browser_type(selector, text)
browser_keyboard(key="Enter")
```
For text selection before overwriting: `browser_keyboard(key="a", modifiers=["ctrl"])`.

## UX Contract — Non-Interference

The user is browsing while you work. Treat their session as read-only except for the specific task they gave you.

**Do:**
- Open new tabs with `browser_new_tab` (goes to the agent window)
- Navigate, click, type only within tabs you opened
- Tell the user in chat what you're doing: *"Opening GitHub, searching for issues…"*
- Close tabs you opened when the task is done (`browser_close_tab`)
- Let the user know when you're finished so they can resume normally

**Don't:**
- Open more tabs than the task requires — one tab per site, reuse with `browser_navigate`
- Leave agent tabs open after the task completes
- Call `browser_switch_tab` on a user's tab unless they asked for a hand-off
- Screenshot repeatedly in a loop — snapshot first, screenshot only when visual layout matters
- Navigate away from a URL the user opened without warning them

## Tab Management

- **New tabs** always open in the agent window — do not interfere with the user's tabs
- **Never** call `browser_switch_tab` on a user's tab unless they explicitly ask you to hand off
- Use `browser_get_tabs` to find tab IDs; filter by `windowId` to distinguish agent vs user tabs
- When you find something the user should review, tell them in chat and offer to switch: *"I found X at tab 430115299 — want me to switch to it?"*

## Hand-off Pattern
When the user needs to take over (login wall, CAPTCHA, manual review):
1. Tell them clearly what you need them to do
2. Call `browser_switch_tab(tabId)` to focus the relevant tab in their window
3. Wait for them to respond before continuing

## Error Recovery
| Error | Fix |
|-------|-----|
| `Element not found` | Use `browser_wait_for_selector` then retry |
| `Timeout waiting for selector` | Try `browser_snapshot` to see current DOM state |
| `Cannot screenshot: window minimized` | Call `browser_navigate` to wake the agent window, then retry |
| `Not connected to browser extension` | Ask user to reload the Chrome extension and restart |
| `Blocked: tool refused on sensitive URL` | Do not retry — the URL is on the security blocklist |

## Token Cost Reference
| Tool | Approx tokens |
|------|--------------|
| `browser_snapshot` | 200–1,500 |
| `browser_screenshot` | 500–3,000 |
| `browser_get_tabs` | ~200 per 10 tabs |
| `browser_execute` | result-dependent |

## Security
Certain URLs are blocked by default (banking, email, OAuth, password managers, crypto). Blocked tools return an error — do not attempt workarounds or alternative selectors on the same URL.
