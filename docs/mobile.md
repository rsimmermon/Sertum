# The phone client

Evidence behind the "Phone client" section of [AGENTS.md](../AGENTS.md). The
phone is always a client of a `sertumd` on a PC; it never hosts a daemon,
agents or sessions. Only spikes exist so far: no gateway, pairing or phone shell
has been built.

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

The new-item stall still grows with conversation size, so the conclusions below
stand: bounded DOM window, incremental appends. Neither has been built, and the
real `ChatPane` has not been visually checked on this phone: the one attempt
stalled when the screen went to sleep.

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

The bounded window and incremental append are inferred from these sizes, not yet
built or measured. React Native remains the fallback if they disappoint on a
real phone.

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
