# Handoff: a broker, a daemon, and a chat UI

**Status: exploration, not a decision.** This records a design conversation
so the next person -- or the next agent -- starts from the conclusions rather
than re-deriving them. `AGENTS.md` stays the canonical description of what
Sertum *is*; this describes a direction it could take and what that would
cost.

**Update, later the same day: stages 1 and 2 of section 6 are built, and
stage 3's Claude-only first cut (section 4's "shortcut for Claude only") is
too.** The transcript-rendered conversation view exists, verified end to end
against live Claude sessions (owned and monitored) and against real Codex
and Grok transcripts. Conversation sessions exist for Claude -- a `stream`
transport carried by a headless `--input-format stream-json` process, with
hooks (and therefore permission rules, the tool gate, steer and interrupt)
verified working in print mode. And sessions can now outlive the window
through Claude's own daemon: a C1 toggle starts them with `--bg`, Sertum
holds only an attach client, and a session was verified surviving Sertum
being force-killed, then reattached with terminal and history after
relaunch. `AGENTS.md` ("The conversation view", "Conversation sessions",
"Sessions that outlive the window") describes all three.

Still unbuilt: Codex conversation sessions (the capability declines with
that reason), the Sertum daemon itself -- the uneven cut leans on Claude's
-- and stage 4. Of section 8's questions, three are now partly answered: a
PTY composer accepts a bracketed paste with a separately-delivered CR (a
single burst is swallowed); Claude's stream-json input accepts text content
blocks (images unprobed); and a `--bg` session costs nothing in fidelity
that these tests exposed -- the attach client renders the full TUI, and the
roster supplies live status.

Recorded 2026-09-01 against Claude Code 2.1.252, codex-cli 0.150.1,
Electron 44.

The question that started it: **could Sertum stop looking like a terminal
multiplexer and start looking like the Claude and Codex desktop apps -- a chat
transcript with a composer under it -- while still running several agents at
once?**

The short answer is yes, and the hard part is not the chat view. It is that
sessions must outlive the window.

---

## 1. Remote Control is a broker, not discovery

This came up first and is worth recording because the intuition it corrects is
a natural one.

The Claude app finds a Remote Control session running on another computer, and
so does the phone. That looks like discovery. It is not.

`claude --remote-control <name>` opens an **outbound, authenticated connection
to Anthropic** and registers the session against the account. The roster lives
server-side. claude.ai, the desktop app and the phone are all authenticated
clients of that same account, so "finding a session on another machine" is
listing what the account has registered, and messages flow back down the
connection the session itself opened.

The phone is the proof rather than a puzzle: it has no process table for the
laptop, no `~/.claude`, no PTY, and usually no route to the machine. It cannot
be discovering anything. Every architecture that explains the phone is a
server-side registry.

That is also why publishing stores the transcript on Anthropic's servers -- the
broker has to hold the conversation to keep devices in sync.

### Why Sertum cannot join that broker

Sertum's truth plane is local by construction: hooks firing into a loopback
port on this machine, JSON-RPC to an app-server Sertum spawned, an
`events.jsonl` on this disk. Each works because Sertum owns or sits beside the
process. A session on another computer has none of that here.

Two things are missing, and only the second is interesting:

- **No local API.** Remote Control is publish-only at the CLI:
  `--remote-control [name]` and `--remote-control-session-name-prefix`, and
  nothing in the subcommand list (`agents`, `attach`, `auth`, `logs`, `stop`,
  `rm`, ...). There is no `claude remote-control list`, no JSON output. The
  roster is reachable only through the interactive slash command inside the
  TUI, and reading that means parsing pixels -- the one thing the two planes
  forbid. There is no on-disk fallback either:
  `~/.claude/remote-settings.json` is 2 bytes, an empty object.
- **The contract is private.** The OAuth credential is in the keychain, so
  reaching an endpoint is not the obstacle. The roster and relay endpoints are
  unversioned and undocumented, so anything built on them breaks silently when
  they move. This is the same judgment `AGENTS.md` already records for Codex
  Remote Control, which is reachable behind `capabilities.experimentalApi:
  true` and declined anyway.

### The correction that matters

An earlier reading of this held that the PTY constraint was the blocker -- that
a session on another machine could never be more than a monitored row because
its terminal cannot be rendered here.

That is too strong, and the phone is what exposes it. **The phone does not
render a terminal either.** Remote Control on mobile is a transcript view plus
a message box, which is structured data and exactly what a relay carries well.

