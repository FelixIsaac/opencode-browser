// Tandem Browser Automation - Background Service Worker
// Native Messaging Host: com.tandem.browser

const NATIVE_HOST_NAME = "com.tandem.browser";

// ============================================================================
// URL Security Blocklist
// ============================================================================

const DEFAULT_BLOCKED_PATTERNS = [
  // Banking / finance
  /bank/i, /paypal\.com/i, /stripe\.com/i, /wise\.com/i, /revolut\.com/i,
  /chase\.com/i, /wellsfargo\.com/i, /barclays\.com/i, /hsbc\.com/i,
  // Email
  /mail\.google\.com/i, /outlook\.live\.com/i, /outlook\.office\.com/i,
  /mail\.yahoo\.com/i, /proton\.me/i, /fastmail\.com/i,
  // OAuth / identity providers
  /accounts\.google\.com/i, /login\.microsoftonline\.com/i,
  /appleid\.apple\.com/i, /github\.com\/login/i, /github\.com\/session/i,
  // Password managers
  /1password\.com/i, /lastpass\.com/i, /bitwarden\.com/i, /dashlane\.com/i,
  // Crypto
  /coinbase\.com/i, /binance\.com/i, /kraken\.com/i,
];

// Cached compiled patterns — invalidated when storage changes.
// LIMIT: chrome.storage.local max size = 10MB total, 8KB per item.
let cachedPatterns = null;
chrome.storage.onChanged.addListener((changes) => {
  if (changes.customBlocklist) cachedPatterns = null;
});

async function getBlockedPatterns() {
  if (cachedPatterns) return cachedPatterns;
  const { customBlocklist = [] } = await chrome.storage.local.get("customBlocklist");
  const safe = customBlocklist.filter(p => {
    if (typeof p !== "string" || p.length > 200) return false;
    try { new RegExp(p); return true; } catch { return false; }
  });
  cachedPatterns = [...DEFAULT_BLOCKED_PATTERNS, ...safe.map(p => new RegExp(p, "i"))];
  return cachedPatterns;
}

async function assertUrlAllowed(url) {
  if (!url) return;
  const patterns = await getBlockedPatterns();
  for (const pattern of patterns) {
    if (pattern.test(url)) {
      throw new Error(
        `Blocked: "${url}" is on the security blocklist (banking, email, OAuth, crypto). ` +
        "Do not retry on this URL. Switch to a different tab or ask the user to perform this action manually."
      );
    }
  }
}

async function assertTabAllowed(tabId) {
  const tab = tabId ? await chrome.tabs.get(tabId) : await getAgentTab().catch(() => null);
  if (tab?.url) await assertUrlAllowed(tab.url);
}

let nativePort = null;
let connectingPromise = null; // deduplicates concurrent connectToNativeHost() calls

// ============================================================================
// Native Messaging Connection
// ============================================================================

function connectToNativeHost() {
  if (nativePort) return Promise.resolve(true);
  // Return the in-flight promise so concurrent callers share one attempt
  // instead of each spawning a native port and leaking the first.
  if (connectingPromise) return connectingPromise;
  connectingPromise = _doConnect().finally(() => { connectingPromise = null; });
  return connectingPromise;
}

async function _doConnect() {
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    port.onMessage.addListener(handleNativeMessage);
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message;
      console.log("[Tandem] Native host disconnected:", error);
      nativePort = null;
    });

    const connected = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      const pingHandler = (msg) => {
        if (msg.type === "pong") {
          clearTimeout(timeout);
          port.onMessage.removeListener(pingHandler);
          resolve(true);
        }
      };
      port.onMessage.addListener(pingHandler);
      port.postMessage({ type: "ping" });
    });

    if (connected) {
      nativePort = port;
      console.log("[Tandem] Connected to native host");
      return true;
    } else {
      port.disconnect();
      return false;
    }
  } catch (error) {
    console.error("[Tandem] Failed to connect:", error);
    return false;
  }
}

function disconnectNativeHost() {
  if (nativePort) {
    nativePort.disconnect();
    nativePort = null;
  }
}

// ============================================================================
// Message Handling from Native Host
// ============================================================================

async function handleNativeMessage(message) {
  console.log("[Tandem] Received from native:", message.type);

  switch (message.type) {
    case "tool_request":
      await handleToolRequest(message);
      break;
    case "ping":
      sendToNative({ type: "pong" });
      break;
    case "get_status":
      sendToNative({
        type: "status_response",
        connected: nativePort !== null,
        version: chrome.runtime.getManifest().version
      });
      break;
    case "update_blocklist":
      // Host pushes user-edited blocklist from ~/.tandem/blocklist.txt
      if (Array.isArray(message.patterns)) {
        const valid = message.patterns.filter(p =>
          typeof p === "string" && p.length > 0 && p.length <= 200 && (() => { try { new RegExp(p); return true; } catch { return false; } })()
        );
        await chrome.storage.local.set({ customBlocklist: valid });
        console.log(`[Tandem] Updated blocklist with ${valid.length} user pattern(s)`);
      }
      break;
  }
}

function sendToNative(message) {
  if (nativePort) {
    nativePort.postMessage(message);
  } else {
    console.error("[Tandem] Cannot send - not connected");
  }
}

// ============================================================================
// Tool Execution
// ============================================================================

