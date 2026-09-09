# Switching models mid-session

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
  switch is stashed on the host and sent from then on. This is deliberately
  *not* the `thread/unsubscribe` + `thread/resume` dance `setPermissionMode`
  has to perform: it needs no idle thread, has no window in which the thread is
  unowned, and works on a thread that has never taken a turn — which resume
  does not, since `thread/resume` on a brand-new thread answers `no rollout
  found for thread id`. `model/rerouted` is honoured when it arrives: the
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
