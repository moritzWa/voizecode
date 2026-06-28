// voizecode desktop shell: its own window (drop it on any macOS Space), auto-grants the mic,
// and starts the relay+client+agent if they aren't already running, then loads the web app.
const { app, BrowserWindow, dialog, session, systemPreferences, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

const CLIENT = "http://localhost:3030";
const RELAY = "http://localhost:8787";
const REPO = path.resolve(__dirname, "..");
let quitting = false; // true once the user confirms a close or a real app quit is underway

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
  quitting = false; // re-arm the close prompt for this fresh window
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

  // Confirm before closing, so an accidental Cmd+W doesn't kill an in-progress call.
  // `quitting` lets a real quit (Cmd+Q / menu) and the confirmed close skip the prompt.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    const response = dialog.showMessageBoxSync(win, {
      type: "question", buttons: ["Cancel", "Close"], defaultId: 0, cancelId: 0,
      title: "voizecode", message: "Close voizecode?",
      detail: "Your sessions keep running on the relay and reappear when you reopen.",
    });
    if (response === 1) { quitting = true; app.quit(); } // quit fully so the single-instance lock is released
  });

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

// Single instance: a second launch (e.g. re-running `voize`) focuses the existing window
// instead of opening a duplicate. The new chat tab for that dir arrives over the relay.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [w] = BrowserWindow.getAllWindows();
    if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
    else createWindow(); // app was alive but windowless (e.g. closed on macOS) -> bring it back
  });
  app.on("before-quit", () => { quitting = true; }); // Cmd+Q / menu quit skips the close prompt
  app.whenReady().then(createWindow);
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