async function handleToolRequest(request) {
  const { id, tool, args } = request;

  // LIMIT: Chrome MV3 service workers have a hard 5-minute lifetime per event handler.
  // A slow toolNavigate (30s page load) inside an already-aged worker can be force-killed
  // mid-await. The agent will hang indefinitely — no error is surfaced, no tool_response
  // is sent. Mitigation: keepalive alarm resets idle timer but cannot extend the 5-min cap.

  try {
    // Block tools that touch tab content if the target URL is sensitive
    const tablessTools = new Set(["get_tabs", "wait", "new_tab", "close_tab", "switch_tab", "new_window", "search_history", "recent_browsing", "history_stats", "get_bookmarks", "get_tab_groups", "create_tab_group", "update_tab_group", "move_to_group", "deduplicate_tabs", "open_batch", "session_save", "session_restore", "notify", "storage_read", "downloads", "recently_closed", "restore_session", "top_sites", "reading_list_get", "reading_list_add", "reading_list_remove", "system_info", "speak", "clear_browsing_data", "save_mhtml"]);
    if (!tablessTools.has(tool)) {
      await assertTabAllowed(args?.tabId ?? null);
    }

    const result = await executeTool(tool, args || {});
    sendToNative({
      type: "tool_response",
      id,
      result: { content: result }
    });
  } catch (error) {
    sendToNative({
      type: "tool_response",
      id,
      error: { content: error.message || String(error) }
    });
  }
}

const TOOL_HANDLERS = {
  navigate:       toolNavigate,
  click:          toolClick,
  type:           toolType,
  screenshot:     toolScreenshot,
  snapshot:       toolSnapshot,
  get_tabs:       toolGetTabs,
  execute_script: toolExecuteScript,
  scroll:         toolScroll,
  wait:           toolWait,
  new_tab:              toolNewTab,
  close_tab:            toolCloseTab,
  switch_tab:           toolSwitchTab,
  new_window:           toolNewWindow,
  wait_for_selector:    toolWaitForSelector,
  keyboard:             toolKeyboard,
  search_history:       toolSearchHistory,
  recent_browsing:      toolRecentBrowsing,
  history_stats:        toolHistoryStats,
  get_bookmarks:        toolGetBookmarks,
  get_tab_groups:       toolGetTabGroups,
  create_tab_group:     toolCreateTabGroup,
  update_tab_group:     toolUpdateTabGroup,
  move_to_group:        toolMoveToGroup,
  print_to_pdf:         toolPrintToPdf,
  performance:          toolPerformance,
  device_emulate:       toolDeviceEmulate,
  page_text:            toolPageText,
  deduplicate_tabs:     toolDeduplicateTabs,
  open_batch:           toolOpenBatch,
  storage_inspect:      toolStorageInspect,
  session_save:         toolSessionSave,
  session_restore:      toolSessionRestore,
  notify:               toolNotify,
  storage_read:         toolStorageRead,
  downloads:            toolDownloads,
  recently_closed:      toolRecentlyClosed,
  restore_session:      toolRestoreSession,
  top_sites:            toolTopSites,
  reading_list_get:     toolReadingListGet,
  reading_list_add:     toolReadingListAdd,
  reading_list_remove:  toolReadingListRemove,
  system_info:          toolSystemInfo,
  speak:                toolSpeak,
  clear_browsing_data:  toolClearBrowsingData,
  save_mhtml:           toolSaveMhtml,
};

async function executeTool(toolName, args) {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) throw new Error(`Unknown tool: ${toolName}`);
  return await handler(args);
}

// ============================================================================
// Tool Implementations
// ============================================================================

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found. Call browser_new_tab to open a tab first.");
  return tab;
}

async function getTabById(tabId) {
  if (tabId) return await chrome.tabs.get(tabId);
  return await getAgentTab();
}

/** Wait for a tab to finish loading, with a 30s safety timeout. */
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
  });
}

async function toolNavigate({ url, tabId }) {
  if (!url) throw new Error("URL is required");
  await assertUrlAllowed(url);
  const tab = await getTabById(tabId);
  await chrome.tabs.update(tab.id, { url });
  await waitForTabLoad(tab.id);
  // Re-check after load: server-side redirects can land on a blocked domain
  const final = await chrome.tabs.get(tab.id);
  await assertUrlAllowed(final.url);
  return `Navigated to ${final.url}. Call browser_wait_for_selector or browser_snapshot before clicking or typing.`;
}

async function toolClick({ selector, tabId }) {
  if (!selector) throw new Error("Selector is required");
  
  const tab = await getTabById(tabId);
  
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      const element = document.querySelector(sel);
      if (!element) return { success: false, error: `Element not found: ${sel}. Call browser_wait_for_selector('${sel}') to wait for it, or browser_snapshot to find the correct selector.` };
      element.click();
      return { success: true };
    },
    args: [selector]
  });
  
  if (!result[0]?.result?.success) {
    throw new Error(result[0]?.result?.error || "Click failed — use browser_snapshot to inspect page state");
  }

  return `Clicked ${selector}. If nothing happened, the element may be non-interactive — use browser_snapshot to verify page state.`;
}

async function toolType({ selector, text, tabId, clear = false }) {
  if (!selector) throw new Error("Selector is required");
  if (text === undefined) throw new Error("Text is required");
  
  const tab = await getTabById(tabId);
  
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, txt, shouldClear) => {
      const element = document.querySelector(sel);
      if (!element) return { success: false, error: `Element not found: ${sel}. Call browser_wait_for_selector('${sel}') first, or browser_snapshot to find the correct selector.` };

      element.focus();
      if (shouldClear) {
        element.value = "";
      }
      
      // For input/textarea, set value directly
      if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        element.value = element.value + txt;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (element.isContentEditable) {
        document.execCommand("insertText", false, txt);
      }
      
      return { success: true };
    },
    args: [selector, text, clear]
  });
  
  if (!result[0]?.result?.success) {
    throw new Error(result[0]?.result?.error || "Type failed — use browser_snapshot to inspect page state");
  }

  return `Typed into ${selector}. Call browser_keyboard(key="Enter") to submit, or browser_snapshot to verify the field value.`;
}

