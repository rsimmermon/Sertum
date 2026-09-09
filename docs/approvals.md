# Approvals: rules, the bar, and the cards

Part of [Sertum's technical guide](../AGENTS.md), which states the rules this
file records the evidence for. Keep verified detail here and the invariant
there.

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
it costs the turn nothing it was not already paying.

It is emphatically **not** `PreToolUse`, which this was built on first:
"before tool execution", firing for every tool call, before and independently
of any permission check. Verified against Claude Code 2.1.251 by capturing
real payloads: it arrives under `bypassPermissions`, `dontAsk`, `acceptEdits`
and `auto` alike, for calls that raise no dialog at all. Holding it meant
Sertum stopped every Read, Grep and Bash the agent was going to run
unprompted, held each for up to two minutes, and captioned it "Bash needs
permission" -- a claim Claude never made, and on a session in auto mode, which
by definition had nothing to ask. That is the crying-wolf failure the two
planes exist to prevent, arriving through Sertum's own UI rather than through
parsed pixels. The lesson generalises: *an event named for a moment in the
tool lifecycle is not an event about permission*, however convenient its
position.

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
reading of the schema -- is rejected, and silently in the direction that
matters: the dialog simply stays up as though no hook had answered. A correct
answer is acknowledged in the transcript as `Allowed by PermissionRequest
hook`.

The quit row was a real deadlock before it was tested. `server.close()` waits
for in-flight requests, and a held approval is deliberately one with no
response yet, so settling *after* the close completed meant it never
completed. Pending calls are released before the server closes, with
`closeAllConnections()` as a backstop for keep-alive sockets that outlive
their request.

**The hook command needs two deadlines, because only one event is ever held.**
Every hook but `PermissionRequest` is answered on arrival and keeps a `-m 2`
ceiling, so a Sertum that stops answering never stalls a turn.
`PermissionRequest`'s curl must outlast the hold (`-m` = the hold plus five
seconds), with `--connect-timeout 2` keeping the fast failure where it
belongs. One shared `-m 2` made B5 impossible in a way that looked like
working software: the bar appeared, curl gave up two seconds later, the
terminal filled with `hook error -- Failed with non-blocking status code: No
stderr output` (exit 28, stderr silenced by `-s`), Claude fell back to its own
dialog, and every button wrote into a socket that had already gone. The long
deadline stays off `PreToolUse` for the same reason the hold does.

That timeout is also why the client-hangup row exists. A held call has a turn
behind it only while its connection lives, so the socket closing without an
answer -- curl's deadline, or the user interrupting Claude -- takes the bar
down rather than leaving it asking about a turn that has ended.

**A held call is `needs-input`, not `working`.** The preceding `PreToolUse`
sets the session working, which is true of the agent and wrong about what it
is waiting for. Claude said it needs a decision by firing
`PermissionRequest`, so this is plane-2 truth rather than an inference from
pixels. The status returns to `working` only when the bar is *answered*: a
call that expired or was abandoned leaves Claude's dialog on screen, where it
still needs you.

Claude issues tool calls in parallel, so the bar is a queue rather than a
single slot, and it says how many are behind the one on screen -- a later
request replacing an earlier one would leave a turn held open with no way to
answer it until the timeout. That parallelism is also why rules are
re-consulted at `PermissionRequest` rather than trusted from `PreToolUse`:
several calls can pass that earlier boundary before "Always allow" writes a
rule, and their dialogs arrive after it, so re-asking lets the new rule answer
them instead of stacking more bars for a call already decided.

The bar is never over the pane, because deciding means reading what led to the
request, and it is never dismissed by clicking away: every route off it
answers the call. **In a conversation it sits directly on top of the
composer** -- the question is part of the turn being read, and the answer
belongs where every other reply to that agent is typed. A pane that is not a
conversation keeps it at the top of the pane. Since every Claude session
renders as a conversation, that placement is a fallback: the app owns the
queue and hands each conversation pane its own session's calls, and anything a
visible conversation pane will not show falls back to the host above the pane,
so a held turn is never invisible.

What the bar says about a call is the **subject** -- the command or the path,
in the mono face -- and never the agent's own summary of it. The subject is
the string the decision is actually about and the one "Always allow" would
write into a rule, so a gloss standing in its place ("Echo the probe marker
string" where `echo probe-marker-hello` belonged) would be asking someone to
approve something they were not shown. Underneath goes the reason the call
escalated, which otherwise reaches the reader only as the agent explaining, a
turn later, that it lacked permission. Both are producer-authored and may
carry ANSI escapes, so both are stripped and set as text.

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
that way would strand the turn for good. The daemon answers
`approval/pending` with everything it is still holding, on both channels, and
a starting window asks once. Verified by reloading the renderer mid-hold: the
bar came back with the same call and answering it resumed the turn.

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
