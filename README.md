# AgentStation

One window for every coding agent you have running.

A desktop GUI that manages multiple AI coding agents — Claude Code and Codex —
across separate working folders and git worktrees, with a live embedded
terminal per session and status you can trust at a glance.

Design source of truth: `AgentStationDesigns.pen` (68 wireframes, 10
storyboards). Frame ids referenced in code comments (`B3`, `C1`, …) point
there.

## Architecture: two planes

The single decision everything else follows from. These never do each other's
job:

| Plane | Owns | Implementation |
|---|---|---|
| **1 — pixels** | Characters in, characters out | `node-pty` per session, rendered by `@xterm/xterm`. Never parsed for meaning. |
| **2 — truth** | What each agent is actually doing | Adapter events. Claude Code hooks: **done**. Codex app-server JSON-RPC: next. |

A tab badge turns amber because the agent *said* it needs input — not because
its pixels stopped moving.

## Status

Phase 01 (de-risking) and folder selection are done and verified:

- [x] Electron 44 + Vite + TypeScript, strict mode clean
- [x] `node-pty` rebuilt against Electron's ABI; PTY spawn / write / read / resize / kill
- [x] Real agent TUIs render correctly (Claude Code draws its full-screen UI)
- [x] Keystrokes reach the PTY from the renderer
- [x] Tab strip, sidebar grouped by status, pane header, status bar
- [x] New Session dialog (wireframe C1) with a **native folder picker**, live
      git validation, recent folders, and auto-derived tab labels
- [x] **Plane 2 for Claude Code** — loopback hook endpoint, per-session binding,
      status and activity driven by real agent events
- [ ] Plane 2 for Codex (app-server JSON-RPC) — next
- [ ] Split views (wireframes G1–G8)
- [ ] Worktree management (C9), diff review (C11), settings (E1–E7)

## How status actually works

Each Claude session is spawned with `--settings` carrying a hooks blob whose
URLs point at *that session's own* endpoint:

```
http://127.0.0.1:<port>/hook/<session-uuid>
```

So an arriving event is attributable to exactly one pane with no correlation
guesswork. `http` hooks are used rather than `command` hooks on purpose: a
shell-command hook would be a per-OS script to maintain, while an HTTP POST is
identical on macOS, Linux and Windows.

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

## Running

```sh
npm start                                  # dev
AGENTSTATION_DEBUG_PORT=9222 npm start     # dev + remote debugging
```

Main-process changes require a full restart; Vite only hot-reloads the renderer.

## Verification

Screen capture is unavailable in some environments, so the app can be checked
headlessly.

```sh
# PTY layer only — no UI. Also the cross-platform check for Windows/Linux.
npx electron scripts/smoke-pty.js          # default shell
npx electron scripts/smoke-pty.js claude   # a real agent TUI

# Drive the running app (needs AGENTSTATION_DEBUG_PORT)
node scripts/drive.js "document.querySelectorAll('.tab').length"
```

`window.__agentStation` is exposed in dev builds only; `debugActiveSnapshot()`
returns the focused terminal's scrollback, which is the only way to read
terminal contents while the WebGL renderer is active.

## Layout

```
src/
  main.ts                     Electron main: window, menu, IPC
  main/pty-manager.ts         Plane 1 — PTY lifecycle
  main/workspace.ts           Folder validation, git/worktree detection
  main/hook-server.ts         Plane 2 ingress — loopback HTTP, per-session URLs
  main/adapters/claude.ts     Hook settings builder + event to status mapping
  preload.ts                  contextBridge API surface
  shared/types.ts             Contracts shared across processes
  renderer/app.ts             Shell: tabs, sidebar, pane, status bar
  renderer/terminal-pane.ts   One xterm bound to one PTY
  renderer/new-session-dialog.ts  Wireframe C1
scripts/
  smoke-pty.js                Headless PTY test
  drive.js                    CDP driver for headless verification
```
