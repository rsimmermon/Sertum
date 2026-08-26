import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface FocusResult {
  ok: boolean;
  /** Why it could not be done, phrased for the user. */
  reason?: string;
  app?: string;
}

/** Terminal emulators we can identify from a process ancestry walk. */
const TERMINALS: Array<{ match: RegExp; app: string }> = [
  { match: /iTerm/i, app: 'iTerm2' },
  { match: /Terminal/i, app: 'Terminal' },
  { match: /ghostty/i, app: 'Ghostty' },
  { match: /WezTerm|wezterm/i, app: 'WezTerm' },
  { match: /alacritty/i, app: 'Alacritty' },
  { match: /kitty/i, app: 'kitty' },
  { match: /Warp/i, app: 'Warp' },
  { match: /Hyper/i, app: 'Hyper' },
  { match: /Code Helper|Electron/i, app: 'VS Code' },
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
export async function terminalOwnerOf(pid: number): Promise<string | null> {
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
    if (hit) return hit.app;
    if (!ppid || ppid <= 1) return null;
    current = ppid;
  }
  return null;
}

/**
 * Raises the OS window holding a session we cannot render.
 *
 * We cannot take over another terminal's PTY, but we can point you at it. On
 * macOS the exact tab is targeted by matching its controlling tty, so a window
 * with ten tabs still lands on the right one.
 */
export async function focusExternalSession(
  pid: number,
): Promise<FocusResult> {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      reason:
        'Raising another terminal’s window is only implemented on macOS so far.',
    };
  }

  const [tty, app] = await Promise.all([ttyForPid(pid), terminalOwnerOf(pid)]);
  if (!app) {
    return { ok: false, reason: 'Could not tell which terminal owns this session.' };
  }

  if (tty && (app === 'iTerm2' || app === 'Terminal')) {
    const script = app === 'iTerm2' ? iterm2Script(tty) : terminalScript(tty);
    try {
      const { stdout } = await run('osascript', ['-e', script], {
        timeout: 6000,
      });
      if (stdout.trim() === 'ok') return { ok: true, app };
    } catch (err) {
      return {
        ok: false,
        app,
        reason: `${app} refused the request. Grant Automation permission to AgentStation in System Settings › Privacy & Security.`,
      };
    }
  }

  // Fall back to raising the application without selecting a tab.
  try {
    await run('osascript', ['-e', `tell application "${app}" to activate`], {
      timeout: 5000,
    });
    return {
      ok: true,
      app,
      reason: tty
        ? undefined
        : `Raised ${app}, but the exact tab could not be identified.`,
    };
  } catch {
    return { ok: false, app, reason: `Could not activate ${app}.` };
  }
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
