# Sertum technical guide and agent instructions

This is the canonical technical reference for Sertum and the repository-level
instruction file for AI coding agents. Keep architecture, invariants, status,
platform notes, and implementation guidance in this file and the `docs/`
files it links, rather than duplicating them in `README.md` or tool-specific
instruction files. `README.md` is the user-facing getting-started guide;
`CLAUDE.md` imports this file.

**The rule lives here; the evidence lives in `docs/`.** Every section below
states the invariants that govern a change, and links to the file carrying
the contract behind them — captured payloads, version numbers, timing tables,
and the mechanisms that were tried and verified wrong. Those files are *not*
imported into an agent's context: read the one covering the area you are
about to change, before you change it.

| File | Covers |
|---|---|
| [docs/conversation.md](docs/conversation.md) | The conversation view, markdown classification, images in messages |
| [docs/sessions.md](docs/sessions.md) | Stream sessions, owned Codex threads, resume, Claude `--bg` hosting |
| [docs/approvals.md](docs/approvals.md) | Permission rules, the B5 bar, question and plan cards, permission modes |
| [docs/models.md](docs/models.md) | Model and thinking-level catalogues, switching mid-session |
| [docs/terminal.md](docs/terminal.md) | Key handling, clipboard, WebGL context loss, helper-process death, node-pty's macOS spawn helper |
| [docs/windows.md](docs/windows.md) | Packaging, binary resolution, icons, installer, platform no-ops |
| [docs/git.md](docs/git.md) | Commit from the review, pull requests through `gh` |

When changing the project:

- Preserve the separation between the pixel plane and truth plane described
  below. Terminal output must never be parsed to infer agent state.
- Treat `SertumDesigns.pen` as the UI source of truth and retain frame IDs in
  relevant code comments.
- Keep TypeScript strict-mode clean and run `npm run lint` after source edits.
- Test lifecycle-sensitive changes against real PTY and adapter events where
  practical; stale events must not revive exited sessions.
- Update this file when an architectural decision, verified capability, or
  known constraint changes, and the matching `docs/` file when the evidence
  behind it does — a new verified payload or refuted mechanism belongs there,
  not here. Update `README.md` only when user setup or the first-run
  experience changes.

## Product summary

One window for every coding agent you have running.

A desktop GUI that manages multiple AI coding agents — Claude Code, Codex and
Grok — across separate working folders and git worktrees, with a chat surface
per agent session, a live terminal for Shell, and status you can trust at a
glance. Agents without structured input retain a PTY underneath chat.

Design source of truth: `SertumDesigns.pen`, tracked at the repo root and
opened with pen.dev. The wireframe ids in code comments (`B3`, `C1`, …) are
frame ids in that file.

## Architecture: two planes

The single decision everything else follows from. These never do each other's
job:

| Plane | Owns | Implementation |
|---|---|---|
| **1 — pixels** | Terminal characters in and out for PTY-backed sessions | `node-pty` for each owned PTY transport, rendered by `@xterm/xterm` when the terminal surface is shown. Never parsed for meaning. |
| **2 — truth** | Agent state and structured conversation content | Adapter events provide live state: Claude Code hooks/stream events, Codex app-server JSON-RPC, and Grok's per-session event log. Agent transcripts (or Claude's structured stream) provide conversation content. Never inferred from terminal pixels. |

A tab badge turns amber because the agent *said* it needs input — not because
its pixels stopped moving.

## Status

What's built and verified so far. Each entry that has a section of its own
below, or a file of its own in `docs/`, is described there rather than here:

- [x] Electron 44 + Vite + TypeScript, strict mode clean
- [x] `node-pty` PTY transport; spawn / write / read / resize / kill, driving
      real agent TUIs (Claude Code and Codex verified on macOS and Windows,
      Grok end to end on Windows) — though supported agents now present their
      transcript-backed chat view rather than the terminal surface
- [x] Terminal keystrokes and chat-composer submissions reach PTY-backed
      sessions
- [x] Tab strip, sidebar grouped by status, pane header, status bar
- [x] New Session dialog (C1) with a **native folder picker**, live git
      validation, recent folders, and auto-derived tab labels
- [x] **Plane 2 for Claude Code** — loopback hook endpoint, per-session
      binding, status and activity driven by real agent events
- [x] **Plane 2 for Codex** — a private app-server instance owned by
      `sertumd`, driven over JSON-RPC (`thread/status/changed`, mapped by
      `mapCodexStatus`)
- [x] **Plane 2 for Grok** — named with `--session-id` at spawn, then its own
      `events.jsonl` tailed and mapped by `mapGrokEvent`
- [x] **Adopting sessions started elsewhere** — discovery, transcript
      summaries, and raising the owning OS window
- [x] **Worktree management** (C9) — inventory of what exists on disk and what
      it costs, creation handed off to C1's isolation preset, safe removal
- [x] **Agent binary resolution you can see and override** — Settings >
      Agents shows each resolved path, Detect re-runs discovery, Browse... sets
      a manual override; the status bar calls out a binary it cannot find
- [x] **Claude Remote Control publish** — an opt-in C1 control starts a session
      with `--remote-control <label>`; published panes carry a REMOTE chip
- [x] **Structured turn steer and interrupt** — Claude over its control
      channel or hook responses, Codex over `turn/steer` and `turn/interrupt`;
      Grok and shell explicitly decline
- [x] **Claude tool gating** — Pause tool use persistently denies `PreToolUse`
      through structured hook responses until resumed; a TOOLS PAUSED chip,
      and no terminal bytes are synthesized
- [x] **Diff review, commit and pull request** (C11, C15, C16) — changed-file
      inventory, per-file unified diff, types-to-confirm discard, a commit
      sheet that commits the reviewed paths and optionally pushes, and a
      pull-request sheet driven by the GitHub CLI
- [x] **Settings E1–E7** — one window with a nav down the left; Terminal (E3),
      Worktrees (E4) and Appearance (E6) wired end to end, E2 keeping the
      agent-path resolver, and every control whose subsystem does not exist
      rendered disabled carrying its reason
- [x] **Remappable shortcuts** (E6) — a command registry behind the menu,
      click-to-record chords, and a collision refused by name
- [x] **Permission rules and in-app approval** (E2, B5) — stored
      allow/deny/ask rules, and an approval bar that holds open the calls
      Claude actually asks about, on either transport; a call whose card *is*
      the question (`AskUserQuestion`, `ExitPlanMode`) is drawn as that card
- [x] **Permission mode per session** — Claude's plan, auto and edit modes;
      Codex's Read Only, Ask for approval, Approve for me and Full Access
      presets; all from a chip beside the composer or the sidebar row menu
- [x] **System notifications** (C20, E5) — fired from adapter events on a
      status transition, only when the window is unfocused, with per-session
      mute and snooze
- [x] **Split views** (G1–G8) — Single, Columns, Rows and Grid, each pane
      independently sized
