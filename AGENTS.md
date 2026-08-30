# Sertum technical guide and agent instructions

This is the canonical technical reference for Sertum and the repository-level
instruction file for AI coding agents. Keep architecture, invariants, status,
platform notes, and implementation guidance here rather than duplicating them
in `README.md` or tool-specific instruction files. `README.md` is the
user-facing getting-started guide; `CLAUDE.md` imports this file.

When changing the project:

- Preserve the separation between the pixel plane and truth plane described
  below. Terminal output must never be parsed to infer agent state.
- Treat `SertumDesigns.pen` as the UI source of truth and retain frame IDs in
  relevant code comments.
- Keep TypeScript strict-mode clean and run `npm run lint` after source edits.
- Test lifecycle-sensitive changes against real PTY and adapter events where
  practical; stale events must not revive exited sessions.
- Update this file when an architectural decision, verified capability, or
  known constraint changes. Update `README.md` only when user setup or the
  first-run experience changes.

## Product summary

One window for every coding agent you have running.

A desktop GUI that manages multiple AI coding agents — Claude Code, Codex and
Grok — across separate working folders and git worktrees, with a live embedded
terminal per session and status you can trust at a glance.

Design source of truth: `SertumDesigns.pen`, tracked at the repo root and
opened with pen.dev. The wireframe ids in code comments (`B3`, `C1`, …) are
frame ids in that file.

## Architecture: two planes

The single decision everything else follows from. These never do each other's
job:

| Plane | Owns | Implementation |
|---|---|---|
| **1 — pixels** | Characters in, characters out | `node-pty` per session, rendered by `@xterm/xterm`. Never parsed for meaning. |
| **2 — truth** | What each agent is actually doing | Adapter events. Claude Code hooks, Codex app-server JSON-RPC, Grok per-session event log: **all three done**. |

A tab badge turns amber because the agent *said* it needs input — not because
its pixels stopped moving.

## Status

What's built and verified so far:

- [x] Electron 44 + Vite + TypeScript, strict mode clean
- [x] `node-pty` rebuilt against Electron's ABI; PTY spawn / write / read / resize / kill
- [x] Real agent TUIs render correctly (Claude Code and Codex draw their
      full-screen UI on macOS and Windows; Grok is verified end to end on
      Windows)
- [x] Keystrokes reach the PTY from the renderer
- [x] Tab strip, sidebar grouped by status, pane header, status bar
- [x] New Session dialog (wireframe C1) with a **native folder picker**, live
      git validation, recent folders, and auto-derived tab labels
- [x] **Plane 2 for Claude Code** — loopback hook endpoint, per-session binding,
      status and activity driven by real agent events
- [x] **Plane 2 for Codex** — a private app-server instance per app run,
      driven over JSON-RPC (`thread/status/changed`, mapped by
      `mapCodexStatus`); the TUI still renders for real while status arrives
      out-of-band
- [x] **Plane 2 for Grok** — the session is named with `--session-id` at spawn,
      then its own `events.jsonl` is tailed and mapped by `mapGrokEvent`;
      verified end to end against a real turn
- [x] **Adopting sessions started elsewhere** — discovery, transcript
      summaries, and raising the owning OS window
- [x] **Worktree management** (wireframe C9) — inventory of what exists on
      disk and what it costs, creation handed off to C1's isolation preset,
      safe removal
- [x] **Agent binary resolution you can see and override** — Settings >
      Agents shows each agent's resolved path, a Detect button re-runs
      discovery, Browse... sets a manual override; the status bar calls out a
      binary that can't be found at all
- [x] **Claude Remote Control publish** — an opt-in control in C1 starts a
      Claude session with `--remote-control <label>` so it can be steered from
      claude.ai or the Claude app; published panes carry a REMOTE chip
- [x] **Structured turn steer and interrupt** — Claude through command-hook
      JSON responses, Codex through app-server `turn/steer` and
      `turn/interrupt`; Grok and shell explicitly decline
- [x] **Claude tool gating** — Pause tool use persistently denies
      `PreToolUse` through structured hook responses until resumed; the pane
      carries a TOOLS PAUSED chip and no terminal bytes are synthesized
- [x] **Diff review, commit and pull request** (wireframes C11, C15, C16) —
      changed-file inventory, per-file unified diff, types-to-confirm discard,
      a commit sheet that commits the reviewed paths and optionally pushes,
      and a pull-request sheet driven by the GitHub CLI
- [x] **Settings E1–E7** — one window with a nav down the left. Terminal (E3),
      Worktrees' base branch and bootstrap command (E4), and Appearance's
      theme, accent, compact rows, tabs, badges and type sizes (E6) are wired
      end to end; E2 keeps the agent-path resolver. Controls whose subsystem
      does not exist — shortcut remapping, session restore, storage — render
      disabled carrying the reason
- [x] **Permission rules** (wireframe E2) — stored allow/deny/ask rules
      answered at Claude's `PreToolUse`, deny winning over allow and an
      unmatched call falling through to the agent's own prompt
- [x] **System notifications** (wireframes C20, E5) — fired from adapter
      events on a status transition, only when the window is unfocused, with
      per-session mute and snooze
- [x] **Split views** (wireframes G1–G8) — Single, Columns, Rows and Grid,
      each pane sized to its own PTY; gutters clamp at a readable terminal,
      focus moves spatially, and a session dropped on a pane moves rather
      than duplicates. See "Pane layouts" below.

## How status actually works

Each Claude session is spawned with `--settings` carrying a hooks blob whose
URLs point at *that session's own* endpoint:

```
http://127.0.0.1:<port>/hook/<session-uuid>
```

So an arriving event is attributable to exactly one pane with no correlation
guesswork.

The hooks are `command` hooks running a one-line `curl` POST. The endpoint was
originally built for the `http` hook type, which reads better, but as of Claude
Code 2.1.247 an `http` hook is accepted in settings and then never fires --
registering both types on one event shows only the command arriving. That
failure is silent and total: the settings are accepted and the endpoint is
live, so plane 2 looks wired while no status ever moves. curl keeps the
cross-platform property the http type was chosen for, shipping with macOS,
mainstream Linux, and Windows 10 and later.

