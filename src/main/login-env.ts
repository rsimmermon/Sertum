import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The environment a login shell would have produced.
 *
 * A GUI app gets the launchd environment, which is close to empty. The user's
 * real setup lives in their shell profile, and on macOS the important half of
 * it -- `brew shellenv`, tool managers, ~/.local/bin -- is conventionally in
 * `.zprofile`, which only a *login* shell reads. Spawning `$SHELL` with no
 * arguments therefore runs `.zshrc` against a PATH that never got built, and
 * the first line of it referencing a homebrew tool fails.
 *
 * Terminal.app and iTerm2 avoid this by starting login shells. We ask the
 * shell once, at startup, and spawn everything with the answer: that fixes
 * shell sessions and agents alike, including whatever those agents go on to
 * exec, which spawning a login shell per session would not.
 *
 * Deliberately not agent-specific. This is the environment of the machine, so
 * it is resolved once and shared; only the executable to run is a per-agent
 * question, and that lives on AgentAdapter.
 */

const DELIMITER = '__SERTUM_ENV__';

let cached: Record<string, string> | null = null;

/** The environment to spawn sessions with. Falls back to ours until hydrated. */
export function sessionEnv(): Record<string, string> {
  return cached ?? (process.env as Record<string, string>);
}

/**
 * Asks the user's shell for its environment, once.
 *
 * `-l` for the profile, `-i` because some setups build PATH in the
 * interactive file instead, and a delimiter because an interactive shell is
 * entitled to print banners and prompts around our output. A shell that hangs
 * or fails leaves the app on the environment it already had rather than
 * blocking startup.
 */
export async function hydrateLoginEnv(): Promise<boolean> {
  if (cached) return true;
  if (process.platform === 'win32') return false;

  // launchd usually exports SHELL, but a bundle can be started in ways that
  // do not; macOS has defaulted to zsh since Catalina.
  const shell =
    process.env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : null);
  if (!shell) return false;

  let stdout: string;
  try {
    ({ stdout } = await run(
      shell,
      ['-lic', `printf '%s' ${DELIMITER}; env; printf '%s' ${DELIMITER}`],
      { timeout: 5_000, maxBuffer: 2_000_000, encoding: 'utf8' },
    ));
  } catch {
    return false;
  }

  const start = stdout.indexOf(DELIMITER);
  const end = stdout.lastIndexOf(DELIMITER);
  if (start === -1 || end <= start) return false;

  const parsed: Record<string, string> = {};
  for (const line of stdout.slice(start + DELIMITER.length, end).split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    parsed[line.slice(0, eq)] = line.slice(eq + 1);
  }
  // A shell that told us nothing useful is not worth adopting.
  if (!parsed.PATH) return false;

  // Ours wins only where the shell said nothing: the point of the exercise is
  // to take the shell's PATH over the launchd one.
  cached = { ...(process.env as Record<string, string>), ...parsed };
  return true;
}