- [x] **Conversation view** — every agent session shown as a conversation read
      from its own transcript, monitored sessions included, read-only; a shell
      declines and remains a terminal
- [x] **Conversation sessions** — stage 2: the preferred transport has no
      terminal at all. Claude and Codex provide owned structured hosts; Grok
      and shell decline and retain PTYs (visible only for Shell)
- [x] **Resuming a previous session** — a Resume dialog lists past
      conversations for a chosen folder and starts a new process bound to the
      picked one's id; Grok and shell decline
- [x] **Claude-native background hosting** — an optional agent-specific path
      predating `sertumd`, no longer the general persistence mechanism
- [x] **sertumd, the session broker** — stage 3 proper: the whole session
      fabric lives in a daemon and the window is a disposable client, so every
      owned session survives it closing. Verified end to end on Windows,
      including a force-killed Electron client
- [x] **System tray companion** — a tray/menu-bar icon on all three platforms,
      showing truth-plane state and delivering notifications while the window
      is closed
- [x] **Markdown in the conversation** — an agent's markup rendered as markup
      unless the turn asked for the markup itself, with a toggle on every
      classified message, GFM footnotes, and local images shown for real
- [x] **Switching models mid-session** — a chip beside the permission-mode
      chip listing the models the *agent* offers this account
- [x] **Switching thinking level mid-session** — a third chip beside the
      model, listing the reasoning levels the *model* offers, and a switch
      each agent reads back rather than assumes
- [x] **A waiting bubble and a stop sign** — bouncing dots and the session's
      activity line while plane 2 says the agent is working, and a red stop
      square at the right edge of the composer
- [x] **Chat attachments and image paste** — native multi-file picker,
      clipboard images spilled to durable temp files, bounded image previews
      and file placeholders in drafts and sent messages, native Claude/Codex
      image inputs, and explicit paths for ordinary files and PTY-backed agents

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
| `PermissionRequest` | `needs-input` | approve Bash? |
| `PostToolUse` | `working` | Bash |
| `Stop` | `idle` | turn finished |

`PreToolUse` and `PermissionRequest` are easy to conflate and must not be.
`PreToolUse` fires before *every* tool call and says only that a tool is about
to run; `PermissionRequest` fires when a permission dialog is displayed and is
the only one of the two that means a person is wanted. Timed on one real turn:
`PreToolUse` at 13.10s, `PermissionRequest` 112ms later -- and on a turn Claude
did not need to ask about, the second never arrives at all. See "B5 holds the
turn open".

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
  negotiation the server rejects them. Sertum continues to decline Remote Control because publication and pairing
  are not implemented. The owned conversation host now negotiates
  `experimentalApi` for structured question support; negotiation alone never
  publishes a session or calls a Remote Control method.

The generated protocol is implementation evidence, not a documented public
OpenAI contract. Keep the generated method names behind `AgentAdapter` rather
than leaking them into renderer branches, and re-run the schema probe when the
installed Codex version changes.

### Structured turn control

Steering and interruption never write synthetic keystrokes into a terminal.
They are declared `turn-steer` and `turn-interrupt` capabilities and dispatched
through `AgentAdapter`:

