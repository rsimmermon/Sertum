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
  | 'turn-interrupt'
  /** Deny tool execution until the user explicitly resumes it. */
  | 'tool-gate'
  /** Decide individual tool calls from stored rules (wireframe E2). */
  | 'permission-rules'
  /**
   * Render the session as a conversation read from the agent's own
   * transcript on disk — stage 1 of the chat direction in BROKER-HANDOFF.md.
   *
   * Read-only by construction: the transcript is the agent's own account of
   * the conversation (the same class of source as a hook payload), so this is
   * plane 2 widened from status to content, never pixels parsed for meaning.
   * Input still goes to the PTY.
   */
  | 'conversation-view'
  /**
   * Run a session over the agent's structured chat protocol instead of a PTY
   * — stage 2 of BROKER-HANDOFF.md. A `stream` session has no terminal at
   * all: input goes down the agent's own bidirectional channel and content
   * comes back structured. A session type alongside terminal sessions, never
   * a replacement — the TUI still carries slash commands, plan mode and the
   * agent's own rendering, which this deliberately does not reimplement.
   */
  | 'structured-conversation'
  /**
   * Host the session in the agent's own daemon so it outlives this app —
   * the first cut of BROKER-HANDOFF.md's stage 3, uneven by design. Claude
   * solves background hosting for itself (`--bg`, `claude attach`); closing
   * Sertum then only ends the attach client, verified leaving the session
   * running. Agents with no daemon decline, and the unevenness is stated
   * here rather than hidden.
   */
  | 'background-host';

/** Yes, or no with the reason in user-facing words. */
export type CapabilityAnswer = { ok: true } | { ok: false; reason: string };

export type AgentCapabilities = Readonly<
  Record<AgentCapability, CapabilityAnswer>
>;

/**
 * How a session's agent is carried.
 *
 * `pty` is a terminal: bytes in, pixels out, plane 1. `stream` is the agent's
 * own structured chat protocol — for Claude, `--input-format stream-json` /
 * `--output-format stream-json` on a headless process. A stream session has
 * no terminal to show; its conversation view is the whole surface.
 */
export type SessionTransport = 'pty' | 'stream';

