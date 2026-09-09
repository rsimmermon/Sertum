# Windows notes

Part of [Sertum's technical guide](../AGENTS.md), which states the rules this
file records the evidence for. Keep verified detail here and the invariant
there.

Development so far has mostly happened on macOS. Running on Windows 11
surfaced these differences:

- **Package under Node 20 LTS, not Node 26.** With Node 26.7.0 and Forge
  7.11.2 / Electron Packager 18.4.4, `npm run make` reaches Electron ZIP
  extraction then exits 0 with no packaged directory and no refreshed maker
  artifact; Node 20.20.2 / npm 10.8.2 completes normally. Prepend the Node 20
  directory to PATH for the build and invoke that version's npm directly --
  no need to change the global nvm selection.
- **`ignoreModules: ['node-pty']` in `forge.config.ts`.** node-pty ships
  prebuilt N-API binaries per platform/arch and N-API is ABI-stable across
  Node/Electron, so no rebuild is needed; left alone, Forge's `rebuildConfig`
  falls through to `node-gyp rebuild`, which wants MSVC Build Tools.
- **npm 11's `allowScripts` blocks install scripts by default.** `node-pty`
  (fetches its prebuild), `esbuild` and `electron-winstaller` (the Squirrel
  maker) all need theirs, or `npm install` silently leaves node-pty with no
  native binary at all. Electron needs no entry -- from 42 on it has no
  install script, see "Electron fetches its own binary on first use" in
  [../AGENTS.md](../AGENTS.md). npm
  10.x has no `allowScripts` and simply runs every install script.
- **Binary resolution needs a real PATH × PATHEXT search on win32**, in the
  shared `src/main/adapters/binary-resolve.ts` every adapter calls. Two
  mechanisms make a bare name unsafe here: `node-pty`'s Windows backend calls
  `CreateProcess`, which only appends `.exe` and never walks `PATHEXT`; and
  `child_process.spawn` has refused `.cmd`/`.bat` without `shell: true` since
  the CVE-2024-27980 hardening, throwing `EINVAL` *synchronously* rather than
  through the `'error'` event the code handles. Codex is installed by npm as
  a `codex.cmd` shim, so a session spawning `codex` failed with `Cannot
  create process, error code: 2`, and the app-server spawn now sets `shell:
  true` for a `.cmd`/`.bat` binary. Claude is a genuine `claude.exe`, but the
  resolver hardcoded that literal with no existence check, so a broken or
  absent install failed just as silently. Grok is not on PATH at all -- the
  CLI installs to `~/.grok/bin/grok.exe` and the installer adds no PATH entry
  -- so its candidate list carries the weight and the PATH walk is fallback.
- **Every session-creation failure was swallowed as an unhandled renderer
  rejection**, on every platform and for every agent, so a spawn failure
  looked exactly like "click the button, nothing happens".
  `new-session-dialog.ts` now creates the session itself and reports failure
  inline; Settings > Agents & permissions (Detect / Browse... / a manual
  per-agent path override) and the status bar's "… not found" readouts make a
  missing binary diagnosable rather than mysterious.
- **Dev builds need an explicit window icon and an app id.** `npm start` runs
  the bare `electron.exe`, which carries Electron's icon; a packaged build is
  its own icon-bearing executable (`packagerConfig.icon`) and needs neither.
  Passing `icon:` to `BrowserWindow` when `MAIN_WINDOW_VITE_DEV_SERVER_URL`
  is set fixes the title bar but *not* the taskbar, because Windows resolves
  the taskbar button's icon through the window's Application User Model ID
  and derives one from the host executable when none is set.
  `app.setAppUserModelId` claims our own, and the dev id includes the
  main-process pid so Windows cannot reuse an icon cached for an older dev
  run. It stays **dev-only**: Windows matches a toast to the Start Menu
  shortcut bearing the sender's id, and Squirrel installs one carrying
  `com.squirrel.Sertum.Sertum`, so claiming an id in a packaged build would
  trade an already-correct taskbar icon for C20's notifications quietly not
  arriving. (The taskbar is invisible to `Graphics.CopyFromScreen`, which
  returns whatever window sits under it; `PrintWindow(hwnd, hdc, 2)` on
  `Shell_TrayWnd` captures it for real.)
- **The Windows icon has its own tighter vector master.** The 88px
  transparent margin in `assets/icon.png` is right for macOS but leaves the
  mark undersized in the taskbar, its 38px segments about a pixel wide.
  `assets/icon-windows.svg` uses a 40px safe area and 54px square-ended
  segments, and `scripts/make-ico.js` renders every ICO entry from that
  vector so the 16–32px variants keep defined edges and visible gaps. Those
  embedded PNGs must be PNG32 at 8-bit channel depth: ImageMagick's Q16
  default produces valid-looking 16-bit entries that Packager accepts and
  Squirrel's install-time execution-stub resource step dies on, leaving the
  setup log at `Rigging execution stub`.
- **The install screen was electron-winstaller's placeholder.** Configured
  with `setupIcon` alone, it falls back to its bundled
  `resources/install-spinner.gif`, a 268x167 mint-green rectangle.
  `loadingGif: 'assets/install-spinner.gif'`, generated by
  `scripts/make-loading-gif.js` from the icon's own vector -- six ring
  segments with one amber, stepped around, so no new artwork can drift from
  the icon -- fixes it, and keeps the placeholder's exact dimensions because
  Squirrel sizes its window to this image. `Setup.exe` compresses its
  payload, so a byte search for `GIF89a` confirms nothing; run the installer.
  Verified against a real `Sertum-1.0.0 Setup.exe`.
- **`node-pty`'s ConPTY `kill()` can throw a benign but scary-looking
  uncaught exception.** On the non-DLL ConPTY path it forks
  `conpty_console_list_agent.js` to force-kill the shell's descendants
  (upstream cites microsoft/vscode#26807); that helper's `AttachConsole` can
  lose the race and print `Error: AttachConsole failed` with a full stack
  trace *after* the PTY has already been killed successfully. Harmless -- a
  one-shot child process, not the app -- and it has no macOS equivalent (the
  POSIX backend is a plain `forkpty`), so don't mistake it for a real failure.
- **The login-shell environment probe is a deliberate no-op on Windows.**
  `hydrateLoginEnv()` exists because a macOS app launched from the Dock
  inherits launchd's near-empty PATH; `win32` short-circuits and always
  returns `false`, which is correct, since Explorer-launched processes
  already inherit the full user/system PATH from the registry. Its startup
  log line -- `using the inherited environment; login shell did not answer`
  -- reads like a failure but means "as designed, never attempted".
- **The Windows process scan listed one Claude session three times.**
  `scanWindows()` selected only `ProcessId,Name` and pushed the `app-server`
  exclusion into the WMI filter, so the per-agent `reject` rules the POSIX
  pass applies to `args=` could not run at all. Claude's helpers wear the
  session's own binary name -- verified on Windows 11: `claude.exe daemon run
  --origin transient`, `claude.exe --bg-pty-host \\.\pipe\cc-daemon-...`, and
  the real `claude.exe --session-id ... --resume ...` -- so the import list
  offered all three, two with an unknown folder. Fixed by selecting
  `CommandLine` and applying the same shared `AGENT_COMMANDS` reject rules,
  with `^(daemon|--bg-pty-host)(\s|$)` added for Claude: five rows down to
  two, the real session and one interactive Claude in another terminal.
- **A monitor row's folder stays unknown on Windows.** `cwdForPid` shells out
  to `lsof` and returns `null` off POSIX; a Windows process's working
  directory lives in its PEB, which WMI does not expose. The row still lists,
  summarises and raises its window, so this is a missing detail rather than a
  broken row.
- **Closing the window hides it to the tray on every platform.** The Electron
  process remains the notification and tray client while `sertumd` keeps the
  hook server, adapters and sessions; only the explicit "Quit Sertum
  completely…" path stops the daemon and its owned sessions.
- **The `.cmd` shim also displaces the codex app server's pid, which used to
  orphan it on every quit.** The same `shell: true` puts `cmd.exe` between us
  and the server: `child.kill()` terminates the shim while the server carries
  on holding its ephemeral port, and the pid recorded for the next launch's
  reaper is the shim's -- a pid that died with the shim, so the reaper found
  nothing and dropped the record. One orphan per *normal* quit, not just per
  crash, each holding a port until reboot. Fixed on both ends: the real pid
  is resolved from the port it is listening on (`Get-NetTCPConnection`,
  falling back to `netstat -ano`) and recorded instead of the shim's, and
  shutdown runs `taskkill /T /F` -- before killing the child, since the tree
  is only walkable while the shim is alive. Neither path runs off Windows,
  where the process we spawn is the server. Untested on Windows so far.
- `dev-app-name.js` (the Dock name/icon branding hack) already no-ops off
  darwin, `titleBarStyle` already falls back to `'default'`, and the
  `curl`-based hooks and the PTY smoke test already worked with no changes.

## Windows installer callback startup

Squirrel install/update callbacks must not enter the normal `ready` handler.
The shortcut helper quits asynchronously, so `ready` can race that exit and
start a detached broker even though `electron-squirrel-startup` returned true.
On Windows the installer then remained on its animation after shortcuts were
created. Verified recovery: the callback-started broker had no sessions;
gracefully stopping it immediately let Squirrel finish and launch the app.
The `ready` handler now returns for Squirrel callbacks and losing single-instance
launches, before connecting to or spawning a broker. Rebuilt-installer verification
is still required for this guard.

## Windows development launch privileges

Run the development app and broker at the desktop user's normal privilege
level. During Windows testing, Print Screen reached ShareX on the desktop but
failed with Sertum focused while Sertum and sertumd were elevated and ShareX
was not. Relaunching both with a limited interactive token removes that
privilege mismatch; the user verified Print Screen works with Sertum focused
after that relaunch. An elevated
launcher can pass elevation through a `Shell.Application` launch too, so verify
the resulting process tokens rather than assuming that route de-elevates them.
