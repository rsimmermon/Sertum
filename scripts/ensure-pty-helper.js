#!/usr/bin/env node
/**
 * Restore the executable bit on node-pty's spawn-helper.
 *
 * node-pty spawns a PTY on macOS by `posix_spawn`ing a tiny helper binary --
 * `prebuilds/darwin-<arch>/spawn-helper`, which opens the slave tty, chdirs
 * and `execvp`s the real command (src/unix/spawn-helper.cc). It is passed as
 * `argv[0]` to `posix_spawn`, so the file itself has to be executable.
 *
 * node-pty 1.1.0's published npm tarball ships it mode 0644:
 *
 *   -rw-r--r--  50480  package/prebuilds/darwin-arm64/spawn-helper
 *   -rw-r--r--   9248  package/prebuilds/darwin-x64/spawn-helper
 *
 * so every install lands a helper nothing can exec. `posix_spawn` fails with
 * EACCES, and the native addon reports that as a single flat sentence --
 * `posix_spawnp failed.` -- with no errno and no path in it. Nothing about
 * the message says "a file in node_modules lost its +x bit", and because it
 * is an ordinary POSIX mode failure rather than anything TCC gates, macOS
 * offers no permission prompt either. On this project it presents as Shell
 * being the one agent that will not start: Claude and Codex run as stream
 * sessions with no PTY at all, so a broken helper never touches them.
 *
 * Linux takes node-pty's `forkpty` branch and never execs the helper, and
 * Windows uses ConPTY, so this is macOS-only -- but the chmod is written
 * against whatever prebuilds are present rather than against an arch, since
 * an install can carry both slices.
 *
 * Runs from `postinstall` and `prestart`, beside ensure-electron.js, because
 * `npm install` restores the pristine 0644 file every time.
 */
const fs = require('node:fs');
const path = require('node:path');

// Only macOS execs the helper, so only macOS needs the bit. Matching
// dev-app-name.js, which bows out on the same test.
if (process.platform !== 'darwin') process.exit(0);

const prebuilds = path.join(
  __dirname, '..', 'node_modules', 'node-pty', 'prebuilds',
);

if (!fs.existsSync(prebuilds)) {
  console.error(`[ensure-pty-helper] ${prebuilds} is missing -- node-pty is not installed.`);
  process.exit(1);
}

for (const slice of fs.readdirSync(prebuilds)) {
  const helper = path.join(prebuilds, slice, 'spawn-helper');
  let mode;
  try {
    ({ mode } = fs.statSync(helper));
  } catch {
    continue; // No helper in this slice (win32), or no such slice.
  }
  // Mirror read to execute, so the bit lands for whoever can already read it.
  const wanted = mode | ((mode & 0o444) >> 2);
  if (wanted === mode) continue;
  fs.chmodSync(helper, wanted);
  console.log(
    `[ensure-pty-helper] made ${slice}/spawn-helper executable `
    + `(${(mode & 0o777).toString(8)} -> ${(wanted & 0o777).toString(8)})`,
  );
}
