import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FocusOutcome } from '../../shared/types';

const run = promisify(execFile);

/**
 * A terminal emulator we can identify from a process ancestry walk.
 *
 * `bundleId` is how the app gets raised: `open -b` goes through
 * LaunchServices, which needs no Automation grant, so a session stays
 * reachable even when Apple events are refused. `scriptable` marks the two we
 * know how to ask for a specific tab.
 */
interface Terminal {
  match: RegExp;
  app: string;
  bundleId?: string;
  scriptable?: boolean;
}

const TERMINALS: Terminal[] = [
  { match: /iTerm/i, app: 'iTerm2', bundleId: 'com.googlecode.iterm2', scriptable: true },
  { match: /Terminal/i, app: 'Terminal', bundleId: 'com.apple.Terminal', scriptable: true },
  { match: /ghostty/i, app: 'Ghostty', bundleId: 'com.mitchellh.ghostty' },
  { match: /WezTerm|wezterm/i, app: 'WezTerm', bundleId: 'com.github.wez.wezterm' },
  { match: /alacritty/i, app: 'Alacritty', bundleId: 'org.alacritty' },
  { match: /kitty/i, app: 'kitty', bundleId: 'net.kovidgoyal.kitty' },
  { match: /Warp/i, app: 'Warp', bundleId: 'dev.warp.Warp-Stable' },
  { match: /Hyper/i, app: 'Hyper', bundleId: 'co.zeit.hyper' },
  { match: /Code Helper|Electron/i, app: 'VS Code', bundleId: 'com.microsoft.VSCode' },
];

/** Controlling terminal of a process, as an absolute device path. */
export async function ttyForPid(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run('ps', ['-o', 'tty=', '-p', String(pid)], {
      timeout: 3000,
    });
    const tty = stdout.trim();
    if (!tty || tty === '?' || tty === '??') return null;
    return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
  } catch {
    return null;
  }
}

/** Walks up the parent chain until a known terminal emulator is found. */
export async function terminalOwnerOf(pid: number): Promise<Terminal | null> {
  let current = pid;
  for (let hop = 0; hop < 10; hop++) {
    let ppid: number;
    let comm: string;
    try {
      const { stdout } = await run(
        'ps',
        ['-o', 'ppid=,comm=', '-p', String(current)],
        { timeout: 3000 },
      );
      const trimmed = stdout.trim();
      if (!trimmed) return null;
      const space = trimmed.indexOf(' ');
      ppid = Number(trimmed.slice(0, space));
      comm = trimmed.slice(space + 1);
    } catch {
      return null;
    }
    const hit = TERMINALS.find((t) => t.match.test(comm));
    if (hit) return hit;
    if (!ppid || ppid <= 1) return null;
    current = ppid;
  }
  return null;
}

/**
 * Whether an osascript failure was macOS withholding Automation consent.
 *
 * -1743 covers both "never granted" and a "Don't Allow" click; the missing
 * Info.plist usage string used to produce it with no prompt at all. Anything
 * else (a target that quit, a script error) is not the user's to fix.
 */
function deniedByTcc(err: unknown): boolean {
  const detail = err as { stderr?: string; message?: string } | null;
  const text = `${detail?.stderr ?? ''} ${detail?.message ?? ''}`;
  return /-1743|-1744|Not authori[sz]ed to send Apple events/i.test(text);
}

/** Raises an app through LaunchServices, which needs no Apple events. */
async function raiseApp(terminal: Terminal): Promise<boolean> {
  const handles = terminal.bundleId
    ? [['-b', terminal.bundleId], ['-a', terminal.app]]
    : [['-a', terminal.app]];
  for (const args of handles) {
    try {
      await run('open', args, { timeout: 5000 });
      return true;
    } catch {
      // Wrong handle for this install; try the next one.
    }
  }
  return false;
}

/**
 * Raises the OS window holding a session we cannot render.
 *
 * We cannot take over another terminal's PTY, but we can point you at it. The
 * exact tab is targeted by matching its controlling tty, so a window with ten
 * tabs still lands on the right one -- that part needs Apple events, and is
 * the only part that does. If macOS withholds that consent we still raise the
 * app itself via LaunchServices, so the jump works and only tab selection is
 * lost.
 */
export async function focusExternalSession(pid: number): Promise<FocusOutcome> {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      reason:
        'Raising another terminal’s window is only implemented on macOS so far.',
    };
  }

  const [tty, terminal] = await Promise.all([
    ttyForPid(pid),
    terminalOwnerOf(pid),
  ]);
  if (!terminal) {
    return {
      ok: false,
      reason: 'Could not tell which terminal owns this session.',
    };
  }
  const app = terminal.app;

  let denied = false;
  if (tty && terminal.scriptable) {
    const script =
      app === 'iTerm2' ? iterm2Script(tty) : terminalScript(tty);
    try {
      const { stdout } = await run('osascript', ['-e', script], {
        timeout: 6000,
      });
      if (stdout.trim() === 'ok') return { ok: true, app };
    } catch (err) {
      denied = deniedByTcc(err);
    }
  }

  if (!(await raiseApp(terminal))) {
    return {
      ok: false,
      app,
      needsPermission: denied,
      reason: `Could not bring ${app} to the front.`,
    };
  }

  if (denied) {
    return {
      ok: true,
      app,
      needsPermission: true,
      reason:
        `Raised ${app}, but macOS withheld permission to select the exact ` +
        'tab. Allow Sertum to control it under Privacy & Security › Automation.',
    };
  }

  return {
    ok: true,
    app,
    reason: tty ? undefined : `Raised ${app}, but the exact tab could not be identified.`,
  };
}

function iterm2Script(tty: string): string {
  return `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is ${JSON.stringify(tty)} then
          select w
          select t
          select s
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "notfound"
end tell`;
}

function terminalScript(tty: string): string {
  return `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is ${JSON.stringify(tty)} then
        set selected tab of w to t
        set frontmost of w to true
        activate
        return "ok"
      end if
    end repeat
  end repeat
  return "notfound"
end tell`;
}
