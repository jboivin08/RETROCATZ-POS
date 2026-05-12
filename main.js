// main.js
const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let backendProc = null;
let backendRestartTimer = null;
let isQuitting = false;
const DATA_DIR_NAME = "vaultcore-pos";

function stableUserDataDir() {
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, DATA_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", DATA_DIR_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), DATA_DIR_NAME);
}

function pinUserDataDir() {
  const dataDir = stableUserDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  app.setPath("userData", dataDir);
  return dataDir;
}

async function createStartupBackup(dataDir) {
  const dbPath = path.join(dataDir, "inventory.db");
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size <= 0) return null;

  const version = app.getVersion() || "dev";
  const today = new Date().toISOString().slice(0, 10);
  const backupsDir = path.join(dataDir, "backups");
  const backupPrefix = `prelaunch-${version}-${today}`;
  fs.mkdirSync(backupsDir, { recursive: true });

  const existing = fs.readdirSync(backupsDir, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && entry.name.startsWith(backupPrefix));
  if (existing) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetDir = path.join(backupsDir, `${backupPrefix}-${stamp}`);
  const targetPath = path.join(targetDir, "inventory.db");
  fs.mkdirSync(targetDir, { recursive: true });

  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(targetPath);
  } finally {
    db.close();
  }
  fs.writeFileSync(path.join(targetDir, "metadata.json"), JSON.stringify({
    createdAt: new Date().toISOString(),
    appVersion: version,
    source: dbPath,
    reason: "prelaunch_update_safety"
  }, null, 2));
  console.log(`[BACKUP] Created startup backup: ${targetPath}`);
  return targetPath;
}

const pinnedDataDir = pinUserDataDir();

function startBackend() {
  if (backendProc) return;
  const backendPath = path.join(__dirname, "backend", "index.js");
  const dataDir = pinnedDataDir || app.getPath("userData");

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

app.whenReady().then(async () => {
  try {
    await createStartupBackup(app.getPath("userData"));
  } catch (err) {
    console.warn("[BACKUP] Startup backup skipped:", err.message);
  }
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
