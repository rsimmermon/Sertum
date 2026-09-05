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

What's built and verified so far:

- [x] Electron 44 + Vite + TypeScript, strict mode clean
- [x] `node-pty` PTY transport; spawn / write / read / resize / kill
- [x] The PTY transport handles real agent TUIs (Claude Code and Codex were
      verified on macOS and Windows; Grok was verified end to end on Windows),
      although supported agents now present their transcript-backed chat view
      rather than the terminal surface
- [x] Terminal keystrokes and chat-composer submissions reach PTY-backed
      sessions
- [x] Tab strip, sidebar grouped by status, pane header, status bar
- [x] New Session dialog (wireframe C1) with a **native folder picker**, live
      git validation, recent folders, and auto-derived tab labels
- [x] **Plane 2 for Claude Code** — loopback hook endpoint, per-session binding,
      status and activity driven by real agent events
- [x] **Plane 2 for Codex** — a private app-server instance owned by `sertumd`,
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
      does not exist — pane-occupancy restoration, launch at login, repository
      cataloguing and diagnostic/session storage — render disabled carrying
      the reason
- [x] **Remappable shortcuts** (wireframe E6) — a command registry behind the
      menu, click-to-record chords, and a collision refused with the command
      that already holds it
- [x] **Permission rules and in-app approval** (wireframes E2, B5) — stored
      allow/deny/ask rules answered at Claude's `PreToolUse`, and an approval
      bar that holds the call open for the ones Claude actually asks about:
      `PermissionRequest` for a PTY-backed session, a `can_use_tool` control
      request for a conversation session, which without it could not ask at
      all. The bar sits directly above the composer, and a held call survives
      the window being reloaded or closed to the tray. A call whose card *is*
      the question — `AskUserQuestion`, `ExitPlanMode` — is drawn as that card
      and answered on it
- [x] **Permission mode per session** — plan, auto, accept edits and the rest
      set from a chip beside the composer or the sidebar row menu, over
      Claude's `set_permission_mode` control request; the mode shown is the
      one the agent reported, and a mode it will not take says why
- [x] **System notifications** (wireframes C20, E5) — fired from adapter
      events on a status transition, only when the window is unfocused, with
      per-session mute and snooze
- [x] **Split views** (wireframes G1–G8) — Single, Columns, Rows and Grid,
      each pane independently sized; PTY-backed panes propagate their own
      geometry, gutters clamp at a readable surface, focus moves spatially,
      and a session dropped on a pane moves rather than duplicates. See
      "Pane layouts" below.
- [x] **Conversation view** — every agent session is shown as a conversation read
      from the agent's own transcript, with a composer that writes to the
      PTY where required. Works for monitored sessions too, read-only. Declared
      as the `conversation-view` capability; a shell declines and remains a
      terminal. See "The
      conversation view" below.
- [x] **Conversation sessions** — stage 2: the preferred transport has no terminal
      at all, carried over Claude's stream-json protocol by a headless
      process. Same sidebar, same status vocabulary, same permission rules
      and hooks as a terminal session; the chat view is the whole surface.
      Declared as `structured-conversation`; Claude and Codex provide owned
      structured hosts. Grok and shell decline and retain PTYs (visible only
      for Shell). See "Conversation sessions" below.
- [x] **Claude-native background hosting** — an optional, agent-specific path
      predating `sertumd`: an Agents setting starts Claude under its own daemon
      (`--bg`) and Sertum attaches as a client. Declared as `background-host`;
      Codex, Grok and shell decline. This is no longer the general persistence
      mechanism; `sertumd` provides that for every agent. See
      "Claude-native background hosting" below.
- [x] **sertumd, the session broker** — stage 3 proper: the whole session
      fabric (PTYs, hook server, Codex app-server, Grok logs, chat host,
      adapters, rules) lives in a daemon; the Electron window is a disposable
      client over a named pipe / unix socket while the Electron process stays
      alive for the tray. Every owned Claude, Codex, Grok and shell session
      survives the window closing; a recreated window lists them again and
      restores buffered PTY output where applicable. Verified end to end on
      Windows, including a force-killed Electron client. See "The daemon:
      sertumd" below.
- [x] **System tray companion** — starting Sertum creates a tray/menu-bar icon
      on Windows, Linux and macOS. Closing the window hides the UI while the
      tray continues to show truth-plane session state and deliver
      notifications; sessions can be opened or ended there. “Quit Sertum
      completely…” stops sertumd and every session it owns.
