#!/usr/bin/env node
/**
 * Native Messaging Host for Tandem Browser Automation
 * 
 * This script is launched by Chrome when the extension connects.
 * It communicates with Chrome via stdin/stdout using Chrome's native messaging protocol.
 * It also connects to an MCP server (or acts as one) to receive tool requests.
 * 
 * Chrome Native Messaging Protocol:
 * - Messages are length-prefixed (4 bytes, little-endian, uint32)
 * - Message body is JSON
 */

import { createServer } from "net";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, chmodSync, statSync, renameSync } from "fs";
import { randomBytes } from "crypto";
import { homedir, platform } from "os";
import { join } from "path";

const BASE_DIR = join(homedir(), ".tandem");
const LOG_DIR = join(BASE_DIR, "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
try { chmodSync(LOG_DIR, 0o700); } catch {}
const LOG_FILE = join(LOG_DIR, "host.log");
const LOG_FILE_OLD = join(LOG_DIR, "host.log.1");
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB cap before rotation
const BLOCKLIST_FILE = join(BASE_DIR, "blocklist.txt");

// =========================================================================
// Tab Claims / Leases (ported from opencode-browser v4)
// =========================================================================

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
const LEASE_TTL_MS = (() => {
  const raw = process.env.TANDEM_CLAIM_TTL_MS ?? process.env.OPENCODE_BROWSER_CLAIM_TTL_MS;
  const v = Number(raw);
  if (Number.isFinite(v) && v >= 0) return v;
  return DEFAULT_LEASE_TTL_MS;
})();

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

// tabId -> { sessionId, claimedAt, lastSeenAt }
const claims = new Map();
// sessionId -> { defaultTabId, lastSeenAt }
const sessionState = new Map();

function listClaims() {
  const out = [];
  for (const [tabId, info] of claims.entries()) {
    out.push({
      tabId,
      sessionId: info.sessionId,
      claimedAt: info.claimedAt,
      lastSeenAt: new Date(info.lastSeenAt).toISOString(),
    });
  }
  out.sort((a, b) => a.tabId - b.tabId);
  return out;
}

function sessionHasClaims(sessionId) {
  for (const info of claims.values()) {
    if (info.sessionId === sessionId) return true;
  }
  return false;
}

function getSessionState(sessionId) {
  if (!sessionId) return null;
  let state = sessionState.get(sessionId);
  if (!state) {
    state = { defaultTabId: null, lastSeenAt: nowMs() };
    sessionState.set(sessionId, state);
  }
  return state;
}

function touchSession(sessionId) {
  const state = getSessionState(sessionId);
  if (!state) return null;
  state.lastSeenAt = nowMs();
  return state;
}

function setDefaultTab(sessionId, tabId) {
  const state = getSessionState(sessionId);
  if (!state) return;
  state.defaultTabId = tabId;
  state.lastSeenAt = nowMs();
}

function clearDefaultTab(sessionId, tabId) {
  const state = sessionState.get(sessionId);
  if (!state) return;
  if (tabId === undefined || state.defaultTabId === tabId) state.defaultTabId = null;
  state.lastSeenAt = nowMs();
}

function releaseClaim(tabId) {
  const info = claims.get(tabId);
  if (!info) return;
  claims.delete(tabId);
  clearDefaultTab(info.sessionId, tabId);
}

function releaseClaimsForSession(sessionId) {
  for (const [tabId, info] of claims.entries()) {
    if (info.sessionId === sessionId) claims.delete(tabId);
  }
  clearDefaultTab(sessionId);
  sessionState.delete(sessionId);
}

function checkClaim(tabId, sessionId) {
  const existing = claims.get(tabId);
  if (!existing) return { ok: true };
  if (existing.sessionId === sessionId) return { ok: true };
  return { ok: false, error: `Tab ${tabId} is owned by another session (${existing.sessionId})` };
}

function setClaim(tabId, sessionId) {
  const existing = claims.get(tabId);
  claims.set(tabId, {
    sessionId,
    claimedAt: existing ? existing.claimedAt : nowIso(),
    lastSeenAt: nowMs(),
  });
}

function touchClaim(tabId, sessionId) {
  const existing = claims.get(tabId);
  if (existing && existing.sessionId !== sessionId) return;
  if (existing) existing.lastSeenAt = nowMs();
  else setClaim(tabId, sessionId);
}

function cleanupStaleClaims() {
  if (!LEASE_TTL_MS) return;
  const now = nowMs();
  for (const [tabId, info] of claims.entries()) {
    if (now - info.lastSeenAt > LEASE_TTL_MS) releaseClaim(tabId);
  }
  for (const [sessionId, state] of sessionState.entries()) {
    if (!sessionHasClaims(sessionId) && now - state.lastSeenAt > LEASE_TTL_MS) sessionState.delete(sessionId);
  }
}

// ============================================================================
// Auth Token — rotated per host start
// ============================================================================

// Rotate on each host start so a process that read the token file earlier
// loses access on the next Chrome relaunch. On Windows the named pipe has a
// permissive default ACL; rotating limits the exposure window. Server.js
// reads the token fresh on each connect attempt.
const TOKEN_PATH = join(BASE_DIR, "auth.token");
const AUTH_TOKEN = randomBytes(32).toString("hex");
writeFileSync(TOKEN_PATH, AUTH_TOKEN, { encoding: "utf8", mode: 0o600 });
try { chmodSync(TOKEN_PATH, 0o600); } catch {}

// ============================================================================
// Logging — with redaction and size-based rotation
// ============================================================================

const REDACT_FIELDS = new Set(["code", "text", "password"]);

function redactArgs(args) {
  if (!args || typeof args !== "object") return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (REDACT_FIELDS.has(k) && typeof v === "string") {
      out[k] = `[REDACTED ${v.length} chars]`;
    } else if (k === "url" && typeof v === "string") {
      // Strip query string — session tokens often live in URL params
      const qIdx = v.indexOf("?");
      out[k] = qIdx >= 0 ? v.slice(0, qIdx) + "?[REDACTED]" : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function summarizeMessage(msg) {
  if (!msg || typeof msg !== "object") return JSON.stringify(msg);
  const safe = { ...msg };
  if (safe.args) safe.args = redactArgs(safe.args);
  if (safe.result && typeof safe.result === "string" && safe.result.length > 200) {
    safe.result = `[${safe.result.length} bytes]`;
  }
  return JSON.stringify(safe);
}

function rotateIfNeeded() {
  try {
    if (statSync(LOG_FILE).size >= LOG_MAX_BYTES) {
      try { unlinkSync(LOG_FILE_OLD); } catch {}
      renameSync(LOG_FILE, LOG_FILE_OLD);
    }
  } catch {}
}

function log(...args) {
  rotateIfNeeded();
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args.join(" ")}\n`;
  appendFileSync(LOG_FILE, message);
}

log("Native host started");

// ============================================================================
// Chrome Native Messaging Protocol
// ============================================================================

// Byte buffer + message queue — handles partial reads, large messages, and
// multiple messages arriving in a single chunk.
let stdinBuffer = Buffer.alloc(0);
const messageQueue = [];
let messageWaiter = null;

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  while (stdinBuffer.length >= 4) {
    const len = stdinBuffer.readUInt32LE(0);
    if (len > 1_048_576) {
      log(`Oversized message (${len} bytes) — Chrome native messaging cap is 1MB. Exiting.`);
      process.exit(1);
    }
    if (stdinBuffer.length < 4 + len) break;
    const body = stdinBuffer.subarray(4, 4 + len);
    stdinBuffer = stdinBuffer.subarray(4 + len);
    try {
      const msg = JSON.parse(body.toString("utf8"));
      if (messageWaiter) {
        const w = messageWaiter;
        messageWaiter = null;
        w.resolve(msg);
      } else {
        messageQueue.push(msg);
      }
    } catch (e) {
      log("Failed to parse message:", e.message);
    }
  }
});

process.stdin.on("end", () => {
  if (messageWaiter) {
    const w = messageWaiter;
    messageWaiter = null;
    w.resolve(null);
  }
});

function readMessage() {
  return new Promise((resolve, reject) => {
    if (messageQueue.length > 0) {
      resolve(messageQueue.shift());
    } else {
      messageWaiter = { resolve, reject };
    }
  });
}

function writeMessage(message) {
  const json = JSON.stringify(message);
  const buffer = Buffer.from(json, "utf8");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(buffer.length, 0);

  // LIMIT: Chrome native messaging max message size = 1MB in each direction.
  // Single write() with Buffer.concat keeps the length prefix and body atomic.
  process.stdout.write(Buffer.concat([lengthBuffer, buffer]));
}

// ============================================================================
// MCP Server Connection
// ============================================================================

const SOCKET_PATH = platform() === "win32"
  ? "\\\\.\\pipe\\tandem"
  : join(homedir(), ".tandem", "browser.sock");

// Multi-client: each connected MCP server gets a unique clientId
let nextClientId = 0;
const clients = new Map(); // clientId → socket
const clientSessions = new Map(); // clientId -> sessionId

// pendingRequests maps hostRequestId → { clientId, mcpId, ts }
// so tool responses route back to the correct client
let pendingRequests = new Map();
let requestId = 0;

// Internal extension tool calls (used for broker-like orchestration)
const extensionPending = new Map(); // hostRequestId -> { resolve, reject, ts }

const DEFAULT_EXT_TIMEOUT_MS = 60_000;

function sendExtensionTool(tool, args) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    extensionPending.set(id, { resolve, reject, ts: Date.now() });
    writeMessage({ type: "tool_request", id, tool, args });
    setTimeout(() => {
      if (!extensionPending.has(id)) return;
      extensionPending.delete(id);
      reject(new Error("Timed out waiting for extension"));
    }, DEFAULT_EXT_TIMEOUT_MS).unref?.();
  });
}

const PENDING_TTL_MS = 90_000;
setInterval(() => {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, entry] of pendingRequests) {
    if (entry.ts < cutoff) {
      pendingRequests.delete(id);
      log(`Expired pending request ${id} (TTL)`);
    }
  }
  for (const [id, entry] of extensionPending) {
    if (entry.ts < cutoff) {
      extensionPending.delete(id);
      log(`Expired internal extension request ${id} (TTL)`);
    }
  }
  cleanupStaleClaims();
}, 30_000).unref();

function connectToMcpServer(attempt = 1) {
  // Clean up stale socket (Unix only — named pipes on Windows are auto-cleaned)
  if (platform() !== "win32") {
    try {
      if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
    } catch {}
  }

  const server = createServer((socket) => {
    const clientId = ++nextClientId;
    let authenticated = false;
    let sessionId = null;

    // Disconnect unauthenticated clients after 5 seconds
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        log(`Client ${clientId}: auth timeout — disconnecting`);
        socket.destroy();
      }
    }, 5000);

    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (!authenticated) {
            // First message must be { type: "auth", token: "<AUTH_TOKEN>" }
            if (msg.type === "auth" && msg.token === AUTH_TOKEN) {
              authenticated = true;
              sessionId = typeof msg.sessionId === "string" && msg.sessionId.trim() ? msg.sessionId.trim() : `c${clientId}`;
              clearTimeout(authTimeout);
              clients.set(clientId, socket);
              clientSessions.set(clientId, sessionId);
              log(`MCP client ${clientId} authenticated (total: ${clients.size})`);
              if (clients.size === 1) writeMessage({ type: "mcp_connected" });
            } else {
              log(`Client ${clientId}: auth failed — disconnecting`);
              socket.destroy();
            }
            continue;
          }
          void handleMcpMessage(clientId, msg).catch((e) => {
            log(`Client ${clientId}: handler error:`, e.message);
          });
        } catch (e) {
          log("Failed to parse MCP message:", e.message);
        }
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimeout);
      if (authenticated) {
        clients.delete(clientId);
        const sid = clientSessions.get(clientId);
        clientSessions.delete(clientId);
        if (sid) {
          releaseClaimsForSession(sid);
          log(`Released claims for session ${sid}`);
        }
        log(`MCP client ${clientId} disconnected (total: ${clients.size})`);
        if (clients.size === 0) writeMessage({ type: "mcp_disconnected" });
      }
    });

    socket.on("error", (err) => {
      log(`MCP client ${clientId} error:`, err.message);
    });
  });

  const tryListen = () => {
    // Restrict socket to owner-only before binding (Unix only).
    // KNOWN LIMITATION (Windows): the named pipe is created with default ACL
    // (Everyone). Token rotation per host start is the mitigation; any process
    // running as the same Windows user can still race to read the token file.
    const oldUmask = platform() !== "win32" ? process.umask(0o177) : null;
    server.listen(SOCKET_PATH, () => {
      if (oldUmask !== null) {
        process.umask(oldUmask);
        try { chmodSync(SOCKET_PATH, 0o600); } catch {}
      }
      log("Listening for MCP connections on", SOCKET_PATH);
    });
  };

  server.on("error", (err) => {
    log("Server error:", err.message);
    if (err.code === "EADDRINUSE" && attempt <= 10) {
      log(`Pipe busy, retrying in 1s (attempt ${attempt}/10)`);
      setTimeout(() => connectToMcpServer(attempt + 1), 1000);
    }
  });

  tryListen();
}

async function handleMcpMessage(clientId, message) {
  log(`Client ${clientId} →`, summarizeMessage(message));

  if (message.type === "tool_request") {
    const mcpId = message.id;
    const tool = message.tool;
    const args = message.args || {};
    const sessionId = clientSessions.get(clientId) ?? `c${clientId}`;
    touchSession(sessionId);

    // Host-only tools
    if (tool === "status") {
      return respondToolOk(clientId, mcpId, JSON.stringify({
        mcpConnected: clients.size > 0,
        clientCount: clients.size,
        leaseTtlMs: LEASE_TTL_MS,
        claims: listClaims(),
      }));
    }

    if (tool === "list_claims") {
      return respondToolOk(clientId, mcpId, JSON.stringify({ claims: listClaims() }));
    }

    if (tool === "claim_tab") {
      const tabId = Number(args.tabId);
      if (!Number.isFinite(tabId)) return respondToolError(clientId, mcpId, "tabId is required");
      const force = !!args.force;
      const existing = claims.get(tabId);
      if (existing && existing.sessionId !== sessionId && !force) {
        return respondToolError(clientId, mcpId, `Tab ${tabId} is owned by another session (${existing.sessionId})`);
      }
      setClaim(tabId, sessionId);
      setDefaultTab(sessionId, tabId);
      return respondToolOk(clientId, mcpId, `Claimed tab ${tabId}`);
    }

    if (tool === "release_tab") {
      const tabId = Number(args.tabId);
      if (!Number.isFinite(tabId)) return respondToolError(clientId, mcpId, "tabId is required");
      const existing = claims.get(tabId);
      if (existing && existing.sessionId !== sessionId) {
        return respondToolError(clientId, mcpId, `Tab ${tabId} is owned by another session (${existing.sessionId})`);
      }
      releaseClaim(tabId);
      return respondToolOk(clientId, mcpId, `Released tab ${tabId}`);
    }

    if (tool === "open_tab") {
      const res = await sendExtensionTool("new_tab", { url: args.url || "about:blank", active: !!args.active });
      let parsed;
      try { parsed = JSON.parse(res); } catch { parsed = null; }
      const tabId = parsed?.tabId;
      if (!Number.isFinite(tabId)) return respondToolError(clientId, mcpId, "Failed to open tab");
      setDefaultTab(sessionId, tabId);
      touchClaim(tabId, sessionId);
      return respondToolOk(clientId, mcpId, res);
    }

    // Treat tab-creating tools as implicitly claiming the returned tab.
    // Otherwise later tool calls with that tabId will fail the ownership check.
    if (tool === "new_tab") {
      const res = await sendExtensionTool("new_tab", args);
      let parsed;
      try { parsed = JSON.parse(res); } catch { parsed = null; }
      const tabId = parsed?.tabId;
      if (Number.isFinite(tabId)) {
        setDefaultTab(sessionId, tabId);
        touchClaim(tabId, sessionId);
      }
      return respondToolOk(clientId, mcpId, res);
    }

    if (tool === "new_window") {
      const res = await sendExtensionTool("new_window", args);
      let parsed;
      try { parsed = JSON.parse(res); } catch { parsed = null; }
      const tabId = parsed?.tabId;
      if (Number.isFinite(tabId)) {
        setDefaultTab(sessionId, tabId);
        touchClaim(tabId, sessionId);
      }
      return respondToolOk(clientId, mcpId, res);
    }

    // Tools that touch a tab: apply per-session default + ownership checks.
    let forwardedArgs = { ...args };
    if (toolWantsTab(tool)) {
      let tabId = forwardedArgs.tabId;
      if (!Number.isFinite(tabId)) {
        tabId = await ensureSessionTab(sessionId);
        forwardedArgs.tabId = tabId;
      }

      const claimCheck = checkClaim(Number(tabId), sessionId);
      if (!claimCheck.ok) return respondToolError(clientId, mcpId, claimCheck.error);
      touchClaim(Number(tabId), sessionId);
      setDefaultTab(sessionId, Number(tabId));
    }

    const id = ++requestId;
    pendingRequests.set(id, { clientId, mcpId, ts: Date.now() });
    writeMessage({ type: "tool_request", id, tool, args: forwardedArgs });
  }
}

// Read user-editable URL blocklist file and push to extension. Format: one
// JS regex per line, lines starting with # are comments. Errors silently
// ignored so a bad file doesn't break the host.
function pushBlocklistToExtension() {
  if (!existsSync(BLOCKLIST_FILE)) return;
  try {
    const patterns = readFileSync(BLOCKLIST_FILE, "utf8")
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#"));
    if (patterns.length > 0) {
      writeMessage({ type: "update_blocklist", patterns });
      log(`Pushed ${patterns.length} user blocklist pattern(s) to extension`);
    }
  } catch (e) {
    log("Failed to read blocklist file:", e.message);
  }
}

function sendToClient(clientId, message) {
  const socket = clients.get(clientId);
  if (socket && !socket.destroyed) {
    socket.write(JSON.stringify(message) + "\n");
  }
}

function respondToolOk(clientId, mcpId, content) {
  sendToClient(clientId, { type: "tool_response", id: mcpId, result: { content } });
}

function respondToolError(clientId, mcpId, content) {
  sendToClient(clientId, { type: "tool_response", id: mcpId, error: { content } });
}

function toolWantsTab(toolName) {
  // Tools that do not touch tab content.
  return !new Set([
    "get_tabs",
    "wait",
    "new_tab",
    "close_tab",
    "switch_tab",
    "new_window",
    // Host-only/broker-like tools
    "status",
    "list_claims",
    "claim_tab",
    "release_tab",
    "open_tab",
  ]).has(toolName);
}

async function ensureSessionTab(sessionId) {
  const state = getSessionState(sessionId);
  if (state?.defaultTabId) return state.defaultTabId;
  const res = await sendExtensionTool("new_tab", { url: "about:blank", active: false });
  let parsed;
  try { parsed = JSON.parse(res); } catch { parsed = null; }
  const tabId = parsed?.tabId;
  if (!Number.isFinite(tabId)) throw new Error("Failed to create agent tab");
  setDefaultTab(sessionId, tabId);
  touchClaim(tabId, sessionId);
  return tabId;
}

// ============================================================================
// Handle Messages from Chrome Extension
// ============================================================================

async function handleChromeMessage(message) {
  log("Received from Chrome:", summarizeMessage(message));

  switch (message.type) {
    case "ping":
      writeMessage({ type: "pong" });
      // Push user blocklist on each ping (extension pings on connect)
      pushBlocklistToExtension();
      break;
      
    case "tool_response": {
      const internal = extensionPending.get(message.id);
      if (internal) {
        extensionPending.delete(message.id);
        if (message.error?.content) internal.reject(new Error(message.error.content));
        else internal.resolve(message.result?.content);
        break;
      }

      const pending = pendingRequests.get(message.id);
      if (pending) {
        pendingRequests.delete(message.id);

        // Best-effort: if the tab was closed, drop any claim we held.
        if (!message.error && typeof message.result?.content === "string") {
          const m = message.result.content.match(/Closed tab\s+(\d+)/);
          if (m) releaseClaim(Number(m[1]));
        }

        sendToClient(pending.clientId, {
          type: "tool_response",
          id: pending.mcpId,
          result: message.result,
          error: message.error
        });
      }
      break;
    }
      
    case "get_status":
      writeMessage({
        type: "status_response",
        mcpConnected: clients.size > 0,
        clientCount: clients.size
      });
      break;
  }
}

// ============================================================================
// Main Loop
// ============================================================================

async function main() {
  // Start MCP socket server
  connectToMcpServer();
  
  // Read messages from Chrome extension
  while (true) {
    try {
      const message = await readMessage();
      if (message === null) {
        log("Received null message, exiting");
        break;
      }
      await handleChromeMessage(message);
    } catch (error) {
      log("Error reading message:", error.message);
      break;
    }
  }
  
  log("Native host exiting");
  process.exit(0);
}

// Handle graceful shutdown (SIGTERM not available on Windows)
if (platform() !== "win32") {
  process.on("SIGTERM", () => {
    log("Received SIGTERM");
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  log("Received SIGINT");
  process.exit(0);
});

main().catch((error) => {
  log("Fatal error:", error.message);
  process.exit(1);
});