async function toolScreenshot({ tabId, fullPage = false }) {
  // LIMIT: captureVisibleTab only captures the ACTIVE tab in a window.
  // LIMIT: throws "The window is not visible" on minimized windows.
  // LIMIT: max image size ~4MB (Chrome internal cap on tab capture).

  if (tabId) {
    // Explicit tab — make it active in its own window (may be user's window, explicit request)
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
      await new Promise(r => setTimeout(r, 150));
    }
    try {
      return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    } catch (err) {
      if (err.message?.includes("not visible") || err.message?.includes("minimized")) {
        throw new Error(`Cannot screenshot: window is minimized. Restore it first, or use browser_snapshot instead (no window required).`);
      }
      throw err;
    }
  }

  // No tabId — capture agent window without stealing user focus
  const windowId = await getOrCreateAgentWindow();
  const win = await chrome.windows.get(windowId);
  if (win.state === "minimized") {
    await chrome.windows.update(windowId, { state: "normal" });
    await new Promise(r => setTimeout(r, 200)); // wait for Chrome to render
  }
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (err) {
    if (err.message?.includes("not visible") || err.message?.includes("minimized")) {
      throw new Error("Cannot screenshot: agent window is not visible. Call browser_navigate to wake the window, then retry. Or use browser_snapshot instead.");
    }
    throw err;
  }
}

async function toolSnapshot({ tabId }) {
  const tab = await getTabById(tabId);

  // PERF: calls getComputedStyle() + getBoundingClientRect() per DOM node, forcing
  // style recalculation and layout reflow. On a 10k-node React SPA this can freeze
  // the tab's UI thread for 200-800ms. Runs in renderer process (not SW event loop).
  // LIMIT: chrome.scripting.executeScript has no documented concurrency cap but
  // consumes an IPC slot per call; heavy parallel use may hit undocumented limits.
  // LIMIT: result capped at 500 nodes (intentional) — deep pages will be truncated.
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // Build accessibility tree snapshot
      function getAccessibleName(element) {
        return element.getAttribute("aria-label") ||
               element.getAttribute("alt") ||
               element.getAttribute("title") ||
               element.getAttribute("placeholder") ||
               element.innerText?.slice(0, 100) ||
               "";
      }
      
      function getRole(element) {
        return element.getAttribute("role") ||
               element.tagName.toLowerCase();
      }
      
      // Clear stale ids from the previous snapshot so they don't pollute the page
      // or confuse selector lookups after a re-snapshot.
      for (const el of document.querySelectorAll("[data-tandem-snap]")) {
        el.removeAttribute("data-tandem-snap");
      }

      function buildSnapshot(element, depth = 0, uid = 0) {
        if (depth > 10) return { nodes: [], nextUid: uid };
        
        const nodes = [];
        const style = window.getComputedStyle(element);
        
        // Skip hidden elements
        if (style.display === "none" || style.visibility === "hidden") {
          return { nodes: [], nextUid: uid };
        }
        
        const isInteractive = 
          element.tagName === "A" ||
          element.tagName === "BUTTON" ||
          element.tagName === "INPUT" ||
          element.tagName === "TEXTAREA" ||
          element.tagName === "SELECT" ||
          element.getAttribute("onclick") ||
          element.getAttribute("role") === "button" ||
          element.isContentEditable;
        
        const rect = element.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;
        
        if (isVisible && (isInteractive || element.innerText?.trim())) {
          const node = {
            uid: `e${uid}`,
            role: getRole(element),
            name: getAccessibleName(element).slice(0, 200),
            tag: element.tagName.toLowerCase()
          };
          
          if (element.tagName === "A" && element.href) {
            node.href = element.href;
          }
          if (element.tagName === "INPUT") {
            node.type = element.type;
            // Never expose password or hidden field values
            if (element.type !== "password" && element.type !== "hidden") {
              node.value = element.value;
            }
          }
          
          // Generate a selector. Prefer stable #id; otherwise stamp a unique
          // data-attribute so the selector identifies *this* element, not the
          // first one matching its class. Class-based selectors (`button.btn`)
          // were misleading — they often matched 10+ elements on real pages
          // and caused silent miss-clicks.
          if (element.id) {
            node.selector = `#${CSS.escape(element.id)}`;
          } else {
            const snapId = `s${uid}`;
            element.setAttribute("data-tandem-snap", snapId);
            node.selector = `[data-tandem-snap="${snapId}"]`;
          }
          
          nodes.push(node);
          uid++;
        }
        
        for (const child of element.children) {
          const childResult = buildSnapshot(child, depth + 1, uid);
          nodes.push(...childResult.nodes);
          uid = childResult.nextUid;
        }
        
        return { nodes, nextUid: uid };
      }
      
      const { nodes } = buildSnapshot(document.body);
      const sliced = nodes.slice(0, 500);

      return {
        url: window.location.href,
        title: document.title,
        nodes: sliced,
        ...(sliced.length === 500 ? { note: "Snapshot capped at 500 nodes — page may have more elements. Scroll down and call browser_snapshot again to see more." } : {})
      };
    }
  });
  
  return JSON.stringify(result[0]?.result, null, 2);
}

async function toolGetTabs() {
  // SCALE: 100 open tabs ≈ 15-25KB JSON ≈ 4,000-6,000 tokens per call.
  // If called in a loop (e.g., agent polling for a new tab), costs accumulate fast.
  // Consider filtering to a window or returning only id/url/title by default.
  const tabs = await chrome.tabs.query({});
  return JSON.stringify(tabs.map(t => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId
  })), null, 2);
}

// Serializes debugger access per tab — prevents concurrent attach on the same tab (C1 fix)
const debuggerQueue = new Map(); // tabId → settled-promise tail