So the PTY constraint rules out showing the live TUI of a remote session --
genuinely impossible, the master file descriptor is on the other machine -- and
rules out nothing else. The experience the phone gives you is not blocked by
anything architectural. It is blocked by the absence of a public API.

Keep this distinction. It is the difference between "cannot" and "not offered."

---

## 2. Two independent axes

The pivot conflates two changes that do not depend on each other:

|  | Terminal UI | Chat UI |
|---|---|---|
| **Local IPC** | Sertum today | the actual pivot |
| **Network broker** | pointless -- a PTY does not ship | Claude/Codex desktop |

Changing the UI model needs no broker, and a broker needs no chat UI. But chat
should come first, because **a broker is only worth building once the payload
is messages.** Relaying bytes to a second client buys nothing.

---

## 3. The architectural change: plane 2 widens from status to content

Plane 2 today carries *what the agent is doing* -- status, activity, model,
effort. A chat window needs *what the agent said* -- prose, tool inputs, tool
results.

That is the whole pivot in one sentence, and it is a widening of the existing
plane rather than a new one. Plane 1 stops being load-bearing and becomes
optional.

Most of what surrounds a chat client is already built, and built against plane
2, which is why it transfers:

| Chat client needs | Sertum already has |
|---|---|
| permission prompts | B5 approval bar |
| a policy engine | permission rules (E2) |
| file-change review | C11 / C15 / C16 |
| model, effort, context readout | `chips.ts` |
| per-session status | adapter events |

What is missing is message content, and nothing else structural.

**Note that Claude's hooks do not carry assistant content.** Hooks are events,
not transcript. Content has to come from somewhere else -- see the three
sources in section 5.

---

## 4. The crux: sessions must outlive the window

This is the real content of "switch to a broker," and it is not about the
network at all.

**Today, closing Sertum kills every session.** `before-quit` calls
`shutdown()`, which calls `disposeAll()`, which kills every PTY. That is by
design -- the PTYs are children of the Electron main process and die with it.
On Windows and Linux, closing the window *is* quitting.

For sessions to survive a GUI restart, they cannot be children of the window
process:

```
today                          broker
-----                          ------
Electron main                  sertumd  (owns sessions, adapters,
  owns PTYs, adapters,           hook server, transcripts)
  hook server                        ^ socket
    +-- renderer (IPC)           Electron GUI -- a disposable client
```

Sertum's main process is **already** a broker in every respect but two: its
transport is Electron IPC (one client, same process tree, no auth) and its
payload is PTY bytes. It already runs a loopback HTTP server
(`hook-server.ts`) with per-session URLs. The primitive is in the building.

### Restart gets better than expected

`AGENTS.md` currently says layout and gutter positions are remembered across
launches but the sessions in those panes are not, "because the PTYs die with
the app." A daemon retires that clause -- layout *and* occupancy restore.

The chat model is also what makes restore lossless. Renderer scrollback lives
in the xterm instance, so a reload costs it today. A conversation lives in the
daemon and on disk, so a restarting GUI replays it in full.

### A shortcut for Claude only

Claude already solves background hosting for itself: `claude --bg` runs
daemon-hosted, `claude agents --json` prints active sessions -- interactive and
background -- and `claude attach` reconnects. Sertum already reads that roster
for discovery.

So Claude sessions could survive a GUI close by letting Claude's own daemon own
them, before any Sertum daemon exists.

This does not generalise. Grok has no equivalent. Codex is an open question:
`codex app-server daemon version` on macOS fails with a missing control socket
(`~/.codex/app-server-control/app-server-control.sock`), which means "not
running" rather than the flat win32 refusal `AGENTS.md` records. Whether it can
be started, and whether it survives independently, is unprobed.

A realistic first cut is therefore uneven -- Claude survives, Codex and Grok do
not. That is another thing `AgentCapabilities` should state rather than hide.

---

## 5. What the local interfaces actually give you

Verified against the installed CLIs, not assumed:

| Agent | Interface | Direction |
|---|---|---|
| **Claude** | `--print --output-format stream-json --input-format stream-json`, plus `--include-partial-messages`, `--include-hook-events`, `--replay-user-messages` | both ways |
| **Codex** | app-server JSON-RPC -- already spawned by Sertum; `thread/read(includeTurns: true)`, `turn/steer`, `turn/interrupt` | both ways |
| **Grok** | `events.jsonl`, `chat_history.jsonl` | read-only |

Claude's is a complete chat protocol, first-party and documented. No private
API is needed for any of this. Codex's is already spoken by Sertum today and
used only for status.

