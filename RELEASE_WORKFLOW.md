# Retro Catz POS Release Workflow

## Goal
- Build a normal Windows installer that can be downloaded or emailed.
- Install newer versions over older versions without touching live inventory data.
- Keep production inventory in AppData, outside the installed program folder.

## Safety model
- Program files are replaced by the installer.
- Inventory data remains in:
  - `C:\Users\<user>\AppData\Roaming\vaultcore-pos\inventory.db`
- The app pins that data folder even if installer branding changes.
- On launch, the app creates a dated prelaunch backup once per app version per day when an inventory database already exists.
- The installer is configured to leave AppData in place during uninstall/update.

## Fast local build
Use this when you want to create files on this computer and email them manually.

1. Update `package.json` version, such as `1.0.1`.
2. Run:
   - `npm run release:windows`
3. Open `dist/`.
4. Send the setup file:
   - `RetroCatz-POS-Setup-<version>-x64.exe`

The `.zip` file in `dist/` is optional. Use the setup `.exe` for normal installs and updates.

## GitHub release build
Use this when you want GitHub to produce downloadable release files.

1. Commit and push the release changes.
2. Create and push a version tag:
   - `git tag v1.0.1`
   - `git push origin v1.0.1`
3. Wait for the Windows Release workflow to finish.
4. Download the setup `.exe` from the GitHub Release.

The workflow can also be run manually from GitHub Actions. Manual runs upload build artifacts even when no GitHub Release is created.

## What to email
For a normal patch/update email, send:
- The setup `.exe`
- A short note with version number and changes
- A reminder to close the POS before running the installer
- A note that Windows may show an unknown-publisher warning until the app has a paid code-signing certificate

Recommended wording:

```text
Close Retro Catz POS, run the attached installer, then reopen the POS.
Your inventory database is stored separately and will not be replaced by this update.
Windows may ask you to confirm the installer because this build is not yet backed by a paid code-signing certificate.
```

## Before sending a patch
1. Confirm the app opens.
2. Confirm Inventory loads.
3. Confirm Settings opens.
4. Confirm the active database path is still under `AppData\Roaming\vaultcore-pos`.
5. Confirm a fresh backup exists under `AppData\Roaming\vaultcore-pos\backups`.

## If something goes wrong
- Do not delete AppData.
- Restore from the newest backup under:
  - `C:\Users\<user>\AppData\Roaming\vaultcore-pos\backups`
- Keep a copy of the broken database before restoring so it can be inspected later.
