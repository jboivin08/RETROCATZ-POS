const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function run(cmd, args, env) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...env }
  });
  if (res.error) {
    console.error("build error:", res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status || 1);
}

const projectRoot = path.join(__dirname, "..");
const userProfile = process.env.USERPROFILE || process.env.HOME || projectRoot;
const cacheDir = path.join(userProfile, "npm-cache");
const logsDir = path.join(cacheDir, "_logs");

ensureDir(logsDir);

const env = {
  NPM_CONFIG_CACHE: cacheDir,
  npm_config_cache: cacheDir,
  npm_config_loglevel: "warn"
};

const electronBuilderCli = path.join(projectRoot, "node_modules", "electron-builder", "out", "cli", "cli.js");
run(process.execPath, [electronBuilderCli, "--win", "--x64"], env);
