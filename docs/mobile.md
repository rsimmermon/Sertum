# The phone client

Evidence behind the "Phone client and gateway" section of
[AGENTS.md](../AGENTS.md). The phone is always a client of a `sertumd` on a PC; it
never hosts a daemon, agents or sessions.

## The gateway, as built

| | |
|---|---|
| Transport | WebSocket over TLS 1.3, port 47615 on every interface, refusing peers outside private, link-local, loopback and carrier-grade NAT space before TLS |
| PC's identity | A P-256 key made once in `~/.sertum`. A phone pins the SHA-256 of its SPKI |
| Phone's identity | A P-256 key in the Android Keystore, unusable while the phone is locked |
| Pairing | A 128-bit code, one use, five minutes, held only as a hash and withdrawn when the Settings pane closes. A wrong guess leaves it standing, or anything on the network could cancel a pairing. One record per phone key: pairing again replaces that phone's record and quietly closes its old sockets, and records already doubled on disk keep the one seen last |
| Each connection | The daemon sends a nonce. The phone signs `sertum-gateway-1\|auth\|<nonce>\|<pin>`, which names the key it saw, so a signature cannot be replayed or relayed |
| Discovery | mDNS `_sertum._tcp`, with the PC's id in TXT. It only says where to try |
| Versioning | `GATEWAY_API`, apart from `DAEMON_PROTOCOL`, because a phone updates on its own schedule |

A phone may start and end sessions, send messages and files, approve calls, and
change a session's mode, model and thinking level, including Full Access. The owner
chose each of these with the cost stated. It may not touch terminals, settings,
stored rules, discovery, or Codex repairs, or read diagnostics. "Always allow" on
the approval bar does write a rule, and is allowed because Full Access already
reaches further. Snapshots leave without `command` and `args`, which on a Claude
session carry the whole hooks blob on every update.

Thumbnails of attachments still need Electron's `nativeImage`, so a phone previews
only what it uploaded in this run of the app.

### What was verified, 2026-11-06

`scripts/test-gateway.ts` runs 27 checks over a real socket with the fabric replaced
by a recorder, so "never reached the fabric" is something a check can see.
`scripts/smoke-gateway.ts` runs pairing, an upload, a real approval and ending a
session against real Claude and Codex, inside Electron's runtime.

On an Android 16 emulator against the real daemon through the phone's own UI, with
the desktop app open as a second client:

| Case | Result |
|---|---|
| Pairing with a real Keystore signature | Connected, shown on the desktop |
| Claude turn: start, ask-first mode, approve on the phone, reply | 4.5s, and the file was written on the PC |
| Codex turn in `codex-ask` | 6.1s, but Codex asked for nothing, so its approval path was not exercised here |
| Session started on the desktop, or ended on either side | Appears on or leaves the other client |
| One held call on both clients, answered on the phone | Both bars gone 9ms later |
| Phone access off while the agent answers, then on | Reconnected in 231ms, caught up in 448ms, each reply drawn once |
| Daemon restarted | Listening again by itself, and the phone back without help |
| Revoked while connected | Cut off at once, stays out, and re-pairs from that screen |
| Reinstalling the app | Stays paired |

Five defects only the running app showed, all fixed:

- **A chip's picker outlived its pane.** It lives on the body, so going back or
  ending the session left it covering the next screen, naming a session no longer
  there. A scripted click reached the button beneath it, so only a screenshot showed
  this.

- **The daemon failed to start at all.** Vite turned `ws`'s optional `bufferutil` into
  a throw at load. With its stdio ignored, the only symptom was "sertumd did not come
  up", and every session on the machine was gone with it, phone access on or off.
- **A busy port killed the daemon.** `ws` re-raises the server's error as its own,
  and an unheard `error` event ends the process. `test-gateway.ts` caught this one.
- **The approval bar hid what it asked about.** On a phone it squeezed the command to
  `n..`, with no hover to read the rest. The buttons now drop below it, and on touch
  the command is shown whole.
- **A second client kept its bar**, because only the answering client took it down.

The firewall: first listening made Windows add Block rules for the dev `electron.exe`
on the Private profile while its prompt was unanswered, and Block outranks Allow.
Traffic from an emulator arrives from this PC, so none of the above crossed the
firewall. The real phone below did, once those rules were changed to Allow.

