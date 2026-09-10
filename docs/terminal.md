# The terminal pane

Part of [Sertum's technical guide](../AGENTS.md), which states the rules this
file records the evidence for. Keep verified detail here and the invariant
there.

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

## Electron 44's clipboard is async and ClipboardItem-shaped

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

## The WebGL renderer must be allowed to die

A WebGL context is not the pane's to keep. Every terminal's context lives in
the one shared GPU process, so a GPU reset -- display sleep, a
discrete/integrated switch, that process being recycled -- loses all of them
at once. xterm goes on rendering into the dead addon regardless, which paints
nothing: the pane reads as a blank rectangle with a broken-image mark in one
corner while the PTY behind it carries on unharmed and the status bar keeps
saying `adapters ok`. It looks like every session died and is only a display
that stopped. Switching the renderer setting does not rescue an open pane
either, since an addon cannot be swapped under a live terminal.

**`WebglAddon.onContextLoss` is the wrong signal, and subscribing to it alone
left the bug in place.** The addon answers `webglcontextlost` by calling
`preventDefault()` -- which asks Chromium to restore the context -- and
starting a three-second timer, then fires `onContextLoss` only if nothing was
restored before it expires. Chromium usually *does* restore, so the common
case clears that timer and `onContextLoss` never fires at all; what follows a
restore is the addon rebuilding its GL state in place, and that rebuild does
not survive the round trip, leaving a live renderer that paints nothing,
permanently.

Verified by killing the GPU process of a running packaged build with two
panes open. Both went blank and stayed blank, `.xterm-rows` absent, so no
renderer was painting at all: `webglcontextlost` at once,
`webglcontextrestored` a second later (so `onContextLoss` never fired), then
`WebGL: INVALID_OPERATION: delete: object does not belong to this context`
from the failed rebuild. Typing into a blank pane still ran the command --
a `touch` landed from a terminal showing nothing -- which is how this reads
as a frozen app rather than a broken display.

`webglcontextlost` is therefore what `TerminalPane` listens to, since it
arrives on both branches. It does **not** bubble (verified: a listener on
`.term-host` sees it only in the capture phase), so capture is not optional.
Listening on the host element rather than the addon's canvas keeps this off
xterm's private fields and covers whatever canvas a later reload creates, and
the handler defers by a tick because disposing the addon tears down the very
canvas the event is still being delivered to. `onContextLoss` is kept as a
second subscription for the no-restore branch; both land in one idempotent
handler.

`TerminalPane` answers the loss: dispose the addon, which returns xterm to
its DOM renderer, then `refresh` the whole viewport, because that renderer
only paints what changes from here and the screen it inherits was drawn by
the addon that just died. Recovery is attempted once and waits for the window
to be visible -- the loss usually arrives while the machine is asleep. A
second loss means the GPU is unreliable here, and staying on DOM beats
flapping between renderers for the rest of the session.

**On the no-restore branch the addon sits on the loss for three seconds
first**, so a pane is legitimately blank for those three seconds and any test
sampling inside that window sees nothing happen. Verified against a live pane
by taking the addon's own canvas (`addon._renderer._canvas`) and calling
`WEBGL_lose_context.loseContext()` -- reaching for a context on any other
canvas in `.term-host` creates a fresh one rather than finding xterm's, and
killing that proves nothing:

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

## A dead helper process must not be a dead window

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

## macOS spawns every PTY through a helper binary node-pty ships broken

On macOS node-pty does not `forkpty`. It `posix_spawn`s a 50KB helper --
`prebuilds/darwin-<arch>/spawn-helper`, passed as `argv[0]` -- which opens the
slave tty, `chdir`s to the session's folder and `execvp`s the real command
(`src/unix/spawn-helper.cc`, twelve lines). Linux takes the `forkpty` branch
and never execs it; Windows uses ConPTY. So this is a macOS-only failure, and
the whole of plane 1 rests on that one file being reachable and runnable.

Two independent things make it neither, and **both report the same sentence**:

```
posix_spawnp failed.
```

That is the entire message. `pty.cc` throws a fixed string on any non-zero
`posix_spawn` return, so there is no errno, no path, and nothing pointing at
node_modules -- and because a POSIX mode failure is not something TCC gates,
macOS offers no permission prompt either. It looks like the app cannot find
the shell.

- **The executable bit is missing from the published package.** node-pty
  1.1.0's own npm tarball ships it 0644:

  ```
  -rw-r--r--  50480  package/prebuilds/darwin-arm64/spawn-helper
  -rw-r--r--   9248  package/prebuilds/darwin-x64/spawn-helper
  ```

  Read straight out of the tarball in npm's cache, so it is not something a
  copy in this repo did. `posix_spawn` returns EACCES. Every install has it:
  `npm start` and a packaged build alike. `scripts/ensure-pty-helper.js`
  chmods the source tree from `postinstall` and `prestart` (npm restores the
  0644 file on every install); `fixDarwinPtyHelper` in `forge.config.ts` does
  the bundle.

- **The asar rewrite fires when it must not.** `lib/unixTerminal.js` computes
  the helper path and then rewrites it unconditionally:

  ```js
  helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
  ```

  Right when Electron's asar-aware require loaded the module from inside the
  archive. sertumd is not that: it runs under `ELECTRON_RUN_AS_NODE`, which
  has no asar support, so it resolves node-pty on the real filesystem at
  `Resources/app.asar.unpacked/node_modules/node-pty` -- already unpacked --
  and the rewrite turns its helper path into `app.asar.unpacked.unpacked`,
  which exists nowhere. `posix_spawn` returns ENOENT. Isolated by putting one
  chmod-ed copy of the module at two paths differing only in that substring:
  the one with `app.asar` in it fails, the other spawns.

  Nothing else in Sertum loads node-pty -- `pty-manager.ts` is the only
  importer and only the daemon reaches it -- so the rewrite is never useful
  here and always wrong. `fixDarwinPtyHelper` answers the path it computes
  with a symlink beside the real directory, created before the ad-hoc re-sign
  so the signature seals it. Verified: `codesign --verify --deep` passes and
  the bundle spawns.

`verifyPackagedDaemon` then stats the path node-pty will *really* use
(`ptyRuntimeHelper`), so one check that follows the symlink proves both fixes,
and a build missing either fails rather than shipping an app whose every PTY
session dies on arrival.

**What it looks like from the front.** Claude and Codex are stream sessions
with no PTY at all, so a broken helper never touches them: the symptom is
Shell, alone, refusing to start while every agent works. The New Session
dialog reported that as "Could not start Shell: posix_spawnp failed.. Check
its location in Settings → Agents" -- and Settings > Agents holds a path per
*managed* agent, so there was no Shell control to check. It no longer offers
that advice for a shell.

## Quitting drains before it exits — in the daemon, now

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
