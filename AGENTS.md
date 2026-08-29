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
- [ ] Diff review (wireframe C11)
- [ ] The rest of Settings (E2–E7) — worktree bootstrap config (E4) and others
      beyond today's display/agent panes
- [ ] Split views (wireframes G1–G8)

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
| `Notification` (idle_prompt) | `needs-input` | Claude is waiting for your input |
| `UserPromptSubmit` | `working` | thinking |
| `PreToolUse` | `working` | Bash… |
| `PostToolUse` | `working` | Bash |
| `Stop` | `idle` | turn finished |

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
(Plane 2, above), but that connection doesn't yet reach backward to describe
sessions started elsewhere — which is why process-scan remains the only Codex
discoverer today. Teaching discovery to query the app server directly would
make it a richer discoverer registered ahead of the process scan; nothing
downstream changes when that lands.

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
scripts/
  smoke-pty.js                Headless PTY test
  drive.js                    CDP driver for headless verification
```