### On a real phone, 2026-11-06

A Galaxy Z Fold6 on Android 16, on its cover screen, over real Wi-Fi from another
address through the Windows firewall, with the desktop as a second client:

| Case | Result |
|---|---|
| Pairing with only a dead address in the code | 2.8s, so mDNS alone found the PC |
| Claude turn, Allow tapped on the phone | 4.5s, and the file was written on the PC |
| Codex turn in `codex-ask`, writing inside its folder | 11.2s, and asked for nothing |
| Codex in `codex-read-only`, writing outside its folder | Asked on the phone, one tap allowed it, 12.2s, and the file was written |
| One held call on both clients, answered on the phone | Both bars gone 17ms later |
| Phone access off while the agent answers, then on (4 runs) | Reply drawn 249 to 554ms after coming back |
| Revoked while connected | Cut off at once, stays out, and re-pairs |
| Reinstalling the app | Stays paired |
| The phone's own file picker, picture sent to real Claude | Claude named the type, and the picture was drawn in the sent bubble |
| 12MB file through the picker | 3.0s, and its SHA-256 matched on the PC |
| 20,000 message conversation, opened over the socket | Newest message in 190ms |
| Scrolling up it for 12s, across 4,400 messages | 120fps at the median and p95, worst frame 50ms, heap steady at 21MB |
| A message arriving while reading far up | The reader moved 0px |
| Locked, then unlocked | The socket is gone while locked and comes back by itself |

The long conversation was synthetic and took no turn, since a real one would have
sent the whole history to the model.

Three defects only the real phone showed, all fixed:

- **A reconnect waited for the backstop.** A pane caught up on its next slow read, up
  to 5s later. The emulator's 448ms was luck in where that timer stood. It now asks
  when the socket returns.
- **A file chosen during a reconnect was lost.** Coming back from the picker, the
  socket can still be returning, and the upload failed on the spot. A request now
  waits up to 15s for the connection, and still fails at once if the phone was removed.
- **Backing out of the scanner said it "could not start".** On this phone the back
  button arrives as ML Kit's internal error 13, not its cancel code, after the scanner
  had run perfectly well. It now says no code was read. Because 13 is not specific to
  backing out, it cannot be treated as a cancel.

By hand, the same day: a QR code on the PC's screen read by the Fold6's camera paired
it. Unfolding with the final shell open took the page from 368 to 707 CSS pixels wide
with the same process and the connection held, no sideways overflow, and the shell
stopping above Samsung's taskbar. That was on the empty session list; a place kept in a
long conversation across an unfold was measured on the spike harness, not this shell.

Not verified: Grok, a mid-range phone, and a packaged desktop build. Nothing notifies a phone that is not open on the app: an approval waits until
someone looks. An upload that loses its connection part way has to be chosen again.

Ending a Codex session leaves its folder locked, because `codex-code-mode-host.exe`,
kept by Codex's own app server, still holds it. This is not specific to phones.

## Several PCs, one list

A phone pairs with as many PCs as it likes and shows their sessions as one list,
with the PC's name and connection dot on every row and in a conversation's header.
Pairing, addresses and Forget live on their own PCs page; New session asks which PC
when there is more than one, and remembers recent folders per PC.

- **One socket per PC.** `PinnedSocketPlugin` holds a map of sockets, and `send` and
  `close` name the connection they mean. It used to cancel the previous socket on
  every `connect`, which is what limited a phone to one PC. A page load closes any
  socket a previous page left open, since only the page uses the plugin.
- **A session's calls go to the PC that owns it.** `mobile/src/fleet.ts` learns
  ownership from each PC's `session/list` and `session:updated` events; session ids
  are UUIDs, so the events of every PC merge without translation and the desktop
  `ChatPane` runs unchanged. A file goes to the PC of the session on screen, and an
  image a message names goes to the PC whose session has that folder.
- **Capabilities are per PC**, because two PCs can run different agent versions.
- **A PC that is off still shows its sessions.** Each PC's list is saved at most
  every 2s (`sertum.sessions.<pc id>`, 50 newest) and shown on start, marked PC
  offline, until that PC answers and its own list replaces it. Verified on the
  Fold6 by breaking the MacBook's port and reloading: its session came back offline,
  and live again once the port was restored.