Grok is the weak link: no documented input channel. This maps cleanly onto a
new declared capability -- call it `structured-conversation` -- where Claude
and Codex answer `ok` and Grok declines with a user-facing reason, exactly as
`AgentCapabilities` is built to do.

### Three possible content sources

1. **Transcript files** (`~/.claude/projects/**/*.jsonl`, Codex
   `rollout-*.jsonl`, Grok `chat_history.jsonl`). Already tail-read by
   `main/adapters/transcript.ts`. Works for every agent, including sessions
   Sertum did not spawn and TUI sessions. Read-only.
2. **stream-json / app-server.** Full bidirectional, structured, streaming.
   Costs the TUI.
3. **Hooks.** Events only, no content. Not a source for this.

---

## 6. Staging

**1. Transcript-rendered chat view.** Render `transcript.ts` output as a
conversation instead of a one-line summary. Input still goes to the PTY. A
chat window over real TUI sessions, no protocol change, nothing lost, and it
works for adopted sessions the headless route never will. Cheap enough to be
worth doing on its own merits.

**2. True conversation sessions.** stream-json for Claude, app-server for
Codex. Real bidirectional chat, no PTY. Build it as a *session type* alongside
terminal sessions rather than as a replacement -- see section 7 for what the
TUI is still carrying.

**3. Local daemon.** Move session ownership out of Electron. This is where
"close the GUI, agents keep running" is actually earned, and where protocol
shape, multi-client fan-out, reconnection and transcript ownership get solved.

**4. Cloud.** Adds NAT traversal, TLS, identity, hosting and a real security
surface.

Steps 1-3 are genuine prerequisites for 4 and the protocol work carries over.
But note that **a local daemon does not reach your phone** -- loopback is not
reachable from another device, and LAN addresses are unreliable on home
networks. The phone is step 4, or a Tailscale-style overlay as a shortcut. It
is what step 3 was practice for, not a small extension of it.

---

## 7. What this costs

- **The TUI is carrying more than it looks.** Slash commands, plan mode, the
  agent's own permission dialogs, its diff and todo rendering. Sertum has
  independently replaced some of that (B5, permission rules, C11) and not the
  rest. Inventory it before treating step 2 as a replacement rather than an
  addition.
- **Quit-drain logic moves rather than disappears.** The daemon still needs it
  at genuine shutdown; the GUI's quit must stop calling `disposeAll` entirely.
  See the `QUIT_DRAIN_MS` reasoning in `AGENTS.md`.
- **The daemon needs a lifecycle and a CLI.** Start on demand, survive GUI
  exit, and a real way to stop it -- otherwise there are orphaned agents with
  no UI to kill them from.
- **Version skew.** A GUI update talking to a daemon still on the old build.
  Needs a protocol version handshake from day one, not retrofitted.
- **Blast radius moves out of sight.** Daemon dies, everything dies. No worse
  than today, but now there may be no window up to notice -- the same class of
  problem as `watchForProcessDeath`.
- **Attachments get simpler, but verify first.** `clipboard-paste.ts` spills
  images to disk and pastes a path *because a PTY carries characters*. With
  structured input that workaround stops being forced -- but what content
  blocks Claude's stream-json input actually accepts has not been checked. The
  path trick keeps working either way, so it is a fallback rather than a
  rewrite.

---

## 8. Open questions to probe

- Can `codex app-server daemon` be started on macOS, and does it survive the
  client that started it?
- What content blocks does Claude's `--input-format stream-json` accept --
  images inline, or paths only?
- Does Grok have any input channel that is not the TUI?
- What does a `--bg` Claude session cost in fidelity versus a PTY-hosted one?
- Protocol: extend the existing loopback HTTP server with WebSocket, or a
  separate socket? The hook server already has per-session URL routing worth
  reusing.

---

## What was verified in this session, and what was not

**Verified by running it:** the Claude CLI flag and subcommand surface
(2.1.252), including the absence of any remote-control roster command;
`claude agents --json` listing interactive and background sessions;
`--input-format`/`--output-format stream-json` and the partial-message,
hook-event and replay flags; `~/.claude/remote-settings.json` being 2 bytes;
`codex app-server daemon version` failing on a missing control socket on
macOS; the existence and shape of `main/adapters/transcript.ts`; the
`before-quit` -> `shutdown` -> `disposeAll` path.

**Inferred from observable behaviour, not from documentation:** that Remote
Control is a server-side registry with an outbound-registered relay. The
evidence is that it crosses NAT, works on a device with no local access to the
machine, and that `AGENTS.md` already records transcripts being stored
server-side when publishing. No spec for Anthropic's internals was read.

**Not checked at all:** everything in section 8.
