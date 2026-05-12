// main.js
const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

let backendProc = null;
let backendRestartTimer = null;
let isQuitting = false;

function startBackend() {
  if (backendProc) return;
  const backendPath = path.join(__dirname, "backend", "index.js");
  const dataDir = app.getPath("userData");

  // Use Electron's embedded Node so the packaged app works without a system Node install.
  backendProc = spawn(process.execPath, [backendPath], {
    cwd: app.isPackaged ? dataDir : __dirname,
    env: {
      ...process.env,
      PORT: "5175",
      ELECTRON_RUN_AS_NODE: "1",
      RETROCATZ_POS_DATA_DIR: dataDir
    },
    stdio: "inherit",
    shell: false
  });

  backendProc.on("exit", (code, signal) => {
    backendProc = null;
    if (isQuitting) return;
    console.warn(`[BACKEND] Local service exited (${code ?? signal ?? "unknown"}). Restarting...`);
    clearTimeout(backendRestartTimer);
    backendRestartTimer = setTimeout(startBackend, 1200);
  });
}

function stopBackend() {
  clearTimeout(backendRestartTimer);
  backendRestartTimer = null;
  if (backendProc) {
    try { backendProc.kill(); } catch (e) {}
    backendProc = null;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true
    }
  });
  win.loadFile(path.join(__dirname, "public", "index.html"));
}

app.whenReady().then(() => {
  startBackend();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
});
process.on("exit", () => {
  isQuitting = true;
  stopBackend();
});
process.on("SIGINT", () => {
  isQuitting = true;
  stopBackend();
  process.exit(0);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
