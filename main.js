// main.js
const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

let backendProc = null;

function startBackend() {
  const backendPath = path.join(__dirname, "backend", "index.js");

  backendProc = spawn("node", [backendPath], {
    cwd: __dirname,
    env: { ...process.env, PORT: "5175" },
    stdio: "inherit",
    shell: false
  });
}

function stopBackend() {
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

app.on("before-quit", () => stopBackend());
process.on("exit", () => stopBackend());
process.on("SIGINT", () => { stopBackend(); process.exit(0); });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
