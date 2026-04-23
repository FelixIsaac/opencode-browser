#!/usr/bin/env node
/**
 * OpenCode Browser - CLI Installer
 * 
 * Installs the Chrome extension and native messaging host for browser automation.
 */

import { createInterface } from "readline";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, statSync, lstatSync, unlinkSync } from "fs";
import { homedir, platform } from "os";
import { join, dirname, sep, resolve } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, "..");

const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function color(c, text) {
  return `${COLORS[c]}${text}${COLORS.reset}`;
}

function log(msg) {
  console.log(msg);
}

function success(msg) {
  console.log(color("green", "✓ " + msg));
}

function warn(msg) {
  console.log(color("yellow", "⚠ " + msg));
}

function error(msg) {
  console.log(color("red", "✗ " + msg));
}

function header(msg) {
  console.log("\n" + color("cyan", color("bright", msg)));
  console.log(color("cyan", "─".repeat(msg.length)));
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function confirm(question) {
  const answer = await ask(`${question} (y/n): `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

// ============================================================================
// Multi-agent auto-configuration
// ============================================================================

function commandExists(cmd) {
  try {
    execSync(platform() === "win32" ? `where ${cmd}` : `command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch { return false; }
}

function mergeJsonConfig(path, mutate) {
  let config = {};
  if (existsSync(path)) {
    try { config = JSON.parse(readFileSync(path, "utf-8")); }
    catch (e) { throw new Error(`Existing file is not valid JSON: ${e.message}`); }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  mutate(config);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

function appendCodexToml(path, serverPath) {
  const block = `\n[mcp_servers.browser]\ncommand = "node"\nargs = ["${serverPath.replace(/\\/g, "\\\\")}"]\n`;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf-8");
    if (existing.includes("[mcp_servers.browser]")) {
      throw new Error("[mcp_servers.browser] section already exists — edit manually");
    }
    writeFileSync(path, existing.replace(/\s+$/, "") + block);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, block.trimStart());
  }
}

async function autoConfigureAgents(serverPath) {
  const home = homedir();
  const updated = [];

  const agents = [
    {
      name: "Claude Code",
      detect: () => commandExists("claude"),
      apply: () => {
        execSync(`claude mcp add -s user browser -- node "${serverPath}"`, { stdio: "ignore" });
      },
    },
    {
      name: "OpenCode (global)",
      path: join(home, ".config", "opencode", "opencode.json"),
      detect: function () { return existsSync(dirname(this.path)); },
      apply: function () {
        mergeJsonConfig(this.path, (c) => {
          c.mcp = c.mcp || {};
          c.mcp.browser = { type: "local", command: ["node", serverPath], enabled: true };
        });
      },
    },
    {
      name: "Cursor",
      path: join(home, ".cursor", "mcp.json"),
      detect: function () { return existsSync(dirname(this.path)); },
      apply: function () {
        mergeJsonConfig(this.path, (c) => {
          c.mcpServers = c.mcpServers || {};
          c.mcpServers.browser = { command: "node", args: [serverPath] };
        });
      },
    },
    {
      name: "Windsurf",
      path: join(home, ".codeium", "windsurf", "mcp_config.json"),
      detect: function () { return existsSync(join(home, ".codeium", "windsurf")); },
      apply: function () {
        mergeJsonConfig(this.path, (c) => {
          c.mcpServers = c.mcpServers || {};
          c.mcpServers.browser = { command: "node", args: [serverPath] };
        });
      },
    },
    {
      name: "Gemini CLI",
      path: join(home, ".gemini", "settings.json"),
      detect: function () { return existsSync(dirname(this.path)); },
      apply: function () {
        mergeJsonConfig(this.path, (c) => {
          c.mcpServers = c.mcpServers || {};
          c.mcpServers.browser = { command: "node", args: [serverPath] };
        });
      },
    },
    {
      name: "Codex CLI",
      path: join(home, ".codex", "config.toml"),
      detect: function () { return existsSync(dirname(this.path)); },
      apply: function () { appendCodexToml(this.path, serverPath); },
    },
  ];

  const detected = agents.filter((a) => {
    try { return a.detect(); } catch { return false; }
  });

  if (detected.length === 0) {
    log(color("yellow", "  No installed agents detected — configure manually using Step 5 above."));
    return updated;
  }

  log(color("bright", `\nDetected ${detected.length} agent(s): ${detected.map((a) => a.name).join(", ")}`));

  for (const agent of detected) {
    if (await confirm(`  Configure ${agent.name}?`)) {
      try {
        agent.apply();
        success(`Configured ${agent.name}`);
        updated.push(agent.name);
      } catch (e) {
        error(`${agent.name}: ${e.message}`);
      }
    }
  }

  return updated;
}

async function main() {
  console.log(`
${color("cyan", color("bright", "╔═══════════════════════════════════════════════════════════╗"))}
${color("cyan", color("bright", "║"))}      ${color("bright", "OpenCode Browser")} - Browser Automation for AI Agents       ${color("cyan", color("bright", "║"))}
${color("cyan", color("bright", "║"))}                                                           ${color("cyan", color("bright", "║"))}
${color("cyan", color("bright", "║"))}  Inspired by Claude in Chrome - browser automation that   ${color("cyan", color("bright", "║"))}
${color("cyan", color("bright", "║"))}  works with your existing logins and bookmarks.           ${color("cyan", color("bright", "║"))}
${color("cyan", color("bright", "╚═══════════════════════════════════════════════════════════╝"))}
`);

  const command = process.argv[2];

  if (command === "install") {
    await install();
  } else if (command === "uninstall") {
    await uninstall();
  } else {
    log(`
${color("bright", "Usage:")}
  npx @felixisaac/opencode-browser install     Install extension and native host
  npx @felixisaac/opencode-browser uninstall   Remove native host registration

${color("bright", "After installation:")}
  Configure your agent to run: node ~/.opencode-browser/server.js
`);
  }

  rl.close();
}

async function install() {
  header("Step 1: Check Platform");

  const currentPlatform = platform();
  if (currentPlatform !== "darwin" && currentPlatform !== "linux" && currentPlatform !== "win32") {
    error(`Unsupported platform: ${currentPlatform}`);
    process.exit(1);
  }
  const platformName = currentPlatform === "darwin" ? "macOS" : currentPlatform === "win32" ? "Windows" : "Linux";
  success(`Platform: ${platformName}`);

  header("Step 2: Install Extension Directory");

  const extensionDir = join(homedir(), ".opencode-browser", "extension");
  const srcExtensionDir = join(PACKAGE_ROOT, "extension");

  mkdirSync(extensionDir, { recursive: true });

  // Zip-Slip guard: a malicious tarball could include entries like
  // "../../.ssh/authorized_keys" or symlinks pointing outside the package.
  // Refuse anything that resolves outside extensionDir, and skip symlinks
  // entirely so copyFileSync can't write through them.
  const safeRoot = resolve(extensionDir) + sep;
  const files = readdirSync(srcExtensionDir, { recursive: true });
  for (const file of files) {
    const srcPath = join(srcExtensionDir, file);
    const destPath = join(extensionDir, file);
    if (!resolve(destPath).startsWith(safeRoot)) {
      throw new Error(`Refusing to write outside install dir: ${destPath}`);
    }
    if (lstatSync(srcPath).isSymbolicLink()) {
      warn(`Skipping symlink in package: ${file}`);
      continue;
    }
    if (statSync(srcPath).isDirectory()) {
      mkdirSync(destPath, { recursive: true });
    } else {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    }
  }

  success(`Extension files copied to: ${extensionDir}`);

  header("Step 3: Load Extension in Chrome");

  log(`
To load the extension:

1. Open Chrome and go to: ${color("cyan", "chrome://extensions")}
2. Enable ${color("bright", "Developer mode")} (toggle in top right)
3. Click ${color("bright", "Load unpacked")}
4. Select this folder: ${color("cyan", extensionDir)}
5. Copy the ${color("bright", "Extension ID")} shown under the extension name
   (looks like: abcdefghijklmnopqrstuvwxyz123456)
`);

  const openChrome = await confirm("Open Chrome extensions page now?");
  if (openChrome) {
    try {
      if (currentPlatform === "darwin") {
        execSync('open -a "Google Chrome" "chrome://extensions"', { stdio: "ignore" });
      } else if (currentPlatform === "win32") {
        execSync('start chrome "chrome://extensions"', { stdio: "ignore", shell: true });
      } else {
        execSync('xdg-open "chrome://extensions"', { stdio: "ignore" });
      }
    } catch {}
  }

  const openFinder = await confirm("Open extension folder in file manager?");
  if (openFinder) {
    try {
      if (currentPlatform === "darwin") {
        execSync(`open "${extensionDir}"`, { stdio: "ignore" });
      } else if (currentPlatform === "win32") {
        execSync(`explorer "${extensionDir}"`, { stdio: "ignore", shell: true });
      } else {
        execSync(`xdg-open "${extensionDir}"`, { stdio: "ignore" });
      }
    } catch {}
  }

  log("");
  const extensionId = await ask(color("bright", "Enter your Extension ID: "));

  if (!extensionId) {
    error("Extension ID is required");
    process.exit(1);
  }

  if (!/^[a-z]{32}$/.test(extensionId)) {
    warn("Extension ID format looks unusual (expected 32 lowercase letters)");
    const proceed = await confirm("Continue anyway?");
    if (!proceed) process.exit(1);
  }

  header("Step 4: Register Native Messaging Host");

  const nodePath = process.execPath;
  const wrapperDir = join(homedir(), ".opencode-browser");
  mkdirSync(wrapperDir, { recursive: true });
  // Wrapper points to the installed host.js (copied below) — not the npx cache,
  // which can be cleared/relocated and would break Chrome's native messaging launch.
  const hostScriptPath = join(wrapperDir, "host.js");

  let wrapperPath;
  if (currentPlatform === "win32") {
    wrapperPath = join(wrapperDir, "host-wrapper.cmd");
    writeFileSync(wrapperPath, `@echo off\r\n"${nodePath}" "${hostScriptPath}" %*\r\n`);
  } else {
    wrapperPath = join(wrapperDir, "host-wrapper.sh");
    writeFileSync(wrapperPath, `#!/bin/bash\nexec "${nodePath}" "${hostScriptPath}" "$@"\n`, { mode: 0o755 });
  }

  const manifest = {
    name: "com.opencode.browser_automation",
    description: "OpenCode Browser Automation Native Messaging Host",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  if (currentPlatform === "win32") {
    // On Windows, manifest lives anywhere; Chrome finds it via registry
    const manifestPath = join(wrapperDir, "com.opencode.browser_automation.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const regKey = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.opencode.browser_automation";
    execSync(`REG ADD "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: "ignore", shell: true });
    success(`Native host manifest: ${manifestPath}`);
    success(`Registry key written: ${regKey}`);
  } else {
    const nativeHostDir = currentPlatform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
      : join(homedir(), ".config", "google-chrome", "NativeMessagingHosts");
    mkdirSync(nativeHostDir, { recursive: true });
    const manifestPath = join(nativeHostDir, "com.opencode.browser_automation.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    success(`Native host registered at: ${manifestPath}`);
  }

  const logsDir = join(homedir(), ".opencode-browser", "logs");
  mkdirSync(logsDir, { recursive: true });

  // Copy server.js and host.js to ~/.opencode-browser/ so agents (and the
  // native-messaging wrapper) reference a stable path, not the npx cache.
  const installedServerPath = join(wrapperDir, "server.js");
  const installedHostPath = join(wrapperDir, "host.js");
  copyFileSync(join(PACKAGE_ROOT, "src", "server.js"), installedServerPath);
  copyFileSync(join(PACKAGE_ROOT, "src", "host.js"), installedHostPath);

  // Write stub package.json so server.js can read its version from the install dir
  const pkgVersion = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8")).version;
  writeFileSync(
    join(wrapperDir, "package.json"),
    JSON.stringify({ name: "opencode-browser-installed", version: pkgVersion }, null, 2) + "\n"
  );
  success(`Server installed at: ${installedServerPath}`);

  header("Step 5: Configure Your Agent");

  const mcpConfig = {
    browser: {
      type: "local",
      command: ["node", installedServerPath],
      enabled: true,
    },
  };

  log(`
${color("bright", "Claude Code (global):")}
  claude mcp add -s user browser -- node ${installedServerPath}

${color("bright", "OpenCode")} — add to opencode.json under "mcp":
${color("bright", JSON.stringify(mcpConfig, null, 2))}

${color("bright", "Other agents")} — use: node ${installedServerPath}
`);

  const updatedConfigs = await autoConfigureAgents(installedServerPath);

  // Project-level opencode.json takes precedence if present in cwd
  const opencodeJsonPath = join(process.cwd(), "opencode.json");
  if (existsSync(opencodeJsonPath)) {
    if (await confirm(`Also update project opencode.json in current directory?`)) {
      try {
        const config = JSON.parse(readFileSync(opencodeJsonPath, "utf-8"));
        config.mcp = config.mcp || {};
        config.mcp.browser = { type: "local", command: ["node", installedServerPath], enabled: true };
        writeFileSync(opencodeJsonPath, JSON.stringify(config, null, 2) + "\n");
        success("Updated project opencode.json");
        updatedConfigs.push("opencode.json (project)");
      } catch (e) {
        error(`Failed to update opencode.json: ${e.message}`);
      }
    }
  }

  header("Installation Complete!");

  log(`
${color("green", "✓")} Extension installed at: ${extensionDir}
${color("green", "✓")} Server installed at:    ${installedServerPath}
${color("green", "✓")} Native host registered
${updatedConfigs.length ? color("green", "✓") + " Auto-configured: " + updatedConfigs.join(", ") : color("yellow", "○") + " No agent configs auto-updated — see Step 5 above"}

${color("bright", "Next steps:")}
1. ${color("cyan", "Restart Chrome")} (close all windows and reopen)
2. Click the extension icon to verify connection
3. Restart your agent to load the MCP server

${color("bright", "Available tools (15):")}
  browser_snapshot         - Accessibility tree — start here
  browser_screenshot       - Visual page capture
  browser_navigate         - Go to a URL
  browser_click            - Click by CSS selector
  browser_type             - Type into an input
  browser_keyboard         - Send key events
  browser_wait_for_selector- Wait for element to appear
  browser_scroll           - Scroll page or element
  browser_wait             - Wait fixed duration
  browser_execute          - Run JavaScript (via chrome.debugger)
  browser_get_tabs         - List open tabs
  browser_new_tab          - Open a new tab
  browser_close_tab        - Close a tab
  browser_switch_tab       - Focus a tab
  browser_new_window       - Open a new window

${color("bright", "Logs:")} ~/.opencode-browser/logs/
`);
}

async function uninstall() {
  header("Uninstalling OpenCode Browser");

  const currentPlatform = platform();

  if (currentPlatform === "win32") {
    const manifestPath = join(homedir(), ".opencode-browser", "com.opencode.browser_automation.json");
    const regKey = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.opencode.browser_automation";
    try {
      execSync(`REG DELETE "${regKey}" /f`, { stdio: "ignore", shell: true });
      success("Removed registry key");
    } catch {
      warn("Registry key not found");
    }
    if (existsSync(manifestPath)) {
      unlinkSync(manifestPath);
      success("Removed native host manifest");
    }
  } else {
    const nativeHostDir = currentPlatform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
      : join(homedir(), ".config", "google-chrome", "NativeMessagingHosts");
    const manifestPath = join(nativeHostDir, "com.opencode.browser_automation.json");
    if (existsSync(manifestPath)) {
      unlinkSync(manifestPath);
      success("Removed native host registration");
    } else {
      warn("Native host manifest not found");
    }
  }

  log(`
${color("bright", "Note:")} Extension files at ~/.opencode-browser/ were not removed.
Remove manually if needed:
  Windows: rmdir /s /q %USERPROFILE%\\.opencode-browser
  Unix:    rm -rf ~/.opencode-browser/

Also remove the "browser" MCP entry from your agent config.
`);
}

main().catch((e) => {
  error(e.message);
  process.exit(1);
});
