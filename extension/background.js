// OpenCode Browser Automation - Background Service Worker
// Native Messaging Host: com.opencode.browser_automation

const NATIVE_HOST_NAME = "com.opencode.browser_automation";

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
      console.log("[OpenCode] Native host disconnected:", error);
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
      console.log("[OpenCode] Connected to native host");
      return true;
    } else {
      port.disconnect();
      return false;
    }
  } catch (error) {
    console.error("[OpenCode] Failed to connect:", error);
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
  console.log("[OpenCode] Received from native:", message.type);

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
  }
}

function sendToNative(message) {
  if (nativePort) {
    nativePort.postMessage(message);
  } else {
    console.error("[OpenCode] Cannot send - not connected");
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
    const tablessTools = new Set(["get_tabs", "wait", "new_tab", "close_tab", "switch_tab", "new_window"]);
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
          
          // Generate a selector
          if (element.id) {
            node.selector = `#${element.id}`;
          } else if (element.className && typeof element.className === "string") {
            const classes = element.className.trim().split(/\s+/).slice(0, 2).join(".");
            if (classes) node.selector = `${element.tagName.toLowerCase()}.${classes}`;
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

  const tab = await getTabById(tabId);
  const id = tab.id;

  const prev = debuggerQueue.get(id) ?? Promise.resolve();
  const curr = prev.then(() => _executeWithDebugger(id, code));
  // Store a settled tail so errors don't block future calls for this tab
  debuggerQueue.set(id, curr.then(() => {}, () => {}));
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
    args: [x, y, selector]
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
      await chrome.tabGroups.update(groupId, { title: "OpenCode Agent", color: "cyan" });
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
  console.log("[OpenCode] Extension installed");
  await detachStaleDebuggerSessions();
  await connectToNativeHost();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[OpenCode] Extension started");
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
      title: "OpenCode Browser",
      message: connected ? "Connected to native host" : "Failed to connect. Is the native host installed?"
    });
  } else {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "OpenCode Browser",
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
chrome.alarms.create("opencode-keepalive", { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "opencode-keepalive") return;
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
