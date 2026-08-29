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

export type AgentKind = 'claude' | 'codex' | 'grok' | 'shell';

/**
 * The agents with a CLI of their own to find, configure and report on.
 *
 * A shell is excluded because there is nothing to detect: it is whatever the
 * environment already says it is. Naming this once keeps Settings, detection
 * and the status bar from each spelling the union out and drifting apart.
 */
export type ManagedAgent = Exclude<AgentKind, 'shell'>;

/**
 * What an agent can do beyond running in a terminal, one name per capability
 * the UI offers.
 *
 * Every adapter answers every one of these, explicitly, in its `capabilities`
 * record -- adding a name here fails to compile until each agent has said yes
 * or no. That is the point: a declined capability is a deliberate answer with
 * a reason the UI can show, distinct from one nobody thought about. The UI
 * reads the answers up front and renders honestly, instead of calling a
 * method to find out that it does nothing.
 */
export type AgentCapability =
  /** Mirror a session's Sertum label into the agent's own records (C3). */
  | 'rename-remote'
  /**
   * Publish a session we own so it can be steered from another device.
   *
   * Publish only. Listing the sessions an account has running on *other*
   * machines is a separate capability nobody can implement yet: Claude Code
   * exposes that roster to a slash command inside a connected session and
   * nowhere a program can read, and reading it off the TUI would be plane 1
   * pretending to be plane 2.
   */
  | 'remote-control'
  /** Add structured guidance without writing characters into the PTY. */
  | 'turn-steer'
  /** Stop an active turn through the agent's structured control plane. */
  | 'turn-interrupt';

/** Yes, or no with the reason in user-facing words. */
export type CapabilityAnswer = { ok: true } | { ok: false; reason: string };

export type AgentCapabilities = Readonly<
  Record<AgentCapability, CapabilityAnswer>
>;

/** What the user asked for when starting a session. */
export interface SessionSpec {
  label: string;
  agent: AgentKind;
  cwd: string;
  /** Executable to spawn. */
  command: string;
  args: string[];
  /**
   * Start this session published for Remote Control, so it can be steered
   * from claude.ai or the Claude app.
   *
   * Opt-in per session and never inferred: while it is on, the transcript is
   * stored on Anthropic servers to keep devices in step, which is the user's
   * call to make rather than a default to inherit. Ignored for an agent whose
   * adapter declines `remote-control`.
   */
  remoteControl: boolean;
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
  /**
   * Grok has nothing to connect to. Its status comes from tailing each
   * session's own event log, so the only thing that can be missing is the CLI
   * itself -- hence a count of what is being followed rather than a
   * connection flag the other two need.
   */
  grok: { watching: number; events: number; binaryFound: boolean };
}

/**
 * What the application menu needs in order to disable what cannot act.
 *
 * The renderer is the only honest source: it owns which session is focused,
 * what order the list is in, and whether a split is up -- and `⌘1…9` addresses
 * panes rather than sessions while one is. Main holds the menu but knows none
 * of that, so the renderer states the conclusions rather than the inputs.
 */
export interface MenuState {
  /** Sessions that exist. */
  count: number;
  /** A session is focused, so the per-session commands have a target. */
  hasActive: boolean;
  /** That session still has a live process to interrupt or stop. */
  activeRunning: boolean;
  /** Highest N that `⌘N` can actually reach — panes when a split is up. */
  gotoLimit: number;
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
  /**
   * Sessions whose working folder lies inside this worktree.
   *
   * A list rather than one id because nothing stops two sessions sharing a
   * checkout, and this is the field removal is gated on -- reporting only the
   * first would let the second be deleted out from under.
   */
  sessionIds: string[];
}

/** Outcome of asking for a worktree to be deleted. */
export interface WorktreeRemoveResult {
  ok: boolean;
  reason?: string;
  /**
   * Sessions occupying the folder, when that is why the removal was refused.
   * Returned so the caller can name them: the main process knows ids, only
   * the renderer knows what the user calls them.
   */
  busySessionIds?: string[];
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
  agentBinaryPaths: Record<ManagedAgent, string>;
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
  agentBinaryPaths: { claude: '', codex: '', grok: '' },
};

/**
 * What the clipboard is offering a terminal paste.
 *
 * An image is handed over as a path rather than as bytes: a PTY carries
 * characters, so the file on disk is the only form an agent on the other end
 * can act on.
 */
export type ClipboardPaste =
  | { kind: 'text'; text: string }
  | { kind: 'image'; path: string }
  | { kind: 'empty' };

/** The surface exposed to the renderer through the preload bridge. */
export interface SertumApi {
  createSession(spec: Partial<SessionSpec>): Promise<SessionSnapshot>;
  listSessions(): Promise<SessionSnapshot[]>;
  killSession(id: string): Promise<void>;
  /** Add structured guidance to a turn without automating terminal input. */
  steerSession(id: string, text: string): Promise<boolean>;
  /** Interrupt the active turn through its adapter, not with PTY bytes. */
  interruptTurn(id: string): Promise<boolean>;
  /**
   * Rename a session. The label is Sertum's own, so this works for every
   * agent -- including a plain shell, which has no notion of a session name.
   * Resolves the stored label, which may differ from the request when an
   * empty name falls back to the folder.
   */
  renameSession(id: string, label: string): Promise<string | null>;
  /**
   * Every agent's answer to every capability, declared once by its adapter.
   * Fixed for the life of the app, so one read at startup is enough.
   */
  agentCapabilities(): Promise<Record<AgentKind, AgentCapabilities>>;
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
  /**
   * Read the system clipboard for a paste into a terminal.
   *
   * Read here rather than in the renderer because an image has to be spilled
   * to a file before it can cross a PTY, and only the main process can write
   * one.
   */
  readClipboard(): Promise<ClipboardPaste>;
  /** Git worktrees for the repository containing `cwd` (wireframe C9). */
  listWorktrees(cwd: string): Promise<WorktreeInventory | null>;
  /**
   * Remove a worktree. `force` discards uncommitted work in it.
   *
   * Refused by the main process whenever a session is working in the folder,
   * and `force` does not override that -- see removeWorktree in main.
   */
  removeWorktree(
    root: string,
    worktreePath: string,
    force: boolean,
  ): Promise<WorktreeRemoveResult>;
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
  detectAgentBinary(agent: ManagedAgent): Promise<BinaryDetection>;
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