Observed transitions for one real turn (`uname -a`), all hook-driven:

| Event | Status | Activity |
|---|---|---|
| `Notification` (permission) | `needs-input` | Claude needs your permission to use Bash |
| `UserPromptSubmit` | `working` | thinking |
| `PreToolUse` | `working` | Bash… |
| `PostToolUse` | `working` | Bash |
| `Stop` | `idle` | turn finished |

### `Notification` carries two unlike things

One event name covers a question and a shrug, and only the question is
"needs you":

- **A permission or approval request.** The agent is blocked and cannot
  proceed until you answer. This is what amber is for.
- **The idle nudge.** Claude Code fires a `Notification` reading *Claude is
  waiting for your input* after roughly a minute of no typing at an empty
  prompt. Nothing is blocked. It is the state a finished turn already left the
  session in, restated a minute later.

Mapping both to `needs-input` turned every session anyone walked away from
amber about sixty seconds after `Stop` had correctly set it idle -- a tab
claiming to need you when its last line was "turn finished". That is precisely
the crying-wolf failure the two planes exist to prevent, and it costs more now
that a needs-input transition can also raise a system notification.

The nudge therefore returns **no status at all** rather than `idle`. It says
nothing about whether the agent is blocked, so it must not clear a genuine
needs-input that arrived before it either. A permission request is recognised
from its reason field *or* its message text, so it still lands even when
Claude sends only the message.

The dot moves because the agent said so — never because output went quiet.
Late events for an exited process are ignored, so a dead session's dot cannot
be resurrected.

### Plane 2 for Grok: name the session, then read its log

Grok offers neither of the other two routes -- there is no `--settings` to
point at an endpoint, and its hooks come from project files rather than
per-session configuration. What it does offer is `--session-id`, which names a
*new* session up front, and a structured event log per session on disk:

```
~/.grok/sessions/<uri-encoded cwd>/<session-id>/events.jsonl
```

Choosing the id at spawn buys exactly what the per-session hook URL buys for
Claude: an arriving event belongs to one pane, with no correlation guesswork.
The session is located by scanning for that id rather than by rebuilding the
encoded folder name, so a change in how Grok names the folder above it cannot
break the binding.

Reading that log is not the thing the two planes forbid. What is forbidden is
inferring state from the pixels a TUI draws; `events.jsonl` is the agent's own
account of what it is doing, the same class of source as a hook payload.

Observed transitions for one real turn ("what is 2 plus 2"), all log-driven:

| Event | Status | Activity |
|---|---|---|
| `mcp_init_completed` | `idle` | ready |
| `turn_started` (carries `model_id`) | `working` | thinking |
| `phase_changed: streaming_reasoning` | `working` | reasoning |
| `phase_changed: streaming_text` | `working` | responding |
| `tool_started` / `tool_completed` | `working` | `list_dir…` / `list_dir` |
| `permission_requested` | `needs-input` | approve `list_dir`? |
| `turn_ended` | `idle` | turn finished |

**A poll, and one update per batch.** The log is followed on a 300ms poll
rather than with `fs.watch`: the file does not exist for a beat after spawn,
watch semantics differ by platform, and a turn is enormously chatty -- one
recorded turn wrote 1776 records, of which 1736 were `phase_changed`.
Coalescing is the point, not a compromise. Replaying that turn one event at a
time turns the tab amber nine times for `permission_prompt`, every one of them
a tool auto-approved in the same millisecond that it was requested; folding
each batch to its last word yields ten honest updates and no false "needs
you". A prompt genuinely waiting has no resolution behind it, so it survives
the fold.

Grok records no token accounting anywhere, so the context chip stays empty for
its sessions rather than showing an estimate. Model comes from
`turn_started`; effort from the transcript, where it is stamped on every
assistant turn.

## Agent capabilities are declared, not discovered

Everything the UI can do to a session that depends on which agent runs it
goes through `AgentAdapter` (`src/main/adapters/agent-adapter.ts`), and each
adapter answers every capability up front:

```ts
readonly capabilities: AgentCapabilities; // Record<AgentCapability, CapabilityAnswer>
```

`AgentCapability` is a union in `shared/types.ts`. Adding a name to it fails
to compile until every adapter has answered `{ ok: true }` or
`{ ok: false, reason }`, and two things follow from that:

- **Declined is an answer, not an omission.** The reason is user-facing copy,
  written once in the adapter, and the UI shows it at the moment it matters:
  the sidebar's rename field says "Renames here only -- Claude Code has no
  way to set a session's name from outside" before you type. Nothing in the
  renderer branches on `AgentKind` to know this; it reads the answers once at
  startup (`agentCapabilities`).
- **A method is only called for a capability answered `ok`.** The
  `session:rename` handler asks `renameRemote` of Codex, which declared it,
  and never of Claude or Grok, which declined. A declining adapter keeps the
  inert implementation and is never asked.

The alternative -- optional fields on a per-agent record, or a `switch` that
answers `null` for the agents nobody revisited -- is how a capability quietly
stops working for most of a fleet with nobody noticing. Adding an agent means
writing its answers and implementations here; adding a capability means
adding one name and answering it for each agent.

Remote Control is deliberately the publish half only. Claude declares
`remote-control` and contributes `--remote-control <label>` to a session's
spawn arguments; Codex, Grok and shell decline with a reason. The C1 toggle is
shown from that declared answer and defaults off every time because publishing
stores the transcript on Anthropic's servers while devices stay in sync. The
chosen value lives on `SessionSpec`/`SessionSnapshot`, which lets both the
single-pane and split-pane headers render the REMOTE chip without inspecting
terminal output.

Sertum does not enumerate Remote Control sessions running on other machines.
Claude currently exposes that account roster only through an interactive slash
command, so reading it would require parsing TUI pixels and violate the two
planes. This is separate from publishing a session Sertum owns.

### Verified Codex control surface

Codex CLI 0.150.1's generated app-server schema and a live Windows app-server
probe establish three answers that were previously unknown:

