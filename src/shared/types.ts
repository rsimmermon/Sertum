/** Contracts shared between the main and renderer processes. */

/**
 * The one status vocabulary the whole app speaks.
 *
 * Plane 2 of the architecture: these values come from agent adapter events
 * (Claude Code hooks, Codex app-server JSON-RPC), never from parsing terminal
 * output. Until the adapters land, only `working`, `idle` and `attention` are
 * produced -- by process lifecycle, which is the one thing the PTY layer
 * legitimately knows.
 */
export type SessionStatus =
  | 'working'
  | 'needs-input'
  | 'attention'
  | 'done'
  | 'idle';

export type AgentKind = 'claude' | 'codex' | 'shell';

/** What the user asked for when starting a session. */
export interface SessionSpec {
  label: string;
  agent: AgentKind;
  cwd: string;
  /** Executable to spawn. */
  command: string;
  args: string[];
}

/** A session as the renderer sees it. */
/**
 * How this app relates to the process behind a session.
 *
 *   owned     - we spawned it, we own the PTY
 *   attached  - daemon-hosted elsewhere, we opened a terminal onto it
 *   monitored - lives in another terminal; status only, no terminal possible
 */
export type SessionOrigin = 'owned' | 'attached' | 'monitored';

export interface SessionSnapshot extends SessionSpec {
  id: string;
  origin: SessionOrigin;
  /** The agent's own session id, when we adopted rather than spawned it. */
  externalId: string | null;
  status: SessionStatus;
  pid: number | null;
  startedAt: number;
  exitCode: number | null;
  /** One-line description of what the agent is doing, from adapter events. */
  activity: string | null;
  /** When plane 2 last said anything about this session. */
  lastEventAt: number | null;
}

export interface PtyDataEvent {
  id: string;
  data: string;
}

export interface PtyExitEvent {
  id: string;
  exitCode: number;
  signal?: number;
}

/**
 * An agent session running outside AgentStation.
 *
 * `adoptMode` reflects an OS constraint, not a preference: only a
 * daemon-hosted session can have a terminal opened onto it here.
 */
export interface DiscoveredSession {
  agent: AgentKind;
  sessionId: string;
  pid: number | null;
  kind: string;
  name: string;
  cwd: string;
  status: SessionStatus;
  adoptMode: 'attach' | 'monitor';
  messagingSocket: string | null;
  /** One-line description read from the session's own transcript. */
  summary: string | null;
  lastActivityAt: number | null;
}

/** Outcome of asking the OS to raise the window owning a session. */
export interface FocusOutcome {
  ok: boolean;
  app?: string;
  reason?: string;
}

export interface AdapterStatus {
  claude: { connected: boolean; port: number; events: number };
}

/** What we can tell the user about a candidate working folder. */
export interface DirectoryInfo {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  branch: string | null;
  /** Present when the folder is a git worktree rather than a main checkout. */
  isWorktree: boolean;
}

export interface PtySize {
  cols: number;
  rows: number;
}

/** The surface exposed to the renderer through the preload bridge. */
export interface AgentStationApi {
  createSession(spec: Partial<SessionSpec>): Promise<SessionSnapshot>;
  listSessions(): Promise<SessionSnapshot[]>;
  killSession(id: string): Promise<void>;
  /** Kill and forget a session. */
  removeSession(id: string): Promise<void>;
  /** Native folder picker. Resolves null if the user cancels. */
  pickDirectory(startIn?: string): Promise<string | null>;
  /** Absolute path used when a session does not specify one. */
  defaultCwd(): Promise<string>;
  /** Validates a folder before we try to spawn an agent in it. */
  inspectDirectory(dir: string): Promise<DirectoryInfo>;
  /** Health of the plane 2 adapters. */
  adapterStatus(): Promise<AdapterStatus>;
  /** Agent sessions running outside this app. */
  discoverSessions(): Promise<DiscoveredSession[]>;
  /** Open a terminal onto a daemon-hosted session. */
  attachSession(d: DiscoveredSession): Promise<SessionSnapshot>;
  /** Track a session we cannot render, as a live status row. */
  monitorSession(d: DiscoveredSession): Promise<SessionSnapshot>;
  /** Raise the OS window that owns a session we cannot render. */
  focusExternal(pid: number): Promise<FocusOutcome>;
  write(id: string, data: string): void;
  resize(id: string, size: PtySize): void;
  onData(cb: (e: PtyDataEvent) => void): () => void;
  onExit(cb: (e: PtyExitEvent) => void): () => void;
  onSessionUpdated(cb: (s: SessionSnapshot) => void): () => void;
  platform: NodeJS.Platform;
}
