#!/usr/bin/env node
/**
 * OpenCode Browser - CLI Installer
 * 
 * Installs the Chrome extension and native messaging host for browser automation.
 */

import { createInterface } from "readline";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { homedir, platform } from "os";
import { join, dirname } from "path";
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

async function main() {
  console.log(`
${color("cyan", color("bright", "╔═══════════════════════════════════════════════════════════╗"))}
${color("cyan", color("bright", "║"))}        ${color("bright", "OpenCode Browser")} - Browser Automation for OpenCode       ${color("cyan", color("bright", "║"))}
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
  The MCP server starts automatically when OpenCode connects.
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

  const files = readdirSync(srcExtensionDir, { recursive: true });
  for (const file of files) {
    const srcPath = join(srcExtensionDir, file);
    const destPath = join(extensionDir, file);
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
  const hostScriptPath = join(PACKAGE_ROOT, "src", "host.js");
  const wrapperDir = join(homedir(), ".opencode-browser");
  mkdirSync(wrapperDir, { recursive: true });

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

  header("Step 5: Configure OpenCode");

  const serverPath = join(PACKAGE_ROOT, "src", "server.js");
  const mcpConfig = {
    browser: {
      type: "local",
      command: ["node", serverPath],
      enabled: true,
    },
  };

  log(`
Add this to your ${color("cyan", "opencode.json")} under "mcp":

${color("bright", JSON.stringify(mcpConfig, null, 2))}
`);

  const opencodeJsonPath = join(process.cwd(), "opencode.json");
  let shouldUpdateConfig = false;

  if (existsSync(opencodeJsonPath)) {
    shouldUpdateConfig = await confirm(`Found opencode.json in current directory. Add browser config automatically?`);
    
    if (shouldUpdateConfig) {
      try {
        const config = JSON.parse(readFileSync(opencodeJsonPath, "utf-8"));
        config.mcp = config.mcp || {};
        config.mcp.browser = mcpConfig.browser;
        writeFileSync(opencodeJsonPath, JSON.stringify(config, null, 2) + "\n");
        success("Updated opencode.json with browser MCP config");
      } catch (e) {
        error(`Failed to update opencode.json: ${e.message}`);
        log("Please add the config manually.");
      }
    }
  } else {
    log(`No opencode.json found in current directory.`);
    log(`Add the config above to your project's opencode.json manually.`);
  }

  header("Installation Complete!");

  log(`
${color("green", "✓")} Extension installed at: ${extensionDir}
${color("green", "✓")} Native host registered
${shouldUpdateConfig ? color("green", "✓") + " opencode.json updated" : color("yellow", "○") + " Remember to update opencode.json"}

${color("bright", "Next steps:")}
1. ${color("cyan", "Restart Chrome")} (close all windows and reopen)
2. Click the extension icon to verify connection
3. Restart OpenCode to load the new MCP server

${color("bright", "Available tools:")}
  browser_navigate   - Go to a URL
  browser_click      - Click an element
  browser_type       - Type into an input
  browser_screenshot - Capture the page
  browser_snapshot   - Get accessibility tree
  browser_get_tabs   - List open tabs
  browser_scroll     - Scroll the page
  browser_wait       - Wait for duration
  browser_execute    - Run JavaScript

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

Also remove the "browser" entry from your opencode.json.
`);
}

main().catch((e) => {
  error(e.message);
  process.exit(1);
});