- **A PC that is off is not hunted for.** After a failed attempt the next tries come
  10s, 30s and 1 min apart, then every 5 min. Nothing is tried while the app is in
  the background; coming back, Try again, or using one of that PC's sessions each
  try at once. Its record is kept until Forget. Measured on the Fold6 2026-11-09
  against an address nothing answers: due times of 4:26, 4:27, then 4:32, a pause
  while the screen dozed, and an immediate try on waking.
- **Back walks the app's screens.** Without `@capacitor/app` nothing handled Back,
  so it closed the app from any screen, a conversation included. `MainActivity`
  now steps back through the WebView's history and leaves only from the list.

Pairing the same phone again used to add a gateway record each time, so the PC's
Settings listed the Fold6 three times after two re-pairings; `test-gateway.ts`
now covers the replacement and the clean-up on load.

Testing note: a value written to `localStorage` just before `am force-stop` can be
lost, because the WebView had not written it out. Reload the page instead.

A phone paired before this kept `sertum.pc`; it is moved to `sertum.pcs` on first
start, with its folders, and the old keys removed. Verified on the Fold6: the paired
MacBook came across connected, with its session and folders.

## Why `mobile/` is in this repo

The app imports `src/renderer` and `src/shared` directly through the `@desktop`
alias. A separate repo would need a package or submodule between them, and two
versions of the UI can drift, which is the failure a mirror cannot have.
`mobile/` has its own `package.json` and is not an npm workspace, so it cannot
disturb the desktop install. Forge packages from an allowlist and `tsconfig` and
lint cover `src`, so desktop builds do not see it.

## Toolchain

Capacitor 8.6 requires Node 22+ (`@capacitor/cli` engines) and its Android
project built here under JDK 21. Desktop packaging needs Node 20, so neither is
switched globally: run Node 26 and JDK 21 per command, as `mobile/README.md`
shows. Verified with Node 26.7.0, Temurin 21.0.13, SDK platform 36.

## Real phone, 2026-11-05

Galaxy Z Fold6 (SM-F956U, Snapdragon 8 Gen 3, 12GB), Android 17 / API 37, WebView
156, cover screen at 368x905 CSS pixels and 120Hz, app `targetSdk` 36, connected
by wireless debugging. It is a flagship, so 4x throttle is only a rough stand-in
for a mid-range phone, and CDP's throttle does not slow the GPU. No mid-range
phone has been measured. The same synthetic fixture as the emulator table below.

| Items | Full speed: open / new item / scroll p50 | 4x: open / new item / scroll p50 |
|---|---|---|
| 400 | 103ms / 94ms / 8.3ms | 218ms / 213ms / 8.3ms |
| 1,000 | 187ms / 181ms / 8.3ms | 640ms / 587ms / 8.3ms |
| 2,000 | 334ms / 353ms / 8.3ms | 1.3s / 1.1s / 8.3ms |
| 5,000 | 763ms / 644ms / 8.3ms | 2.9s / 2.5s / 8.4ms (p95 24.9ms) |
| 20,000 | 3.2s / 3.1s / 16.7ms | 12.4s / 11.4s / 116.6ms |

The first 2,000-item run recorded one 22-second frame gap. The log shows the app
returning from Recents as that run ended, and three reruns measured 281-383ms
per new item with no such gap, so the row uses the first run's other figures.

The new-item stall grew with conversation size, which is what the bounded window
and incremental updates in [conversation.md](conversation.md) were built to end.
The table above is the "before". The same runs after that work, on the cover
screen, with the range of three new items:

| Items | Full speed: open / new item / scroll p50 | 4x: open / new item / scroll p50 |
|---|---|---|
| 400 | 73ms / 14-20ms / 8.3ms | 117ms / 20-57ms / 8.3ms |
| 1,000 | 46ms / 18-86ms / 8.3ms | 112ms / 18-47ms / 8.3ms |
| 2,000 | 44ms / 17-62ms / 8.3ms | 101ms / 19-53ms / 8.3ms |
| 5,000 | 33ms / 16-59ms / 8.3ms | 97ms / 18-20ms / 8.3ms |
| 20,000 | 30ms / 15-52ms / 8.3ms | 105ms / 19-54ms / 8.3ms |