/** What the user asked for when starting a session. */
export interface SessionSpec {
  label: string;
  agent: AgentKind;
  cwd: string;
  /** Executable to spawn. */
  command: string;
  args: string[];
  /** How the agent is carried. Every session before stage 2 was `pty`. */
  transport: SessionTransport;
  /**
   * Start the session daemon-hosted, so it keeps running when Sertum
   * closes. Opt-in per session; ignored for an agent whose adapter declines
   * `background-host`. The terminal shown is an attach client, and closing
   * it detaches rather than ends the agent.
   */
  background: boolean;
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
  /** True while the adapter is denying tool execution for this session. */
  toolsPaused: boolean;
  /** Notifications for this session are muted until it finishes (E5). */
  muted: boolean;
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

/**
 * One rendered item in a session's conversation, read from the agent's own
 * transcript (the `conversation-view` capability).
 *
 * `at` is the record's own timestamp where the agent writes one; Grok's
 * chat history carries none, so null means "not recorded" rather than "now".
 */
/**
 * How a message's characters should be shown.
 *
 * `text` means rendering would change nothing — there is no markup in it, so
 * the choice never arises. `markdown` means the agent wrote markup and meant
 * it. `markdown-source` means it wrote markup because the markup *is* the
 * answer — the turn asked for the source — so the characters are shown as
 * written. See `main/adapters/markdown-format.ts` for how the three are told
 * apart, and why the reader can always overrule the guess.
 */
export type MessageFormat = 'text' | 'markdown' | 'markdown-source';

export type ChatItem =
  | {
      kind: 'message';
      role: 'user' | 'assistant';
      text: string;
      at: number | null;
      /** Always `text` for a user's own words; see `MessageFormat`. */
      format: MessageFormat;
    }
  | { kind: 'thinking'; text: string; at: number | null }
  | {
      kind: 'image';
      /** Agent-produced data URL from a structured tool result. */
      src: string;
      alt: string;
      at: number | null;
    }
  | {
      kind: 'tool';
      name: string;
      /** The part of the input a person would read: a command, a path. */
      detail: string | null;
      /** The result, paired by the agent's own call id. Null while running. */
      output: string | null;
      at: number | null;
    };

export interface ConversationSnapshot {
  items: ChatItem[];
  path: string | null;
  updatedAt: number | null;
  /** The read window cut off older records; the full history stays on disk. */
  truncated: boolean;
  /** Why there is nothing to show, when `items` is empty. */
  reason: string | null;
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
  /** An in-app dialog owns the window; outside commands must not act. */
  modalOpen: boolean;
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
  /** Why the E4 bootstrap command failed. Absent when it ran or was unset. */
  bootstrap?: string;
  reason?: string;
}

/** One changed path in C11's Git-backed review inventory. */
export interface DiffFileInfo {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** Why this path cannot be rendered, when Git has no useful text patch. */
  reason: string | null;
}

/** Read-only summary of the worktree changes shown by wireframe C11. */
export interface DiffInventory {
  root: string;
  branch: string | null;
  /**
   * Where a push would land, e.g. `origin/main`, resolved by reading Git
   * rather than assuming a remote name. Null when there is nowhere to push.
   */
  pushTarget: string | null;
  /** Why `pushTarget` is null, as user-facing copy. */
  pushReason: string | null;
  files: DiffFileInfo[];
  additions: number;
  deletions: number;
}

/** A single file's unified diff, loaded only when its row is selected. */
export interface DiffFilePatch {
  path: string;
  patch: string | null;
  reason: string | null;
}

export interface DiffDiscardResult {
  ok: boolean;
  reason?: string;
}

/**
 * What C15 asks Git to do. Paths are the rows ticked in C11's inventory, so
 * an empty list is a caller error rather than "commit everything".
 */
export interface DiffCommitRequest {
  root: string;
  message: string;
  paths: string[];
  push: boolean;
}

/**
 * Committing and pushing succeed independently, so they are reported
 * independently: a commit that lands and a push that cannot is a real state
 * the sheet has to show without implying the work was lost.
 */
export interface DiffCommitResult {
  ok: boolean;
  /** Abbreviated hash of the commit that was written, when one was. */
  commit?: string;
  /** Absent when no push was asked for. */
  push?: { ok: boolean; reason?: string };
  reason?: string;
}

/**
 * What C15 asks Git to do. Paths are the rows ticked in C11's inventory, so
 * an empty list is a caller error rather than "commit everything".
 */
export interface DiffCommitRequest {
  root: string;
  message: string;
  paths: string[];
  push: boolean;
}

/**
 * Committing and pushing succeed independently, so they are reported
 * independently: a commit that lands and a push that cannot is a real state
 * the sheet has to show without implying the work was lost.
 */
export interface DiffCommitResult {
  ok: boolean;
  /** Abbreviated hash of the commit that was written, when one was. */
  commit?: string;
  /** Absent when no push was asked for. */
  push?: { ok: boolean; reason?: string };
  reason?: string;
}

/**
 * What C15 asks Git to do. Paths are the rows ticked in C11's inventory, so
 * an empty list is a caller error rather than "commit everything".
 */
export interface DiffCommitRequest {
  root: string;
  message: string;
  paths: string[];
  push: boolean;
}

/**
 * Committing and pushing succeed independently, so they are reported
 * independently: a commit that lands and a push that cannot is a real state
 * the sheet has to show without implying the work was lost.
 */
export interface DiffCommitResult {
  ok: boolean;
  /** Abbreviated hash of the commit that was written, when one was. */
  commit?: string;
  /** Absent when no push was asked for. */
  push?: { ok: boolean; reason?: string };
  reason?: string;
}

/**
 * What C15 asks Git to do. Paths are the rows ticked in C11's inventory, so
 * an empty list is a caller error rather than "commit everything".
 */
export interface DiffCommitRequest {
  root: string;
  message: string;
  paths: string[];
  push: boolean;
}

/**
 * Committing and pushing succeed independently, so they are reported
 * independently: a commit that lands and a push that cannot is a real state
 * the sheet has to show without implying the work was lost.
 */
export interface DiffCommitResult {
  ok: boolean;
  /** Abbreviated hash of the commit that was written, when one was. */
  commit?: string;
  /** Absent when no push was asked for. */
  push?: { ok: boolean; reason?: string };
  reason?: string;
}

/**
 * What C15 asks Git to do. Paths are the rows ticked in C11's inventory, so
 * an empty list is a caller error rather than "commit everything".
 */
export interface DiffCommitRequest {
  root: string;
  message: string;
  paths: string[];
  push: boolean;
}

/**
 * Committing and pushing succeed independently, so they are reported
 * independently: a commit that lands and a push that cannot is a real state
 * the sheet has to show without implying the work was lost.
 */
export interface DiffCommitResult {
  ok: boolean;
  /** Abbreviated hash of the commit that was written, when one was. */
  commit?: string;
  /** Absent when no push was asked for. */
  push?: { ok: boolean; reason?: string };
  reason?: string;
}

/**
 * What C16 can offer for the current branch, resolved before the sheet is
 * shown. `ok: false` always carries a `reason` the user can act on.
 */
export interface PullRequestContext {
  ok: boolean;
  reason: string | null;
  /** owner/name, as GitHub knows it. */
  repo: string | null;
  base: string | null;
  head: string | null;
  /** A pull request this branch already has, if any. */
  existing: {
    url: string;
    number: number;
    state: string;
    title: string;
  } | null;
  /** Commit subjects on the branch but not on base, newest first. */
  commits: string[];
  /**
   * The branch has commits GitHub has not seen. The sheet says so on its
   * button and pushes before creating, rather than refusing.
   */
  needsPush: boolean;
  /** Seeded from a lone commit's own words; empty when there are several. */
  title: string;
  body: string;
}

export interface PullRequestResult {
  ok: boolean;
  /** The new pull request, or the existing one that blocked it. */
  url?: string;
  reason?: string;
}

/**
 * A tool call held open waiting for a person — wireframe B5.
 *
 * The agent's turn is genuinely blocked while one of these is outstanding,
 * which is why every one of them is answered: by a person, by the timeout, or
 * by the session ending.
 */
export interface PendingApproval {
  id: string;
  sessionId: string;
  tool: string;
  /** The command or path the call is about, as the rules would match it. */
  subject: string;
}

/** How far an approval reaches, from B5's four buttons. */
export type ApprovalScope = 'once' | 'session' | 'always';

export interface ApprovalAnswer {
  decision: 'allow' | 'deny';
  scope: ApprovalScope;
  reason?: string;
}

/** Which group E6 lists a shortcut under. */
export type KeybindingSection = 'Application' | 'Sessions' | 'Panes';

/** One remappable command and the chord currently bound to it. */
export interface Keybinding {
  id: string;
  label: string;
  section: KeybindingSection;
  accelerator: string;
  /** False once the user has changed it, so E6 can offer a revert. */
  isDefault: boolean;
  defaultAccelerator: string;
}

export type KeybindingResult =
  | { ok: true; bindings: Keybinding[] }
  | { ok: false; reason: string };

/** What a permission rule says to do (wireframe E2). */
export type PermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * One rule, as E2 lists it and B5's "Always allow" writes it.
 *
 * `tool` is an exact tool name or `*`; `pattern` is matched against the field
 * a person would write a rule about (a Bash command, an edited path) with `*`
 * as the only wildcard; `scope` is `*` or a repository path, which also
 * covers the worktrees beneath it.
 */
export interface PermissionRule {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: PermissionDecision;
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
  /** Persisted schema version for one-time preference-default migrations. */
  settingsVersion: number;
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
  /** Start supported agents in their own host so closing Sertum detaches. */
  agentBackground: Record<ManagedAgent, boolean>;