async function toolExecuteScript({ code, tabId }) {
  if (!code) throw new Error("Code is required");

  // Note: no JS-content filtering. Regex/string blocklists for executed code are
  // trivially bypassable (string concat, computed properties, eval-of-string) and
  // give a false sense of security. The real boundary is the URL blocklist —
  // banning the agent from reaching sensitive sites neuters every tool at once.
  // browser_execute runs as the user; trust the agent or sandbox the URL space.

  const tab = await getTabById(tabId);

  // Warn when attaching debugger to a tab outside the agent window — URL
  // blocklist is the primary defence; this surfaces unexpected scope to logs.
  const { agentWindowIds = [] } = await chrome.storage.session.get("agentWindowIds").catch(() => ({}));
  if (!agentWindowIds.includes(tab.windowId)) {
    console.warn(`[Tandem] browser_execute on non-agent-window tab ${tab.id} (${tab.url})`);
  }

  const id = tab.id;

  const prev = debuggerQueue.get(id) ?? Promise.resolve();
  const curr = prev.then(() => _executeWithDebugger(id, code));
  // Store a settled tail so errors don't block future calls for this tab.
  // Delete entry once settled — but only if it's still ours (later calls
  // will have replaced the value).
  const tail = curr.then(() => {}, () => {});
  debuggerQueue.set(id, tail);
  tail.finally(() => {
    if (debuggerQueue.get(id) === tail) debuggerQueue.delete(id);
  });
  return curr;
}

async function _executeWithDebugger(tabId, code) {
  const target = { tabId };

  await new Promise((resolve, reject) =>
    chrome.debugger.attach(target, "1.3", () =>
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()
    )
  );

  try {
    // TOCTOU re-check: tab URL may have changed (meta-refresh, JS redirect)
    // between the caller's assertTabAllowed and now. Re-verify after attach
    // so we don't run JS on a freshly-blocklisted page.
    const liveTab = await chrome.tabs.get(tabId).catch(() => null);
    if (liveTab?.url) await assertUrlAllowed(liveTab.url);

    const res = await new Promise((resolve, reject) =>
      // timeout: 55000 keeps us under server.js 60s so finally always runs (C2 fix)
      chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression: code, returnByValue: true, timeout: 55000 }, (r) =>
        chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r)
      )
    );

    if (res.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`Script error: ${msg}`);
    }

    const value = JSON.stringify(res.result?.value ?? null);
    if (value.length > 51200) {
      throw new Error(`Result exceeds 50KB (${value.length} bytes) — narrow your query or return a subset of the data.`);
    }
    return value;
  } finally {
    await new Promise(resolve => chrome.debugger.detach(target, resolve));
  }
}

async function toolScroll({ x = 0, y = 0, selector, tabId }) {
  const tab = await getTabById(tabId);
  
  const scrollResult = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (scrollX, scrollY, sel) => {
      if (sel) {
        const element = document.querySelector(sel);
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "center" });
          return { found: true };
        }
        window.scrollBy(scrollX, scrollY);
        return { found: false };
      }
      window.scrollBy(scrollX, scrollY);
      return { found: null };
    },
    args: [x, y, selector ?? null]
  });

  const sr = scrollResult[0]?.result;
  if (sr?.found === false) {
    return `Selector "${selector}" not found — scrolled window by (${x}, ${y}) instead. Use browser_snapshot to find the correct selector.`;
  }
  return `Scrolled ${selector ? `to ${selector}` : `by (${x}, ${y})`}`;
}

async function toolWait({ ms = 1000 }) {
  const capped = Math.min(Math.max(0, ms), 30000);
  await new Promise(resolve => setTimeout(resolve, capped));
  return capped < ms
    ? `Waited ${capped}ms (capped from ${ms}ms — max is 30000ms).`
    : `Waited ${capped}ms.`;
}

// Persists across tool calls in this SW lifecycle; reset when SW restarts.
let agentWindowId = null;
let agentGroupId = null;
// Mutex: deduplicates concurrent getOrCreateAgentWindow() calls
let agentWindowCreationPromise = null;

// Remove closed agent windows from tracked set and reset in-memory state
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { agentWindowIds = [] } = await chrome.storage.session.get("agentWindowIds").catch(() => ({}));
  if (!agentWindowIds.includes(windowId)) return;
  const updated = agentWindowIds.filter(id => id !== windowId);
  await chrome.storage.session.set({ agentWindowIds: updated, savedAgentWindowId: updated[updated.length - 1] ?? null }).catch(() => {});
  if (agentWindowId === windowId) { agentWindowId = null; agentGroupId = null; }
});

async function getOrCreateAgentWindow() {
  // Fast path: verify in-memory ID is still tracked in session storage.
  // If session was cleared externally, agentWindowIds will be empty and we fall through to create.
  if (agentWindowId !== null) {
    const { agentWindowIds = [] } = await chrome.storage.session.get("agentWindowIds").catch(() => ({}));
    if (agentWindowIds.includes(agentWindowId)) {
      try { await chrome.windows.get(agentWindowId); return agentWindowId; } catch {}
    }
    agentWindowId = null;
    agentGroupId = null;
  }
  // Mutex: deduplicates concurrent window-creation calls
  if (agentWindowCreationPromise) return agentWindowCreationPromise;
  agentWindowCreationPromise = _getOrCreateAgentWindowImpl().finally(() => { agentWindowCreationPromise = null; });
  return agentWindowCreationPromise;
}

async function _getOrCreateAgentWindowImpl() {
  // Persist across SW restarts within the same browser session
  const { savedAgentWindowId, agentWindowIds = [] } = await chrome.storage.session.get(["savedAgentWindowId", "agentWindowIds"]).catch(() => ({}));
  // Only reuse if the id is in our tracked set (prevents hijacking user windows)
  if (savedAgentWindowId && agentWindowIds.includes(savedAgentWindowId)) {
    try { await chrome.windows.get(savedAgentWindowId); agentWindowId = savedAgentWindowId; return agentWindowId; }
    catch {} // window gone; fall through to create
  }
  // Create new agent window — not focused so user's window stays active.
  // Capture focused window first; on macOS the new window may steal focus despite focused:false.
  const focusedWindow = await chrome.windows.getCurrent({ windowTypes: ["normal"] }).catch(() => null);
  const win = await chrome.windows.create({ focused: false, width: 1280, height: 800, type: "normal" });
  agentWindowId = win.id;
  // Restore focus to the user's original window if it was stolen.
  if (focusedWindow?.id != null) {
    await chrome.windows.update(focusedWindow.id, { focused: true }).catch(() => {});
  }
  agentGroupId = null; // group belongs to old window, reset
  const updatedIds = [...agentWindowIds, agentWindowId];
  await chrome.storage.session.set({ savedAgentWindowId: agentWindowId, agentWindowIds: updatedIds }).catch(() => {});
  return agentWindowId;
}

