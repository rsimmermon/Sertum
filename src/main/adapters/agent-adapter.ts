import os from 'node:os';
import path from 'node:path';
import type { AgentKind } from '../../shared/types';
import { firstExecutable, resolveOnWindowsPath } from './binary-resolve';
import { resolveCodexBinary, type CodexAppServer } from './codex-app-server';

/** The part of a session an adapter needs in order to act on it. */
export interface AgentSessionRef {
  /** The agent's own id for this session — a Codex thread, a Claude uuid. */
  externalId: string | null;
  cwd: string;
}

/**
 * What Sertum needs from an agent: declared once, implemented once per agent.
 *
 * Every capability the UI offers is named here so a feature behaves the same
 * whichever agent a session is running. The sidebar, the menus and the
 * palette call these methods and never branch on `AgentKind` themselves.
 *
 * How a capability is met is entirely the implementation's business, and the
 * implementations differ wildly: Codex answers a rename with a JSON-RPC call
 * to its app server, a shell answers by declining. Declining is a first-class
 * answer rather than a failure -- it keeps the interface uniform and lets the
 * UI report honestly instead of pretending an agent can do something it
 * cannot.
 *
 * Adding an agent means adding one implementation here; adding a capability
 * means adding one method and answering it for each agent.
 */
export interface AgentAdapter {
  readonly agent: AgentKind;

  /**
   * Where this agent's executable actually lives.
   *
   * A GUI app launched from Finder or the Dock inherits the bare launchd
   * PATH -- /usr/bin:/bin:/usr/sbin:/sbin -- not the one from the user's shell
   * profile. A plain `claude` therefore resolves during `npm start`, where the
   * launching terminal's PATH is inherited, and then fails in the packaged
   * build with the agent exiting immediately. Each agent knows its own install
   * locations, so each answers for itself; PATH remains the last resort, which
   * is the correct answer when the app was started from a shell.
   */
  resolveBinary(): string;

  /**
   * Mirror a session's new name into the agent's own records.
   *
   * Sertum has already renamed the session locally by the time this runs, so
   * the result only reports whether the agent now agrees. False means this
   * agent has nowhere to keep a name — wireframe C3's "both stay in sync"
   * simply does not apply to it.
   */
  renameRemote(session: AgentSessionRef, label: string): Promise<boolean>;
}

/**
 * An agent that holds no session state of its own, so every capability
 * declines. A plain shell is the pure case, and it is also the right base for
 * an agent that happens to support none of these yet.
 */
class InertAgentAdapter implements AgentAdapter {
  constructor(readonly agent: AgentKind) {}

  /** A shell is already an absolute path in the environment we inherited. */
  resolveBinary(): string {
    if (process.platform === 'win32') return 'powershell.exe';
    return process.env.SHELL ?? '/bin/bash';
  }

  async renameRemote(): Promise<boolean> {
    return false;
  }
}

/**
 * Codex keeps thread names on its app server, so a rename is a real round
 * trip: `thread/name/set` takes the thread id and the new name.
 */
class CodexAdapter implements AgentAdapter {
  readonly agent: AgentKind = 'codex';

  constructor(private server: CodexAppServer) {}

  // The app server already had to solve this to start at all; one list of
  // install locations serves both it and the TUI we spawn for the user.
  resolveBinary(): string {
    return resolveCodexBinary();
  }

  async renameRemote(
    session: AgentSessionRef,
    label: string,
  ): Promise<boolean> {
    const threadId = session.externalId;
    if (!threadId || !this.server.connected) return false;
    try {
      await this.server.request('thread/name/set', { threadId, name: label });
      return true;
    } catch {
      // The thread can end between the local rename and this call. The name
      // we already stored still stands, so this is not worth surfacing.
      return false;
    }
  }
}

/**
 * Claude Code offers no way to set a session's name from outside: hooks are
 * one-way and `claude agents` has no rename. The local label is therefore the
 * whole truth for Claude, which this states outright rather than hides behind
 * a silent no-op.
 */
class ClaudeAdapter extends InertAgentAdapter {
  constructor() {
    super('claude');
  }

  resolveBinary(): string {
    const home = os.homedir();
    if (process.platform === 'win32') {
      return (
        firstExecutable([path.join(home, '.local', 'bin', 'claude.exe')]) ??
        resolveOnWindowsPath('claude') ??
        'claude.exe'
      );
    }
    return (
      firstExecutable([
        // The official installer's location shadows the others on PATH, so it
        // is checked first for the same reason Codex checks its standalone
        // build first.
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.claude', 'local', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        path.join(home, '.volta', 'bin', 'claude'),
      ]) ?? 'claude'
    );
  }
}

export function createAgentAdapters(deps: {
  codex: CodexAppServer;
}): Map<AgentKind, AgentAdapter> {
  return new Map<AgentKind, AgentAdapter>([
    ['claude', new ClaudeAdapter()],
    ['codex', new CodexAdapter(deps.codex)],
    ['shell', new InertAgentAdapter('shell')],
  ]);
}
