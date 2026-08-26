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
export interface SessionSnapshot extends SessionSpec {
  id: string;
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
  write(id: string, data: string): void;
  resize(id: string, size: PtySize): void;
  onData(cb: (e: PtyDataEvent) => void): () => void;
  onExit(cb: (e: PtyExitEvent) => void): () => void;
  onSessionUpdated(cb: (s: SessionSnapshot) => void): () => void;
  platform: NodeJS.Platform;
}
