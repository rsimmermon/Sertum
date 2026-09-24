import fs from 'node:fs';
import path from 'node:path';
import { sessionEnv } from '../login-env';

/**
 * Real, existence-checked agent binary resolution, shared by every adapter
 * that needs to find a CLI without trusting PATH -- a GUI app launched from
 * Finder or the Dock inherits a bare login PATH, not the one from the user's
 * shell profile, so a plain command name resolves in `npm start` (launched
 * from a terminal) and then fails once packaged.
 *
 * Windows has a different problem: Explorer-launched processes do inherit the
 * full user/system PATH, but node-pty's Windows backend calls CreateProcess
 * directly, which resolves a bare name by trying `<name>.exe` only. A shell
 * would also try PATHEXT's other extensions, which is exactly how npm installs
 * a CLI -- as `<name>.cmd`, never `<name>.exe`. Skipping this and returning a
 * bare name spawns fine from a real shell but fails from node-pty with
 * "Cannot create process, error code: 2" (ERROR_FILE_NOT_FOUND), because
 * `<name>.exe` never existed to find.
 */

/** First candidate that exists and is executable, else null. */
export function firstExecutable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

/** Windows only: walks PATH x PATHEXT, X_OK-checking each candidate. */
export function resolveOnWindowsPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Try the next extension.
      }
    }
  }
  return null;
}

/**
 * macOS/Linux: walks the login shell's PATH, X_OK-checking each candidate.
 *
 * The fixed install locations each resolver lists cannot cover version
 * managers -- nvm puts a CLI under ~/.nvm/versions/node/<version>/bin, which
 * only exists on PATH once the user's shell profile has run. A GUI launched
 * from a desktop menu never ran that profile, so a bare command name spawned
 * from it searches a PATH without the directory. `sessionEnv()` is the PATH
 * the login shell reported, so searching it here finds what a terminal would.
 */
export function resolveOnLoginPath(name: string): string | null {
  const dirs = (sessionEnv().PATH ?? '').split(path.delimiter).filter(Boolean);
  return firstExecutable(dirs.map((dir) => path.join(dir, name)));
}