These scrolls moved 15,000px and landed no page, and nearly every run still had
one frame over 50ms (worst 83.6ms), whose cause was not established. Paging was
exercised separately. 20,000 items at 4x, scrolled at 9,000px/s for 15 seconds,
landed two pages at p50 8.3ms, with 4 frames over 50ms and a worst of 116.8ms.
`spike.pagingCheck(5000)` reached both ends, followed an arrival, held at most
1,000 items and moved the reader by 0px at every page. All of this uses the stub,
not a real daemon, and scrolls by script rather than by touch.

**Unfolding fills the inner screen, and the app is not restarted.** With a
conversation open on the cover screen, opening the phone kept the same process and
went from 368x905 to 707x823 CSS pixels, with window bounds equal to the whole
1856x2160 display and no horizontal overflow. No foldable-specific code was needed:
the activity is resizable and declares the size changes in `configChanges`. Folding
back on this phone showed the home screen rather than the app. Whether that is a
Samsung setting or the swipe prompt expiring was not established; the process
survived, and returning to the app showed it at 368x905 in the same place.

Two defects showed up on the first unfold, and both are fixed:

- **The reader lost their place.** Reflow took `scrollHeight` from 41,398px to
  35,606px and moved a view of messages 1884-1895 to 1911-1914. The pane now
  restores the item at the top of the view and how far through it the view was.
  On a real fold, the same item and the same fraction (0.863, then 0.276 on the way
  back) held in both directions. `spike.widthCheck` repeats that at five positions
  through four widths on each screen, and a reader at the end stays there. Scrolling
  and paging measured the same afterwards.
- **System bars covered the app.** Content drew beneath the status bar, and the
  navigation bar and Samsung's taskbar covered the Mode, Model and Thinking chips.
  WebView 156 reports them through `env(safe-area-inset-*)`, 36-37px at the top and
  48px at the bottom on both screens, and `mobile/index.html` pads by those values.
  Older WebViews may report zero, which has not been tested and matters at
  `minSdkVersion` 24.

With the keyboard open the viewport shrinks from 905 to 559 CSS pixels, the bottom
inset drops to zero, and the composer and chips stay above the keyboard with the
top line unmoved. The composer's placeholder still names Shift+Enter, which is
desktop copy.

Over real Wi-Fi, with the phone and PC both on the same network and subnet:

| Case | Result |
|---|---|
| mDNS: PC advertises, `NsdBrowserPlugin` browses | Found `172.20.20.38:8843` |
| Correct pin | Opens, `TLSv1.3 TLS_AES_256_GCM_SHA384` |
| Wrong pin | Refused: "Server key does not match the paired key." |
| Echo through the bridge | p50 90.3ms, p95 123.6ms, worst 206.4ms |
| 1MB / 5MB frame | 351ms / 1,251ms |
| WebView `ws://` / self-signed `wss://` | Throws / times out |

ICMP ping to the PC averaged 26ms in the same session, with spikes to 84ms. Where
the rest of the echo time goes has not been investigated. Android reports
`ACCESS_LOCAL_NETWORK` as granted at `targetSdk` 36 with no prompt; `targetSdk`
37 has not been tried and may change that.

**Discovery succeeding says nothing about reachability.** The phone discovered
the PC while TCP to the same service was being dropped: ping and mDNS worked and
connections timed out. Pairing has to report "found this PC but cannot reach it"
as its own state, with the firewall as the likely cause.

Windows Firewall, from its event log: an inbound listener under this `node.exe`
on the Private profile produced a "Query User" Block rule at 19:30:30, changed to
Allow at 19:30:39 when the prompt was answered, separate from the rules the same
path already had for Public. So a rule is per path and per profile, and one
network change can prompt again. The phone's connections kept failing for a
short while after the Allow rule was listed, then succeeded with the same server
process. The reason for that delay was not established.

## Emulator spike results, 2026-11-05

Android 16 emulator (Pixel 9 Pro image, 4 cores, WebView 147, x86_64, host GPU).
An emulator on a desktop CPU flatters every number, and CDP's CPU throttle slows
the main thread but not the GPU or compositor, so 4x approximates a mid-range
phone without measuring one.