- Claude has two interrupt paths, and `ClaudeAdapter.interruptTurn` picks
  between them by asking `ClaudeChatHost.has(session.id)`. A structured
  (stream-json) session is stopped **immediately** over its own control
  channel: `interrupt` is sent as a `control_request` exactly like
  `set_permission_mode`, verified against Claude Code 2.1.261 to be
  acknowledged in single-digit milliseconds even mid-`content_block_delta`,
  ending the turn's `result` record with `terminal_reason:
  'aborted_streaming'` — which `ClaudeChatHost` reports as `turn interrupted`
  rather than `turn failed`, since that same record also carries `is_error:
  true` with nothing else to tell the two apart. The process stays live and
  answers a following turn normally. A **PTY**-backed session has no control
  channel of its own — Claude's TUI owns that pipe — so its interrupt is still
  queued in `HookServer` and returns `{ continue: false }` at the next
  attributable hook boundary; guidance is returned as `UserPromptSubmit`
  `additionalContext` when that session next submits a prompt. The command
  hook's curl prints the HTTP response body to stdout, which is Claude's
  structured hook-response channel rather than terminal output.

  The PTY path only stops a turn that reaches a hook boundary
  (`PreToolUse`/`PermissionRequest`/`UserPromptSubmit`) — pure text
  generation with no tool call reaches none of those until the turn ends on
  its own, so queuing an interrupt there does nothing until the turn was
  already finishing. This was a real bug, not a documented limitation: with
  Claude declaring `structured-conversation` and starting as a stream by
  default, most Claude sessions have the fast control-channel path available
  and were going through the queue-and-hope path uselessly. Fixed by giving
  `ClaudeAdapter` the same `ClaudeChatHost` instance the daemon spawns
  sessions on, so it can tell which path a given session actually has.
  `session/interrupt-turn` in `daemon/fabric.ts` sets the optimistic
  `interrupting…` activity *before* awaiting the adapter, not after — the
  structured path's real `result` update can land within the same tick the
  await resolves, and setting the optimistic label first means that real,
  authoritative update naturally supersedes it instead of being clobbered by
  it. Verified end to end with `scripts/smoke-chat-interrupt.ts`: interrupt
  sent while `responding`, acknowledged in single-digit milliseconds, session
  answered a following turn normally.
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

## The conversation view

Every Claude, Codex and Grok pane renders the agent's own transcript as a
conversation — user and assistant messages, collapsed thinking, and tool
calls paired with their results. A shell declines `conversation-view` and
remains a terminal. What it reads is each agent's transcript on disk, the
same class of source as a hook payload, so this does not touch the
two-planes rule.

Five rules constrain any change here:

- **Nothing is ever assembled as an HTML string.** Every node is created and
  every leaf filled through `textContent` or a text node, so a transcript
  can no more inject markup than before `renderer/message-text.ts` existed.
- **An agent's markdown is rendered as markdown**, unless the turn asked for
  the markup itself, in which case the characters are the answer and are set
  in the mono face. A fenced block is always code, and every classified
  message carries a toggle, so the guess is never the last word.
- **An address out of a transcript is never fetched by the renderer.** A
  local image inside the session's own folder is read in the main process
  and returned as a `data:` URL; a remote one, or one outside that folder,
  keeps the labelled link it already had.
- **The composer writes the body and then a CR 150ms later**, never as one
  burst — Claude's and Codex's TUIs both silently fail to submit otherwise.
- **Attachments remain files until the owning transport takes them.** The
  renderer holds bounded path descriptors and never base64. Claude turns
  verified PNG/JPEG/GIF/WebP files into image content blocks in `sertumd`;
  Codex sends `localImage` inputs; ordinary files and PTY-backed agents receive
  explicit absolute paths so their normal file permissions still apply.
- **A poll asks whether the transcript moved; it does not fetch it again.**
  `conversation/read` takes the `version` the pane holds and answers
  `{ unchanged: true }` when it still matches. Sending the snapshot every
  second regardless is what locked the GUI up: a Codex conversation with
  pasted images measures 9.32MB, 99.7% of it base64, and parsing that on the
  main thread once a second per pane saturated a core and starved the event
  loop until the window stopped responding. The pane records the version only
  once it has drawn the snapshot, never when it arrives.

The waiting bubble is on because an adapter reported a turn in progress,
never because output went quiet, and the stop button calls the declared
`turn-interrupt` capability rather than writing Ctrl+C into a PTY.

A message typed while the agent cannot take one is **queued rather than
refused**, and goes in by itself at the next moment the session is
receivable — the same bargain the model, thinking and permission chips
already make. Receivable is read from the truth plane (`working` and
`needs-input` both defer), never from whether output went quiet, and one
message goes in per turn boundary because the pane's own snapshot cannot yet
know that delivering started a new turn. Queued messages are rendered as
user-style bubbles with an × in each bubble's corner, so clicking one removes
only that message from the renderer-owned queue. The stop sign has one job:
stop the active turn through the declared capability. It does not recall or
rewrite queued or sent text, and it appears only while a turn is running, so
an idle session never offers a red square for a turn that has already ended.
The queue lives in the pane, so it does not survive the window closing.

Verified record shapes, the classifier's two signals, the markdown parser's
constructs, image bounds, selection and polling:
[docs/conversation.md](docs/conversation.md).

## Conversation sessions

`SessionSpec.transport` is `'pty' | 'stream'`, and a stream session has no
terminal — not hidden, nonexistent. Claude and Codex declare
`structured-conversation` and start as owned structured hosts: Claude over
`--print --input-format stream-json --output-format stream-json`, hosted by
`main/adapters/claude-chat.ts`; Codex over its private app server's
`thread/start`. Grok declines (no input channel) and shell declines, both
retaining PTYs, visible only for Shell. C1 no longer asks the user to choose
a transport.

- **Identity is chosen at spawn** — `--session-id`, or the thread id the app
  server returns — so the transcript is matched exactly from the first poll,
  before any hook has named the session.
- **Content is not routed from the stream into the UI.** A headless session
  writes the same transcript an interactive one does, so the conversation
  view reads it with no new code.
- **The registry stays one registry.** `PtyManager.registerStream` records
  the snapshot with host-supplied controls, so tab close, daemon shutdown,
  discovery exclusion, rename and mute treat both transports identically.
- **Hooks ride along**, so permission rules, the tool gate, steer and
  interrupt work unchanged; permission questions ride the control channel
  instead (see [docs/approvals.md](docs/approvals.md)).
- **`session-resume` starts a new process bound to a past conversation's own
  id** rather than beginning blank. Claude needs `RESUME_SETTLE_MS` before
  its first turn and Codex does not; Grok and shell decline.
- **Claude-native background hosting** (`--bg`) remains an optional
  agent-specific mode, declared as `background-host`. General persistence
  belongs to `sertumd`, not to it.

What a stream session gives up is what the TUI carried: slash commands, plan
mode, Claude's own diff and todo rendering.

The stream contract, Codex's owned-thread and approval rules, both resume
mechanisms, and the two mechanisms tried and verified wrong before the
settle timer: [docs/sessions.md](docs/sessions.md).

## The daemon: sertumd

`sertumd` makes the session broker a process independent of the GUI. Sertum's
main process was already a broker in every respect but two — its
transport was Electron IPC and its payload was PTY bytes — and this change
fixes exactly those two things while moving the code rather than redesigning
it. The split:

| Process | Owns |
|---|---|
| **sertumd** | PTYs, hook server, Codex app-server, Grok event logs, chat host, adapters, discovery, permission-rule evaluation and storage, meta/monitor polling |
| **Sertum (Electron)** | windows, menus, dialogs, notifications, clipboard, settings storage, git/worktrees/PRs — and a socket client |

Because the renderer's IPC channel names are unchanged — each main-process
handler that used to *be* the fabric now forwards to it — the renderer
needed almost nothing: the fabric moved to `src/daemon/fabric.ts` nearly
verbatim, and main.ts shrank to UI concerns plus proxies.

**Transport and lifecycle.** A named pipe on Windows
(`\\.\pipe\sertumd-<user>`), a unix socket at `~/.sertum/sertumd.sock`
elsewhere; both are user-scoped by the OS, so no token scheme is invented.
Frames are newline-delimited JSON: requests with ids, responses, events.
`~/.sertum/daemon.json` records the live daemon; `~/.sertum/sertumd.log` is
its console. The GUI joins an existing daemon or spawns one — the app's own
executable run with `ELECTRON_RUN_AS_NODE`, detached — and reconnects with
backoff if the socket drops, re-priming its session mirror when it returns.
A second daemon losing the listen race exits quietly, so two GUIs can race
the spawn without harm.

**The handshake is not deferred.** Version skew is routine in this design —
a GUI update will find a daemon still running the previous build — so the
first frame each side sends is `hello` with a protocol number
(`shared/daemon-protocol.ts`), and a mismatch is answered with a refusal the
GUI can show, never a best-effort conversation. Protocol 2 adds native question
answers and server-limited approval scopes; an old daemon must be stopped and
restarted before the new GUI can connect, so an old client cannot submit an
empty answer to a question whose ids it does not understand. Protocol 4 takes
`conversation/read` from a bare session id to `{ id, known }` so a poll can be
answered `{ unchanged: true }`; a protocol 3 daemon would read that object as
an id and answer every poll "Session not found." Protocol 5 adds attachments
to `chat/send`; a protocol 4 daemon would otherwise accept the text while
silently dropping the files. Protocol 6 replaces Codex's old single-policy
mode ids with terminal-equivalent permission tuples; a protocol 5 daemon
cannot safely interpret the new choices.

**Terminals come back.** The daemon keeps a per-session ring of recent raw
output (512KB). A reopened GUI asks `pty/replay` when it first builds a
pane for a session that predates it, and holds live bytes back until the
replay lands; because the daemon appends to the ring before emitting each
byte, everything before the replay frame is inside it and everything after
follows it — each byte drawn exactly once, verified against a force-killed
and relaunched GUI whose terminal came back mid-conversation and kept
working.

Replay is output-only even though xterm normally has a bidirectional terminal
protocol. Historical output can contain device-attributes queries such as
`CSI c`; replaying one makes xterm emit its `CSI ? 1 ; 2 c` answer through
`onData`. Forwarding that answer into the live PTY injected visible
`[?1;2c` prefixes into the agent's next prompt. `TerminalPane.replay` now
suppresses xterm-generated input until the replay write callback proves all
historical bytes were parsed, queues live output arriving during that window,
then resumes the ordinary bidirectional path.

**What the GUI keeps, and why.** Notifications stay beside the window they
gate on, and mute stays with them: the daemon never learns who is muted, the
GUI stamps it on each `session:updated` it forwards. Settings storage stays
in userData with the GUI; the fabric receives only the slice it acts on
(`approvalsInApp`, `agentBinaryPaths`), pushed on connect and on change.
Permission rules moved wholesale — the daemon evaluates them at the hook
boundary, so it owns the store, and E2 edits through proxies.

**Window close and full quit are deliberately different.** Closing the GUI
window is a detach: the Electron tray process stays connected and the daemon
keeps every session alive. The quit-drain dance (`QUIT_DRAIN_MS`) and the
node-pty teardown crash it dodged live in the daemon, the process that owns
the PTYs. “Quit Sertum completely…” in the tray and application menus first
requests `daemon/stop`, then exits the tray process. “Shut down agent
daemon…” in the command palette remains useful while the window is open: it
kills the daemon-owned sessions and reconnects to a fresh empty daemon.
Claude `--bg` sessions created by Sertum are explicitly stopped through
Claude's own daemon during the complete shutdown; merely imported attached
and monitored rows are labelled Detach in the tray rather than claiming that
Sertum can end an externally owned agent.

**The tray is the persistent GUI surface.** The Electron process stays alive
when its last window is closed and owns a cross-platform tray/menu-bar icon.
Its menu is rebuilt from the GUI's daemon-fed `SessionSnapshot` mirror, so
its status labels come only from adapter events and process lifecycle — never
PTY pixels. It can reveal a session, end an owned session, or detach an
externally hosted one, and reopening recreates or shows the same disposable
window.

It holds Electron's single-instance lock, so launching Sertum again reveals
the existing window instead of creating a duplicate tray and notification
client. **The losing launch quits silently, because the launch was not
refused -- it was answered.** `second-instance` calls `showMainWindow`, which
creates a window when the last one was closed and only the tray remained, so
relaunching from the taskbar or Start menu is the ordinary way to bring the
window back and the window appearing is the sign that the launch was heard.
An error box there described that success as a failure: dismiss "only one
copy can run at a time", and the window opens anyway. The losing instance
still never reaches `ready` -- `app.quit()` called that early aborts startup
outright, before a window or a daemon of its own exists. `sertumd` matches:
its listen-race loss is the correct silent outcome for a headless process --
logged to `sertumd.log`, never surfaced live.

**Installing is not starting.** Squirrel launches the app it just installed
with `--squirrel-firstrun` (a different flag set from the install/update
callbacks `electron-squirrel-startup` answers). Sertum's start-up joins or
spawns a daemon that then outlives its window, so an installer that runs the
app leaves a background process behind for someone who only meant to install.
That run therefore shows one information box saying the install succeeded and
exits, before any daemon, tray or window exists. The box waits for `ready`,
since `showMessageBoxSync` -- unlike `showErrorBox` -- needs it.

**What is deliberately not solved yet.** Session restore in the *renderer*
sense (which panes held what) is unchanged — the daemon restores existence
and scrollback, not layout occupancy. The daemon dying takes every session
with it, possibly with no window up to notice — same class of problem as
`watchForProcessDeath`, now out of sight; the GUI logs the loss and
reconnects, and the log file is the trail. Packaging now fails closed if the
`RunAsNode` fuse is off or the asar-unpacked `sertumd.js` is absent (the first
real `npm run make` audit found that the old dot-directory glob silently
omitted it). A Windows packaged executable has loaded the daemon bundle under
RunAsNode and safely lost the listen race to the live daemon. A clean-start
and GUI reconnect test remains; it was not forced while that daemon owned a
live shell session. Packaging must run under Node 20 LTS — see
[docs/windows.md](docs/windows.md).

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

A bare Enter sends a message to an agent, so composing a multi-line prompt
needs a second chord: `terminal-pane.ts` intercepts Shift, Ctrl and Alt+Enter
(and Cmd+Enter on macOS) before xterm encodes them and writes `ESC CR`, which
is what Claude Code's `/terminal-setup` installs and what Codex reads as
Alt+Enter. Ctrl+C copies and clears the selection only when there is one, and
otherwise falls through to xterm as the interrupt that stops the agent.
Ctrl/Cmd+V pastes through the main process, because an image has to become a
path before a byte stream can carry it — both Claude Code and Codex treat an
image path in the prompt as an image.

Two invariants for anything touching a live pane:

- **The WebGL renderer must be allowed to die.** Every terminal's context
  lives in the one shared GPU process, and a reset loses them all at once
  while xterm goes on painting nothing. `webglcontextlost` is the signal to
  listen for — in the capture phase, on the host element — not
  `WebglAddon.onContextLoss`, which never fires on the common branch where
  Chromium restores the context and the addon's rebuild fails anyway. The
  answer is to dispose the addon, fall back to the DOM renderer and refresh
  the viewport, once, when the window is visible.
- **A dead helper process must not be a dead window.** `watchForProcessDeath`
  reloads a killed renderer exactly once — sessions live in the daemon, so a
  reload costs only scrollback — and logs a lost GPU process or an
  unresponsive window rather than leaving either invisible.

Chords and their platforms, the three clipboard shapes Electron 44 answers
with, the context-loss timeline, the two ways node-pty's macOS spawn helper
arrives unusable, and the node-pty teardown crash the quit drain dodges:
[docs/terminal.md](docs/terminal.md).

## Committing from the review

C15 is reached from C11's Commit & push button and writes through Git alone
(`main/diff-review.ts`); C16 opens a pull request through the GitHub CLI
(`main/pull-request.ts`), because `gh` already owns the credential and
reimplementing auth here would mean holding a token the user has already
handed to a tool built for it.

- **The inventory on screen never authorises the write.** `commitDiff`
  re-resolves the repository and re-reads its changes before touching
  anything, and a chosen path Git no longer reports as changed fails the
  whole commit rather than being dropped quietly.
- **The commit is pathspec-limited**, so a file staged outside Sertum stays
  in the index instead of being swept in; untracked paths are staged first.
- **Committing and pushing are reported independently**, so a commit that
  lands behind a failed push is shown as exactly that.
- **The push destination is resolved before it is offered**, never assumed to
  be `origin`; the same answer labels the control and performs the push.
- **Sertum composes no commit message, title or body.** They stay empty
  unless a lone commit's own words seed them, and no trailer of any kind is
  appended. Inferring one from a terminal is what the two planes forbid.

Every precondition C16 answers before offering a button, `gh`'s exit-code
contract, and the six push-target states:
[docs/git.md](docs/git.md).

## Settings say what they cannot do

E1–E7 share one window and a nav; every control applies live, and Cancel puts
back the settings captured on open, so previewing a theme or a type size stays
safe to explore.

The rule that shapes the panes: **a control whose subsystem does not exist is
rendered disabled carrying its reason, never as a switch that switches
nothing.** This is the same answer `AgentAdapter` gives for a declined
capability, for the same purpose -- the user learns why, at the moment it
matters, instead of discovering later that a toggle did nothing. Pane-layout
restoration and storage management read that way today; shortcut remapping is
implemented and persists through the command registry.

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
- **Only meaningful terminal states.** `working` never notifies.
  `needs-input`, a failure and a clean finish are on by default. A finished
  turn is the truth-plane transition `working → idle`; `done` means the
  session process itself exited. Finished notifications cover both — checking
  only `done` silently omits ordinary completed answers while their agent
  processes correctly remain ready for another turn.

Settings schema version 1 migrates legacy files from the former
`notifyFinished: false` default to true once. After version 1 is persisted,
turning the preference off is an explicit choice and remains off.

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
- **Windows development notifications use the tray balloon.** A toast emitted
  by bare `electron.exe` can render, but it has no installed Start-menu
  shortcut containing Sertum's app path; clicking it launches Electron's
  default welcome window. `process.defaultApp` therefore selects
  `Tray.displayBalloon`, whose click is delivered to the running Sertum
  process. Packaged Windows builds retain normal Electron notifications
  through Squirrel's shortcut and stable AppUserModelID.
- **`app.setBadgeCount` is macOS and Linux only.** E5 says so next to the
  control instead of offering a switch that appears to work.

## Permission rules are the tool gate made selective

Stored allow/deny/ask rules answer at Claude's `PreToolUse`, a structured
decision point that attributes to exactly one session, so they need no new
channel. They answer at the boundary before *every* tool call precisely
because they need no one present; nothing here ever waits for a person.

- **Deny wins.** A permission control that resolves ambiguity by permitting
  is not a permission control.
- **No rule is not an approval.** An unmatched call returns nothing at all,
  so Claude runs its own permission flow exactly as it would without Sertum.
- **`*` is the only wildcard**, so what a rule covers can be read off the
  row; every other character is literal.
- **Scope is a path prefix**, so a rule bound to a repository also covers the
  worktrees beneath it.

A rule matches the field a person would write it about — a Bash command, an
edited path — not the tool name, which a bare `*` still covers. The
precedence chain at that boundary, outermost first: a queued interrupt
returns `{ continue: false }`; the wholesale tool gate denies; then rules;
then nothing. `permission-rules` is declared ok by Claude and declined with
a reason by Codex, Grok and shell.

## B5 holds the turn open

Everything else answers a hook immediately. B5 holds the HTTP response while
a person looks at it — the only thing in Sertum that can stall an agent, and
the reason **which event is held is the whole design**.

- **It is `PermissionRequest`**, which fires when a permission dialog is
  displayed, so the agent is already blocked and holding costs the turn
  nothing it was not already paying. It is emphatically **not**
  `PreToolUse`, which fires before every tool call, under every permission
  mode, for calls that raise no dialog at all. *An event named for a moment
  in the tool lifecycle is not an event about permission.*
- **A conversation session asks on its own channel.** With no terminal and no
  dialog it declares `--permission-prompt-tool stdio`, and the CLI sends a
  `can_use_tool` control request and holds the turn. The hook is then a
  deliberate no-op for that session, so one call is never asked twice.
- **Every path out of the hold answers** — a choice, the timeout, session
  exit, a client hangup, or quit. A held call is `needs-input`, not
  `working`, and returns to `working` only when it is *answered*.
- **The bar shows the subject** — the command or the path, in the mono face
  — never the agent's own summary of it, since the subject is what a rule
  would be written from.
- **A held call survives the window.** The daemon answers `approval/pending`
  on both channels and a starting window asks once.
- **A card that is itself the question** — `AskUserQuestion`, `ExitPlanMode`
  — is drawn as that card rather than an approve/deny bar, skips the rules
  and the session-scoped allows, and never writes a rule.
- **The permission mode is read, never assumed.** `SessionSnapshot.permissionMode`
  is null until the agent has said. Claude reports one mode over
  `set_permission_mode`; Codex reports the effective permission profile,
  approval policy and reviewer after `thread/settings/update`. The chip beside
  the composer shows only the mode reconstructed from that agent-owned reply.

The reply shapes, the two curl deadlines, the four choices and their reach,
the card contract and every verified payload:
[docs/approvals.md](docs/approvals.md).

## The model is a setting too, and it sits beside the mode

Which model a session runs is the other half of the pair the permission mode
belongs to: both decide how a turn goes, both are asked about where the turn
is composed, and both are reached from the sidebar row menu as well. So
`model-select` is built as `permission-mode`'s twin — same chip, same picker
shape, same "declined is an answer" rule — and the two chips sit together
under the composer. `thinking-level` is the third of that row and the same
twin again: how hard a turn reasons is the other half of what it runs on.

- **The list is never Sertum's.** A hardcoded catalogue goes stale the week a
  model ships and offers models an account cannot run, so every
  implementation asks the agent, per session, each time the picker opens:
  Claude's `list_models` control request, Codex's `model/list`, and for Grok
  the cache its own CLI fetched. A model is only ever sent if that session's
  agent just listed it, so the renderer can never name one of its own.
- **A running turn keeps the model it started with**, verified on all three,
  so `ModelChangeResult.appliesToNextTurn` says so when a turn was in flight.
- **The model recorded is the resolved one.** `SessionSnapshot.model` means
  "the model this session runs", so a successful switch writes to it at once
  and the agent's own later reports keep superseding it.

Claude and Codex declare `requires: 'structured-conversation'` because a
PTY-backed session's stream belongs to its TUI; Grok declares no requirement,
because a prompt is the transport it has. Shell declines.

**A thinking ladder belongs to a model, not to an account.** Which levels
exist depends on which model is answering — Claude publishes
`supportedEffortLevels` per catalogue row and none at all for haiku — so the
ladder is read for the model this session is on, and re-read after a model
switch. Same rule as the catalogue above it: a level is only ever sent if that
session's agent just listed it.

**A switch is reported, never assumed.** Two of the three agents will accept a
level and quietly not take it — Claude answers an unusable one with a plain
success — so every implementation reads the level back and reports what the
session is *on*, which is what lands in the snapshot. An unchanged level is a
refusal with a reason, not a success nobody can see through.

**A setting that changed says so.** A successful switch on an idle session
used to write nothing at all: `appliesToNextTurn` is false there, and the chip
alone could not carry the news — it showed a slug the reader had never seen,
elided to a width where two models can look identical. The composer now names
what the session landed on, the chip uses the agent's own display name
(`SessionSnapshot.modelLabel`, which travels with the slug and is dropped when
it moves without one), and a catalogue read teaches the snapshot what a
session with no turns behind it could not otherwise say
(`AgentModelList.current`, `AgentEffortList.current`). Choosing from a chip
also puts the caret back in the composer, because what follows deciding how a
turn runs is typing the turn.

Each agent's catalogue and switch for both settings, what each was verified
against, why Claude's thinking key is `effortLevel` and its read-back is
load-bearing, and why Grok's `/model` on its own prompt is not the
synthesized-keystroke move `turn-interrupt` refuses:
[docs/models.md](docs/models.md).

## Modals answer, they do not vanish

B5's bar is never dismissed by clicking away because every route off it has
to answer the call. The same rule now covers every modal in the app, for a
plainer reason: a stray click on the backdrop is not a decision, and treating
it as Cancel throws away whatever was typed into the sheet behind it. A
half-written commit message, a pull request body, a folder picked in C1 --
all of them used to disappear on a misplaced click, silently and with no undo.

So a modal closes only through one of its own buttons. Neither a backdrop
click nor Escape does anything, and the invariant that makes this safe is
that **every modal carries a button that closes it** -- Cancel, Close or
Done. Adding a modal means adding that button; there is no ambient way out.
While one is present, the renderer also marks the native application menu
modal: File, Session, View and Window are disabled and their dispatch path
rejects commands. A DOM backdrop cannot otherwise stop Electron's menu bar,
which let an action mutate the window behind the dialog.

That invariant has teeth while a modal is waiting on something slow. C11,
C16 and C9 each used to blank themselves to a bare "Reading changes…" line
during their first Git or `gh` call, which was survivable only because Escape
was still a way out; with Escape gone it would have been an uncloseable
dialog whenever a call hung. Their waiting states now render through the same
footer as every other state, so the Close button is on screen from the first
frame.

Transient pickers are deliberately not modals and keep dismissing on
click-away: the command palette, the layout picker, the agent picker and the
sidebar row menu. None of them has a decision to record or a field to lose,
and none has a confirm button to route a dismissal through, so click-away is
the gesture that fits them.

## Shortcuts are a registry, not literals

Accelerators lived as strings inside `buildMenu`, which made them unremappable
by construction: there was nowhere to put an override and nothing to detect a
collision against. `main/keybindings.ts` is that missing piece -- a table of
commands, a map of overrides, and one rule about conflicts.

- **Nothing is stored until the conflict is resolved** (E6 note 236). Two menu
  items claiming one chord would leave which of them fires up to Electron
  rather than to the user, so `setKeybinding` refuses and names the command
  already holding it. The bar keeps recording, because the fix is another
  chord.
- **Chords are compared as chords, not as strings.** `Ctrl+Shift+X` and
  `CmdOrCtrl+Shift+X` are one binding written two ways; normalising modifiers
  and case before comparing is what stops a duplicate slipping in through
  spelling.
- **A stored accelerator is validated before Electron ever sees it.**
  `Menu.buildFromTemplate` throws on a malformed accelerator and the menu is
  built during startup, so one bad string in a hand-edited file would leave
  the app with no menu at all. Anything that does not parse is dropped on load
  and the command keeps its default.
- **Changing a binding rebuilds the menu**, since the menu is where
  accelerators live.

### The Edit menu is macOS-only, and that is the fix rather than an omission

macOS delivers the standard editing chords through the application menu. With
no Edit menu, **Cmd+C and Cmd+V reach nothing at all** — not the transcript,
not the composer, not a dialog field — which is how the app shipped until a
Mac user found copy simply dead. Windows and Linux never had the problem,
because Chromium handles those keys itself.

Adding the usual `copy`/`paste` roles on every platform would have been a
regression rather than a fix: their default accelerator is `CmdOrCtrl+C`, and
on Windows that takes Ctrl+C away from the terminal — where, with no
selection, it is the interrupt that stops the agent. So the menu is built only
for darwin.

Copy and Paste are routed through the renderer rather than given the roles,
because a terminal is not an ordinary text surface: xterm's selection lives in
its own model where the platform's copy cannot see it, and its paste has to
turn an image into a path before any byte reaches the PTY. The renderer asks
the focused pane first — `document.activeElement.closest('.term-host')` — and
falls back to `webContents.copy()`/`paste()`, which is what makes a plain
textarea behave exactly as it does everywhere else.

Two details that are load-bearing. The menu carries **no `edit-menu` entry in
the modal-disabling list**, because a dialog is exactly where someone pastes a
branch name or copies an error. And its items use `sendAlways` rather than
`send`, since `send` swallows every command while a modal is open — which
would have made Cmd+V dead in the one place it is most wanted.

Only commands with a fixed accelerator are listed. `⌘1`…`⌘4` address the nth
session or pane rather than naming one command, and the layout radio set keeps
its numeric mnemonic, so neither is offered for remapping.

## Pane layouts

Design section 07. A window shows one session pane by default; splitting is opt-in
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
loading it somewhere else moves it rather than duplicating it; two simultaneous
views onto one session transport are a separate feature and are not built.

Three things follow for PTY-backed panes; chat-only stream sessions have no
terminal geometry or xterm instance:

- **Every PTY-backed pane resize is sent to its PTY.** Each such pane gets its
  own geometry, so several terminal sessions can have different `cols`/`rows`
  and their TUIs reflow independently.
- **Panes refuse to shrink below a readable surface.** Gutter drags use the
  equivalent of 40 terminal columns and 12 rows, scaled to the terminal point
  size; a window too small to honour that says so over the pane instead of
  clipping either a terminal or conversation.
- **Moving a session between panes costs a DOM move and a refit.** The xterm
  instance for a PTY transport is keyed by session and never rebuilt, so its
  scrollback survives every layout change; a chat pane is likewise reused --
  but reuse alone was not enough for it. xterm keeps scroll position in its
  own buffer model, unaffected by DOM moves; a chat pane's scroller is an
  ordinary element, and per the CSSOM View spec a scroller with no box (the
  state of anything detached from the document, which is exactly what moving
  it out of an off-screen tab does) reports `scrollTop` as zero for as long
  as it stays out. Switching tabs and back therefore silently reset every
  chat pane to the top regardless of where the reader had left it. Fixed by
  having `ChatPane` remember its own position -- a `pinnedToBottom` flag plus
  the last `scrollTop`, updated on every scroll event rather than read off
  the DOM at the moment it matters -- and restoring it the instant `attach()`
  puts the element back, before that poll's first render can land. The
  restore reads as "scroll to the end" when the reader had been there and an
  exact pixel offset otherwise, so a turn that kept streaming while the tab
  was away still auto-follows the reader down, and a message re-read from
  history stays exactly on screen.

Layout and gutter positions are remembered across launches, but pane occupancy
is not. The sessions and their transports continue in `sertumd` and return to the
sidebar; the recreated window does not yet place them back into their previous
panes. While a split is up the sidebar regroups into IN VIEW and OTHER SESSIONS,
and an unfocused pane carries its status colour on its border so an errored
session reads from across the room.

## Running

```sh
npm start                                  # dev
SERTUM_DEBUG_PORT=9222 npm start     # dev + remote debugging
```

Main-process changes require a full restart; Vite only hot-reloads the
renderer. **Daemon changes require restarting the daemon too**: `npm start`
joins a sertumd that is already running, which by design keeps executing the
build it was started from. Shut it down from the command palette ("Shut down
agent daemon…") or kill the pid in `~/.sertum/daemon.json`; the next GUI
launch spawns one from the current build. `~/.sertum/sertumd.log` is the
daemon's console.

### Electron fetches its own binary on first use, not at `npm install`

Electron 42 removed the `postinstall` script that downloaded the binary during
`npm install` (electron/electron#49328, after the npm supply-chain attacks
that used install scripts as their vector). The package now fetches itself the
first time `require('electron')` is asked for the executable's path -- which
is what `electron-forge start` does -- and offers `npx install-electron` to
do it deliberately. This repo is on 44.

That is why a fresh checkout worked on Windows and failed on macOS. Windows
downloaded at the first `npm start`. On macOS, `dev-app-name.js` brands the
dev bundle from `postinstall`, before anything has asked for the path, and
read `node_modules/electron/dist` -- which on a fresh install no longer
exists -- so `npm install` died with `ENOENT: scandir .../electron/dist`
every time `node_modules` was rebuilt. Not a network or permissions problem,
and re-running did not help, since the next run hit the same missing directory.

`scripts/ensure-electron.js` now runs ahead of the branding in both
`postinstall` and `prestart`. It calls `require('electron')` rather than
`install.js`, because the former goes by `path.txt` and leaves a bundle
already renamed to `Sertum.app` alone, while `install.js`'s own check
compares `path.txt` against the stock path and would fetch again on every
run. Verified from an emptied `node_modules`: the binary is extracted from
Electron's cache, branded, and a second `npm install` is a silent no-op.

### node-pty's macOS spawn helper arrives unusable, twice over

Every PTY on macOS is `posix_spawn`ed through a helper binary node-pty ships,
and it reaches us broken in two unrelated ways -- the published package
clears its executable bit, and node-pty's `app.asar` path rewrite fires even
when the module was already loaded from `app.asar.unpacked`, which is always
the case here because sertumd runs under `ELECTRON_RUN_AS_NODE`. Either one
alone stops every PTY session, and both report the same errno-free sentence,
`posix_spawnp failed.`, with no path in it and no macOS permission prompt to
explain it. Since Claude and Codex are stream sessions with no PTY, the
symptom is Shell alone refusing to start.

Both are answered where the file lands rather than at spawn time:
`scripts/ensure-pty-helper.js` from `postinstall` and `prestart` for the
source tree, `fixDarwinPtyHelper` in `forge.config.ts` for the bundle, before
the ad-hoc re-sign that has to seal it. `verifyPackagedDaemon` stats the path
node-pty will really use, so packaging fails closed on either.

Never diagnose this from the message alone, and never conclude a spawn failure
here is macOS permissions: the exact modes, the isolating test and the
reproduction are in [docs/terminal.md](docs/terminal.md).

## Verification

Screen capture is unavailable in some environments, so the app can be checked
headlessly.

```sh
# PTY layer only — no UI. Also the cross-platform check for Windows/Linux.
npx electron scripts/smoke-pty.js          # default shell
npx electron scripts/smoke-pty.js claude   # a real agent TUI

# Drive the running app (needs SERTUM_DEBUG_PORT)
node scripts/drive.js "document.querySelectorAll('.tab').length"

# A conversation session's permission channel, against a real claude process:
# the ask arrives, the turn stays held, the answer resumes it.
npx esbuild scripts/smoke-chat-permission.ts --bundle --platform=node   --format=cjs --outfile=/tmp/smoke-chat.cjs &&   node /tmp/smoke-chat.cjs <folder> deny 8000

# Native image input against each owned structured host:
npx esbuild scripts/smoke-chat-image.ts --bundle --platform=node --format=cjs --outfile=/tmp/smoke-chat-image.cjs && node /tmp/smoke-chat-image.cjs <folder>
npx esbuild scripts/smoke-codex-chat-image.ts --bundle --platform=node --format=cjs --outfile=/tmp/smoke-codex-image.cjs && node /tmp/smoke-codex-image.cjs <folder>
```

`scripts/drive.js` opens a CDP WebSocket, so it needs a Node with the
`WebSocket` global: under Node 20 run it as `node --experimental-websocket
scripts/drive.js …`.

`window.__sertum` is exposed in dev builds only. It is the app object itself:
`panes.get(activeId).snapshot()` returns the focused terminal's scrollback,
which is the only way to read terminal contents while the WebGL renderer is
active.

Restarting the app quickly on the same `SERTUM_DEBUG_PORT` can come up with
no debugger at all: the previous instance's sockets sit in TIME_WAIT, the
bind fails, and Chromium treats that as non-fatal and silent — the app runs
normally while `/json/list` answers nothing. Cost two blind restarts before
it was recognised. Use a fresh port per restart when driving the app
headlessly.

## Windows notes

Development has mostly happened on macOS, and Windows 11 differs in ways
that have cost this project real time. The load-bearing ones:

- **Package under Node 20 LTS, not Node 26.** Electron Packager 18.4.4 exits
  0 partway through Electron archive extraction, producing no packaged
  directory and no maker artifact.
- **Binary resolution needs a real PATH × PATHEXT search**, in the shared
  `src/main/adapters/binary-resolve.ts`: `node-pty`'s `CreateProcess` only
  ever appends `.exe`, `child_process.spawn` refuses `.cmd`/`.bat` without
  `shell: true` and throws `EINVAL` *synchronously*, and Grok is not on PATH
  at all. A bare command name is never safe here.
- **Run the dev app and the daemon at the desktop user's normal privilege
  level.** An elevation mismatch breaks the desktop's own hotkeys while
  Sertum is focused, and an elevated launcher can pass elevation through a
  `Shell.Application` launch, so verify the resulting tokens.
- **A Squirrel install/update callback must not enter the normal `ready`
  handler**, or it races the shortcut helper's asynchronous exit and starts a
  detached broker; the handler returns early for callbacks and for losing
  single-instance launches.
- **`npm install` needs an `allowScripts` block** under npm 11, or `node-pty`
  ends up with no native binary at all.

**Linux (.deb).** `npx electron-forge make --targets deb` on Ubuntu 26.04
produces `out/make/deb/x64/sertum_<version>_amd64.deb`; verified launching on
KDE Plasma (Wayland), spawning `sertumd` and opening a PTY. Name the target
by its short name: `--targets @electron-forge/maker-deb` builds a *fresh*
maker with none of `forge.config.ts`'s options (default icon, `bin: sertum`,
which does not exist because Packager names the executable `Sertum`). The rpm
maker shares those options (`linuxPackageOptions`); `--targets rpm` needs
`rpmbuild`, and so does a bare `make`, which fails without it. node-pty has no Linux prebuild, so
`npm install` compiles it (needs `build-essential` and `python3`); Linux
PTYs use `forkpty`, so the macOS spawn-helper problems do not apply.

Packaging and rebuild config, icons and the installer image, ConPTY's benign
`kill()` throw, the process scan's reject rules, the codex app-server pid,
and what is deliberately a no-op on this platform:
[docs/windows.md](docs/windows.md).

## Layout

```
SertumDesigns.pen             Design source of truth — wireframes, storyboards
docs/                         The evidence behind the rules stated in AGENTS.md
  conversation.md             Transcript to conversation; markdown; images
  sessions.md                 Stream sessions, owned Codex threads, resume
  approvals.md                Rules, the B5 bar, cards, permission modes
  models.md                   Per-agent model catalogues and switching
  terminal.md                 Keys, clipboard, WebGL loss, helper-process death
  windows.md                  Packaging, binary resolution, icons, installer
  git.md                      Commit from the review, pull requests via gh
src/
  main.ts                     Electron main: window, menu, UI IPC, daemon proxies
  sertumd.ts                  The session broker: socket server, lifecycle, log
  daemon/fabric.ts            The session fabric, re-homed from main.ts
  shared/daemon-protocol.ts   GUI <-> sertumd wire contract and endpoints
  main/daemon-client.ts       GUI side: connect-or-spawn, requests, reconnect
  main/pty-manager.ts         Plane 1 — PTY lifecycle (runs inside sertumd)
  main/workspace.ts           Folder validation, git/worktree detection
  main/hook-server.ts         Plane 2 ingress — loopback HTTP, per-session URLs
  main/settings.ts            Display/agent-path preferences, JSON in userData
  main/clipboard-paste.ts     Clipboard reads for terminal/chat paste; images spilled to disk  [docs/terminal.md, docs/conversation.md]
  main/chat-attachments.ts    Validates chat files and encodes native Claude images  [docs/conversation.md]
  main/attachment-preview.ts  Builds bounded composer/chat thumbnails  [docs/conversation.md]
  main/worktrees.ts           Worktree inventory, provisioning, removal (C9)
  main/diff-review.ts         Git-backed changes, discard and commit (C11, C15)  [docs/git.md]
  main/pull-request.ts        Pull requests through the GitHub CLI (C16)  [docs/git.md]
  main/notifications.ts       System notifications from adapter events (C20, E5)
  main/permission-rules.ts    Stored allow/deny/ask rules for tool calls (E2)  [docs/approvals.md]
  main/keybindings.ts         Command registry behind the menu accelerators (E6)
  main/local-image.ts         Reads an image a message points at, inside the session folder  [docs/conversation.md]
  main/login-env.ts           macOS login-shell environment probe (no-op on Windows)
  main/adapters/agent-adapter.ts   Per-agent capabilities: declared answers, resolveBinary, renameRemote
  main/adapters/binary-resolve.ts Shared existence-checked PATH × PATHEXT search  [docs/windows.md]
  main/adapters/claude.ts     Hook settings builder + event to status mapping
  main/adapters/codex.ts      Codex thread status/summary mapping
  main/adapters/codex-app-server.ts  Codex's private app-server: spawn, JSON-RPC, reap
  main/adapters/grok.ts       Grok event to status mapping, session-dir lookup, model catalogue
  main/adapters/grok-event-log.ts  Plane 2 ingress for Grok: tails events.jsonl
  main/adapters/discovery.ts  Agent-agnostic discoverer registry
  main/adapters/process-scan.ts  Universal agent-process scanner
  main/adapters/session-meta.ts  Model/effort/context read from a live transcript
  main/adapters/transcript.ts    Per-agent transcript summaries
  main/adapters/conversation.ts  Transcript parsed into conversation items (chat view)  [docs/conversation.md]
  main/adapters/markdown-format.ts  Is a message markdown, and is the markup the answer?  [docs/conversation.md]
  main/adapters/interactive-tools.ts  Cards read from a tool's own input, and how each answer gets back  [docs/approvals.md]
  main/adapters/claude-chat.ts   Headless Claude over stream-json (conversation sessions)  [docs/sessions.md]
  main/adapters/codex-chat.ts    Owned Codex threads on the private app server  [docs/sessions.md]
  main/adapters/window-focus.ts  Raise the OS window owning a session
  preload.ts                  contextBridge API surface
  shared/types.ts             Contracts shared across processes
  renderer/app.ts             Shell: tabs, sidebar, pane, status bar
  renderer/terminal-pane.ts   One xterm bound to one PTY  [docs/terminal.md]
  renderer/chat-pane.ts       A session as a conversation; composer uses its declared transport  [docs/conversation.md]
  renderer/message-text.ts    Message text to DOM: markdown or source, never an HTML string  [docs/conversation.md]
  renderer/pane-grid.ts       Split-pane geometry, gutters and readable-size limits
  renderer/layout-picker.ts   Single/Columns/Rows/Grid picker and split actions
  renderer/agent-icon.ts      Shared agent identity marks
  renderer/chips.ts           Model/effort badges, read by shape and colour
  renderer/command-palette.ts     ⌘K command palette — wireframe C13
  renderer/confirm-dialog.ts      Destructive-action confirm gate — wireframe C7
  renderer/text-prompt-dialog.ts  Shared one-field modal prompt
  renderer/session-menu.ts        Sidebar row context menu — wireframe C5
  renderer/settings-dialog.ts     Settings — wireframe E1, plus agent paths
  renderer/worktree-dialog.ts     Worktree manager — wireframe C9
  renderer/new-session-dialog.ts  Wireframe C1
  renderer/adopt-dialog.ts        Wireframe C18
  renderer/resume-dialog.ts       Resume a past conversation by agent + folder  [docs/sessions.md]
  renderer/diff-review-dialog.ts  Changes review — wireframe C11
  renderer/commit-dialog.ts       Commit & push sheet — wireframe C15
  renderer/pull-request-dialog.ts Open pull request — wireframe C16
  renderer/approval-bar.ts        Tool-call approval bar, above the composer — wireframe B5  [docs/approvals.md]
  renderer/approval-card.ts       Question and plan cards, when allow/deny is not the question  [docs/approvals.md]
  renderer/permission-mode.ts     The mode catalogue and its picker (plan, auto, accept edits…)  [docs/approvals.md]
  renderer/model-picker.ts        The models an agent offers this session, and the switch  [docs/models.md]
  renderer/effort-picker.ts       The thinking levels this session's model offers, and the switch  [docs/models.md]
scripts/
  ensure-electron.js          Fetch the Electron binary if absent; Electron 42+ has no postinstall
  ensure-pty-helper.js        Restore the +x bit node-pty's package drops from spawn-helper  [docs/terminal.md]
  smoke-pty.js                Headless PTY test
  smoke-chat-permission.ts    A conversation session's permission ask, held and answered
  smoke-chat-interrupt.ts     Structured-session interrupt: fast ack, correct end state, session stays usable
  smoke-resume.ts             session-resume round trip: kill a session, resume it, confirm recall
  smoke-model-switch.ts       model-select: read each agent's catalogue, switch, confirm the turn ran on it
  smoke-effort-switch.ts      thinking-level: read each agent's ladder, switch, confirm the level was really taken
  drive.js                    CDP driver for headless verification
```