  // ------------------------------------------------- E3 · Terminal
  /** Empty means the stylesheet's own mono stack, not a hardcoded family. */
  terminalFontFamily: string;
  terminalLineHeight: number;
  terminalCursorStyle: TerminalCursorStyle;
  /**
   * Lines xterm keeps per session. The main memory cost in the app: this many
   * lines across eight sessions is the difference between tens and hundreds of
   * megabytes, which is why E3 states the cost next to the control.
   */
  terminalScrollback: number;
  terminalCopyOnSelect: boolean;
  /** WebGL falls back to canvas on its own; this only sets the preference. */
  terminalRenderer: TerminalRenderer;

  // ------------------------------------------------ E4 · Worktrees
  /** `fresh` branches from the remote default; `head` carries local work. */
  worktreeBase: WorktreeBase;
  /** Run in a new worktree before the agent starts. Empty means none. */
  worktreeBootstrap: string;

  // --------------------------------------------- E6 · Appearance
  /**
   * Answer tool calls in Sertum's own bar (wireframe B5) instead of letting
   * the agent ask in its terminal. This holds the agent's turn open while the
   * bar is up, which is the whole feature and also its only cost, so it is
   * switchable.
   */
  approvalsInApp: boolean;

  // -------------------------------------------- E5 · Notifications
  /**
   * Which transitions are worth interrupting for. The defaults are narrow on
   * purpose: notifications come from adapter events rather than screen
   * output, so they are exact, and an exact notifier earns the right to be
   * quiet about everything else.
   */
  notifyNeedsInput: boolean;
  notifyFailed: boolean;
  notifyFinished: boolean;
  /** Minutes a turn may run before it is mentioned. 0 never mentions it. */
  notifyLongTurnMinutes: number;
  /** With the window focused, the sidebar dot has already said it. */
  notifyOnlyWhenUnfocused: boolean;
  notifySound: boolean;
  notifyBadge: boolean;
  /** Minutes a snoozed session stays quiet. */
  notifySnoozeMinutes: number;