### Rendering: the unmodified desktop `ChatPane`

The desktop modules load with only `window.sertum` replaced. Fixture: seeded
synthetic items shaped like a working session. Scrolling is a 5-second
main-thread programmatic scroll at 3000px/s, not a touch fling, and covers only
part of the larger conversations. "New item" is one appended message, which
today repaints the whole conversation and blocks the composer for that long.

At 4x throttle:

| Items | DOM nodes | Open | New item | Scroll p50 / p95 |
|---|---|---|---|---|
| 400 | 3,307 | 414ms | 321ms | 16.7 / 16.8ms |
| 1,000 | 8,388 | 848ms | 861ms | 16.7 / 16.8ms |
| 2,000 | 16,758 | 1.7s | 1.8s | 16.7 / 16.8ms |
| 5,000 | 41,247 | 4.3s | 4.1s | 33.3 / 50ms |
| 20,000 | 167,011 | 19.1s | 20.6s | 200 / 267ms |

Unthrottled, 20,000 items opened in 6.9s with a 6.1s new-item stall and scrolled
at p50 33ms. Heap readings are omitted because `performance.memory` returned the
same bucketed 16MB at every size.

- **Full history cannot mean a full DOM.** The DOM has to be a bounded window
  of about 1,000 items, with older items paged from the daemon and released.
- **The repaint is the first thing to fix.** Scrolling holds to 2,000 items but
  a new item already stalls for 321ms at 400. Appends must be incremental. This
  also improves the desktop, which pays the same cost.
- **`content-visibility: auto` is not the answer.** It roughly halved open time
  but made scrolling worse: 2,000 items at 4x went from p50 16.7ms to 33.2ms,
  because scrolling forces deferred layout.

Both are now built; the results are in [conversation.md](conversation.md). React
Native remains the fallback if they disappoint on a real mid-range phone.

### Transport: a native socket pinned to one key

`PinnedSocketPlugin` (OkHttp, TLS 1.3 only, trust replaced by one SHA-256 SPKI
pin), against a Node `https`/`ws` server with a self-signed P-256 key:

| Case | Result |
|---|---|
| Correct pin | Opens, `TLSv1.3 TLS_AES_256_GCM_SHA384` |
| Wrong pin | Refused: "Server key does not match the paired key." |
| Echo through the bridge, 200 trips | p50 6.6ms, p95 12.7ms, worst 29.5ms |
| 1MB / 5MB frame through the bridge | 254ms / 1,036ms |
| WebView `new WebSocket('ws://…')` | Throws: insecure WebSocket from an HTTPS page |
| WebView `wss://` with a self-signed key | Refused |

The app's origin is `https://localhost`, so the WebView cannot carry this
traffic; the native socket is required, as designed. Loopback through the
emulator's 10.0.2.2 only, so no real Wi-Fi latency is included. TLS 1.3 arrived
natively in API 29 by general knowledge rather than a test here, while the
template's `minSdkVersion` is 24: raise it or test older releases.

### Discovery and firewall

`bonjour-service` 1.4.4 advertised and found itself on this PC's Wi-Fi in about
a second under Node 26. Multicast does not work on the emulator; the real-phone
section above has the first run of `NsdBrowserPlugin` against a real service.

Windows Firewall evidence, read from this machine while its Wi-Fi was Public:

- Rules are per executable path: each Node version has its own, and the same
  version at a different path has a different verdict. That supports the concern
  that Squirrel's versioned install folders re-prompt on each update, which
  remains untested on a packaged build.
- The dev `electron.exe` has inbound **Block** rules on the Public profile. A dev
  daemon would be refused on a Public network whatever the gateway does. Block
  rules also outrank Allow rules, so a later Allow would not fix it. The Wi-Fi
  has since become Private, and `electron.exe` has no rule of any kind there yet,
  so the actual daemon path through a firewall is still untested.

## Icons

`mobile/scripts/make-icons.mjs` generates all Android art from
`assets/icon-windows.svg`, so there is one source for the mark. It uses resvg:
ImageMagick delegates SVG to Inkscape where installed, which failed here, and its
built-in renderer drew solid black tiles while exiting 0. Look at the output.
