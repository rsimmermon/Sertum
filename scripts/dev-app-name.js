#!/usr/bin/env node
/**
 * Make `electron-forge start` present as "AgentStation" instead of "Electron".
 *
 * In development the running bundle is node_modules/electron/dist/Electron.app,
 * and macOS reads its identity straight off that bundle before any of our JS
 * runs — so app.setName() cannot reach these surfaces. Three separate strings
 * feed three separate places:
 *
 *   menu bar   <- CFBundleName / CFBundleDisplayName
 *   Dock icon  <- Contents/Resources/electron.icns
 *   Dock label <- the bundle path, via a Dock-side cache
 *
 * That last one is the stubborn one: the Dock pins a name to the bundle path
 * and keeps serving it after the bundle is corrected, surviving `killall Dock`
 * and an lsregister refresh. Renaming the .app directory sidesteps the cache
 * entirely by presenting a path the Dock has never seen, which is cheaper and
 * far less invasive than rebuilding the LaunchServices database.
 *
 * Renaming the executable means also updating CFBundleExecutable, electron's
 * path.txt (how Forge locates the binary), and re-signing, since the ad-hoc
 * signature seals the executable name.
 *
 * Packaged builds need none of this: Forge writes the correct bundle from
 * packagerConfig. This only touches the throwaway dev copy, and re-applies
 * itself after any `npm install` restores the pristine bundle.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'AgentStation';
const BUNDLE_ID = 'ai.wisecode.agentstation';

if (process.platform !== 'darwin') process.exit(0);

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'node_modules', 'electron', 'dist');
const pristineApp = path.join(distDir, 'Electron.app');
const appDir = path.join(distDir, `${APP_NAME}.app`);

// A reinstall restores Electron.app; any previously renamed copy is now stale.
if (fs.existsSync(pristineApp)) {
  if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
  fs.renameSync(pristineApp, appDir);
}
const plist = path.join(appDir, 'Contents', 'Info.plist');
const macOsDir = path.join(appDir, 'Contents', 'MacOS');
const bundleIcon = path.join(appDir, 'Contents', 'Resources', 'electron.icns');
const ourIcon = path.join(root, 'assets', 'icon.icns');
const pathTxt = path.join(root, 'node_modules', 'electron', 'path.txt');

if (!fs.existsSync(plist)) process.exit(0);

const get = (key) => {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist],
      { encoding: 'utf8' }).trim();
  } catch { return null; }
};
const set = (key, value) => {
  const verb = get(key) === null ? `Add :${key} string ${value}` : `Set :${key} ${value}`;
  execFileSync('/usr/libexec/PlistBuddy', ['-c', verb, plist]);
};

const changed = [];

// 1. Menu-bar name and identity.
const names = {
  CFBundleName: APP_NAME,
  CFBundleDisplayName: APP_NAME,
  CFBundleIdentifier: BUNDLE_ID,
};
if (!Object.entries(names).every(([k, v]) => get(k) === v)) {
  for (const [key, value] of Object.entries(names)) set(key, value);
  changed.push('name');
}

// 2. Dock icon. Overwrites the file Info.plist already points at, so the
//    CFBundleIconFile key stays valid and untouched.
if (fs.existsSync(ourIcon) && fs.existsSync(bundleIcon)
    && !fs.readFileSync(ourIcon).equals(fs.readFileSync(bundleIcon))) {
  fs.copyFileSync(ourIcon, bundleIcon);
  changed.push('icon');
}

// 3. Dock label, which follows the executable name.
const pristine = path.join(macOsDir, 'Electron');
const renamed = path.join(macOsDir, APP_NAME);
if (fs.existsSync(pristine)) {
  // A reinstall restores Electron alongside any previously renamed copy.
  if (fs.existsSync(renamed)) fs.rmSync(renamed);
  fs.renameSync(pristine, renamed);
  changed.push('executable');
}
if (get('CFBundleExecutable') !== APP_NAME) set('CFBundleExecutable', APP_NAME);

// path.txt must have no trailing newline: electron reads it verbatim as a path.
const wantPath = `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`;
const havePath = fs.existsSync(pathTxt) ? fs.readFileSync(pathTxt, 'utf8') : '';
if (havePath !== wantPath) fs.writeFileSync(pathTxt, wantPath);

if (havePath !== wantPath) changed.push('bundle path');

if (!changed.length) process.exit(0);

// Renaming the executable invalidates the ad-hoc signature it was sealed with.
try {
  execFileSync('codesign', ['--force', '--sign', '-', appDir], { stdio: 'ignore' });
} catch (err) {
  console.error('[dev-app-name] re-sign failed; run `npm install` to restore:', err.message);
  process.exit(1);
}

// LaunchServices caches name and icon against the bundle path.
try {
  fs.utimesSync(appDir, new Date(), new Date());
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/'
    + 'LaunchServices.framework/Support/lsregister', ['-f', appDir], { stdio: 'ignore' });
} catch { /* cache busting is best-effort */ }

console.log(`[dev-app-name] dev bundle branded as ${APP_NAME} (${changed.join(', ')})`);