async function getAgentTab() {
  const windowId = await getOrCreateAgentWindow();
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  if (tab) return tab;
  return await chrome.tabs.create({ windowId, active: true, url: "about:blank" });
}

async function getOrCreateAgentGroup(tabId) {
  if (agentGroupId !== null) {
    try {
      const [tab, group] = await Promise.all([chrome.tabs.get(tabId), chrome.tabGroups.get(agentGroupId)]);
      if (group.windowId === tab.windowId) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: agentGroupId });
        return agentGroupId;
      }
      // Stale group is in a different window — would move the tab. Discard it.
      agentGroupId = null;
    } catch {
      agentGroupId = null;
    }
  }
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    try {
      await chrome.tabGroups.update(groupId, { title: "Tandem", color: "cyan" });
    } catch {}
    agentGroupId = groupId;
    return groupId;
  } catch {
    // Tab groups not supported in this window type — non-fatal
    return null;
  }
}

const BLANK_TAB_URLS = new Set(["about:blank", "chrome://newtab/", ""]);

async function toolNewTab({ url, active = false }) {
  if (url) await assertUrlAllowed(url);
  const windowId = await getOrCreateAgentWindow();
  const allTabs = await chrome.tabs.query({ windowId });
  let tab;
  // Reuse the lone placeholder tab (about:blank or chrome://newtab/) — avoids double-tab
  if (allTabs.length === 1 && BLANK_TAB_URLS.has(allTabs[0].url)) {
    await chrome.tabs.update(allTabs[0].id, { url: url || "about:blank", active: true });
    tab = await chrome.tabs.get(allTabs[0].id);
  } else {
    tab = await chrome.tabs.create({ url: url || "about:blank", active: true, windowId });
    // Close any leftover blank placeholder tabs so the agent window stays clean
    for (const bt of allTabs.filter(t => BLANK_TAB_URLS.has(t.url))) {
      await chrome.tabs.remove(bt.id).catch(() => {});
    }
  }
  try {
    if (url) await waitForTabLoad(tab.id);
  } finally {
    await getOrCreateAgentGroup(tab.id).catch(() => {});
  }
  const updated = await chrome.tabs.get(tab.id);
  // Re-check after load: a redirect (meta-refresh / JS) may have landed on a blocked URL
  await assertUrlAllowed(updated.url);
  return JSON.stringify({ tabId: updated.id, url: updated.url, windowId: updated.windowId });
}

async function toolCloseTab({ tabId }) {
  if (!tabId) throw new Error("tabId is required — omitting it would close the user's active tab");
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.remove(tab.id);
  return `Closed tab ${tab.id}`;
}

async function toolSwitchTab({ tabId }) {
  if (!tabId) throw new Error("tabId is required");
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  return `Switched to tab ${tabId} (${tab.url})`;
}

async function toolNewWindow({ url, incognito = false }) {
  if (url) await assertUrlAllowed(url);
  const win = await chrome.windows.create({ url: url || undefined, incognito, focused: true });
  const tab = win.tabs?.[0];
  return JSON.stringify({ windowId: win.id, tabId: tab?.id, url: tab?.url });
}