  // --------------------------------------------- E6 · Appearance
  theme: ThemePreference;
  accent: AccentColour;
  /** Denser sidebar rows: roughly 40% more sessions in the same height. */
  compactRows: boolean;
}

export type TerminalCursorStyle =
  | 'block'
  | 'block-blink'
  | 'bar'
  | 'bar-blink'
  | 'underline'
  | 'underline-blink';

export type TerminalRenderer = 'webgl' | 'canvas';

export type WorktreeBase = 'fresh' | 'head';

export type ThemePreference = 'system' | 'light' | 'dark';

export type AccentColour = 'blue' | 'violet' | 'green' | 'amber';

/** Offered by E3, with the per-session memory each choice implies. */
export const SCROLLBACK_CHOICES = [1000, 5000, 10_000, 50_000, 100_000];

export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: 1,
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
  agentBackground: { claude: false, codex: false, grok: false },
  terminalFontFamily: '',
  terminalLineHeight: 1.2,
  terminalCursorStyle: 'block-blink',
  terminalScrollback: 10_000,
  terminalCopyOnSelect: false,
  terminalRenderer: 'webgl',
  worktreeBase: 'fresh',
  worktreeBootstrap: '',
  approvalsInApp: true,
  notifyNeedsInput: true,
  notifyFailed: true,
  notifyFinished: true,
  notifyLongTurnMinutes: 0,
  notifyOnlyWhenUnfocused: true,
  notifySound: false,
  notifyBadge: true,
  notifySnoozeMinutes: 10,
  theme: 'system',
  accent: 'blue',
  compactRows: false,
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
  /** Enable or release the adapter's structured tool-execution gate. */
  setToolGate(id: string, paused: boolean): Promise<boolean>;
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
   * Copy or paste through the platform, so a text field behaves exactly as it
   * does everywhere else. The Edit menu routes here for every surface except
   * a terminal, whose selection and image-aware paste are its own.
   */
  copySelection(): Promise<void>;
  pasteSelection(): Promise<void>;
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
  /** Read changed paths directly from Git (wireframe C11). */
  readDiff(cwd: string): Promise<DiffInventory | null>;
  /** Load one selected path's unified diff without involving an agent. */
  readDiffFile(root: string, path: string): Promise<DiffFilePatch>;
  /** Permanently discard the currently reported worktree changes. */
  discardDiff(root: string): Promise<DiffDiscardResult>;
  /**
   * Commit the selected paths, optionally pushing (wireframe C15). Git is
   * asked directly; no agent is involved and no terminal is written to.
   */
  commitDiff(request: DiffCommitRequest): Promise<DiffCommitResult>;
  /**
   * Commit the selected paths, optionally pushing (wireframe C15). Git is
   * asked directly; no agent is involved and no terminal is written to.
   */
  commitDiff(request: DiffCommitRequest): Promise<DiffCommitResult>;
  /**
   * Commit the selected paths, optionally pushing (wireframe C15). Git is
   * asked directly; no agent is involved and no terminal is written to.
   */
  commitDiff(request: DiffCommitRequest): Promise<DiffCommitResult>;
  /**
   * Commit the selected paths, optionally pushing (wireframe C15). Git is
   * asked directly; no agent is involved and no terminal is written to.
   */
  commitDiff(request: DiffCommitRequest): Promise<DiffCommitResult>;
  /** What a pull request for the current branch would need (wireframe C16). */
  readPullRequest(root: string): Promise<PullRequestContext>;
  /** Open the pull request through the GitHub CLI. */
  createPullRequest(request: {
    root: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<PullRequestResult>;
  /**
   * Commit the selected paths, optionally pushing (wireframe C15). Git is
   * asked directly; no agent is involved and no terminal is written to.
   */
  commitDiff(request: DiffCommitRequest): Promise<DiffCommitResult>;
  /** Show a folder in the OS file manager. */
  revealPath(target: string): Promise<void>;
  /** Open an http(s) URL in the browser. Any other scheme is refused. */
  openExternal(url: string): Promise<boolean>;
  /**
   * An image a message points at, as a `data:` URL, or null when it is not a
   * readable local image inside the session's own folder.
   *
   * Null is the ordinary answer rather than an error -- a remote address, a
   * path outside the folder, a missing file and a non-image all give it, and
   * the chat view keeps the link it already drew.
   */
  readLocalImage(cwd: string, src: string): Promise<string | null>;
  /** Answer a tool call B5 is holding open. */
  answerApproval(
    request: { id: string; sessionId: string; tool: string; subject: string },
    answer: ApprovalAnswer,
  ): Promise<void>;
  /** A call is waiting on a person (wireframe B5). */
  onApprovalNeeded(fn: (request: PendingApproval) => void): () => void;
  /** That call no longer has a turn behind it; take the bar down. */
  onApprovalGone(fn: (id: string) => void): () => void;
  /** Remappable shortcuts, as E6 lists them. */
  getKeybindings(): Promise<Keybinding[]>;
  /** Record a chord. Refused, with a reason, when it collides. */
  setKeybinding(id: string, accelerator: string): Promise<KeybindingResult>;
  resetKeybindings(): Promise<Keybinding[]>;
  /** Permission rules, as E2 lists and edits them. */
  getPermissionRules(): Promise<PermissionRule[]>;
  addPermissionRule(rule: Omit<PermissionRule, 'id'>): Promise<PermissionRule[]>;
  removePermissionRule(id: string): Promise<PermissionRule[]>;
  /** Mute a session's notifications until it finishes (E5). */
  muteSession(id: string, muted: boolean): Promise<boolean>;
  /** Quiet one session for the configured snooze (C20 note 152). */
  snoozeSession(id: string): Promise<void>;
  /** A notification was clicked: bring this session forward (C20 note 150). */
  onSessionReveal(fn: (id: string) => void): () => void;
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
  /**
   * The session's conversation, read from the agent's own transcript on
   * disk. Works for owned and monitored sessions alike, because the
   * transcript is on disk whoever owns the process. Polled by the chat view;
   * an empty answer carries the reason.
   */
  readConversation(id: string): Promise<ConversationSnapshot>;
  /**
   * Send a message into a `stream` session over the agent's structured chat
   * protocol. Resolves false when the session cannot take one — wrong
   * transport, or its process has exited.
   */
  sendChatMessage(id: string, text: string): Promise<boolean>;
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
  /**
   * Ask the daemon to replay a session's recent output. The replay arrives
   * through `onPtyReplay`, ordered against the live `onData` stream: every
   * byte before it is inside it, every byte after follows it. Used for
   * sessions that predate this window — the daemon kept them alive.
   */
  replayPty(id: string): Promise<void>;
  onPtyReplay(cb: (e: PtyDataEvent) => void): () => void;
  /**
   * Stop sertumd and every session it owns — the deliberate end of
   * everything, distinct from closing the window, which ends nothing.
   */
  stopDaemon(): Promise<void>;
  onSessionUpdated(cb: (s: SessionSnapshot) => void): () => void;
  /** Persisted display preferences. */
  getSettings(): Promise<Settings>;
  /** Merges a patch and returns the settings as stored. */
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  platform: NodeJS.Platform;
}
