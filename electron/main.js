// voizecode desktop shell: its own window (drop it on any macOS Space), auto-grants the mic,
// and starts the relay+client+agent if they aren't already running, then loads the web app.
const { app, BrowserWindow, session, systemPreferences, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

const CLIENT = "http://localhost:3030";
const RELAY = "http://localhost:8787";
const REPO = path.resolve(__dirname, "..");

const ping = (url) => new Promise((res) => {
  const req = http.get(url, () => { req.destroy(); res(true); });
  req.on("error", () => res(false));
  req.setTimeout(800, () => { req.destroy(); res(false); });
});

async function ensureServices() {
  if (await ping(RELAY)) return;
  spawn("npm", ["run", "dev"], { cwd: REPO, detached: true, stdio: "ignore" }).unref();
}
async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ping(url)) return true; await new Promise((r) => setTimeout(r, 1000)); }
  return false;
}

async function createWindow() {
  if (process.platform === "darwin") { try { await systemPreferences.askForMediaAccess("microphone"); } catch { /* ignore */ } }
  // grant getUserMedia (and friends) without an in-page prompt
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media" || perm === "audioCapture"));
  session.defaultSession.setPermissionCheckHandler(() => true);

  const win = new BrowserWindow({
    width: 1100, height: 840, minWidth: 380, title: "voizecode",
    webPreferences: { contextIsolation: true },
  });
  // open external links in the real browser, keep app routes in-app
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });

  // If the Next dev server restarts (HMR socket drops / page fails to load), reconnect the window.
  win.webContents.on("did-fail-load", (_e, _code, _desc, url) => {
    if (url && url.startsWith(CLIENT)) setTimeout(() => win.loadURL(CLIENT), 1000);
  });
  // Cmd/Ctrl+R = reload, Cmd/Ctrl+Alt+I = devtools (handy while iterating).
  win.webContents.on("before-input-event", (_e, input) => {
    const mod = input.meta || input.control;
    if (mod && !input.alt && input.key.toLowerCase() === "r") win.webContents.reloadIgnoringCache();
    if (mod && input.alt && input.key.toLowerCase() === "i") win.webContents.toggleDevTools();
  });

  await win.loadURL("data:text/html,<body style='font-family:system-ui;background:%23111;color:%23eee;display:grid;place-items:center;height:100vh;margin:0'><div>Starting voizecode…</div></body>");
  ensureServices();
  if (await waitFor(CLIENT)) win.loadURL(CLIENT);
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