- `turn/interrupt` is a stable request taking `threadId` and `turnId`.
- `turn/steer` is a stable request taking `threadId`, the active turn as
  `expectedTurnId`, and structured input; it can also carry application or
  untrusted `additionalContext`.
- Codex Remote Control works on Windows and exposes enable, disable, status,
  pairing and client-management requests. These methods appear only when the
  client initializes with `capabilities.experimentalApi: true`; without that
  negotiation the server rejects them. Sertum therefore continues to decline
  this capability until it deliberately adopts the experimental contract.

The generated protocol is implementation evidence, not a documented public
OpenAI contract. Keep the generated method names behind `AgentAdapter` rather
than leaking them into renderer branches, and re-run the schema probe when the
installed Codex version changes.

### Structured turn control

Steering and interruption never write synthetic keystrokes into a terminal.
They are declared `turn-steer` and `turn-interrupt` capabilities and dispatched
through `AgentAdapter`:

- Claude queues a per-session response in `HookServer`. An interrupt returns
  `{ continue: false }` at the next hook boundary; guidance is returned as
  `UserPromptSubmit` `additionalContext` when that session next submits a
  prompt. The command hook's curl prints the HTTP response body to stdout,
  which is Claude's structured hook-response channel rather than terminal
  output.
- Codex tracks the active turn id from `turn/started` and clears it on
  `turn/completed` when those notifications are present. TUI-owned turns
  connected through `--remote` currently emit thread status but not those turn
  notifications, so the adapter falls back to `thread/read(includeTurns:
  true)` and accepts only a turn the server marks `inProgress`. Steering calls
  `turn/steer` with `expectedTurnId`, so a stale request is rejected instead of
  landing in the wrong turn; interrupt calls `turn/interrupt` with the thread
  and turn ids.
- Grok's event log is read-only and a shell has no agent turn, so both decline
  with user-facing reasons. Their row-menu actions remain visible but disabled
  with that reason.

These controls are available from a session's row menu and from the command
palette for the focused session. Claude guidance may wait for the next prompt;
Codex guidance requires an active turn. A failed active-turn precondition is
reported in the session activity rather than silently ignored. Pending Claude
control words and Codex turn ids are cleared when the owning PTY exits, so a
later session cannot inherit them.

Claude additionally declares `tool-gate`. While enabled, every attributable
`PreToolUse` hook receives `permissionDecision: "deny"` with a reason that
points back to Sertum; unrelated hooks still receive an empty 204. This is
called **Pause tool use**, not Pause agent: Claude may continue reasoning or
responding, but it cannot execute another tool until the gate is released.
The gate persists across denied attempts, an interrupt takes precedence for
the hook boundary that consumes it, and the gate remains afterward until the
user resumes it. `SessionSnapshot.toolsPaused` drives the row-menu label,
command-palette action, and TOOLS PAUSED pane chip. Process exit clears both
the hook-server gate and the snapshot flag. Codex currently declines because
Sertum has not verified a persistent structured tool gate for its TUI-owned
turns; Grok's event log is read-only and shell has no agent policy to gate.

## Adopting sessions started outside the app

A PTY's master file descriptor belongs to whoever spawned it. A session started
in iTerm2 therefore **cannot** have its terminal rendered here — no OS offers a
way to take that over. This is why tmux exists, and it is a constraint rather
than a missing feature.

What is possible splits in two, and the UI says which you are getting:

| Session | Listed | Summary | Status | Terminal here | Raise its window |
|---|---|---|---|---|---|
| `claude --bg` (daemon-hosted) | ✓ | ✓ | ✓ | ✓ `claude attach` | n/a |
| Interactive claude in another terminal | ✓ | ✓ | ✓ polled | ✗ | ✓ |
| Codex in another terminal | ✓ | ✓ | ✓ polled | ✗ | ✓ |
| Grok in another terminal | ✓ | ✓ | ✓ polled | ✗ | ✓ |
| Started inside tmux | ✓ | ✓ | ✓ | ✓ (planned) | ✓ |

Clicking a monitored row raises the exact terminal tab that owns it. On macOS
the tab is matched by controlling tty, so a window with ten tabs still lands on
the right one; other platforms fall back to activating the app, and unsupported
ones say so instead of failing quietly.

### The macOS Automation grant

Selecting a specific tab means sending an Apple event to the terminal, which
macOS gates behind Privacy & Security › Automation. Three things have to line
up before that grant is even offerable, and all three are in the build rather
than in the app's code:

- **`NSAppleEventsUsageDescription` in Info.plist.** Without it macOS refuses
  every Apple event with `-1743` and never prompts — so the app never appears
  under Automation and there is no toggle to switch on. Set for packaged builds
  by `extendInfo` in `forge.config.ts`, and for `npm start` by
  `scripts/dev-app-name.js`, which patches the throwaway dev bundle Electron
  ships.
- **A signature that verifies.** Packager writes Info.plist after the fuses
  plugin re-signs, leaving the bundle failing `codesign --verify`; TCC will not
  hold a grant for a bundle in that state. The `postPackage` hook in
  `forge.config.ts` re-signs once everything else is done.
- **Our own signing identifier.** That same fuses re-sign preserves Electron's
  `com.github.Electron` identifier, which is what TCC keys the grant on — so
  every ad-hoc Electron app on the machine would share one TCC identity. The
  re-sign above derives `dev.sertum.app` from `CFBundleIdentifier` instead.

Because the signature is ad-hoc, its designated requirement pins the cdhash:
each rebuild is a new identity, and the grant has to be given again. To clear a
stale one, `tccutil reset AppleEvents dev.sertum.app`.

Refusing the grant is not fatal. Raising the app itself goes through
LaunchServices (`open -b <bundle id>`), which needs no permission at all, so
the jump still works — only tab selection is lost, and the UI says so with a
button that opens the right settings pane.

Discovery is agent-agnostic by construction. `AgentDiscoverer` implementations
are tried richest-first and merged by pid:

- **claude** — `claude agents --json` gives session id, name and live status
- **process scan** — walks the process table for any known agent binary, so
  Codex and Grok work today with no vendor API; adding an agent is one row in
  `AGENT_COMMANDS`

