# Conversation sessions, and resuming them

Part of [Sertum's technical guide](../AGENTS.md), which states the rules this
file records the evidence for. Keep verified detail here and the invariant
there.

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
  conversation session asks on its own channel" in
  [approvals.md](approvals.md): `PermissionRequest`
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

## Owned Codex conversations

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
modes. Applying a policy change requires an idle turn: `thread/resume` on a
loaded thread ignores overrides, so the host unsubscribes first, resumes, and
uses the returned effective policy. Failed sends keep the composer's text.

That idle requirement used to mean an outright refusal -- "Finish or stop
the current turn before changing its policy" -- however long the turn ran,
which read as the picker simply not working. `CodexChatHost` now queues the
request instead: a mode asked for while `busy` is stashed as `pendingMode`
and applied the instant `turn/completed` lands. A later ask while one is
already queued simply overwrites it -- only the mode you actually land on
when the turn ends is meaningful, the same as retyping over an unsent draft.
`PermissionModeResult` carries a `queued` flag for exactly this reply,
distinct from both an applied change and a refusal. The daemon must not publish
that queued mode as effective session metadata; the composer note under
the mode chip is the only place a queued change is visible until
`mode-applied` lands and the chip repaints from the snapshot like any other
mode change. A failure applying the queued mode reaches the session as an
activity string rather than silently vanishing, the same pattern turn-steer
and turn-interrupt failures already follow.

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

`CodexChatHost.send` reports `working` optimistically, the moment a turn is
requested, rather than waiting on the app server's own `turn/started` /
`thread/status/changed` notifications -- the same pattern `ClaudeChatHost`
already used. Found via a real GUI click-through of `session-resume`:
those notifications are a separate async frame that landed up to ~90ms after
`turn/start`'s own response, verified with raw notification logging, leaving
a real window where a turn had genuinely begun but the session still read
`idle`. That window is invisible in the UI, which only ever polls once a
second, but it is exactly what `scripts/smoke-resume.ts`'s `waitIdle` helper
raced: it checked status *before* ever sleeping, so it could observe the
stale `idle`, declare a turn that had just started already finished, and
let the harness's own `fabric.shutdown()` kill the codex app server
mid-turn -- which is why a resumed session's second turn was seen answering
with its *first* turn's stale reply. Fixed on both sides: `send` emits the
optimistic status (the real notification supersedes it the instant it
lands, same as the interrupt path's optimistic label), and `waitIdle` now
sleeps before its first check.

## Resuming a previous session

`session-resume` starts a brand-new process bound to a past conversation's
own id, so the agent continues exactly where it left off instead of
beginning blank. It is declared like every other capability -- Claude and
Codex answer `ok` with `requires: 'structured-conversation'`, since there is
no PTY state to resume into, only a transcript; Grok and shell decline, the
former because its CLI has no way to resume a session by id at all.

Both mechanisms were verified live against the installed CLIs rather than
assumed from `--help` text:

- **Claude**: `claude --resume <id>` in place of `--session-id <id>` on the
  same `--print --input-format stream-json --output-format stream-json`
  invocation `createConversationSession` already builds. Verified against
  Claude Code 2.1.263 end to end: a first turn taught a session a secret
  value under a fresh `--session-id`; a wholly separate process, given only
  `--resume <that id>`, answered a follow-up turn with the secret correctly
  and `system/init` echoed the same session id back. The transcript file
  grew from 12 lines to 19 across the two processes -- one continuous file,
  not two -- which is also why the conversation view needs no changes at
  all to show a resumed session's earlier turns: `transcriptFor` already
  matches by exact session id.
- **Codex**: `thread/resume` needs nothing but a `threadId` -- verified
  against Codex CLI 0.153.4 by starting a thread on one app-server process,
  killing that process's entire tree (not just the client connection), and
  resuming the same id from a brand-new server that had never seen it: the
  resumed thread answered a follow-up turn with full context from before
  that process existed. `thread/list` with a `cwd` filter finds such threads
  purely from what is on disk, with no live process or pid involved, which
  is what makes it usable here where the same call was rejected for live
  discovery (see "Discovery is agent-agnostic by construction" in
  [../AGENTS.md](../AGENTS.md)) --
  that rejection was specifically about attributing a *pid* to a `notLoaded`
  thread, a problem resuming never has because it does not need one.
  `CodexThread` gained `parentThreadId` so `resumableThread` can exclude
  AgentControl sub-agent threads the same way `isUserThread` already excludes
  the throwaway title-generation thread.

Listing past sessions is therefore two genuinely different reads, one per
agent, both landing on the shared `ResumableSession` shape: Codex's comes
from its own roster (`CodexChatHost.listResumable`, wrapping `thread/list`);
Claude has no roster API, so `listResumableClaudeSessions` enumerates
`~/.claude/projects/<cwd-hash>/*.jsonl` directly -- the same directory
`findClaudeTranscript` already reads, scoped to one folder for the same
reason every session-creation surface in this app asks for a folder first.
A session already live in Sertum is filtered out of the list before it
reaches the dialog: resuming it a second time would race the copy already
running for the same id, which is exactly what Codex's own "already has an
active writer" refusal was verified to say when that race was tried
deliberately.

The resume dialog (`renderer/resume-dialog.ts`) mirrors C18's adopt dialog's
list-of-rows shape but reads past conversations instead of live processes,
and mirrors C1's own convention of asking for a working folder first with
the same folder field, Browse button and recents. Picking a row performs the
resume itself and reports a failure inline, the same convention C1 uses for
a failed spawn, rather than closing and losing the choice.

## A resumed Claude process needs a moment before its first turn

Sending a message the instant a `--resume`d process spawns is not safe, and
this was found and fixed by driving the real CLI rather than trusting that
`--resume` behaves like `--session-id` with older history attached. Verified
against Claude Code 2.1.263: a message written to stdin immediately after
spawn came back `"No response requested."` — a real reply, not an error, so
nothing in the transport looked broken — while the identical message held
back for `RESUME_SETTLE_MS` (2000ms) answered correctly and recalled the
earlier turn.

Two mechanisms that look like the obvious fix were tried and verified wrong
before this one, and both are worth naming so they are not tried again:

- **Gating the first send on `system/init`, unconditionally.** This
  deadlocked a *fresh* session outright: driving a real spawn with the send
  withheld showed the process staying completely silent, because `system/init`
  is emitted as part of *beginning* a turn ("Init opens every turn") and a
  turn cannot begin without input already sent. Withholding input to wait for
  a signal that only input produces is a real deadlock, not a race that
  usually resolves.
- **Gating the first send on `system/init`, scoped to only a resumed
  process.** This does not deadlock, but it does not work either: driving a
  real `--resume` spawn with the send withheld showed the same silence for
  60+ seconds, proving `init` needs a turn to open for a resumed process too
  -- there is no independent "history finished loading" event to wait on.

What actually discriminates the working case from the broken one is real
wall-clock time since spawn, not any observable event, which is why
`ClaudeChatHost.awaitingResumeSettle` is a plain timer: `spawn` starts it
only when `resuming` is passed, `send` queues into it while it is pending,
and its callback flushes the queue in order once it fires. An ordinary fresh
spawn never sets it at all, so the fix changes nothing about the path that
already worked.

This uncovered a second, independent bug already present before resume
existed: `SessionStart`'s hook payload carries a `source` field --
`"startup"`, `"resume"`, `"clear"`, `"compact"` -- verified with a raw hook
capture, and `mapClaudeHook` was mapping every `SessionStart` to
`{status: 'idle', activity: 'ready'}` regardless of which. That is correct
for `"startup"`, where nothing has happened yet, but a resumed session's
`SessionStart:resume` hook can land *after* `chat/send`'s own optimistic
`{status: 'working', activity: 'thinking'}` -- verified by capturing the
exact interleaving -- silently overwriting a turn that has genuinely begun
with a stale "ready". `mapClaudeHook` now reports nothing (`{}`) for every
`source` but `"startup"`, letting the turn's own lifecycle stay the only
authority on whether one is running, the same rule every other event in that
function already follows.

A third, unrelated finding from the same live testing: Claude's own
`~/.claude/projects/` directory name replaces `.` in the cwd exactly like
`/`, `\` and `:` -- one dash per character, never collapsed -- which
`claudeProjectDirName` now matches. Missing this made a dotted working
folder (a `.temp` scratch directory, in the case that surfaced it) silently
show no past Claude sessions at all, since `listResumableClaudeSessions` has
nothing but that directory name to go on.

Codex needed no equivalent settle delay -- verified by resuming a thread and
calling `turn/start` in the same tick, which answered correctly -- but
`thread/list` itself has a brief indexing lag after a thread is created, so
a session resumed within about a second of being created may not appear in
`session/resumable` yet. This does not matter in practice: the dialog lists
sessions that have already been sitting closed, not ones from the last
second, and `scripts/smoke-resume.ts` polls past the lag rather than
assuming it away.

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