async function toolWaitForSelector({ selector, tabId, timeout = 10000 }) {
  if (!selector) throw new Error("Selector is required");
  const tab = await getTabById(tabId);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (sel) => !!document.querySelector(sel),
      args: [selector]
    });
    if (result[0]?.result) return `Element found: ${selector}`;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Timeout: "${selector}" not found after ${timeout}ms. Call browser_snapshot to see current DOM state and find the correct selector.`);
}

async function toolKeyboard({ key, selector, tabId, modifiers = [] }) {
  if (!key) throw new Error("Key is required");
  const tab = await getTabById(tabId);
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, k, mods) => {
      const target = sel ? document.querySelector(sel) : document.activeElement;
      if (sel && !target) return { success: false, error: `Element not found: ${sel}. Call browser_snapshot to find the correct selector.` };
      const opts = {
        key: k, bubbles: true, cancelable: true,
        ctrlKey: mods.includes("ctrl"),
        shiftKey: mods.includes("shift"),
        altKey: mods.includes("alt"),
        metaKey: mods.includes("meta"),
      };
      target.dispatchEvent(new KeyboardEvent("keydown", opts));
      target.dispatchEvent(new KeyboardEvent("keypress", opts));
      target.dispatchEvent(new KeyboardEvent("keyup", opts));
      return { success: true };
    },
    args: [selector || null, key, modifiers]
  });
  if (!result[0]?.result?.success) throw new Error(result[0]?.result?.error || "Keyboard event failed");
  return `Key "${key}"${modifiers.length ? ` (${modifiers.join("+")})` : ""} sent${selector ? ` to ${selector}` : ""}`;
}

// ============================================================================
// History & Bookmarks Tools
// ============================================================================

async function toolSearchHistory({ query = "", startTime, endTime, maxResults = 100 } = {}) {
  const searchQuery = {
    text: query,
    maxResults: Math.min(maxResults, 1000),
  };
  if (startTime) searchQuery.startTime = new Date(startTime).getTime();
  if (endTime) searchQuery.endTime = new Date(endTime).getTime();

  const items = await chrome.history.search(searchQuery);
  const results = items.map(item => ({
    url: item.url,
    title: item.title || "",
    visitCount: item.visitCount || 0,
    lastVisitTime: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : null,
    typedCount: item.typedCount || 0,
  }));
  return JSON.stringify(results);
}

async function toolRecentBrowsing({ hours = 24, maxResults = 50 } = {}) {
  const startTime = Date.now() - hours * 60 * 60 * 1000;
  const items = await chrome.history.search({
    text: "",
    startTime,
    maxResults: Math.min(maxResults, 500),
  });
  items.sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0));
  const results = items.map(item => ({
    url: item.url,
    title: item.title || "",
    lastVisitTime: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : null,
    visitCount: item.visitCount || 0,
  }));
  return JSON.stringify(results);
}

async function toolHistoryStats() {
  const [allItems] = await Promise.all([
    chrome.history.search({ text: "", maxResults: 10000, startTime: 0 }),
  ]);

  const domainCounts = {};
  let earliest = Infinity;
  let latest = 0;

  for (const item of allItems) {
    if (item.lastVisitTime) {
      if (item.lastVisitTime < earliest) earliest = item.lastVisitTime;
      if (item.lastVisitTime > latest) latest = item.lastVisitTime;
    }
    try {
      const domain = new URL(item.url).hostname;
      domainCounts[domain] = (domainCounts[domain] || 0) + (item.visitCount || 1);
    } catch {}
  }

  const topDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([domain, count]) => ({ domain, visitCount: count }));

  return JSON.stringify({
    totalEntries: allItems.length,
    earliestVisit: earliest !== Infinity ? new Date(earliest).toISOString() : null,
    latestVisit: latest > 0 ? new Date(latest).toISOString() : null,
    topDomains,
  });
}

function flattenBookmarks(nodes, depth = 0) {
  const results = [];
  for (const node of nodes) {
    if (node.url) {
      results.push({ type: "bookmark", title: node.title || "", url: node.url, depth });
    } else {
      results.push({ type: "folder", title: node.title || "", depth, id: node.id });
      if (node.children) results.push(...flattenBookmarks(node.children, depth + 1));
    }
  }
  return results;
}

async function toolGetBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  const flat = flattenBookmarks(tree);
  return JSON.stringify(flat);
}

// ============================================================================
// Tab Group Tools
// ============================================================================

async function toolGetTabGroups() {
  const groups = await chrome.tabGroups.query({});
  const tabs = await chrome.tabs.query({});
  const tabsByGroup = {};
  for (const tab of tabs) {
    if (tab.groupId >= 0) {
      if (!tabsByGroup[tab.groupId]) tabsByGroup[tab.groupId] = [];
      tabsByGroup[tab.groupId].push({ id: tab.id, url: tab.url, title: tab.title });
    }
  }
  return JSON.stringify(groups.map(g => ({
    id: g.id, title: g.title || "", color: g.color, collapsed: g.collapsed,
    windowId: g.windowId, tabs: tabsByGroup[g.id] || [],
  })));
}

async function toolCreateTabGroup({ tabIds, title, color = "blue" }) {
  if (!Array.isArray(tabIds) || !tabIds.length) throw new Error("tabIds array is required");
  const VALID_COLORS = ["grey","blue","red","yellow","green","pink","purple","cyan","orange"];
  if (!VALID_COLORS.includes(color)) throw new Error(`color must be one of: ${VALID_COLORS.join(", ")}`);
  const groupId = await chrome.tabs.group({ tabIds });
  await chrome.tabGroups.update(groupId, { title: title || undefined, color });
  return JSON.stringify({ groupId, title: title || "", color });
}

async function toolUpdateTabGroup({ groupId, title, color, collapsed }) {
  if (!groupId) throw new Error("groupId is required");
  const update = {};
  if (title !== undefined) update.title = title;
  if (color !== undefined) update.color = color;
  if (collapsed !== undefined) update.collapsed = collapsed;
  await chrome.tabGroups.update(groupId, update);
  return `Tab group ${groupId} updated`;
}

async function toolMoveToGroup({ tabIds, groupId }) {
  if (!Array.isArray(tabIds) || !tabIds.length) throw new Error("tabIds array is required");
  if (!groupId) throw new Error("groupId is required");
  await chrome.tabs.group({ tabIds, groupId });
  return `Moved ${tabIds.length} tab(s) to group ${groupId}`;
}

// ============================================================================
// CDP Tools (debugger permission)
// ============================================================================

async function _withDebugger(tabId, fn) {
  const target = { tabId };
  await new Promise((resolve, reject) =>
    chrome.debugger.attach(target, "1.3", () =>
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()
    )
  );
  try {
    return await fn(target);
  } finally {
    await new Promise(resolve => chrome.debugger.detach(target, resolve));
  }
}

function cdpSend(target, method, params = {}) {
  return new Promise((resolve, reject) =>
    chrome.debugger.sendCommand(target, method, params, (result) =>
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(result)
    )
  );
}

async function toolPrintToPdf({ tabId, landscape = false, printBackground = true } = {}) {
  const tab = await getTabById(tabId);
  const result = await _withDebugger(tab.id, async (target) => {
    const { data } = await cdpSend(target, "Page.printToPDF", {
      landscape, printBackground, preferCSSPageSize: true,
    });
    return { mimeType: "application/pdf", data, url: tab.url, title: tab.title };
  });
  return JSON.stringify(result);
}

async function toolPerformance({ tabId } = {}) {
  const tab = await getTabById(tabId);
  const metrics = await _withDebugger(tab.id, async (target) => {
    await cdpSend(target, "Performance.enable");
    const { metrics } = await cdpSend(target, "Performance.getMetrics");
    const result = {};
    for (const m of metrics) result[m.name] = m.value;
    return result;
  });
  return JSON.stringify(metrics);
}

async function toolDeviceEmulate({ tabId, width = 390, height = 844, deviceScaleFactor = 3, mobile = true, userAgent, reset = false } = {}) {
  const tab = await getTabById(tabId);
  const msg = await _withDebugger(tab.id, async (target) => {
    if (reset) {
      await cdpSend(target, "Emulation.clearDeviceMetricsOverride");
      return "Device emulation reset to desktop";
    }
    await cdpSend(target, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile });
    if (userAgent) await cdpSend(target, "Emulation.setUserAgentOverride", { userAgent });
    return `Emulating ${width}x${height} (scale ${deviceScaleFactor}, mobile=${mobile})`;
  });
  return msg;
}

// ============================================================================
// Page Utilities
// ============================================================================

async function toolPageText({ tabId, maxLength = 20000 } = {}) {
  const tab = await getTabById(tabId);
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (max) => (document.body?.innerText || "").slice(0, max),
    args: [maxLength],
  });
  const text = result[0]?.result || "";
  return text.length === maxLength ? text + `\n[truncated at ${maxLength} chars]` : text;
}

async function toolDeduplicateTabs({ dryRun = false } = {}) {
  const tabs = await chrome.tabs.query({});
  const seen = new Map();
  const toClose = [];
  for (const tab of tabs) {
    const key = tab.url?.split("#")[0];
    if (!key || ["about:blank", "chrome://newtab/"].includes(key)) continue;
    if (seen.has(key)) {
      toClose.push({ id: tab.id, url: tab.url, title: tab.title });
    } else {
      seen.set(key, tab.id);
    }
  }
  if (!dryRun && toClose.length) await chrome.tabs.remove(toClose.map(t => t.id));
  return JSON.stringify({ duplicatesFound: toClose.length, closed: !dryRun && toClose.length > 0, tabs: toClose });
}

async function toolOpenBatch({ urls, active = false } = {}) {
  if (!Array.isArray(urls) || !urls.length) throw new Error("urls array is required");
  if (urls.length > 20) throw new Error("Max 20 URLs per batch");
  for (const url of urls) await assertUrlAllowed(url);
  const windowId = await getOrCreateAgentWindow();
  const results = [];
  for (const url of urls) {
    const tab = await chrome.tabs.create({ url, active, windowId });
    results.push({ tabId: tab.id, url });
  }
  return JSON.stringify(results);
}

async function toolStorageInspect({ tabId, store = "local" } = {}) {
  const tab = await getTabById(tabId);
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (s) => {
      const storage = s === "session" ? sessionStorage : localStorage;
      const out = {};
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        try { out[key] = JSON.parse(storage.getItem(key)); } catch { out[key] = storage.getItem(key); }
      }
      return out;
    },
    args: [store],
  });
  return JSON.stringify(result[0]?.result || {});
}

// ============================================================================
// Session Management
// ============================================================================

async function toolSessionSave({ name = "default" } = {}) {
  const tabs = await chrome.tabs.query({});
  const session = tabs
    .filter(t => t.url && !["about:blank", "chrome://newtab/", ""].includes(t.url))
    .map(t => ({ url: t.url, title: t.title, pinned: t.pinned }));
  const key = `session_${name}`;
  const savedAt = new Date().toISOString();
  await chrome.storage.local.set({ [key]: { tabs: session, savedAt } });
  return JSON.stringify({ name, tabCount: session.length, savedAt });
}

async function toolSessionRestore({ name = "default", newWindow = false } = {}) {
  const key = `session_${name}`;
  const data = await chrome.storage.local.get(key);
  const session = data[key];
  if (!session) throw new Error(`No session found with name "${name}". Use browser_session_save first.`);
  const windowId = newWindow ? (await chrome.windows.create({ focused: true })).id : undefined;
  const results = [];
  for (const t of session.tabs) {
    try {
      await assertUrlAllowed(t.url);
      const tab = await chrome.tabs.create({ url: t.url, windowId, active: false });
      results.push({ tabId: tab.id, url: t.url });
    } catch (e) {
      results.push({ url: t.url, error: e.message });
    }
  }
  return JSON.stringify({ name, savedAt: session.savedAt, restored: results.length, tabs: results });
}

// ============================================================================
// Browser Utilities
// ============================================================================

async function toolNotify({ title, message, buttons = [] } = {}) {
  if (!title) throw new Error("title is required");
  if (!message) throw new Error("message is required");
  const opts = {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
  };
  if (buttons.length) opts.buttons = buttons.slice(0, 2).map(b => ({ title: String(b) }));
  return new Promise((resolve, reject) => {
    chrome.notifications.create("", opts, (id) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(`Notification sent (id: ${id})`);
    });
  });
}

async function toolStorageRead({ keys, area = "local" } = {}) {
  const storage = area === "sync" ? chrome.storage.sync : chrome.storage.local;
  const data = keys ? await storage.get(keys) : await storage.get(null);
  return JSON.stringify(data);
}

async function toolDownloads({ limit = 20, query = "" } = {}) {
  const searchQuery = { limit: Math.min(limit, 100) };
  if (query) searchQuery.query = [query];
  const items = await chrome.downloads.search(searchQuery);
  return JSON.stringify(items.map(d => ({
    id: d.id,
    filename: d.filename,
    url: d.url,
    state: d.state,
    totalBytes: d.totalBytes,
    receivedBytes: d.receivedBytes,
    startTime: d.startTime,
    endTime: d.endTime || null,
    mime: d.mime,
    danger: d.danger,
  })));
}

// ============================================================================
// Sessions, Top Sites & Reading List Tools
// ============================================================================

async function toolRecentlyClosed({ maxResults = 10 } = {}) {
  const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: Math.min(maxResults, 25) });
  return JSON.stringify(sessions.map(s => ({
    type: s.tab ? "tab" : "window",
    sessionId: s.tab?.sessionId ?? s.window?.sessionId,
    lastModified: s.lastModified,
    tab: s.tab ? { url: s.tab.url, title: s.tab.title } : null,
    window: s.window ? { tabCount: s.window.tabs?.length ?? 0, tabs: s.window.tabs?.map(t => ({ url: t.url, title: t.title })) ?? [] } : null,
  })));
}

async function toolRestoreSession({ sessionId }) {
  if (!sessionId) throw new Error("sessionId is required — get one from browser_recently_closed");
  const session = await chrome.sessions.restore(sessionId);
  return JSON.stringify({ restored: true, type: session.tab ? "tab" : "window" });
}

async function toolTopSites() {
  const sites = await chrome.topSites.get();
  return JSON.stringify(sites);
}

async function toolReadingListGet() {
  const items = await chrome.readingList.query({});
  return JSON.stringify(items);
}

async function toolReadingListAdd({ url, title }) {
  if (!url) throw new Error("url is required");
  await assertUrlAllowed(url);
  await chrome.readingList.addEntry({ url, title: title || url, hasBeenRead: false });
  return `Added to reading list: ${url}`;
}

async function toolReadingListRemove({ url }) {
  if (!url) throw new Error("url is required");
  await chrome.readingList.removeEntry({ url });
  return `Removed from reading list: ${url}`;
}

// ============================================================================
// System Info, TTS, Browsing Data & Page Capture Tools
// ============================================================================

async function toolSystemInfo() {
  const [cpu, memory, displays] = await Promise.all([
    chrome.system.cpu.getInfo(),
    chrome.system.memory.getInfo(),
    chrome.system.display.getInfo(),
  ]);
  return JSON.stringify({
    cpu: { modelName: cpu.modelName, numOfProcessors: cpu.numOfProcessors, archName: cpu.archName },
    memory: { capacity: memory.capacity, availableCapacity: memory.availableCapacity },
    displays: displays.map(d => ({ id: d.id, name: d.name, bounds: d.bounds, workArea: d.workArea, dpiX: d.dpiX, dpiY: d.dpiY, isPrimary: d.isPrimary })),
  });
}

async function toolSpeak({ text, rate = 1.0, pitch = 1.0, lang = "en-US", voiceName } = {}) {
  if (!text) throw new Error("text is required");
  return new Promise((resolve, reject) => {
    const opts = { rate, pitch, lang };
    if (voiceName) opts.voiceName = voiceName;
    chrome.tts.speak(text, { ...opts, onEvent: (event) => {
      if (event.type === "end" || event.type === "interrupted" || event.type === "cancelled") resolve(`Spoke: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`);
      if (event.type === "error") reject(new Error(event.errorMessage || "TTS error"));
    }});
  });
}

async function toolClearBrowsingData({ dataTypes = ["cache"], since = "hour" } = {}) {
  const VALID_TYPES = ["appcache","cache","cacheStorage","cookies","downloads","fileSystems","formData","history","indexedDB","localStorage","passwords","serviceWorkers","webSQL"];
  const VALID_SINCE = { hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, all: 0 };
  const invalid = dataTypes.filter(t => !VALID_TYPES.includes(t));
  if (invalid.length) throw new Error(`Invalid dataTypes: ${invalid.join(", ")}. Valid: ${VALID_TYPES.join(", ")}`);
  if (!Object.prototype.hasOwnProperty.call(VALID_SINCE, since)) throw new Error(`since must be one of: ${Object.keys(VALID_SINCE).join(", ")}`);
  const removalOptions = { since: since === "all" ? 0 : Date.now() - VALID_SINCE[since] };
  const dataToRemove = {};
  for (const t of dataTypes) dataToRemove[t] = true;
  await chrome.browsingData.remove(removalOptions, dataToRemove);
  return `Cleared ${dataTypes.join(", ")} from the last ${since}`;
}

async function toolSaveMhtml({ tabId } = {}) {
  const tab = await getTabById(tabId);
  const data = await new Promise((resolve, reject) =>
    chrome.pageCapture.saveAsMHTML({ tabId: tab.id }, (mhtmlData) =>
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(mhtmlData)
    )
  );
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return JSON.stringify({ mimeType: "multipart/related", data: base64, url: tab.url, title: tab.title, size: data.byteLength });
}

// ============================================================================
// Extension Lifecycle
// ============================================================================

async function detachStaleDebuggerSessions() {
  const targets = await new Promise(resolve => chrome.debugger.getTargets(resolve));
  for (const t of targets) {
    if (t.attached) {
      await new Promise(resolve => chrome.debugger.detach({ targetId: t.id }, resolve));
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Tandem] Extension installed");
  await detachStaleDebuggerSessions();
  await connectToNativeHost();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[Tandem] Extension started");
  await detachStaleDebuggerSessions();
  await connectToNativeHost();
});

// Auto-reconnect on action click
chrome.action.onClicked.addListener(async () => {
  if (!nativePort) {
    const connected = await connectToNativeHost();
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Tandem",
      message: connected ? "Connected to native host" : "Failed to connect. Is the native host installed?"
    });
  } else {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Tandem",
      message: "Already connected"
    });
  }
});

// Keepalive: prevent service worker from going dormant (which kills the native host).
// NOTE: Chrome MV3 clamps alarm intervals to a minimum of 1 minute regardless of
// what periodInMinutes is set to — 0.25 min (15s) is silently rounded up to 1 min.
// An open nativePort itself keeps the SW alive; this alarm only handles reconnection
// after host crashes. For sub-minute keepalive, use an offscreen document instead.
// LIMIT: chrome.alarms minimum interval = 1 min (MV3, Chrome 117+)
chrome.alarms.create("tandem-keepalive", { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "tandem-keepalive") return;
  if (!nativePort) {
    // connectToNativeHost is now re-entrancy-safe: concurrent calls share one attempt.
    await connectToNativeHost();
  } else {
    // Pings are fire-and-forget; unanswered pings queue silently in the native messaging
    // buffer (max message size 1MB per Chrome docs). No pong timeout means a hung host
    // accumulates queued pings until the port errors and disconnects.
    try { nativePort.postMessage({ type: "ping" }); } catch {}
  }
});

// Try to connect on load
connectToNativeHost();