Summaries come from each agent's own transcript, which is on disk regardless of
who owns the process — `~/.claude/projects/**/<id>.jsonl`,
`~/.codex/sessions/**/rollout-*.jsonl` and
`~/.grok/sessions/**/<id>/chat_history.jsonl`. Only the tail is read.

Codex's own app-server already drives live status for sessions Sertum starts
(Plane 2, above), but a separate instance cannot supply live truth for a TUI it
does not own. Verified against Codex CLI 0.150.1: `thread/list` finds an active
external CLI thread by exact id, cwd, rollout path and title, but reports
`status: { type: "notLoaded" }`, `canAcceptDirectInput: null`, and no owning
pid. The managed app-server daemon that could share loaded runtime state is
Unix-only in that release (`codex app-server daemon version` refuses win32).
Consequently, joining an app-server row to a Windows process would require a
timing/cwd guess and still would not improve live status. Process-scan remains
the honest Codex discoverer until Codex exposes a cross-platform roster with a
stable process/session identity; stored thread metadata alone is not Plane 2.

## Terminal key handling

A bare Enter is how you send a message to an agent, so composing a multi-line
prompt needs a second chord. `terminal-pane.ts` intercepts Enter before xterm
encodes it and writes `ESC CR` (`\x1b\r`) to the PTY for:

| Chord | Platform |
|---|---|
| Shift+Enter | all |
| Ctrl+Enter | all |
| Alt+Enter | all |
| Cmd+Enter | macOS |

One sequence covers both agents: `ESC CR` is what Claude Code's own
`/terminal-setup` installs for Shift+Enter, and what Codex reads as Alt+Enter.

The handler requires *exactly one* modifier, so `⌘⌥↩` / `Ctrl+Alt+Enter` still
falls through to the menu accelerator that maximises a pane.

