import os from 'node:os';
import path from 'node:path';
import type { AgentCapabilities, AgentKind } from '../../shared/types';
import { firstExecutable, resolveOnWindowsPath } from './binary-resolve';
import { resolveCodexBinary, type CodexAppServer } from './codex-app-server';

/** The part of a session an adapter needs in order to act on it. */
export interface AgentSessionRef {
  /** Sertum's own id, used by per-session control channels such as hooks. */
  id: string;
  /** The agent's own id for this session — a Codex thread, a Claude uuid. */
  externalId: string | null;
  /** The active provider turn, when its event plane exposes one. */
  activeTurnId: string | null;
  cwd: string;
}

interface ClaudeTurnControl {
  queueSteer(sessionId: string, text: string): void;
  queueInterrupt(sessionId: string): void;
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
 * means adding one name to `AgentCapability`, answering it in every adapter's
 * `capabilities` record, and implementing it where the answer is yes.
 */
export interface AgentAdapter {
  readonly agent: AgentKind;

  /**
   * What this agent can do, answered up front.
   *
   * The methods below are the implementations; this record is the
   * declaration the UI reads before calling any of them, so a declined
   * capability can be shown as declined -- with its reason -- rather than
   * discovered by calling a method that does nothing. A method is only called
   * for a capability answered `ok` here, which is what lets a declining
   * adapter keep the inert implementation and never be asked.
   */
  readonly capabilities: AgentCapabilities;

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
   * the result only reports whether the agent now agrees. Only called when
   * `capabilities['rename-remote']` is ok; an agent with nowhere to keep a
   * name says so there instead, and wireframe C3's "both stay in sync" simply
   * does not apply to it.
   */
  renameRemote(session: AgentSessionRef, label: string): Promise<boolean>;

  /**
   * Extra argv that publishes a session for Remote Control, named `label`.
   *
   * Naming the remote session at spawn is the same move `--session-id` buys
   * for Grok: we choose the name, so a row that later appears in an account's
   * session list belongs to a known pane instead of having to be matched by
   * guesswork. Only called when `capabilities['remote-control']` is ok.
   */
  remoteControlArgs(label: string): string[];

  /** Add guidance through the agent's structured control plane. */
  steerTurn(session: AgentSessionRef, text: string): Promise<boolean>;

  /** Stop an active turn through the agent's structured control plane. */
  interruptTurn(session: AgentSessionRef): Promise<boolean>;
}

/**
 * An agent that holds no session state of its own, so every capability
 * declines. A plain shell is the pure case, and it is also the right base for
 * an agent that happens to support none of these yet. The answers are still
 * passed in rather than assumed, so each agent's reasons are its own.
 */
class InertAgentAdapter implements AgentAdapter {
  constructor(
    readonly agent: AgentKind,
    readonly capabilities: AgentCapabilities,
  ) {}

  /** A shell is already an absolute path in the environment we inherited. */
  resolveBinary(): string {
    if (process.platform === 'win32') return 'powershell.exe';
    return process.env.SHELL ?? '/bin/bash';
  }

  async renameRemote(): Promise<boolean> {
    return false;
  }

  remoteControlArgs(_label: string): string[] {
    return [];
  }

  async steerTurn(
    _session: AgentSessionRef,
    _text: string,
  ): Promise<boolean> {
    return false;
  }

  async interruptTurn(_session: AgentSessionRef): Promise<boolean> {
    return false;
  }
}

/**
 * Codex keeps thread names on its app server, so a rename is a real round
 * trip: `thread/name/set` takes the thread id and the new name.
 */
class CodexAdapter implements AgentAdapter {
  readonly agent: AgentKind = 'codex';
  readonly capabilities: AgentCapabilities = {
    'rename-remote': { ok: true },
    // Codex does have a remote surface, but it is a separate `app-server
    // daemon` with its own control socket rather than a flag on the TUI.
    // Its API is experimental even though it works on Windows, so decline
    // until Sertum deliberately opts into and owns that unstable contract.
    'remote-control': {
      ok: false,
      reason:
        'Codex is steered remotely by its own app-server daemon, which Sertum does not run yet.',
    },
    'turn-steer': { ok: true },
    'turn-interrupt': { ok: true },
  };

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

  remoteControlArgs(_label: string): string[] {
    return [];
  }

  async steerTurn(session: AgentSessionRef, text: string): Promise<boolean> {
    const threadId = session.externalId;
    if (!threadId || !this.server.connected) return false;
    const turnId =
      session.activeTurnId ?? (await this.readActiveTurn(threadId));
    if (!turnId) return false;
    try {
      await this.server.request('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text }],
      });
      return true;
    } catch {
      return false;
    }
  }

