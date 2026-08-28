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
  /**
   * True when an adapter is feeding this session's status. False means the
   * dot reflects process lifecycle only -- we do not know what the agent is
   * doing, and the UI should not pretend otherwise.
   */
  adapterBound: boolean;
  /** Model slug in use, when known. */
  model: string | null;
  /** Reasoning effort / thinking level, when the agent reports one. */
  effort: string | null;
  /** Tokens occupying the context window on the latest request. */
  contextTokens: number | null;
  contextLimit: number | null;
  /** Where this session's transcript lives, once known. */
  transcriptPath: string | null;
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
 * An agent session running outside Sertum.
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
  /** macOS withheld Automation consent, so the user has a toggle to flip. */
  needsPermission?: boolean;
}

export interface AdapterStatus {
  claude: { connected: boolean; port: number; events: number; binaryFound: boolean };
  codex: { connected: boolean; url: string; events: number; binaryFound: boolean };
}

/** What auto-detection found for one agent, ignoring any saved override. */
export interface BinaryDetection {
  /** The resolved, existence-checked path, or null if nothing was found. */
  path: string | null;
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

/** One git worktree in the C9 inventory. */
export interface WorktreeInfo {
  path: string;
  name: string;
  /** Null when the worktree is on a detached HEAD. */
  branch: string | null;
  detached: boolean;
  locked: boolean;
  /** The repository's own checkout, which can never be removed. */
  isMain: boolean;
  modified: number;
  untracked: number;
  /** Already contained in the default branch, so safe to reclaim. */
  merged: boolean;
  /** Null where the size could not be measured. */
  sizeBytes: number | null;
  /**
   * Created and kept by Sertum's pool, as opposed to one made by hand. Pooled
   * worktrees are the ones reuse and reclaim apply to.
   */
  managed: boolean;
  /** The session working in this worktree, when one is. */
  sessionId: string | null;
}

export interface WorktreeInventory {
  repo: string;
  root: string;
  worktrees: WorktreeInfo[];
  /** Untracked files copied into every new worktree, when configured. */
  includeFile: { path: string; entries: string[] } | null;
}

/** Outcome of asking for a worktree to work in (wireframe C1 isolation). */
export interface WorktreeProvisionResult {
  ok: boolean;
  path?: string;
  /** An existing managed worktree was handed back rather than created. */
  reused?: boolean;
  /** Untracked files copied in from .worktreeinclude. */
  copied?: string[];
  reason?: string;
}

export interface PtySize {
  cols: number;
  rows: number;
}

/** Where the session tabs live. The sidebar alone is the default. */
export type TabPlacement = 'side' | 'top' | 'both';

/**
 * User preferences. Everything here is a display choice — nothing about a
 * session's behaviour lives in settings, so a corrupt or missing file can
 * always fall back to DEFAULT_SETTINGS without losing work.
 */
/**
 * How many terminals the pane area shows at once — design section 07.
 *
 * Opt-in: every window starts at `single` and splitting is a per-window
 * choice. Tabs stay the session registry; a layout only decides how many of
 * them are visible together.
 */
export type PaneLayout = 'single' | 'columns' | 'rows' | 'grid';

/** Panes a layout draws. Four is the practical ceiling (design G3). */
export const PANE_COUNT: Record<PaneLayout, number> = {
  single: 1,
  columns: 2,
  rows: 2,
  grid: 4,
};

/**
 * Gutter positions, as the fraction of the axis given to the first pane.
 *
 * Stored per layout per axis, because a split you tuned for Columns should
 * not be disturbed by visiting Grid. `col` splits left/right, `row` splits
 * top/bottom, so Grid needs both and the others need one each.
 */
export interface PaneSplits {
  columns: number;
  rows: number;
  gridCol: number;
  gridRow: number;
}

export interface Settings {
  tabPlacement: TabPlacement;
  /** Pane layout, remembered until changed (design G4). */
  paneLayout: PaneLayout;
  paneSplits: PaneSplits;
  /** Point sizes. The terminal is separate: it is read far more closely. */
  terminalFontSize: number;
  tabFontSize: number;
  listFontSize: number;
  uiFontSize: number;
  /** Sidebar width in px, dragged by the splitter. */
  sidebarWidth: number;
  /** Model and effort badges on tabs and rows. */
  showChips: boolean;
  /**
   * Explicit path to an agent's CLI, overriding auto-detection. Empty string
   * means "keep auto-detecting" -- this is what Settings clears a field back
   * to, not a sentinel some other part of the app has to know about.
   */
  agentBinaryPaths: { claude: string; codex: string };
}

export const DEFAULT_SETTINGS: Settings = {
  tabPlacement: 'side',
  paneLayout: 'single',
  paneSplits: { columns: 0.5, rows: 0.5, gridCol: 0.5, gridRow: 0.5 },
  terminalFontSize: 14,
  tabFontSize: 13,
  listFontSize: 13,
  uiFontSize: 13,
  sidebarWidth: 280,
  showChips: true,
  agentBinaryPaths: { claude: '', codex: '' },
};

/** The surface exposed to the renderer through the preload bridge. */
export interface SertumApi {
  createSession(spec: Partial<SessionSpec>): Promise<SessionSnapshot>;
  listSessions(): Promise<SessionSnapshot[]>;
  killSession(id: string): Promise<void>;
  /**
   * Rename a session. The label is Sertum's own, so this works for every
   * agent -- including a plain shell, which has no notion of a session name.
   * Resolves the stored label, which may differ from the request when an
   * empty name falls back to the folder.
   */
  renameSession(id: string, label: string): Promise<string | null>;
  /**
   * End a session and forget it. Resolves false if the process survived even
   * SIGKILL, in which case the session is kept rather than stranded.
   */
  removeSession(id: string): Promise<boolean>;
  /**
   * Put text on the system clipboard.
   *
   * Goes through the main process on purpose: navigator.clipboard needs a
   * secure context, which the dev server is and a packaged file:// build is
   * not, so the browser API would work in development and fail once shipped.
   */
  copyText(text: string): Promise<void>;
  /** Git worktrees for the repository containing `cwd` (wireframe C9). */
  listWorktrees(cwd: string): Promise<WorktreeInventory | null>;
  /** Remove a worktree. `force` discards uncommitted work in it. */
  removeWorktree(
    root: string,
    worktreePath: string,
    force: boolean,
  ): Promise<{ ok: boolean; reason?: string }>;
  /**
   * Get a worktree for a branch, creating it or reusing a managed one.
   * Agent-neutral: a worktree is git's, so every agent takes the same path.
   */
  provisionWorktree(
    cwd: string,
    branch: string,
    copyIncludes: boolean,
  ): Promise<WorktreeProvisionResult>;
  /** Show a folder in the OS file manager. */
  revealPath(target: string): Promise<void>;
  /** Native folder picker. Resolves null if the user cancels. */
  pickDirectory(startIn?: string): Promise<string | null>;
  /** Native file picker, for browsing to an agent's CLI. Resolves null if the user cancels. */
  pickFile(startIn?: string): Promise<string | null>;
  /**
   * Runs auto-detection for one agent right now, ignoring any saved override
   * -- what Settings' "Detect" button and manual-path validation both call.
   */
  detectAgentBinary(agent: 'claude' | 'codex'): Promise<BinaryDetection>;
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
  /** Opens Privacy & Security › Automation, where our grant lives. */
  openAutomationSettings(): Promise<void>;
  write(id: string, data: string): void;
  resize(id: string, size: PtySize): void;
  onData(cb: (e: PtyDataEvent) => void): () => void;
  onExit(cb: (e: PtyExitEvent) => void): () => void;
  onSessionUpdated(cb: (s: SessionSnapshot) => void): () => void;
  /** Persisted display preferences. */
  getSettings(): Promise<Settings>;
  /** Merges a patch and returns the settings as stored. */
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  platform: NodeJS.Platform;
}