Ctrl+C is overloaded the way a terminal user expects. With a selection it
copies and then clears the selection; with nothing selected it falls through to
xterm untouched and stays the interrupt that stops the agent's current
operation. Clearing matters: a selection left on screen would otherwise keep
swallowing every interrupt. The copy goes through `api.copyText` (the main
process's `clipboard:write`) rather than `navigator.clipboard`, matching how the
rest of the app copies.

Ctrl+V (Cmd+V on macOS) pastes, handled here rather than left to the browser
because an image has to be turned into something a byte stream can carry before
xterm sees it. `main/clipboard-paste.ts` answers with one of three things:

| Clipboard holds | Pasted as |
|---|---|
| a bitmap (screenshot, image copied from a browser) | path to a PNG spilled into the temp dir |
| an image file copied in Explorer/Finder | that file's own path, used where it lies |
| text | the text, through `term.paste` so bracketed-paste mode is honoured |

A bitmap wins over text, because copying an image from a browser puts both on
the clipboard and the image is the part worth having. Spilled files are swept
on the next paste once they are a day old -- nothing tracks whether an agent
ever read one, so age is the only safe signal.

Pasting a *path* rather than bytes is the whole trick: a PTY carries
characters, and both Claude Code and Codex treat an image path in the prompt as
an image, while a plain shell just shows the path.

### Electron 44's clipboard is async and ClipboardItem-shaped

There is no `clipboard.readImage()` or `clipboard.readBuffer()` any more. The
API is modelled on the W3C one: `await clipboard.read()` gives
`ClipboardItem[]`, each with `types` and `getType(mime)` resolving to a `Blob`.
`getType` *rejects* for a format the item doesn't carry, which is how this code
probes for one.

Two things that cost time and are not obvious from the types:

- **The `clipboard` export type-checks against lib.dom's `Clipboard`, not
  Electron's.** With `"lib": [..., "DOM"]` in `tsconfig.json`, `Clipboard`
  resolves to the browser interface even for an import from `electron` or
  `electron/main`, so reaching for a removed method fails with a puzzling
  "Property 'readImage' does not exist on type 'Clipboard'". The two interfaces
  are close enough that the code compiles and runs correctly regardless.
- **A file copied in Explorer arrives as `text/uri-list`, not `FileNameW`.**
  Verified on Windows 11: the item's types are `text/uri-list` plus
  `electron application/osclipboard;format="FileName"` (ANSI, note, not the
  wide `FileNameW` the Win32 docs point at), and the uri-list body is a plain
  `file:///C:/...` URL. A bitmap arrives as `image/png`.

## Committing from the review

C15 is reached from C11's Commit & push button and writes through Git alone
(`main/diff-review.ts`). Four decisions are worth keeping:

- **The inventory on screen never authorises the write.** `commitDiff`
  re-resolves the repository and re-reads its changes before touching
  anything, exactly as `discardDiff` does. A path the user chose that Git no
  longer reports as changed fails the whole commit rather than being dropped
  quietly -- a commit silently missing a file someone selected is worse than
  one that did not happen.
- **The commit is pathspec-limited.** `git commit -- <paths>` means a file
  staged outside Sertum stays in the index instead of being swept in. C11 has
  no hunk selection, so a chosen path is committed whole. Untracked paths are
  staged first, since a pathspec commit only accepts paths Git already knows.
- **Committing and pushing are reported independently.** `DiffCommitResult`
  carries the commit and the push outcome separately, so a commit that lands
  behind a push that fails is shown as exactly that. The sheet stays open
  saying "Committed <sha>. Not pushed -- <reason>" instead of implying the
  work was lost.
- **The push destination is resolved before it is offered, not assumed.**
  `resolvePushTarget` prefers the branch's upstream, adopts a lone remote
  explicitly, and otherwise declines with a reason; the same answer labels the
  checkbox and performs the push, so the control names where the push will
  actually land rather than promising `origin`. Verified against real repos in
  all six states, including detached HEAD and two remotes with no upstream.

Sertum does not compose the commit message. The sheet opens with an empty
field and a placeholder: an invented summary would be committed under the
user's name, and inferring one from a terminal is what the two planes forbid.
No trailer of any kind is appended.

### C16 goes through the GitHub CLI

`main/pull-request.ts` shells out to `gh` rather than calling the REST API,
for one reason: **`gh` already owns the credential**. Reimplementing auth here
would mean discovering, storing or prompting for a token the user has already
handed to a tool built to hold it.

Two things the CLI's contract dictates, both verified against gh 2.89.0:

- **`gh pr view` exits 1 when a branch has no pull request**, printing to
  stderr, so it cannot distinguish "none" from "failed". Existence detection
  uses `gh pr list --head <branch> --json ...`, which exits 0 and returns `[]`.
- **`gh pr create` cannot open a request for commits GitHub has never seen**,
  and running it non-interactively means its own offer to push simply fails.
  Rather than refuse, the sheet says so on its button -- "Push and create pull
  request" -- and performs the push first, reusing the same `pushBranch` and
  the same resolved target C15 uses.

Every other precondition is answered before the sheet offers anything, in the
same spirit as a declined agent capability: no `gh`, signed out, detached
HEAD, sitting on the default branch, or a branch that already has a pull
request each produce a reason the user can act on rather than a button that
fails when pressed.

Title and body are seeded only from a **lone** commit's own subject and body.
Those are the user's words. Several commits have no such answer, so the fields
stay empty rather than being invented -- the same rule the commit message
follows.

`shell:open-external` was added for the resulting URL and is restricted to
http(s). `shell.openExternal` hands any other scheme to whatever the OS
registered for it, which is how a renderer bug or a hostile string turns into
launching a local program -- and these URLs come from `gh`'s output.

## Settings say what they cannot do

E1–E7 share one window and a nav; every control applies live, and Cancel puts
back the settings captured on open, so previewing a theme or a type size stays
safe to explore.

The rule that shapes the panes: **a control whose subsystem does not exist is
rendered disabled carrying its reason, never as a switch that switches
nothing.** This is the same answer `AgentAdapter` gives for a declined
capability, for the same purpose -- the user learns why, at the moment it
matters, instead of discovering later that a toggle did nothing. Shortcut
remapping, session restore and storage management all read that way today.

Two settings were deliberately removed rather than shipped as stored values
nothing reads:

- **Worktree location.** E4 draws it as a repo-relative path, but managed
  worktrees live under one root outside the repository (`~/.sertum/worktrees`)
  and `isManagedWorktree` is a prefix test against it. That prefix is what
  lets the pool tell its own worktrees from the user's, so making the location
  configurable per repo would trade a load-bearing invariant for a preference.
- **Remove worktree when closing a clean tab.** Nothing reclaims a worktree on
  tab close; C9 removes them deliberately.

What is wired: `terminalFontFamily`, size, line height, cursor style,
scrollback and copy-on-select reach a live xterm through
`TerminalPane.applySettings`, which refits whenever the cell box changes
because the PTY has to be told the new geometry. The renderer choice applies
to the next session, since an addon cannot be swapped under a live terminal.
`worktreeBase` picks a new branch's start point -- `fresh` resolves
`origin/HEAD`, `head` takes git's default -- and `worktreeBootstrap` runs in
the new worktree before any agent starts, since only tracked files come with a
checkout. A bootstrap failure is reported and the worktree kept: telling the
user their install step failed beats discarding a working checkout over it.

## Notifications are the payoff of the truth plane

C20 fires because an adapter said the agent is waiting, never because output
went quiet. That is the whole reason it is allowed to interrupt someone, and
why E5's defaults can be as narrow as they are: an exact notifier earns the
right to stay silent about everything else.

`main/notifications.ts` consumes the same `session-updated` event the renderer
draws from, so a notification can never disagree with the dot beside it. Three
gates keep it honest, all verified against a driven sequence of snapshots:

- **Only transitions.** A session already sitting in `needs-input` that
  updates for any other reason does not notify again.
- **Only when you are not looking.** With the window focused, the sidebar dot
  has already said it.
- **Only states blocked on you.** `working` never notifies. `needs-input` and
  a failure are on by default; a clean finish is off.

The long-turn threshold is a timer started on entering `working` and cleared
on leaving it, so "at most once per turn" is a property of the construction
rather than of bookkeeping -- a turn that ends before the threshold fires
nothing.

Mute is ours rather than the agent's, so every session offers it, and it
lasts until the process ends. It deliberately does not touch the status dot:
muting is about not being interrupted, not about pretending the agent is not
waiting.

Two platform facts shape the surface rather than being hidden:

- **Notification action buttons are macOS-only in Electron.** C20's Answer and
  Snooze buttons cannot render on Windows or Linux, so snooze lives in the
  session row menu where every platform reaches it, and the notification body
  is the whole affordance -- clicking it focuses the window and that session.
- **`app.setBadgeCount` is macOS and Linux only.** E5 says so next to the
  control instead of offering a switch that appears to work.

## Permission rules are the tool gate made selective

`tool-gate` already proved the mechanism: `PreToolUse` is a structured
decision point that accepts `allow` or `deny` and attributes to exactly one
session. Rules add a matcher in front of that answer and need no new channel,
which is why this is a small module rather than a subsystem.

Four decisions, all verified by driving the hook server over real HTTP:

- **Deny wins.** When several rules match, one deny beats any number of
  allows. A permission control that resolves ambiguity by permitting is not a
  permission control: the cost of failing closed is one extra prompt, the cost
  of failing open is the command the user wrote a rule to stop.
- **No rule is not an approval.** An unmatched call returns nothing at all, so
  Claude runs its own permission flow exactly as it would without Sertum.
- **`*` is the only wildcard.** Full regex in a permission rule is a foot-gun,
  because the character that makes a pattern broader than intended is
  invisible in a settings row. Every other character is literal -- `a.b` does
  not match `aXb` -- so what a rule covers can be read off the row.
- **Scope is a path prefix**, so a rule bound to a repository also covers the
  worktrees beneath it.

The precedence chain at a `PreToolUse` boundary, outermost first: a queued
interrupt returns `{ continue: false }`; the wholesale tool gate denies; then
rules answer; then nothing. The gate is the blunter instrument and must
outrank rules, or pausing tool use would be quietly overridden by an allow.

A rule matches on the field a person would actually write it about -- a Bash
command, an edited path -- not on the tool name, which a bare `*` still
covers.

`permission-rules` is a declared capability. Claude answers `ok`; Codex, Grok
and shell decline with reasons, so E2 can say the rules are Claude-only rather
than implying a fleet-wide policy.

## Pane layouts

Design section 07. A window shows one terminal by default; splitting is opt-in
and per window. Tabs stay the session registry — a layout only decides how many
of them are visible at once, so nothing about a split starts, stops or hides a
session.

| Layout | Panes | Shortcut | For |
|---|---|---|---|
| Single | 1 | ⌘⌥1 | the default, and where closing the last split returns to |
| Columns | 2 | ⌘⌥2 | one session you are steering, one you are watching |
| Rows | 2 | ⌘⌥3 | wide, shallow output — build logs, test runs, diffs |
| Grid | 4 | ⌘⌥4 | the fleet view; four is the ceiling |

Reachable from the layout button in the pane header, from View → Layout, or with
the picker at ⌘⌥L. `⌘⌥D` / `⌘⌥⇧D` split the focused pane right or down and
promote the layout to suit; `⌘⌥W` closes a pane, `⌘⌥↩` maximises one and `⌘⌥0`
equalises the gutters. `⌘⌥` arrows move focus — spatially in Grid, along its own
axis in Columns and Rows — and while a split is up `⌘1…4` address panes rather
than sessions, matching the number printed on each pane and its sidebar row.

Choosing a layout backfills its new panes from sessions that were only tabs
until now. Splitting the focused pane deliberately does not: it opens empty and
names its three ways in — drop a session on it, click a tab or sidebar row while
it has focus, or start a new session. A session occupies at most one pane, so
loading it somewhere else moves it rather than duplicating it; two views onto
one PTY is a separate feature with its own sizing rules and is not built.

Three things follow from a terminal being a real PTY rather than a view:

- **Every pane resize is sent to its PTY.** Each pane gets its own geometry, so
  four panes mean four different `cols`/`rows` and four TUIs reflowing to fit.
- **Panes refuse to shrink below a readable terminal.** Gutter drags clamp at 40
  columns and 12 rows, scaled to the terminal's own point size; a window too
  small to honour that says so over the pane instead of clipping output.
- **Moving a session between panes costs a DOM move and a refit.** The xterm
  instance is keyed by session and never rebuilt, so scrollback survives every
  layout change.

Layout and gutter positions are remembered across launches; the sessions that
were in those panes are not, because the PTYs die with the app. While a split is
up the sidebar regroups into IN VIEW and OTHER SESSIONS, and an unfocused pane
carries its status colour on its border so an errored session reads from across
the room.

## Running

```sh
npm start                                  # dev
SERTUM_DEBUG_PORT=9222 npm start     # dev + remote debugging
```

Main-process changes require a full restart; Vite only hot-reloads the renderer.

## Verification

Screen capture is unavailable in some environments, so the app can be checked
headlessly.

```sh
# PTY layer only — no UI. Also the cross-platform check for Windows/Linux.
npx electron scripts/smoke-pty.js          # default shell
npx electron scripts/smoke-pty.js claude   # a real agent TUI

# Drive the running app (needs SERTUM_DEBUG_PORT)
node scripts/drive.js "document.querySelectorAll('.tab').length"
```

`window.__sertum` is exposed in dev builds only. It is the app object itself:
`panes.get(activeId).snapshot()` returns the focused terminal's scrollback,
which is the only way to read terminal contents while the WebGL renderer is
active.

## Windows notes

Development so far has mostly happened on macOS. Running on Windows 11
surfaced a handful of differences, some already handled in code and some
fixed along the way:

- **Run Forge packaging under Node 20 LTS, not Node 26.** Verified with Node
  26.7.0 and Forge 7.11.2 / Electron Packager 18.4.4: `npm run make` reaches
  Electron ZIP extraction, then the process exits with code 0 before producing
  a packaged directory or refreshing any maker artifact. The same checkout
  invoked with the installed Node 20.20.2 and npm 10.8.2 completes packaging
  and the Squirrel maker normally. This does not require changing the global
  nvm selection; prepend the Node 20 directory to PATH for the build process
  and invoke that version's npm CLI directly.
- **Forge's rebuild step wants a full native toolchain it doesn't need.**
  `node-pty` ships its own prebuilt N-API binaries per platform/arch
  (`node_modules/node-pty/prebuilds/win32-x64/…`), and N-API is ABI-stable
  across Node/Electron — no rebuild is actually required. Left alone, Forge's
  `rebuildConfig` doesn't know that and falls through to `node-gyp rebuild`,
  which wants MSVC Build Tools. Fixed by `ignoreModules: ['node-pty']` in
  `forge.config.ts`.
- **npm 11's `allowScripts` blocks install scripts by default.** `node-pty`
  (fetches its prebuild), `esbuild`, and `electron-winstaller` (the Squirrel
  installer maker, Windows-only) all need their `postinstall`/`install`
  scripts to run. Without an `allowScripts` block in `package.json`, `npm
  install` silently skips them and `node-pty` ends up with no native binary
  at all.
- **Codex sessions failed to start — `resolveCodexBinary()` had no Windows
  branch.** Its candidate list was entirely POSIX paths (`~/.codex/…`,
  `/opt/homebrew/…`, `/usr/local/…`), so on win32 it always fell through to
  a bare `'codex'` and let PATH decide. That's the right call on macOS/Linux,
  but wrong on Windows for two independent reasons, both hit here:
  - `codex` is installed by npm as a `codex.cmd` shim (confirmed via `where
    codex`), never as `codex.exe`. `node-pty`'s Windows backend calls
    `CreateProcess` directly, which resolves a bare name by trying
    `<name>.exe` only — it doesn't walk `PATHEXT` the way a shell does. A
    session pane spawning `codex` failed with `Cannot create process, error
    code: 2` (`ERROR_FILE_NOT_FOUND`), reproduced directly with
    `npx electron scripts/smoke-pty.js codex`.
  - Separately, the app's own Codex app-server (`spawn(this.binary, …)` in
    `codex-app-server.ts`) uses plain `child_process.spawn`, and Node has
    refused to spawn `.cmd`/`.bat` files without `shell: true` since the
    CVE-2024-27980 hardening — it throws `EINVAL` *synchronously*, not via
    the `'error'` event the code already handles gracefully.
  - Fixed by adding a win32 branch to `resolveCodexBinary()` that walks
    `PATH` × `PATHEXT` itself (mirroring what a shell would do, since neither
    `CreateProcess` nor `child_process.spawn` will), and by setting `shell:
    true` on the app-server spawn when the resolved binary is a `.cmd`/
    `.bat`. Verified end-to-end: a real codex session now spawns, connects
    to the app server, and reaches `status: "working"`.
