# VaultCore Release Workflow (PC -> Laptop)

## Goal
- PC is source-of-truth (development machine).
- Laptop only installs release builds.

## One-time setup
1. Keep working on `master` in this repo.
2. Push changes to GitHub.
3. Use tag-based releases to build installer artifacts automatically.

A GitHub Actions workflow is configured at:
- `.github/workflows/windows-release.yml`

It triggers when you push a tag like `v1.0.1` and publishes Windows installer files to GitHub Releases.

## Daily workflow
1. Finish/test changes on PC.
2. Bump version in `package.json` (example: `1.0.1`).
3. Commit and push `master`.
4. Create and push a release tag:
   - `git tag v1.0.1`
   - `git push origin v1.0.1`
5. Wait for GitHub Action to finish.
6. Download installer from GitHub Release on laptop and install.

## Local build (optional)
If you want to generate installer locally on PC without publishing:
- `npm run build:win:local`

Output files are in `dist/`.

## Update behavior on laptop
- Install the latest release `.exe` from GitHub Releases.
- Re-running a newer installer upgrades existing installation.
- Keep production data backed up before major updates.

## Notes
- The app can be rebranded later (`productName`, app icon, installer metadata) without changing this workflow.
- If a release fails, check Actions logs for missing env vars or packaging errors.
