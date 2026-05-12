const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function readElectronVersion() {
  const installedPkgPath = path.join(__dirname, "..", "node_modules", "electron", "package.json");
  if (fs.existsSync(installedPkgPath)) {
    const installedPkg = JSON.parse(fs.readFileSync(installedPkgPath, "utf8"));
    if (installedPkg.version) return installedPkg.version;
  }

  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const raw =
    (pkg.devDependencies && pkg.devDependencies.electron) ||
    (pkg.dependencies && pkg.dependencies.electron) ||
    "";
  return raw.replace(/^[^0-9]*/, "");
}

function readElectronPath() {
  try {
    return require("electron");
  } catch {
    return "";
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function run(cmd, args, env, options = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: options.cwd || projectRoot,
    env: { ...process.env, ...env }
  });
  if (res.error) {
    console.error("prebuild error:", res.error.message);
    if (options.allowFailure) return 1;
    process.exit(1);
  }
  if (res.status !== 0) {
    if (options.allowFailure) return res.status || 1;
    console.error("prebuild failed with exit code:", res.status);
    process.exit(res.status || 1);
  }
  return 0;
}

const projectRoot = path.join(__dirname, "..");
const cacheDir = path.join(projectRoot, ".npm-cache");
const logsDir = path.join(cacheDir, "_logs");
const electronVersion = readElectronVersion();
const electronPath = readElectronPath();

ensureDir(logsDir);

if (!electronVersion) {
  console.error("Unable to determine Electron version from package.json.");
  process.exit(1);
}

console.log(`prebuild: rebuilding better-sqlite3 for Electron ${electronVersion}`);

if (electronPath) {
  const verify = spawnSync(electronPath, ["-e", "require('better-sqlite3')"], {
    cwd: projectRoot,
    stdio: "ignore",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  if (verify.status === 0) {
    console.log("prebuild: existing better-sqlite3 binary already works with Electron");
    process.exit(0);
  }
}

const env = {
  NPM_CONFIG_CACHE: cacheDir,
  npm_config_cache: cacheDir,
  npm_config_runtime: "electron",
  npm_config_target: electronVersion,
  npm_config_disturl: "https://electronjs.org/headers"
};

const betterSqliteDir = path.join(projectRoot, "node_modules", "better-sqlite3");
const prebuildInstallBin = path.join(projectRoot, "node_modules", "prebuild-install", "bin.js");
const nodeGypBin = path.join(projectRoot, "node_modules", "node-gyp", "bin", "node-gyp.js");

if (fs.existsSync(prebuildInstallBin)) {
  const installed = run(
    process.execPath,
    [prebuildInstallBin, "--runtime", "electron", "--target", electronVersion],
    env,
    { cwd: betterSqliteDir, allowFailure: true }
  );
  if (installed === 0) process.exit(0);
}

if (!fs.existsSync(nodeGypBin)) {
  console.error("prebuild failed: node-gyp is not installed for source rebuild fallback.");
  process.exit(1);
}

run(process.execPath, [nodeGypBin, "rebuild", "--release"], env, { cwd: betterSqliteDir });