- **`ClaudeAdapter.resolveBinary()` on win32 hardcoded the literal string
  `'claude.exe'`, with no existence check at all.** The installed `claude` is
  a genuine `claude.exe`, not an npm shim, so `CreateProcess`'s built-in
  "append `.exe` to a bare name" does find it when it exists — but
  `resolveBinary()` never actually checked, unlike the real PATH × PATHEXT
  search Codex had. A session spawned `'claude.exe'` regardless of whether
  that resolved to anything, so a broken or absent install failed exactly
  like the Codex case above, and just as silently. Fixed by giving
  `ClaudeAdapter.resolveBinary()` the same candidate-list-then-PATH search as
  Codex, factored into a shared `src/main/adapters/binary-resolve.ts` both
  adapters now call.
- **Every session-creation failure was swallowed as an unhandled renderer
  rejection, on every platform, for every agent** — so any spawn failure,
  including the `claude.exe` bug above, looked identical to "click the button,
  nothing happens." `new-session-dialog.ts` now performs session creation
  itself and reports a failure inline instead of closing and letting the
  error vanish. Settings > Agents (Detect / Browse... / a manual per-agent
  path override) and status-bar "Claude Code not found" / "Codex not found" /
  "Grok not found" readouts make a missing binary diagnosable rather than
  mysterious.
