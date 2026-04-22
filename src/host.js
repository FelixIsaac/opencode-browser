#!/usr/bin/env node
/**
 * Native Messaging Host for OpenCode Browser Automation
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
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, chmodSync } from "fs";
import { randomBytes } from "crypto";
import { homedir, platform } from "os";
import { join } from "path";

const BASE_DIR = join(homedir(), ".opencode-browser");
const LOG_DIR = join(BASE_DIR, "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, "host.log");

// ============================================================================
// Auth Token — shared secret between host and MCP server
// ============================================================================

const TOKEN_PATH = join(BASE_DIR, "auth.token");

function loadOrCreateToken() {
  if (existsSync(TOKEN_PATH)) {
    try {
      const t = readFileSync(TOKEN_PATH, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(t)) return t;
    } catch {}
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_PATH, token, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(TOKEN_PATH, 0o600); } catch {}
  return token;
}

const AUTH_TOKEN = loadOrCreateToken();

function log(...args) {
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
  // WARNING: two separate write() calls are not atomic — if two async paths call
  // writeMessage() in the same event loop tick, bytes can interleave and corrupt
  // Chrome's length-prefixed framing. Node's single-threaded model makes this
  // unlikely but not impossible. Fix: Buffer.concat both and issue one write(),
  // or use a write queue (see parallel tool call notes).
  process.stdout.write(Buffer.concat([lengthBuffer, buffer]));
}

// ============================================================================
// MCP Server Connection
// ============================================================================

const SOCKET_PATH = platform() === "win32"
  ? "\\\\.\\pipe\\opencode-browser"
  : join(homedir(), ".opencode-browser", "browser.sock");

// Multi-client: each connected MCP server gets a unique clientId
let nextClientId = 0;
const clients = new Map(); // clientId → socket

// pendingRequests maps hostRequestId → { clientId, mcpId, ts }
// so tool responses route back to the correct client
let pendingRequests = new Map();
let requestId = 0;

const PENDING_TTL_MS = 90_000;
setInterval(() => {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, entry] of pendingRequests) {
    if (entry.ts < cutoff) {
      pendingRequests.delete(id);
      log(`Expired pending request ${id} (TTL)`);
    }
  }
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
              clearTimeout(authTimeout);
              clients.set(clientId, socket);
              log(`MCP client ${clientId} authenticated (total: ${clients.size})`);
              if (clients.size === 1) writeMessage({ type: "mcp_connected" });
            } else {
              log(`Client ${clientId}: auth failed — disconnecting`);
              socket.destroy();
            }
            continue;
          }
          handleMcpMessage(clientId, msg);
        } catch (e) {
          log("Failed to parse MCP message:", e.message);
        }
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimeout);
      if (authenticated) {
        clients.delete(clientId);
        log(`MCP client ${clientId} disconnected (total: ${clients.size})`);
        if (clients.size === 0) writeMessage({ type: "mcp_disconnected" });
      }
    });

    socket.on("error", (err) => {
      log(`MCP client ${clientId} error:`, err.message);
    });
  });

  const tryListen = () => {
    // Restrict socket to owner-only before binding (Unix only — named pipes on Windows are ACL-controlled)
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

function handleMcpMessage(clientId, message) {
  log(`Client ${clientId} →`, JSON.stringify(message));

  if (message.type === "tool_request") {
    const id = ++requestId;
    // NOTE: pendingRequests entries are only removed when Chrome sends a tool_response.
    // If server.js times out the request (60s) and removes it from its own map, this
    // entry is never cleaned up — it accumulates until process restart. In high-volume
    // workloads with frequent timeouts, add a matching TTL here.
    pendingRequests.set(id, { clientId, mcpId: message.id, ts: Date.now() });
    writeMessage({ type: "tool_request", id, tool: message.tool, args: message.args });
  }
}

function sendToClient(clientId, message) {
  const socket = clients.get(clientId);
  if (socket && !socket.destroyed) {
    socket.write(JSON.stringify(message) + "\n");
  }
}

// ============================================================================
// Handle Messages from Chrome Extension
// ============================================================================

async function handleChromeMessage(message) {
  log("Received from Chrome:", JSON.stringify(message));
  
  switch (message.type) {
    case "ping":
      writeMessage({ type: "pong" });
      break;
      
    case "tool_response": {
      const pending = pendingRequests.get(message.id);
      if (pending) {
        pendingRequests.delete(message.id);
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