  async interruptTurn(session: AgentSessionRef): Promise<boolean> {
    const threadId = session.externalId;
    if (!threadId || !this.server.connected) return false;
    const turnId =
      session.activeTurnId ?? (await this.readActiveTurn(threadId));
    if (!turnId) return false;
    try {
      await this.server.request('turn/interrupt', { threadId, turnId });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * TUI-owned turns do not currently emit `turn/started` on the remote
   * connection. `thread/read` is the structured fallback: an id is usable
   * only when the server itself says that exact turn is still in progress.
   */
  private async readActiveTurn(threadId: string): Promise<string | null> {
    try {
      const result = (await this.server.request('thread/read', {
        threadId,
        includeTurns: true,
      })) as { thread?: { turns?: Array<{ id?: unknown; status?: unknown }> } };
      const active = result.thread?.turns
        ?.slice()
        .reverse()
        .find((turn) => turn.status === 'inProgress');
      return typeof active?.id === 'string' ? active.id : null;
    } catch {
      return null;
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
  constructor(private control: ClaudeTurnControl) {
    super('claude', {
      'rename-remote': {
        ok: false,
        reason: 'Claude Code has no way to set a session’s name from outside.',
      },
      'remote-control': { ok: true },
      'turn-steer': { ok: true },
      'turn-interrupt': { ok: true },
    });
  }

  /**
   * `--remote-control [name]` both enables Remote Control and names the
   * session that appears in the account's list, which is why the label goes
   * in here rather than being left to the hostname-derived default: with
   * several sessions published at once, "which machine" is not enough to tell
   * them apart.
   *
   * A label that starts with a dash would be read as another flag, so the
   * bare flag is used instead and Claude Code names the session itself.
   */
  override remoteControlArgs(label: string): string[] {
    const name = label.trim();
    return name && !name.startsWith('-')
      ? ['--remote-control', name]
      : ['--remote-control'];
  }

  override async steerTurn(
    session: AgentSessionRef,
    text: string,
  ): Promise<boolean> {
    this.control.queueSteer(session.id, text);
    return true;
  }

  override async interruptTurn(session: AgentSessionRef): Promise<boolean> {
    this.control.queueInterrupt(session.id);
    return true;
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

/**
 * Grok keeps a session's name in its own store and offers no way to set one
 * from outside -- `--resume` matches a title but nothing writes it -- so the
 * local label is the whole truth here, exactly as it is for Claude.
 */
class GrokAdapter extends InertAgentAdapter {
  constructor() {
    super('grok', {
      'rename-remote': {
        ok: false,
        reason: 'Grok has no way to set a session’s name from outside.',
      },
      'remote-control': {
        ok: false,
        reason: 'Grok has no remote-control surface.',
      },
      'turn-steer': {
        ok: false,
        reason: 'Grok’s event log reports turns but cannot control them.',
      },
      'turn-interrupt': {
        ok: false,
        reason: 'Grok’s event log reports turns but cannot control them.',
      },
    });
  }

  // The installer puts Grok in its own home rather than on PATH: a fresh
  // install is reachable as ~/.grok/bin/grok and nowhere else, so checking
  // there first is what makes a session start at all on a default setup.
  resolveBinary(): string {
    const home = os.homedir();
    if (process.platform === 'win32') {
      return (
        firstExecutable([path.join(home, '.grok', 'bin', 'grok.exe')]) ??
        resolveOnWindowsPath('grok') ??
        'grok.exe'
      );
    }
    return (
      firstExecutable([
        path.join(home, '.grok', 'bin', 'grok'),
        path.join(home, '.local', 'bin', 'grok'),
        '/opt/homebrew/bin/grok',
        '/usr/local/bin/grok',
      ]) ?? 'grok'
    );
  }
}

export function createAgentAdapters(deps: {
  codex: CodexAppServer;
  claudeControl: ClaudeTurnControl;
}): Map<AgentKind, AgentAdapter> {
  return new Map<AgentKind, AgentAdapter>([
    ['claude', new ClaudeAdapter(deps.claudeControl)],
    ['codex', new CodexAdapter(deps.codex)],
    ['grok', new GrokAdapter()],
    [
      'shell',
      new InertAgentAdapter('shell', {
        'rename-remote': {
          ok: false,
          reason: 'A shell has no session name of its own.',
        },
        'remote-control': {
          ok: false,
          reason: 'A shell has no agent to steer from another device.',
        },
        'turn-steer': {
          ok: false,
          reason: 'A shell has no structured turn to steer.',
        },
        'turn-interrupt': {
          ok: false,
          reason: 'A shell has no structured turn to interrupt.',
        },
      }),
    ],
  ]);
}