- **Grok installs outside PATH entirely.** `where grok` finds nothing on a
  default install: the CLI lives at `~/.grok/bin/grok.exe` and the installer
  does not add it to PATH, so the PATH × PATHEXT search every other agent
  relies on has nothing to find. `GrokAdapter.resolveBinary()` therefore
  checks that location first and keeps the PATH walk as the fallback, which is
  the same shape as the Claude and Codex resolvers with the candidate list
  carrying the weight. Verified on Windows 11: a session spawns from that
  location with no PATH entry for the command present at all.
- **`npm start` in dev mode shows Electron's own icon, not Sertum's.**
  `npm start` runs the bare `electron.exe`/`Electron.app` binary, which
  carries Electron's generic icon; a packaged build is its own icon-bearing
  executable (`packagerConfig.icon`, applied by resedit at package time) and
  needs no override. On macOS this was already patched for dev via
  `dev-app-name.js`, but nothing did the equivalent for the title bar and
  taskbar on Windows. Fixed by passing an explicit `icon:` to `BrowserWindow`
  whenever `MAIN_WINDOW_VITE_DEV_SERVER_URL` is set (i.e., only in dev).
- **The Windows icon has its own tighter vector master.** The 88px transparent
  margin in `assets/icon.png` is intentional for macOS, but made the same mark
  visibly undersized in the Windows taskbar and reduced its 38px segments to
  roughly one pixel. `assets/icon-windows.svg` uses a 40px safe area and 54px
  square-ended segments; `scripts/make-ico.js` renders every ICO entry from
  that vector so the 16–32px variants keep defined edges and visible gaps.
  Those embedded PNGs must be PNG32 at 8-bit channel depth. ImageMagick's
  Q16 default produces valid-looking 16-bit PNG entries that Electron Packager
  accepts, but Squirrel's install-time execution-stub resource step terminates
  while copying them and leaves the setup log at `Rigging execution stub`.
- **The install screen was electron-winstaller's placeholder, not ours.**
  `MakerSquirrel` was configured with `setupIcon` only, and
  `electron-winstaller` resolves `options.loadingGif` or else falls back to
  its own bundled `resources/install-spinner.gif` -- a 268x167 mint-green
  rectangle with two stray marks in one corner, which is what Squirrel showed
  for the whole install. Fixed with `loadingGif: 'assets/install-spinner.gif'`,
  generated by `scripts/make-loading-gif.js` from the same vector as the icon:
  the mark's ring is six segments with one amber, so stepping the amber one
  around animates it with no new artwork to drift from the icon. It keeps the
  placeholder's exact dimensions because Squirrel sizes its window to this
  image. Note that `Setup.exe` contains no raw `GIF89a` header at all -- the
  payload is compressed -- so a byte search of the installer cannot confirm
  which image is embedded; run the installer to check that.