- [x] **Markdown in the conversation** — an agent's markup is rendered as
      markup, unless the turn asked for the markup itself, in which case the
      characters are the answer and are shown in the mono face. A fenced
      block is always code, ```markdown included. Every classified message
      carries a toggle, so the guess is never the last word. GFM footnotes
      render; a local image inside the session's folder is shown for real
      while a remote one stays a link. Nothing is assembled as an HTML
      string. See “Markdown, and when the markup is the answer” below.
- [x] **A waiting bubble and a stop sign** — bouncing dots and the
      session's activity line while plane 2 says the agent is working, and a
      red stop square at the right edge of the composer.

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

## The conversation view

The truth plane extends from status to content without a new channel. Every
Claude, Codex and Grok pane renders the transcript
as a conversation — user and assistant messages, collapsed thinking, and tool
calls paired with their results. When the adapter still needs a PTY, it keeps
running underneath and collecting bytes, but there is no terminal/chat choice
in the product UI. Shell declines the conversation capability and remains a
normal terminal.

What it reads is each agent's own transcript on disk, through
`main/adapters/conversation.ts` — the same class of source as a hook payload,
so this does not touch the two-planes rule. Record shapes were verified
against real files, not documentation: Claude's `message.content` blocks
(`text`/`thinking`/`tool_use`/`tool_result`, with `isMeta` and `isSidechain`
marking what is not conversation), Codex's `response_item` payloads
(`function_call`/`custom_tool_call` and their `*_output` twins paired by
`call_id`), and Grok's role-as-type records with `tool_calls` and
`tool_result` paired by `tool_call_id`. Injected context is skipped by its
tag opener, never by a blanket "starts with `<`", so pasted XML still shows.
Explicit TeX spans (`\[...\]` and `\(...\)`) are typeset by KaTeX with trust
disabled, while all surrounding transcript content remains text nodes rather
than injectable HTML. Markdown is rendered — see below for how a message that
should stay source is told apart.

The renderer polls `conversation:read` once a second while the view is on
screen, for the reasons Grok's event log established: the file may not exist
yet, watch semantics differ by platform, and one update per batch is the
point. Transcript resolution reuses `transcriptFor`, so a Claude session is
only ever matched exactly and a shell never inherits another agent's
transcript.

Conversation reads keep complete transcripts up to a 32MB safety ceiling and
cache the parsed snapshot by file size and mtime. A fixed 512KB tail was not a
complete-turn boundary: one image-generation result embeds a multi-megabyte
data URL in a single JSONL record and pushed the user's prompt, tool call and
earlier conversation out of view. Structured `data:image/*` fields in tool
results now become `image` chat items and render as bounded previews; ordinary
prose is never interpreted as an image URL. Beyond the ceiling, the tail and
its truncation notice remain the honest bounded fallback.

Conversation content opts back into native text selection (`user-select:
text`) beneath the app-wide chrome rule that prevents accidental interface
selection. The selection tint uses the solid accent with the theme background
as its text color (the soft accent matches the user bubble and hides selection), so copied text is
visibly selected in both themes; composer controls remain outside that
transcript selection surface.

Chromium descendants explicitly opt into text selection too. Transcript polls
defer replacing conversation nodes while the reader has selected text, then
catch up once the selection is cleared. Codex's `<recommended_plugins>` user
record is injected context and is excluded from conversation, like its
environment preamble; ordinary pasted XML remains visible.

Input still goes to the PTY, and the byte sequence matters. The composer
sends the body as a bracketed paste and the final CR **separately, a beat
later**, so it arrives as a real Enter press. Encoding newlines as ESC CR
with a trailing CR in one burst was tried first and failed silently: Claude's
TUI read the whole burst as a paste, swallowed the CR into it, and left the
message sitting unsent in its composer. A single line goes as one plain
write, verified, which keeps the common case free of paste markers for any
agent that never enabled bracketed paste.

The delayed Enter boundary applies to single-line PTY messages too. Codex
0.153.0 visibly accepted a one-write `text + CR` into its composer but did not
submit it, leaving plane 2 at the startup `turn finished` state and writing no
transcript. The body is now one write (bracketed only when multiline) and CR
is always a second write 150ms later.

The composer carries **one button with two jobs**, at the right edge of the
box you type into — the control that acts on a turn sits where the turn is
composed. Text in the composer makes it a paper plane that sends; an empty
composer during a turn makes it a red square that stops. The two are never
both available, so a second button would always be dead, and the composer's
own content is the signal: it flips on the first keystroke and back on the
last backspace.

Stop calls the declared `turn-interrupt` capability and never writes Ctrl+C
or Escape into the PTY. The square stays on screen when the agent declines
that capability — disabled, carrying the adapter's reason — because that
reason is user-facing copy and hiding the button would hide it. Being a sign
rather than a word, both modes put their reason in `aria-label` as well as
the tooltip.

A waiting bubble — three bouncing dots and the session's `activity` line —
sits at the tail of the conversation while plane 2 says the agent is working.
This is the truth plane at conversation scale, and the same rule applies as
everywhere else: the dots are on because an adapter reported a turn in
progress, never because output went quiet. The caption is the same string the
sidebar reads, so a pane cannot disagree with the dot beside it. A
`needs-input` session is deliberately *not* shown as waiting — it is not
working, it is waiting on the reader, which the status dot and B5's bar
already say. The bubble is one long-lived element re-appended on each repaint
rather than rebuilt, so the transcript poll does not restart its animation
once a second.

Before the transcript
has conversational content, the pane renders a Sertum-owned welcome card from
the session's real identity, cwd and model metadata. Agent startup protocols
(Claude's `system/init` included) report readiness and identity but do not send
the terminal's welcome banner as an assistant message, and the banner is not
parsed from terminal pixels.

`conversation-view` is a declared capability: Claude, Codex and Grok answer
ok (Grok's read-only event plane is exactly what a read-only view asks for);
a shell declines with its reason on the disabled button. Monitored sessions
get the view too — the transcript is on disk whoever owns the process, which
is the property that already let discovery summarise them — with the
composer disabled and saying where input actually lives. This is the part of
an adopted session that genuinely can live here, so selecting a monitored
row no longer jumps to its owning window while its conversation is up.

What stage 1 deliberately does not do: no synthetic "pending" messages (a
sent message is acknowledged under the composer until the agent records it),
and no structured input channel — that is stage 2, below.

### Markdown, and when the markup is the answer

Stage 1 showed every message as literal characters, on the principle that
inventing formatting the agent did not send is the same class of mistake as
inventing a commit message. That principle stands; the conclusion drawn from
it was wrong. Agents emit `##`, `-` and fenced blocks *deliberately* — that
markup is theirs, not ours — so printing it as characters is the same
misrepresentation pointed the other way. Rendering it is reading what the
agent wrote. The mistake would be adding structure to text that has none, and
that is what the classifier exists to avoid.

`main/adapters/markdown-format.ts` stamps each assistant message with a
`MessageFormat` — `text`, `markdown` or `markdown-source` — from two signals,
both read from the transcript, never from pixels:

- **The message's own syntax.** No constructs means no decision: the message
  is `text` and takes the original plain path. The inline patterns require a
  non-space beside each delimiter and a non-word character outside the
  underscore forms, so `snake_case_names` and `a * b * c` stay prose.
- **The request the turn answers**, which says whether the markup is the
  subject rather than the presentation. "Give me the markdown for a table"
  wants characters; "summarise this in markdown" names a house style and
  wants a summary. A request to *render* is asked first and settles it, so
  "render the markdown" is not read as a request for source by the phrase it
  contains.

The narrower signal costs nothing to trust: **a fenced block is always shown
as code, ```markdown included.** That fence is the agent's own declaration
that these characters are the subject, so the common case of an answer *about*
markdown needs no heuristic at all — only a whole reply that is unfenced
source falls to the request test.

Neither signal is load-bearing. A guess about intent will sometimes be wrong,
so every classified message carries a toggle: source mode is set in the mono
face — the only way a markdown table's columns line up — and a message shown
as source because the request asked for source says so, or being handed
characters reads as the app failing. A user's own message is never
classified; they typed those characters into the composer, and handing them
back reformatted would hide what was actually sent.

`renderer/message-text.ts` owns both paths, so the rule they share cannot
drift: **nothing is ever assembled as an HTML string.** Every node is created
and every leaf filled through `textContent` or a text node, so raw HTML in a
message is shown as the characters the agent wrote and a transcript can no
more inject markup than before the file existed. Verified against a message
carrying `<img src=x onerror=...>` and a `<script>` tag: both come out as
escaped text with no element created. Two things are deliberately not
rendered — a bare URL does not become a link, and a remote image is not
fetched, both being the renderer acting on an address out of a transcript.
Only http(s) links become anchors, matching what `shell:open-external`
accepts, so the app never draws an affordance that would silently fail;
every other address keeps its label and carries its target in a tooltip.
Newlines inside a paragraph stay line breaks rather than being reflowed,
because reflowing an agent's deliberate line breaks is exactly the invented
formatting this view exists to avoid.

Three constructs used to render *wrongly* rather than merely plainly, which
is the worse failure and the reason they are called out here:

- **A setext underline.** `Sub Title` over `---------` produced a paragraph
  *and* a horizontal rule: the heading became body text and a rule appeared
  that the agent never wrote. The underline now closes the paragraph above it
  as a heading, which is also where it outranks the thematic-break reading of
  `---`. A `---` after a blank line, with no paragraph above it, is still a
  rule.
- **`\[` is display math in TeX and an escaped bracket in markdown**, and
  agents write both. Nothing in the delimiters says which, so the content
  decides: real math carries operators, digits or a backslash macro, and a
  single token with no spaces is a variable. `\[not a link\]` has none of
  that and goes to the escape rule. The asymmetry is deliberate — typesetting
  a sentence as an equation is a far worse failure than leaving one that was
  meant as math — and it applies on the plain path too, so a `text` message
  cannot be turned into algebra either.
- **Four-space indented code.** Read as a paragraph, the inline pass then ran
  over it, so `*ptr` became emphasis and the code was altered on screen. A
  line that is also a list item is still a list: an agent indenting a whole
  list is commoner here than one relying on indented code, and misreading a
  list as code is the worse trade.

**Links and images are scanned with balanced brackets, not matched with a
regex.** A link's label can itself contain brackets, and the commonest case
of that is an image wrapped in a link — which is what every badge is. A
`[^\]]*` label stops at the image's own `]`, so `[![alt](src)](href)`
produced a link captioned `![alt` pointing at the *image*, with the real
address left in the text as characters. The scanner counts depth and skips
escapes, so a label may hold brackets, and the same routine serves images,
links, and both by reference.

Reference links (`[text][label]` and `[text][]`) resolve against definitions
lifted out of the flow alongside the footnote ones, and so do reference
*images* (`![alt][label]`). The shortcut form
(`[label]` alone) is deliberately not supported — it would swallow ordinary
bracketed prose. An undefined reference stays literal text, the same answer an
orphan footnote gets.

**Dollar-delimited TeX** is supported, because agents emit `$...$` far more
often than `\(...\)`. `$$` is unambiguous and is handled both inline and as
a block opened by `$$` alone on a line — the inline rule cannot see that
form, since a paragraph reaches the inline pass one line at a time. A single
`$` is ambiguous, because money looks the same, so it must hug its content,
must not be followed by a digit, and must contain a character belonging to
TeX rather than to a price. That last test is deliberately stricter than
`looksLikeMath`: a digit alone is enough to call `\(2\)` math, but would
typeset "$5 and $10" as well.

**Character references are decoded from a table**, not by handing a string to
an HTML parser, which keeps the promise at the top of `message-text.ts`
literally true. A reference the table does not know stays as written, and a
code span keeps every character it was given — decoding happens on prose runs
only. Decoded angle brackets are still text: `&lt;tag&gt;` shows `<tag>` as
characters and creates no element.

Known and deliberate: a bare URL is not linked, and the shortcut reference
form (`[label]` alone) is not resolved — it would swallow ordinary bracketed
prose.

GFM footnotes are supported. Definitions are lifted out of the block flow
before parsing — a definition is not a paragraph wherever the agent happened
to write it — and the *references* fix both the numbering and the order,
because that is the order a reader meets them in. A reference whose
definition is missing stays literal text: inventing a marker for a note that
does not exist is the same mistake as inventing formatting. A definition
nothing referenced is still listed rather than dropped, since it is something
the agent wrote. Marks scroll within the pane rather than navigating, so they
are buttons wired to their elements — an `href="#id"` would need ids unique
across every message on screen and would move the renderer's own URL — and a
brief highlight is what says "here" when the target was already in view and
nothing scrolled.

### A local image is shown; a remote one stays a link

A markdown image carries an address written by the agent, and the two useful
answers are different for different addresses:

- **`data:`** — already trusted from structured tool results, shown directly.
- **A readable local file** — read by `main/local-image.ts` and returned as a
  `data:` URL, so what reaches the renderer is the same trusted shape.
- **Anything else** — remote, missing, outside the session's folder, or not
  actually an image — keeps the labelled link it already had.

The read happens in the main process because the renderer is a web page: it
cannot open a `file://` path, and letting it fetch an arbitrary address out of
a transcript is exactly what the conversation view avoids. The link is
rendered synchronously and *upgraded* to a picture only if the read succeeds,
so every way it can fail leaves the link that was already there — the failure
mode and the fallback are the same thing.

Three bounds, each failing to `null`:

- **Scope is the session's own folder.** The path resolves against the cwd
  from `SessionSnapshot` — never a value the message supplied — and must
  still be inside it, so a transcript cannot widen its own reach. Without
  that check, message text could make the app read any file on disk and hand
  it to the renderer. Worktrees beneath a repository are covered by the same
  prefix test the permission rules use. **This is narrower than "anywhere on
  the machine"**; a temp-dir screenshot outside the folder stays a link.
- **It must actually be an image**, decided by magic bytes rather than the
  extension, so a `.png` that is really something else is not sent. SVG is
  deliberately never inlined: it can carry script, and this is a page.
- **It must be small enough to inline** (8MB), since a data URL is base64 in
  the renderer's memory.

Resolved reads are cached, so the once-a-second repaint does not re-read a
file per image. A file that changes on disk keeps the bytes the message was
first shown with, which is the right answer for a transcript: it records what
the agent produced, not what that path holds now.

## Conversation sessions

An agent can use a structured stream rather than a PTY.
`SessionSpec.transport` is `'pty' | 'stream'`, and
a stream session has no terminal — not hidden, nonexistent. C1 no longer asks
the user to choose a transport: Claude declares `structured-conversation` and
therefore starts as a stream unless Remote Control or background hosting needs
its interactive process; the surface remains chat either way. Codex also declares this capability and
starts an owned app-server thread, without a TUI. Grok declines (no input
channel) and retains a PTY beneath the same chat UI. A shell declines
and is the one session kind whose PTY is shown.

The Claude implementation, all verified against Claude Code 2.1.252:

- **The process** is `claude --print --input-format stream-json
  --output-format stream-json --include-partial-messages --verbose`, hosted
  by `main/adapters/claude-chat.ts` over plain pipes. This is a persistent
  bidirectional protocol, not one-shot: one process answered consecutive
  turns on one session id. Input is one JSON user message per line on stdin.
  The process and its stdin belong to `sertumd`, so closing or crashing the
  Electron GUI does not end the stream session.
- **The stream is plane 2 at full width.** `system/init` names the session
  and model, `stream_event` partials drive activity (a tool's name,
  "responding", "thinking"), `result` closes the turn. Content is
  deliberately not routed from the stream into the UI: a headless session
  writes the same transcript an interactive one does, so the stage 1
  conversation view reads stream sessions with zero new code.
- **Hooks ride along.** Command hooks fire in `--print` mode —
  UserPromptSubmit, PreToolUse, PostToolUse and Stop all verified arriving
  — so the same `--settings` blob is attached and permission rules, the
  tool gate, steer and interrupt all work unchanged. Verified end to end: a
  deny rule answered a stream session's `PreToolUse` and the tool result
  carried the rule's own reason.
- **Permission questions ride the stream, not the hook.** See "A
  conversation session asks on its own channel" below: `PermissionRequest`
  does fire in print mode, but only once an approval surface exists, and by
  then the same call is already held on the control channel — so the hook is
  deliberately a no-op for these sessions.
- **Identity is chosen at spawn.** `--session-id` mints the agent-side id
  up front — the same move Grok's spawn makes — so the transcript is
  matched exactly from the first poll, before any hook has named it.
- **The registry stays one registry.** `PtyManager.registerStream` records
  the snapshot with `StreamControls` (kill/terminate) supplied by the host,
  so tab close, daemon shutdown, `ownedPids` discovery exclusion, rename, mute and
  the sidebar treat both transports identically. The manager never learns
  the chat protocol; the host never learns bookkeeping.

What a stream session gives up is what the TUI was carrying: slash commands,
plan mode, Claude's own diff and todo rendering. This is now the deliberate
Claude default; adapters without a verified structured transport retain their
PTY instead of being forced through a fictional chat protocol.

### Owned Codex conversations

`main/adapters/codex-chat.ts` owns `thread/start` and `turn/start` on the
private app-server. The response supplies the exact thread id, model and
transcript path; no cwd matching or terminal parsing is involved. The registry
records a structured session with per-thread termination controls. Closing one
thread interrupts/unsubscribes it, never kills the shared server. A dropped
connection ends the local owned handles and clears their held requests; they
are not silently revived after reconnect. Existing transcripts remain readable.
The old PTY route remains available to explicit PTY callers; its startup queue
accepts only CLI-source threads, so a structured thread cannot consume it.

App-server requests carry reply closures bound to their original connection.
Only the host owning that exact thread answers them. Command execution and
file changes use B5; file changes join the preceding item by `itemId` to show
the proposed paths and diff. `availableDecisions` limits approval scopes. A
persistent command rule sends the server-proposed amendment verbatim, after
showing it; it does not create a Sertum rule. Additional permission requests
show their exact grant and denial returns an empty grant. Stored Sertum rules
remain declined for Codex; its native session cache and command rules are the
supported policy surfaces.

`item/tool/requestUserInput` uses the question card and returns answers keyed
by question id, not the display header. Secret input uses a password control.
Withdrawal, item completion, turn completion and exit clear pending cards.
A question marked `isBlocking: false` does not change the session to needs-input.
Unsupported server requests receive an explicit protocol error instead of
hanging indefinitely. Codex's plan output remains conversation content: it has
no Claude `ExitPlanMode` approval contract here. Selecting Codex collaboration
plan mode is not implemented; the permission picker offers only the three
verified native approval policies, with the workspace sandbox retained.

`permission-mode` declarations must name their structured-conversation
dependency and supported modes in the type. `shared/session-capabilities.ts`
combines that declaration with ownership, transport and exit state, shared by
the daemon and picker. Codex's policies are distinct from Claude's permission
modes. Changing policy is restricted to an idle turn: `thread/resume` on a
loaded thread ignores overrides, so the host unsubscribes first, resumes, and
uses the returned effective policy. Failed sends keep the composer's text.

Verified on Windows with Codex CLI 0.153.1: a real file approval stayed held,
denial prevented the write, duplicate replies were refused, a policy change
was echoed, multiple turns completed, and a native question was answered by id and
acknowledged by the agent. Unsubscribe ended only the owned thread. `scripts/smoke-codex-chat.ts` retains that live probe;
`scripts/test-codex-chat.ts` covers question ids, approval scopes, cancellation,
permission denial, session isolation and late events. Questions are also verified against a live model-driven request. Additional
permission grants remain schema/fixture tested; a live grant has not been
verified yet. `scripts/smoke-codex-fabric.ts` verifies the public daemon handlers
for creation, send, pending approvals, denial, status and exact transcript
resolution under Electron’s Node runtime.

## Claude-native background hosting

This was the first implementation of sessions outliving the window and remains
as an optional Claude-specific hosting mode. General persistence now belongs
to `sertumd`: ordinary Claude, Codex, Grok and shell sessions all survive the
window closing without this capability. `background-host` instead means that the
agent's own service owns the process. Claude answers ok; Codex, Grok and shell
decline. Agents & permissions shows the option only for an adapter that
answered ok.

The flow, verified end to end on Windows: the per-agent "Use Claude’s
background host" setting makes new Claude sessions run `claude --bg -n <label>`,
which returns immediately and prints
the id that `attach`, `logs`, `stop` and `rm` take (`--bg` manages its own
session id — a passed `--session-id` is ignored with a warning, so the
printed id plus one `claude agents --json` lookup is the binding). Sertum
then opens a terminal onto it with `claude attach`, registered with origin
`attached` — a terminal that is only a client. Killing that client was
verified leaving the session running. `sertumd` now owns the attach client, so
closing or crashing the GUI does not tear down that attachment. A full Sertum
shutdown explicitly stops Claude background sessions that Sertum created;
externally imported sessions remain detach-only. After relaunch, the daemon
snapshot restores the row and the conversation view matches history by the
exact session id reported by Claude's roster.

Three things follow from origin `attached` now being real:

- **Closing an attached tab never confirms.** The confirm dialog exists to
  warn that work mid-turn dies with the process; detaching kills nothing,
  so the gate correctly does not apply (it keys on origin `owned`).
- **Status comes from the roster, not the attach client.** The monitor
  poll now sweeps attached rows too: `claude agents --json` is the daemon's
  own account of whether a session is busy, the same class of source as any
  adapter event. The attach client's PTY says nothing about the agent.
- **The transcript is matched by the roster's session id** — exact, never
  guessed by cwd — so the conversation view works on attached rows the
  same way it does everywhere else.

Claude-native background hosting still does not combine with structured stream
sessions or Remote Control; C1 keeps those choices exclusive. This limitation
does not affect broker persistence: `sertumd` owns stream processes and PTYs
for every ordinary Sertum session.

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
empty answer to a question whose ids it does not understand.

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
It holds Electron's single-instance lock, so launching Sertum again reveals
the existing window instead of creating a duplicate tray and notification
client.
Its menu is rebuilt from the GUI's daemon-fed `SessionSnapshot` mirror, so its
status labels come only from adapter events and process lifecycle — never PTY
pixels. It can reveal a session, end an owned session, or detach an externally
hosted one. Reopening recreates or shows the same disposable window. The
explicit “Quit Sertum completely…” action first requests `daemon/stop`, which
drains all daemon-owned sessions, and only then exits the tray process.

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
live shell session. Run Forge under Node 20 LTS for now: with Node 26.7.0,
Electron Packager 18.4.4 silently exits after beginning Electron archive
extraction, before package finalization or maker artifacts.

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

### The WebGL renderer must be allowed to die

A WebGL context is not the pane's to keep. Every terminal's context lives in
the one shared GPU process, so a GPU reset -- display sleep, a
discrete/integrated switch, that process being recycled -- loses all of them
at once. xterm goes on rendering into the dead addon regardless, which paints
nothing: the canvas is left with no backing store and the pane reads as a
blank rectangle with a broken-image mark in one corner, while the PTY behind
it carries on unharmed and the status bar keeps saying `adapters ok`. It
looks like every session died and is in fact only a display that stopped.

Switching the renderer setting does not rescue an open pane either, since an
addon cannot be swapped under a live terminal.

**`WebglAddon.onContextLoss` is the wrong signal, and subscribing to it alone
left the bug in place.** The addon answers `webglcontextlost` by calling
`preventDefault()` -- which asks Chromium to restore the context -- and
starting a three-second timer, then fires `onContextLoss` only if nothing was
restored before it expires. Chromium usually *does* restore, so the common
case clears that timer and `onContextLoss` never fires at all. What follows a
restore is the addon rebuilding its GL state in place, and that rebuild does
not survive the round trip: the terminal is left with a live renderer that
paints nothing, permanently.

Verified by killing the GPU process of a running packaged build with two
panes open. Both went blank and stayed blank -- through the window being
raised, focused and left alone -- while `.xterm-rows` was absent, so no
renderer was painting at all. The console carried the whole story:
`webglcontextlost` at once, `webglcontextrestored` a second later (so
`onContextLoss` never fired), then `WebGL: INVALID_OPERATION: delete: object
does not belong to this context` from the failed rebuild. Typing into a blank
pane still ran the command -- a `touch` landed from a terminal showing
nothing -- which is exactly how this reads as a frozen app rather than a
broken display.

`webglcontextlost` is therefore what `TerminalPane` listens to, since it
arrives on both branches. It does **not** bubble (verified: a listener on
`.term-host` sees it only in the capture phase), so capture is not optional.
Listening on the host element rather than the addon's canvas keeps this off
xterm's private fields and covers whatever canvas a later reload creates, and
the handler defers by a tick because disposing the addon tears down the very
canvas the event is still being delivered to. `onContextLoss` is kept as a
second subscription for the no-restore branch; both land in one idempotent
handler.

`TerminalPane` answers the loss: dispose the addon, which returns
xterm to its DOM renderer, then `refresh` the whole viewport, because that
renderer only paints what changes from here and the screen it inherits was
drawn by the addon that just died. Recovery is attempted once and waits for
the window to be visible -- the loss usually arrives while the machine is
asleep, so retrying at that moment would only fail again. A second loss means
the GPU is unreliable here, and staying on DOM beats flapping between
renderers for the rest of the session.

**On the no-restore branch the addon sits on the loss for three seconds
first**, so a pane is legitimately blank for those three seconds and any test
that samples inside that window sees nothing happen.

Verified against a live pane by taking the addon's own canvas
(`addon._renderer._canvas`) and calling `WEBGL_lose_context.loseContext()` --
note that reaching for a context on any other canvas in `.term-host` creates
a fresh one rather than finding xterm's, and killing that proves nothing:

| t | State |
|---|---|
| 0ms | context lost for real (`isContextLost()` true) |
| 500-2500ms | still on WebGL, inside the addon's grace window |
| 3300ms | `onContextLoss` fires: addon disposed, DOM renderer painting the real scrollback |
| 4200ms | the retry lands, WebGL back with three canvases |
| 7000ms | stable, and the PTY echoes new input |

Before the fix, everything from 3300ms on was a blank canvas for the life of
the app.

Note that `TerminalRenderer`'s `canvas` value names a renderer that no longer
exists: xterm dropped the canvas addon, so anything other than `webgl` simply
loads no addon and gets the DOM renderer.

### A dead helper process must not be a dead window

The pane blanking above has a louder sibling, and neither used to be
survivable or even visible: nothing in the main process was subscribed to a
child process dying. `watchForProcessDeath` in `main.ts` now is.

- **The renderer.** Verified by killing it under a running build: the window
  is left an empty rectangle painted in `backgroundColor`, answering nothing,
  and Electron never brings it back -- every tab, pane and control gone for
  good while the main process sits there healthy, still owning every PTY.
  Reloading is safe precisely because sessions live in the main process and
  the renderer re-lists them on start, so what a reload costs is pane
  scrollback and nothing else. Verified after a kill: the window comes back,
  the session is still listed, and its PTY still echoes. It reloads **once** --
  a replacement that dies too means reloading is not the answer, and a window
  left alone beats one flickering through fresh renderers all session.
- **The GPU process.** Recovered by `TerminalPane`, but silently, so
  `child-process-gone` is logged (`[sertum] GPU (GPU) gone: killed`) to make
  the cause legible afterwards.
- **Unresponsive.** Not recoverable from here; logged so it stops being
  invisible.

### Quitting drains before it exits — in the daemon, now

`disposeAll` kills every PTY, and node-pty reports each death from a
`waitpid` thread through a ThreadSafeFunction. Exiting immediately after
means those callbacks arrive while `node::FreeEnvironment` is already
running: the call into JS fails, node-addon-api turns the failure into a C++
throw, and nothing above it catches one -- `std::terminate`, SIGABRT, and a
crash report. Two such reports on this machine, identical stacks,
`Napi::ThreadSafeFunction::CallJS` under `node::Environment::CleanupHandles`
in both.

This race lives wherever the PTYs live, and since sertumd that is the
daemon: its `stop` gives the exits `QUIT_DRAIN_MS` to land in a live
environment before `process.exit`. The GUI's quit stopped being dangerous at
all -- it owns no PTYs, so `before-quit` is now a socket disconnect and
nothing more; session teardown now lives in the daemon rather than disappearing.

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

Rules answer here, at the boundary before *every* tool call, precisely because
they need no one present -- a deny rule should stop a call the agent was about
to make unprompted. A rule the user set to `ask` is the exception, and it
answers `ask`: that makes Claude raise its own dialog, which is what summons
B5's bar below. Nothing here ever waits for a person.

A rule matches on the field a person would actually write it about -- a Bash
command, an edited path -- not on the tool name, which a bare `*` still
covers.

`permission-rules` is a declared capability. Claude answers `ok`; Codex, Grok
and shell decline with reasons, so E2 can say the rules are Claude-only rather
than implying a fleet-wide policy.

## B5 holds the turn open

Everything else here answers a hook immediately. B5 does not: it holds the
HTTP response while a person looks at it. That hold *is* the feature -- it is
what lets you answer without switching to the terminal, and what lets "Always
allow" write a rule from the moment it matters -- and it is also the only
thing in Sertum that can stall an agent.

**Which event is held is the whole design.** It is `PermissionRequest`, which
Claude Code describes as firing "when a permission dialog is displayed" -- so
an arriving event is a question the agent is *already* blocked on, and holding
it costs the turn nothing it was not already paying. Answering is strictly
faster than walking over to the terminal.

It is emphatically **not** `PreToolUse`, which this was built on first and
which is a different kind of event entirely: Claude Code's own summary of it is
"before tool execution". It fires for every tool call, before and independently
of any permission check. Verified against Claude Code 2.1.251 by capturing real
payloads: `PreToolUse` arrives under `bypassPermissions`, `dontAsk`,
`acceptEdits` and `auto` alike, for calls that raise no dialog at all.

Holding it therefore meant Sertum stopped every Read, Grep and Bash the agent
was going to run unprompted, held each for up to two minutes, and captioned it
"Bash needs permission" -- a claim Claude never made. A session in auto mode,
which by definition had nothing to ask, was interrupted on every tool call.
That is exactly the crying-wolf failure the two planes exist to prevent,
arriving through Sertum's own UI rather than through parsed pixels. The lesson
generalises: *an event named for a moment in the tool lifecycle is not an event
about permission*, however convenient its position.

`permission_mode` rides on every payload and is kept as a backstop only --
`bypassPermissions` and `dontAsk` never raise a bar. It cannot be the
mechanism, because `auto` and `manual` both arrive as `default`; the event
itself is what carries the fact that a person is wanted.

Every path out of the hold answers:

| Ending | Response | Result |
|---|---|---|
| Someone chooses | `200` with the decision | the call proceeds or is refused |
| Two minutes pass | `204` empty | Claude's own dialog is still up |
| The session exits | `204` empty | nothing is left waiting |
| The client hangs up | nothing to answer | the bar comes down, unanswered |
| The app quits | released, then closed | quit is not blocked |

**The reply shape is not `PreToolUse`'s.** `PermissionRequest` nests its answer
under `decision` and spells the verdict `behavior`:
`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`,
or `{"behavior":"deny","message":"..."}`. A flat `behavior` -- the obvious
reading of the schema, and the first thing tried -- is rejected, and the
failure is silent in the direction that matters: the dialog simply stays up as
though no hook had answered. A correct answer is acknowledged in the
transcript as `Allowed by PermissionRequest hook`.

That last row was a real deadlock before it was tested. `server.close()` waits
for in-flight requests to finish, and a held approval is deliberately an
in-flight request with no response yet, so settling *after* the close
completed meant the close never completed. Pending calls are now released
before the server closes, with `closeAllConnections()` as a backstop for
keep-alive sockets that outlive their request.

**The hook command needs two deadlines, because only one event is ever held.**
Every hook but `PermissionRequest` is answered the moment it arrives and keeps
a `-m 2` ceiling, so a Sertum that stops answering never stalls a turn.
`PermissionRequest` is the call the bar holds, so its curl must outlast the
hold (`-m` = the hold plus five seconds), with `--connect-timeout 2` keeping
the fast failure where it belongs: an endpoint that is gone refuses the
connection at once. One shared `-m 2` made B5 impossible in a way that looked
like working software -- the bar appeared, curl gave up two seconds later, the
terminal filled with `hook error -- Failed with non-blocking status code: No
stderr output` (exit 28, stderr silenced by `-s`), Claude fell back to its own
dialog, and every button on the bar wrote into a socket that had already gone.
The long deadline stays off `PreToolUse` for the same reason the hold does: it
is the busiest hook of a turn and none of it is a question.

That timeout is also why the client-hangup row exists. A held call has a turn
behind it only while its connection lives, so the socket closing without an
answer -- curl's own deadline, or the user interrupting Claude -- takes the bar
down rather than leaving it asking about a turn that has ended.

**A held call is `needs-input`, not `working`.** The preceding `PreToolUse`
sets the session working, which is true of the agent and wrong about what it is
waiting for, so the dot would read working beside a bar asking for permission.
Claude said it needs a decision by firing `PermissionRequest`, so this is
plane-2 truth rather than an inference from pixels. The status returns to
`working` only when the bar is *answered*: a call that expired or was abandoned
leaves Claude's dialog on screen, where it still needs you.

Claude issues tool calls in parallel, so the bar is a queue rather than a
single slot, and it says how many are behind the one on screen. A later request
replacing an earlier one would leave a turn held open with no way to answer it
until the timeout. That parallelism is also why rules are re-consulted at
`PermissionRequest` and not merely trusted from `PreToolUse`: several calls can
pass that earlier boundary before "Always allow" writes a rule, and their
dialogs arrive after it. Re-asking lets the new rule answer them instead of
stacking more bars for a call the user has already decided.

The bar is never over the pane, because deciding means reading what led to the
request, and it is never dismissed by clicking away: every route off it
answers the call. **In a conversation it sits directly on top of the
composer** -- the question is part of the turn being read, and the answer to
it belongs where every other reply to that agent is typed. A pane that is not
a conversation keeps it at the top of the pane, above the terminal. Since
every Claude session renders as a conversation, the second placement is a
fallback: the app owns the queue and hands each conversation pane the calls
for its own session, and anything a visible conversation pane will not show
falls back to the old host above the pane, so a held turn is never invisible.

What the bar says about a call is the **subject** -- the command or the path,
in the mono face -- and never the agent's own summary of it. The subject is
the string the decision is actually about and the one "Always allow" would
write into a rule, so a gloss standing in its place ("Echo the probe marker
string" where `echo probe-marker-hello` belonged) would be asking someone to
approve something they were not shown. Underneath it goes the reason the call
escalated, which is the sentence that otherwise reaches the reader only as the
agent explaining, a turn later, that it lacked permission. Both are
producer-authored and may carry ANSI escapes, so both are stripped and set as
text.

The four choices differ only in reach. **Allow once** answers this call.
**Allow this session** is remembered in memory and dropped when the session
ends, so an approval given to one run cannot silently govern the next.
**Always allow** writes a permission rule scoped to that session's repository
and matched literally -- a rule written by pressing a button should cover what
was on screen and nothing broader; a call whose ask says a persistent rule
would reach wider than itself does not offer the button at all. **Deny**
offers an optional reason, which goes back to the agent so it can try
something else rather than guess why it was stopped.

**A held call survives the window.** The queue lives in the renderer, so a
reload, a devtools restart, or closing to the tray and reopening all lose it
-- and a conversation session's ask has no deadline behind it, so a bar lost
that way would strand the turn for good rather than merely delaying it. The
daemon answers `approval/pending` with everything it is still holding, on
both channels, and a starting window asks once. Verified by reloading the
renderer mid-hold: the bar came back with the same call and answering it
resumed the turn.

The whole feature is switchable in E2, and the switch is the presence of the
handler: with none, the hook server never holds a call at all, so turning it
off cannot leave a turn waiting on a bar that will not appear. A conversation
session is the exception, because it has nowhere else to ask: with approvals
off its calls are refused outright, carrying that as the reason.

### A conversation session asks on its own channel

A stream session has no terminal and no dialog, and that is why the reader
used to see nothing at all. Headless Claude refuses anything that would prompt
-- `no approval surface in this session; permission request denied
automatically` -- and the only trace reaching the conversation was the agent
explaining afterwards that it had lacked permission. Nothing was broken in
Sertum; there was simply no question to catch.

`--permission-prompt-tool stdio` is the declaration that a surface exists.
`stdio` names the stream itself rather than a real MCP tool: from then on the
CLI sends a `control_request` of subtype `can_use_tool` down its own stdout
and **holds the turn** until a `control_response` comes back on stdin. All
verified against Claude Code 2.1.260:

| Verified | Result |
|---|---|
| Without the flag | a Write outside the working directory is denied outright, `decision_reason_type: workingDir` |
| With it | the same call arrives as a control request carrying the input, `description`, `decision_reason` and the CLI's own `permission_suggestions` |
| Holding 25s | still accepted; there is no deadline on this wire |
| `deny` with a message | the message is the tool result the model reads, and it acts on it |
| Answering twice | the second answer is refused, since the ask is no longer held |

The reply is `{behavior:'allow', updatedInput?}` or `{behavior:'deny',
message}` -- `message` is required on a deny -- plus a
`decisionClassification`, which Sertum sets from what actually happened
(`user_temporary` / `user_reject`) rather than leaving the CLI to infer it.

Three things follow, and each is a decision rather than a detail:

- **The hook must not ask a second time.** Once a surface exists, a prompt is
  genuinely raised, so `PermissionRequest` *does* fire in print mode -- 112ms
  after the control request, in the same call. Answering both would ask the
  reader twice for one call and let the two answers disagree, a rule denying
  at the hook while the control channel had already allowed. The control
  request is the one with the turn behind it, so `HookServer` treats
  `PermissionRequest` as a no-op for any session that declared its own
  surface.
- **Nothing here expires.** The hook hold has curl's deadline behind it and
  must be released before it; a control request has only the turn, and an
  interactive Claude leaves its own dialog up indefinitely too. Answering late
  is correct. Timing out would resume a turn with a decision nobody made --
  which is also why the pending list above has to survive the window.
- **The same rules answer it.** Session-scoped allows and stored permission
  rules are consulted through one function shared with the hook boundary, so a
  rule cannot mean two different things depending on which transport asked.

### When the card is the question

The flag also makes Claude offer the tools whose approval card *is* their
user-interaction surface. Those arrive with `requires_user_interaction: true`,
and the name means it literally: the answer wanted is not "may this run" but
**which option** or **is this plan right**, neither of which an approve/deny
bar can express.

The protocol has a channel for handing such a card to a host --
`request_user_dialog`, whose kinds include `permission_ask_user_question` and
`permission_exit_plan_mode_v2` -- and **it is not wired to a stream-json host
in Claude Code 2.1.260.** The dialog transport is constructed only for the
REPL bridge, the path a session published to claude.ai uses. Verified by
declaring every relevant kind in an `initialize` control request (which is
accepted, and answers with the session's commands) and watching `can_use_tool`
arrive instead, every time. Allowing the call is not the answer either: the
tool then runs with no answer channel and returns "The user did not answer the
questions", throwing the user's choice away.

What makes the cards buildable anyway is that **`can_use_tool` already carries
the whole card** -- the questions with their options and descriptions, or the
plan as its own markdown. So `main/adapters/interactive-tools.ts` reads the
card out of the tool input, and `renderer/approval-card.ts` draws it where the
bar goes, between the transcript and the composer. Each answer goes back on
the wire that exists:

| Card | Answer | On the wire |
|---|---|---|
| `ExitPlanMode` | Approve plan | `allow` -- the tool result reads "User has approved your plan. You can now start coding" and the session leaves plan mode |
| `ExitPlanMode` | Keep planning | `deny` carrying the typed feedback; the session stays in plan mode and revises |
| `AskUserQuestion` | Send answer | `deny` carrying the choices, stated as answers |
| `AskUserQuestion` | Skip | `deny` saying the question was dismissed |

**A plan is a native fit**; a question is not, and the deny channel is used
because it is the only one that carries a message back. That is not a lie
about what happened -- the tool call genuinely did not run -- and the message
says what the user chose rather than reporting a refusal, so the agent reads
it as an answer. Verified end to end in the app: a two-question card, one
single-select and one multi-select, came back as "Indentation: Spaces /
Frameworks: React, Svelte" and the reply was "Got your answers". A plan
declined with "Also mention a Licence section" was re-presented revised, then
approved, and the session wrote the file.

Three decisions worth keeping:

- **`multiSelect` is the agent's own field**, so it picks the control rather
  than a heuristic: radios where one answer replaces another, checkboxes where
  several apply. Every question also takes free text, because a set of options
  the user disagrees with must not be a dead end -- the CLI's own card offers
  the same way out, and the tool's result format carries free text beside the
  choices.
- **A card skips the permission rules and the session-scoped allows.** A rule
  is a policy about whether a call is safe to run; it has no opinion on which
  option a person would pick or whether a plan is right, and a stale `allow`
  silently approving every plan is precisely the answer-nobody-gave this
  surface exists to prevent. For the same reason a card never offers "Always
  allow", and the session's activity line reads "waiting on your answer" or
  "review the plan" rather than "approve X?".
- **`ApprovalAnswer.decision` has a third word, `answer`**, so the vocabulary
  keeps a card's outcome apart from a refusal even though they share a wire.
  It never writes a rule, and the activity line afterwards says "answered".

Anything else marked `requires_user_interaction` has a card whose shape Sertum
does not know, so it keeps the honest refusal naming that limitation. The
plan is rendered by `appendMessageText`, the transcript's own renderer, under
the same promise: nothing is assembled as an HTML string.

### The permission mode is a setting, and it is set beside the composer

How much of a session you are asked about at all is decided before any of the
above: the permission mode. `set_permission_mode` is a stable control request
the *host* sends, and the CLI answers with the mode now in effect — so what is
recorded is what happened, never what was asked for. Verified against Claude
Code 2.1.260:

| Sent | Result |
|---|---|
| `plan`, `acceptEdits`, `dontAsk`, `auto`, `default` | accepted, echoed back |
| `manual` | accepted, normalises to `default` — the CLI flag's name for one mode, the protocol's for the other |
| `bypassPermissions` | refused: "the session was not launched with --dangerously-skip-permissions" |
| anything else | refused, naming the valid modes |

Behaviour was checked rather than assumed, by setting a mode and then asking
for a file: `acceptEdits` wrote it with no ask, `default` raised one, and
`plan` produced a plan and an `ExitPlanMode` card instead of a write.

- **The current mode is read, never assumed.** `system/init` carries
  `permissionMode`, which is the user's own `defaultMode` setting unless
  something changed it, and every accepted change echoes the resulting mode.
  `SessionSnapshot.permissionMode` is null until the agent has said, and null
  is deliberately not drawn as "Manual" — that would put a word on screen the
  agent never used. The mode arrives with the session's first turn.
- **The control lives beside the composer**, because the mode decides how much
  of the session you are asked about and the asking happens there — which is
  also where Claude Code keeps its own. It is a chip showing the current mode;
  clicking it opens the catalogue in `renderer/permission-mode.ts`, which is
  the single list every surface reads. The sidebar row menu offers the same
  picker for reaching it without bringing the pane forward.
- **`permission-mode` is a declared capability**, answered `ok` by Claude and
  declined with a reason by Codex, Grok and shell. The agent-level answer is
  not the whole story, though: only a conversation session has a channel to
  say it on, so a PTY-backed Claude session gets the chip disabled saying the
  mode is set there with Shift+Tab — which is a truer answer than hiding it,
  since "where is this set?" is exactly the question that session raises.
  `bypassPermissions` is listed the same way, disabled carrying the reason,
  rather than as a row that reports an error when pressed.

Setting the mode at spawn is deliberately not offered in C1: the control works
the moment a session exists, so a second place to choose it would be a second
thing to keep in step. `MenuItem` gained `note` and `checked` for this, and
the row menu's disabled items moved their reasons from the right-aligned
accel slot — sized for a chord — onto that second line.

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
  scrollback survives every layout change; a chat pane is likewise reused.

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
  error vanish. Settings > Agents & permissions (Detect / Browse... / a manual per-agent
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
  whenever `MAIN_WINDOW_VITE_DEV_SERVER_URL` is set (i.e., only in dev) --
  which turns out to fix the title bar and *not* the taskbar, see below.
- **The taskbar reads an id, not the window's icon.** The `icon:` override
  above is genuinely applied -- verified by asking the live window for it
  (`WM_GETICON`), which answers Sertum's mark in dev -- and the title bar draws
  it. The taskbar button ignored it and went on showing Electron's atom,
  because Windows resolves that button's icon through the window's Application
  User Model ID, and with no explicit id the shell derives one from the host
  executable, which in dev is `electron.exe`. `app.setAppUserModelId` in
  `main.ts` claims an id of our own and the button falls back to the window
  icon; verified by capturing the real taskbar before and after. The dev id
  includes the main-process pid so Windows cannot reuse an `electron.exe`
  icon cached for an older dev run; packaged identity remains stable.

  Two details worth keeping. A packaged build needs none of this: its window
  sets no icon at all (`WM_GETICON` answers 0) and both surfaces read the
  executable's own resource, verified against `out/Sertum-win32-x64`. And the
  id stays dev-only rather than being claimed everywhere, because Windows
  matches a toast notification to the Start Menu shortcut bearing the sender's
  id -- Squirrel installs one carrying `com.squirrel.Sertum.Sertum`, so
  overriding the id in a packaged build would trade a taskbar icon that is
  already correct for C20's notifications quietly not arriving.

  Note that the taskbar is invisible to `Graphics.CopyFromScreen`, which
  returns whatever window sits under it; `PrintWindow(hwnd, hdc, 2)` on
  `Shell_TrayWnd` captures it for real. Two screenshots that showed no taskbar
  at all read as a capture failure rather than as the wrong API.
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
  which image is embedded; run the installer to check that. Verified by
  running a real `Sertum-1.0.0 Setup.exe`: the install screen shows our
  spinner, not the placeholder.
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
- **Closing the window hides it to the tray on every platform.** The Electron
  process remains the notification and tray client, while `sertumd` continues
  to own the hook server, adapters and sessions. Only the explicit “Quit
  Sertum completely…” path stops the daemon and its owned sessions.
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

### Windows development launch privileges

Run the development app and broker at the desktop user's normal privilege
level. During Windows testing, Print Screen reached ShareX on the desktop but
failed with Sertum focused while Sertum and sertumd were elevated and ShareX
was not. Relaunching both with a limited interactive token removes that
privilege mismatch; the user verified Print Screen works with Sertum focused
after that relaunch. An elevated
launcher can pass elevation through a `Shell.Application` launch too, so verify
the resulting process tokens rather than assuming that route de-elevates them.

## Layout

```
SertumDesigns.pen             Design source of truth — wireframes, storyboards
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
  main/clipboard-paste.ts     Clipboard reads for paste; images spilled to disk
  main/worktrees.ts           Worktree inventory, provisioning, removal (C9)
  main/diff-review.ts         Git-backed changes, discard and commit (C11, C15)
  main/pull-request.ts        Pull requests through the GitHub CLI (C16)
  main/notifications.ts       System notifications from adapter events (C20, E5)
  main/permission-rules.ts    Stored allow/deny/ask rules for tool calls (E2)
  main/keybindings.ts         Command registry behind the menu accelerators (E6)
  main/local-image.ts         Reads an image a message points at, inside the session folder
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
  main/adapters/conversation.ts  Transcript parsed into conversation items (chat view)
  main/adapters/markdown-format.ts  Is a message markdown, and is the markup the answer?
  main/adapters/interactive-tools.ts  Cards read from a tool's own input, and how each answer gets back
  main/adapters/claude-chat.ts   Headless Claude over stream-json (conversation sessions)
  main/adapters/window-focus.ts  Raise the OS window owning a session
  preload.ts                  contextBridge API surface
  shared/types.ts             Contracts shared across processes
  renderer/app.ts             Shell: tabs, sidebar, pane, status bar
  renderer/terminal-pane.ts   One xterm bound to one PTY
  renderer/chat-pane.ts       A session as a conversation; composer uses its declared transport
  renderer/message-text.ts    Message text to DOM: markdown or source, never an HTML string
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
  renderer/diff-review-dialog.ts  Changes review — wireframe C11
  renderer/commit-dialog.ts       Commit & push sheet — wireframe C15
  renderer/pull-request-dialog.ts Open pull request — wireframe C16
  renderer/approval-bar.ts        Tool-call approval bar, above the composer — wireframe B5
  renderer/approval-card.ts       Question and plan cards, when allow/deny is not the question
  renderer/permission-mode.ts     The mode catalogue and its picker (plan, auto, accept edits…)
scripts/
  smoke-pty.js                Headless PTY test
  smoke-chat-permission.ts    A conversation session's permission ask, held and answered
  drive.js                    CDP driver for headless verification
```
