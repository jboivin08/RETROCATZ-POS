const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const projectRoot = path.join(__dirname, "..");
const backendPath = path.join(projectRoot, "backend", "index.js");
const electronPath = require("electron");
const APP_DATA_DIR_NAME = "vaultcore-pos";

function getDefaultDataDir() {
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, APP_DATA_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_DATA_DIR_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), APP_DATA_DIR_NAME);
}

const dataDir = process.env.RETROCATZ_POS_DATA_DIR || getDefaultDataDir();

const child = spawn(electronPath, [backendPath], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: process.env.PORT || "5175",
    RETROCATZ_POS_DATA_DIR: dataDir
  },
  stdio: "inherit",
  shell: false
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code || 0);
});

child.on("error", (err) => {
  console.error("backend start failed:", err.message);
  process.exit(1);
});