- **`node-pty`'s ConPTY `kill()` can throw a benign but scary-looking
  uncaught exception.** On the non-DLL ConPTY path, `kill()` forks a helper
  (`conpty_console_list_agent.js`) to enumerate and force-kill the shell's
  descendant processes, working around orphaned children (upstream cites
  microsoft/vscode#26807). That helper calls `AttachConsole` on the just-killed
  process's console and can lose the race, throwing `Error: AttachConsole
  failed` with a full stack trace to stderr *after* the PTY has already been
  killed successfully. Harmless — it's a one-shot child process, not the app
  — but there's no macOS equivalent (the POSIX backend is a plain
  `forkpty`), so don't mistake it for a real failure when it shows up in the
  logs.
- **The login-shell environment probe is a deliberate no-op on Windows.**
  `hydrateLoginEnv()` exists because a macOS GUI app launched from the Dock
  inherits launchd's near-empty PATH, not the user's shell profile — fixed by
  asking `$SHELL -lic env` once at startup. `process.platform === 'win32'`
  short-circuits that entirely and always returns `false`, which is correct:
  Windows doesn't have the launchd problem, since Explorer-launched processes
  already inherit the full user/system PATH from the registry. The startup
  log line — `using the inherited environment; login shell did not answer` —
  reads like a failure on Windows but is actually "as designed, never
  attempted."
- **The Windows process scan listed one Claude session three times.** The
  POSIX pass reads `args=` and applies a per-agent `reject` rule, but
  `scanWindows()` selected only `ProcessId,Name` and pushed the
  `app-server` exclusion into the WMI filter, so nothing else could be ruled
  out. Claude's helpers wear the session's own binary name -- verified on
  Windows 11, one background session is `claude.exe daemon run --origin
  transient` (the daemon), `claude.exe --bg-pty-host \\.\pipe\cc-daemon-...`
  (the PTY host) and `claude.exe --session-id ... --resume ...` (the session
  Claude's roster already reports) -- so the import list offered all three,
  two of them with an unknown folder. Fixed by selecting `CommandLine` on
  Windows and applying the same `AGENT_COMMANDS` reject rules both platforms
  share, with `^(daemon|--bg-pty-host)(\s|$)` added for Claude. The live scan
  drops from five rows to two: the real session and one interactive Claude in
  another terminal.
- **A monitor row's folder stays unknown on Windows.** `cwdForPid` shells out
  to `lsof` and returns `null` off POSIX; a Windows process's working
  directory lives in its PEB, which WMI does not expose. The row still lists,
  summarises and raises its window, so this is a missing detail rather than a
  broken row.
- **Closing the window quits the whole app, unlike macOS.**
  `window-all-closed` already guards on `process.platform !== 'darwin'`, so
  this is handled correctly, not a bug — but it's a real behavior difference
  worth knowing if you're used to Sertum staying alive in the Dock after the
  last window closes. On Windows (and Linux), closing the window ends the
  process, the hook server, and every session it owns.
- **The `.cmd` shim also displaces the codex app server's pid, which used to
  orphan it on every quit.** The same `shell: true` that makes a `codex.cmd`
  spawn legal puts `cmd.exe` between us and the server: `child.kill()`
  terminates the shim while the server carries on holding its ephemeral port,
  and the pid recorded for the next launch's reaper is the shim's — a pid that
  died with the shim, so the reaper looked for it, found nothing and dropped
  the record. One orphan per *normal* quit, not just per crash, each holding a
  port until reboot. Fixed on both ends: the real pid is resolved from the port
  it is listening on (`Get-NetTCPConnection`, falling back to `netstat -ano`)
  and recorded instead of the shim's, and shutdown runs `taskkill /T /F` —
  before killing the child, since the tree is only walkable while the shim is
  alive. Neither path runs off Windows, where the process we spawn is the
  server. Untested on Windows so far.
- `dev-app-name.js` (the Dock name/icon branding hack) already no-ops on
  `process.platform !== 'darwin'`, `titleBarStyle` already falls back to
  `'default'` off Darwin, and `curl`-based hooks and the PTY smoke test
  already worked as documented above with no changes needed.

## Layout

```
SertumDesigns.pen             Design source of truth — wireframes, storyboards
src/
  main.ts                     Electron main: window, menu, IPC
  main/pty-manager.ts         Plane 1 — PTY lifecycle
  main/workspace.ts           Folder validation, git/worktree detection
  main/hook-server.ts         Plane 2 ingress — loopback HTTP, per-session URLs
  main/settings.ts            Display/agent-path preferences, JSON in userData
  main/clipboard-paste.ts     Clipboard reads for paste; images spilled to disk
  main/worktrees.ts           Worktree inventory, provisioning, removal (C9)
  main/diff-review.ts         Git-backed changes, discard and commit (C11, C15)
  main/pull-request.ts        Pull requests through the GitHub CLI (C16)
  main/notifications.ts       System notifications from adapter events (C20, E5)
  main/permission-rules.ts    Stored allow/deny/ask rules for tool calls (E2)
  main/login-env.ts           macOS login-shell environment probe (no-op on Windows)
  main/adapters/agent-adapter.ts   Per-agent capabilities: declared answers, resolveBinary, renameRemote
  main/adapters/binary-resolve.ts Shared existence-checked PATH × PATHEXT search
  main/adapters/claude.ts     Hook settings builder + event to status mapping
  main/adapters/codex.ts      Codex thread status/summary mapping
  main/adapters/codex-app-server.ts  Codex's private app-server: spawn, JSON-RPC, reap
  main/adapters/grok.ts       Grok event to status mapping, session-dir lookup
  main/adapters/grok-event-log.ts  Plane 2 ingress for Grok: tails events.jsonl
  main/adapters/discovery.ts  Agent-agnostic discoverer registry
  main/adapters/process-scan.ts  Universal agent-process scanner
  main/adapters/session-meta.ts  Model/effort/context read from a live transcript
  main/adapters/transcript.ts    Per-agent transcript summaries
  main/adapters/window-focus.ts  Raise the OS window owning a session
  preload.ts                  contextBridge API surface
  shared/types.ts             Contracts shared across processes
  renderer/app.ts             Shell: tabs, sidebar, pane, status bar
  renderer/terminal-pane.ts   One xterm bound to one PTY
  renderer/chips.ts           Model/effort badges, read by shape and colour
  renderer/command-palette.ts     ⌘K command palette — wireframe C13
  renderer/confirm-dialog.ts      Destructive-action confirm gate — wireframe C7
  renderer/session-menu.ts        Sidebar row context menu — wireframe C5
  renderer/settings-dialog.ts     Settings — wireframe E1, plus agent paths
  renderer/worktree-dialog.ts     Worktree manager — wireframe C9
  renderer/new-session-dialog.ts  Wireframe C1
  renderer/adopt-dialog.ts        Wireframe C18
  renderer/diff-review-dialog.ts  Changes review — wireframe C11
  renderer/commit-dialog.ts       Commit & push sheet — wireframe C15
  renderer/pull-request-dialog.ts Open pull request — wireframe C16
scripts/
  smoke-pty.js                Headless PTY test
  drive.js                    CDP driver for headless verification
```
