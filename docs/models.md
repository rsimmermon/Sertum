# Switching models and thinking levels mid-session

Part of [Sertum's technical guide](../AGENTS.md), which states the rules this
file records the evidence for. Keep verified detail here and the invariant
there.

Which model a session runs is the other half of the pair the permission mode
belongs to: both decide how a turn goes, both are asked about where the turn
is composed, and both are reached from the sidebar row menu as well. So
`model-select` is deliberately built as `permission-mode`'s twin — same chip,
same picker shape, same "declined is an answer" rule — and the two chips sit
together under the composer.

**The list is never Sertum's.** A hardcoded catalogue goes stale the week a
model ships and offers models an account cannot run, so every implementation
asks the agent, per session, each time the picker opens:

| Agent | Catalogue | Switch |
|---|---|---|
| Claude | `list_models` control request on the session's own stream | `set_model` control request |
| Codex | `model/list` on the app server | `model` override on the next `turn/start` |
| Grok | `~/.grok/models_cache.json`, which its own CLI fetched | `/model <id>` on its own prompt |

That per-session fetch is why the picker is the one popup here that opens
twice: once saying it is reading, again with the answer. Claude answers in
milliseconds; Codex's `model/list` goes to its app server and was measured at
~1.9s cold, and a chip that appears to do nothing for two seconds reads as
broken. `openSessionMenu` returns its element and `isSessionMenuOpen` tests
it, so a menu the reader dismissed while the fetch was in flight is not put
back.

**A running turn keeps the model it started with**, on all three, verified
rather than assumed — so `ModelChangeResult.appliesToNextTurn` says so under
the composer when a turn was actually in flight, and says nothing on an idle
session, where "from the next turn" is simply what changing the model means.

**The model recorded is the resolved one.** `SessionSnapshot.model` has always
meant "the model this session runs" rather than "the model the last turn
used" — it is seeded from the agent's own configuration before any turn has
happened — so a successful switch writes to it immediately. Claude's
catalogue resolves an alias for us (`default` and `opus[1m]` both resolve to
`claude-opus-5[1m]`), and recording the resolved name rather than the alias is
what stops the chip changing again under the reader when the next turn reports
the concrete id. The agent's own reports keep superseding it either way: a
Claude turn's `system/init`, a Grok `turn_started`, and the 4s transcript meta
poll for all three.

A model is only ever sent if the session's own agent just listed it. The
renderer cannot name one of its own, so a picker left open while an account
changed cannot ask for a model that is gone.

## What each agent actually does

- **Claude**, verified against Claude Code 2.1.266. `list_models` is a control
  request like `set_permission_mode` and answers before any turn has opened,
  with the id to send in `value` and the model it resolves to in
  `resolvedModel`. `set_model` takes that `value` and answers success with
  **no payload at all** — unlike `set_permission_mode` there is nothing echoed
  to read the result off, which is why the resolved name is looked up in the
  same catalogue the picker was built from. An unrecognised id is refused by
  name (`Model "not-a-model" is not a recognized model id. Run /model to see
  available models.`) and that sentence is worth showing. Sent 60ms into a
  turn that then ran for another 55 seconds it was still accepted immediately;
  the running turn stayed on `claude-opus-5` and the *next* turn's
  `system/init` reported `claude-sonnet-5`. `model: null` resets to the
  default.
- **Codex**, verified against Codex CLI 0.153.4. `turn/start` carries a `model`
  override documented as applying "for this turn and subsequent turns", so the
  switch is stashed on the host and sent from then on. `model/rerouted` is honoured when it arrives: the
  server moving a turn to another model is its own account of what is running
  and outranks what was asked for.
- **Grok**, verified against Grok 1.0.13 in a real PTY. Grok has no control
  channel — no `--settings` endpoint, no app server, and an event log that is
  strictly read-only — but it has `/model <name> [effort]` on its own prompt.
  The switch goes down the one input channel the session has, which is the
  same channel the composer already writes every message to. **This is not the
  synthesized-keystroke move `turn-interrupt` refuses**: nothing stands in for
  a control plane by pretending to be a chord; it is Grok's own published
  command sent as the text it is, and the two writes with 150ms between them
  are the composer's own sequence for the composer's own reason. The session
  answered "Switched to Grok 4.6 (low effort)" and its footer changed.

  Two things were checked because guessing either would have been wrong. The
  effort argument is **omitted**: `/model grok-4.6` after `/model grok-4.6
  low` left the session on low, so a bare switch preserves the reasoning
  effort rather than silently resetting it. And **nothing is written to
  `events.jsonl` at the moment of the switch** — the log stayed at its four
  MCP startup records — so there is no acknowledgement to wait on; which model
  the session is on is reported by plane 2 the ordinary way, on the next
  `turn_started`.

Unlike `permission-mode`, this capability is not structured-transport-bound by
nature — it depends on where the agent keeps the control. Claude and Codex
declare `requires: 'structured-conversation'` because a PTY-backed session's
stream belongs to its TUI; Grok declares no requirement at all, because a
prompt is exactly the transport it has.

## How you know it took

A switch used to be silent on exactly the session where it is most often
made. `ModelChangeResult.appliesToNextTurn` is false on an idle session — a
brand-new one always is — and the composer note only fired when it was true,
so the ordinary case wrote nothing at all. The only remaining evidence was
the chip, and the chip could not carry it either: it showed
`SessionSnapshot.model`, a slug the reader had never seen (they clicked
"Opus 5" and the chip said `claude-opus-5[1m]`), capped at `max-width: 42%`
with an ellipsis, so two ids sharing a prefix rendered identically. Doing
something and saying nothing reads as doing nothing.

Three things now answer "did that work", and each is the agent's own word
rather than an echo of the request:

- **The composer says so.** `Now running Opus 5.` under the box you type in,
  cleared after `NOTE_FADE_MS` because a confirmation has done its job the
  moment it is read. A refusal has no timer — it is the answer to something
  that did not happen, and has to still be there when the reader looks up.
- **The chip uses the agent's own name for it.** `SessionSnapshot.modelLabel`
  carries the display name off the catalogue row the switch came from, so the
  chip says the words that were clicked and the tooltip carries both names. It
  is not a field of its own: it travels with `model` and is dropped whenever
  the slug moves without one, since a friendly name left attached to a
  different slug is a claim the agent never made.
- **The catalogue reports what the session is on.** `AgentModelList.current`
  and `AgentEffortList.current`, applied to the snapshot when the picker reads
  them. This is what a session with no turns behind it could not say before:
  Claude's `get_settings` answers `applied.model` and `applied.effort`
  immediately, while the snapshot is otherwise seeded from a transcript that
  does not exist yet. Opening the picker is the first moment such a session
  can be asked, so the tick lands on the right row and the chip stops reading
  "Model".

And the caret comes back. `openSessionMenu` focuses its first item, which is
what makes the arrow keys work; nothing handed focus back when the menu
closed, and `focusActivePane` refocuses only when the pane it should be in has
*changed* — which setting a chip on the session you are already looking at
never does. So the composer was left unfocused and the next keystroke went
nowhere. Worse, the document-level capturing `mousedown` handler that
dismisses the menu was removed only by a dismissing click, so *choosing* an
item left it behind: the next click anywhere in the app hit a detached menu,
was swallowed by that handler's `preventDefault`, and only the click after it
reached the composer. Both are fixed in `session-menu.ts` — every close path
runs through `closeMenu`, which releases the handlers and returns focus to
whatever had it — and a chip pick additionally puts the caret in the composer,
because what someone does after choosing how a turn runs is type the turn.

## Thinking level

`thinking-level` is `model-select`'s twin for the same reason `model-select`
is `permission-mode`'s: what a turn runs on and how hard it reasons are the
pair that decide how a turn goes, so they are asked about in the same place,
in the same shape, under the same rules. The three chips sit together under
the composer.

**The ladder is never Sertum's either**, and it belongs to a *model* rather
than to an account — which levels exist depends on which model is answering:

| Agent | Catalogue | Switch |
|---|---|---|
| Claude | `supportedEffortLevels` on each `list_models` row | `apply_flag_settings { effortLevel }`, then read back |
| Codex | `supportedReasoningEfforts` on each `model/list` row | `effort` override on the next `turn/start` |
| Grok | `reasoning_efforts` on each model in `models_cache.json` | `/model <id> <effort>` on its own prompt |

- **Claude**, verified against Claude Code 2.1.266. Every catalogue row
  carries `supportedEffortLevels` — `low,medium,high,xhigh,max` on `default`,
  `opus[1m]`, `claude-fable-5-1[1m]` and `sonnet`, and nothing at all on
  `haiku`, which is why the ladder is read from the row for the model this
  session is on rather than from the catalogue as a whole.

  There is no `set_effort` control request. The full subtype list is
  `set_model`, `set_permission_mode`, `interrupt`, `stop_task`,
  `background_tasks`, `set_max_thinking_tokens`, `rename_session`,
  `set_color`, `mcp_authenticate`, `mcp_oauth_callback_url`, `mcp_reconnect`,
  `apply_flag_settings`, `side_question` and `reload_plugins`. The one that
  looks right is not: `set_max_thinking_tokens` takes an integer budget, and
  per Claude's own description a numeric budget means *no* effort parameter is
  sent at all — the two are alternatives rather than two spellings of one
  setting. The one that works is `apply_flag_settings`, which merges into the
  session-scoped flag layer, and **the key is `effortLevel`, not `effort`** —
  the first moved the level, the second was accepted and did nothing.

  **The read-back is load-bearing.** `apply_flag_settings { effortLevel:
  "bogus" }` answered `{"subtype":"success"}` and left the level exactly where
  it was: accepted and ignored, the same silent-no-op failure the `http` hook
  type taught this project to check for. So `setEffort` reads
  `get_settings().applied.effort` before and after, and reports an unchanged
  level as a refusal rather than as the success it was handed. `applied` is
  read rather than `effective` because the two disagree whenever a level is
  downgraded, and the one worth showing is the one Claude says it "will send
  on its next request — after env overrides, session state, org caps and
  model-support downgrades".

  `supportsAdaptiveThinking` is real on these rows and is deliberately not
  offered: there is no verified way to *select* adaptive over this channel,
  and a row that does nothing is worse than no row.
- **Codex**, verified against the generated app-server schema of Codex CLI
  0.153.4. `turn/start` carries an `effort` field documented as overriding
  "for this turn and subsequent turns" — `model`'s twin, down to the wording —
  so it is stashed on the host and sent from then on, with all the same
  properties: no idle thread needed, no reload, and it works on a thread that
  has never taken a turn. Each `model/list` row carries
  `supportedReasoningEfforts` (a `{reasoningEffort, description}` per rung)
  beside a `defaultReasoningEffort`, which is what a thread with no override
  actually runs at and therefore what `current` reports.
- **Grok**, from the same file and the same command as its model switch. Each
  cached model carries `supports_reasoning_effort` and, when true, a
  `reasoning_efforts` array of `{id, value, label, description, default}` —
  Grok's own words, fetched by its own CLI. The switch is the effort argument
  `setModel` deliberately omits, sent alongside the model the session is
  already on. That is also its one precondition: with no model reported there
  is no command to write, and naming one here would switch the model as a side
  effect of setting the level, so the adapter declines with that reason until
  plane 2 names a model on `turn_started`.

`scripts/smoke-effort-switch.ts` drives the public daemon handlers the way
`smoke-model-switch.ts` does. The Claude and Codex legs pass end to end: the
catalogue comes back (`low, medium, high, xhigh, max` on both), the session
moves off the level `current` reported (`xhigh` to `low` on Claude, `medium`
to `low` on Codex), an unlisted level is refused, and the level survives a
real turn and two 4s transcript polls. The Grok leg reads its ladder and
confirms the command reaches a live PTY, and skips when the session has not
named a model yet — which is what it does before its first turn, so that leg
is currently the unproven one.

`scripts/smoke-model-switch.ts` drives the public daemon handlers for all
three. The Claude and Codex legs switch models on a live session, refuse an
unlisted model, run a real turn, and then wait out two 4s transcript polls
before asserting — the poll re-reads the model from the agent's own
transcript and would put the old one back if the turn had actually run on it,
so surviving it is the agent agreeing rather than Sertum repeating itself.
Both pass. The Grok leg reads its catalogue and confirms the command reaches
a live PTY; it deliberately does not drive a turn, and the account it ran
against offers a single model, so a *change* through the fabric is not covered
there — the direct PTY probe above is what covers that.
