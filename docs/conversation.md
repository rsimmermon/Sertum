# The conversation view

Part of [Sertum's technical guide](../AGENTS.md), which states the rules this
file records the evidence for. Keep verified detail here and the invariant
there.

The truth plane extends from status to content without a new channel. Every
Claude, Codex and Grok pane renders the transcript as a conversation — user
and assistant messages, collapsed thinking, and tool calls paired with their
results. When the adapter still needs a PTY, it keeps running underneath and
collecting bytes, but there is no terminal/chat choice in the product UI.
Shell declines the conversation capability and remains a normal terminal.

What it reads is each agent's own transcript on disk, through
`main/adapters/conversation.ts` — the same class of source as a hook payload,
so this does not touch the two-planes rule. Record shapes were verified
against real files, not documentation: Claude's `message.content` blocks
(`text`/`thinking`/`tool_use`/`tool_result`, with `isMeta` and `isSidechain`
marking what is not conversation), Codex's `response_item` payloads
(`function_call`/`custom_tool_call` and their `*_output` twins paired by
`call_id`), and Grok's role-as-type records with `tool_calls` and
`tool_result` paired by `tool_call_id`. Injected context is skipped by its
tag opener, never by a blanket "starts with `<`", so pasted XML still shows —
Codex's `<recommended_plugins>` user record is excluded like its environment
preamble. Explicit TeX spans (`\[...\]` and `\(...\)`) are typeset by KaTeX
with trust disabled, while all surrounding transcript content remains text
nodes rather than injectable HTML. Markdown is rendered — see below for how a
message that should stay source is told apart.

The renderer polls `conversation:read` once a second while the view is on
screen, for the reasons Grok's event log established: the file may not exist
yet, watch semantics differ by platform, and one update per batch is the
point. Transcript resolution reuses `transcriptFor`, so a Claude session is
only ever matched exactly and a shell never inherits another agent's
transcript.

Conversation reads keep complete transcripts up to a 32MB safety ceiling and
cache the parsed snapshot by file size and mtime. A fixed 512KB tail was not a
complete-turn boundary: one image-generation result embeds a multi-megabyte
data URL in a single JSONL record and pushed the user's prompt, tool call and
earlier conversation out of view. Structured `data:image/*` fields in tool
results now become `image` chat items and render as bounded previews; ordinary
prose is never interpreted as an image URL. Beyond the ceiling, the tail and
its truncation notice remain the honest bounded fallback.

Conversation content opts back into native text selection (`user-select:
text`) beneath the app-wide chrome rule that prevents accidental interface
selection, Chromium descendants included. The selection tint uses the solid
accent with the theme background as its text color — the soft accent matches
the user bubble and hides selection — so copied text is visibly selected in
both themes; composer controls remain outside that surface. Transcript polls
defer replacing conversation nodes while the reader has selected text, then
catch up once the selection is cleared.

Input still goes to the PTY, and the byte sequence matters. The composer
sends the body as a bracketed paste and the final CR **separately, a beat
later** (150ms), so it arrives as a real Enter press. Encoding newlines as
ESC CR with a trailing CR in one burst was tried first and failed silently:
Claude's TUI read the whole burst as a paste, swallowed the CR into it, and
left the message sitting unsent in its composer. The delayed Enter boundary
applies to single-line messages too — Codex 0.153.0 visibly accepted a
one-write `text + CR` into its composer but did not submit it, leaving plane
2 at the startup `turn finished` state and writing no transcript — so the
body is one write, bracketed only when multiline, and CR always follows as a
second write.

The composer carries **one button with two jobs**, at the right edge of the
box you type into — the control that acts on a turn sits where the turn is
composed. Text in the composer makes it a paper plane that sends; an empty
composer during a turn makes it a red square that stops. The two are never
both available, so a second button would always be dead, and the composer's
own content is the signal: it flips on the first keystroke and back on the
last backspace.

Stop calls the declared `turn-interrupt` capability and never writes Ctrl+C
or Escape into the PTY. The square stays on screen when the agent declines
that capability — disabled, carrying the adapter's reason — because that
reason is user-facing copy and hiding the button would hide it. Being a sign
rather than a word, both modes put their reason in `aria-label` as well as
the tooltip.

A waiting bubble — three bouncing dots and the session's `activity` line —
sits at the tail of the conversation while plane 2 says the agent is working.
This is the truth plane at conversation scale, and the same rule applies as
everywhere else: the dots are on because an adapter reported a turn in
progress, never because output went quiet. The caption is the same string the
sidebar reads, so a pane cannot disagree with the dot beside it. A
`needs-input` session is deliberately *not* shown as waiting — it is not
working, it is waiting on the reader, which the status dot and B5's bar
already say. The bubble is one long-lived element re-appended on each repaint
rather than rebuilt, so the transcript poll does not restart its animation
once a second.

Before the transcript has conversational content, the pane renders a
Sertum-owned welcome card from the session's real identity, cwd and model
metadata. Agent startup protocols (Claude's `system/init` included) report
readiness and identity but do not send the terminal's welcome banner as an
assistant message, and the banner is not parsed from terminal pixels.

`conversation-view` is a declared capability: Claude, Codex and Grok answer
ok (Grok's read-only event plane is exactly what a read-only view asks for);
a shell declines with its reason on the disabled button. Monitored sessions
get the view too — the transcript is on disk whoever owns the process, which
is the property that already let discovery summarise them — with the
composer disabled and saying where input actually lives, so selecting a
monitored row no longer jumps to its owning window while its conversation is
up.

What stage 1 deliberately does not do: no synthetic "pending" messages (a
sent message is acknowledged under the composer until the agent records it),
and no structured input channel — that is stage 2, below.

## A poll carries a version, not the conversation

The once-a-second poll used to fetch the whole snapshot every time, and
that is what locked the GUI up. Measured, not estimated:

| Transcript | items | snapshot | per pane at 1 Hz |
|---|---|---|---|
| Claude, 31MB on disk | 400 | 0.38 MB | 0.4 MB/s |
| Claude, 8MB on disk | 379 | 0.29 MB | 0.3 MB/s |
| Codex, 93MB on disk | 60 | **9.32 MB** | **9.3 MB/s** |

The Codex figure is the one that matters, and it is 99.7% `image` items —
9.29MB of base64 across 60 items, against 0.03MB of text. `ITEM_CAP` bounds
how many items a snapshot carries and `TOOL_CAP` bounds a tool's detail, but
neither bounds an image, so a session with pasted screenshots produces a
snapshot two orders of magnitude larger than a chatty one.

Every open pane was being sent all of that every second, whether or not a
byte had changed, and the GUI's **main** process parsed it on the main
thread inside the socket's `data` handler. One core saturated, the event
loop starved, the window stopped pumping messages — Windows reported it Not
Responding and flagged it under `RADAR_PRE_LEAK_64` — and pending requests
ran out the 30s `REQUEST_TIMEOUT_MS` until the pipe dropped and reconnected
into the same flood. A captured stack of the spinning thread was
`onStreamRead → Readable.push → addChunk → maybeReadMore`, and the daemon,
idle with no client attached, grew ~40 MB/s the moment one connected.

So `conversation/read` takes `{ id, known }`. `known` is the `version` the
pane already holds — the transcript's `size:mtime`, the same pair the parse
cache already keys on, named once by `versionOf` so a poll's "unchanged" and
a cache hit cannot disagree about what identity is. When it still matches,
the answer is `{ unchanged: true }`: **18 bytes instead of 9.32MB, a
543,117× reduction on an idle conversation.** A transcript only changes when
the agent writes, so that is the overwhelmingly common answer.

Two details are load-bearing:

- **The pane remembers the version only once the snapshot is on screen**,
  beside `renderedKey` rather than where the answer arrives. Recording it on
  arrival would have the next poll answer "unchanged" for a conversation the
  pane never drew — and since a poll already defers repainting while the
  reader holds a selection, a selection held across a turn would strand them
  on stale text until the agent happened to write again.
- **`noConversation` answers carry a null version** and are always sent.
  They are empty, so there is nothing to avoid re-sending, and gating them
  would mean inventing an identity for a file that is not there.

This changed the wire shape, so `DAEMON_PROTOCOL` is 4. A protocol 3 daemon
would read `{ id, known }` as an id, find no session, and answer every poll
"Session not found." — which is why the handshake refuses rather than tries.

The GUI's frame decoder was the other half of the collapse and is fixed with
it. `DaemonClient` held its partial frame in an **instance** field and
rebuilt it with `buf.slice()` per frame, which re-copies the whole remainder
every time — O(n²) across a burst of megabyte frames, on the main thread.
Worse, an instance field outlives the socket that filled it: half a frame
left by a dropped connection was still there when the next socket arrived and
was glued onto the front of the new stream. The buffer is now a per-connection
list of `Buffer` chunks, walked once and joined only at a frame boundary; a
newline byte cannot fall inside a multi-byte UTF-8 sequence, so cutting on one
before decoding is safe. Verified against the real class with a fake daemon
chunking at hostile boundaries: a 9MB frame, a multi-byte character split
across a chunk cut, a frame immediately after the big one, and a blank line
between frames all survive.

## Typing while the agent is busy: the queue

A turn in progress used to make the composer a dead end — `chat/send` refused
the message and the note said to finish or stop the turn and try again — so a
thought you had while reading had to be held in your head. A message typed
then is now queued instead, and goes in at the next moment the session can
take one.

- **Receivable is read, not guessed.** `working` and `needs-input` both
  defer; a session waiting on an approval is as unable to take a prompt as
  one mid-answer. It comes from `SessionSnapshot.status`, so this is the
  adapter's own word and not an inference from output going quiet.
- **One message per turn boundary.** Delivering starts a new turn, and the
  pane's snapshot does not say so until the daemon's next event — so draining
  the whole queue on one boundary would fire every message into a session
  that stopped being receivable after the first. The rest follow on the
  boundaries after it.
- **The flush is driven by the session event, not by the render.** Panes are
  only updated while they are on screen, so `app.ts` also hands the update
  straight to the pane; without that, a message queued before switching tabs
  would sit there until someone looked at it again.
- **The stop sign has one job.** A press stops a running turn through the
  declared `turn-interrupt` capability. Queued messages are not recalled or
  rewritten by stop; they remain queued for the next turn boundary.
- **Queued messages are visible and individually removable.** Each queued
  message is rendered below the transcript as a user-style bubble with an ×
  control in its corner. Clicking that control removes only that entry from
  the renderer-owned queue. The queue can therefore be edited without
  changing the stop action or disturbing the order of the other messages.

The queue is per pane, in the renderer. It does not survive the window
closing, which is the honest limit of putting it there and the same one pane
occupancy already has; moving it into the session fabric would make it
survive, at the cost of a protocol change and a snapshot field.

Attachments follow the same draft and queue lifetime. A paperclip opens a
native multi-file picker; pasting a clipboard bitmap or files into the
textarea adds them without turning their paths into editable prompt text.
Every attachment is a removable chip before send and remains visible on a
queued message. Ten files is the per-message bound. Clipboard bitmap bytes are
spilled under the OS temp directory and swept after a day, while files picked
from disk stay where the reader selected them.

The renderer carries only `{path, name, size, kind}` descriptors. `sertumd`
re-stats each path, determines image kind from magic bytes, rejects a missing
file or a native image above 7MB, and only then starts the turn. Base64 never
crosses the GUI/daemon socket. Claude receives verified PNG, JPEG, GIF and
WebP files as base64 image content blocks before the text; Codex receives its
documented `localImage` input. Ordinary files have no shared binary input in
these coding-agent transports, so the turn names each one with an absolute
path and the agent's normal read/permission flow applies. PTY-backed agents
receive image and file paths the same way. An attachment-only send gets a
small explicit review request so it still produces an honest user message in
the transcript.

Status: attachment classification, validation, prompt labelling and Codex's
exact `localImage` request shape are fixture-tested. Claude Code 2.1.268 and
Codex CLI 0.154.0 also completed real structured turns carrying
`assets/icon.png` through their native image inputs. The queue has **not** yet
been exercised against a live agent turn.

## Markdown, and when the markup is the answer

Stage 1 showed every message as literal characters, on the principle that
inventing formatting the agent did not send is the same class of mistake as
inventing a commit message. That principle stands; the conclusion drawn from
it was wrong. Agents emit `##`, `-` and fenced blocks *deliberately* — that
markup is theirs, not ours — so printing it as characters is the same
misrepresentation pointed the other way. The mistake would be adding
structure to text that has none, and that is what the classifier exists to
avoid.

`main/adapters/markdown-format.ts` stamps each assistant message with a
`MessageFormat` — `text`, `markdown` or `markdown-source` — from two signals,
both read from the transcript, never from pixels:

- **The message's own syntax.** No constructs means no decision: the message
  is `text` and takes the original plain path. The inline patterns require a
  non-space beside each delimiter and a non-word character outside the
  underscore forms, so `snake_case_names` and `a * b * c` stay prose.
- **The request the turn answers**, which says whether the markup is the
  subject rather than the presentation. "Give me the markdown for a table"
  wants characters; "summarise this in markdown" names a house style and
  wants a summary. A request to *render* is asked first and settles it, so
  "render the markdown" is not read as a request for source by the phrase it
  contains.

The narrower signal costs nothing to trust: **a fenced block is always shown
as code, ```markdown included.** That fence is the agent's own declaration
that these characters are the subject, so an answer *about* markdown needs no
heuristic at all — only a whole reply that is unfenced source falls to the
request test.

Neither signal is load-bearing. A guess about intent will sometimes be wrong,
so every classified message carries a toggle: source mode is set in the mono
face — the only way a markdown table's columns line up — and a message shown
as source because the request asked for source says so, or being handed
characters reads as the app failing. A user's own message is never
classified; they typed those characters into the composer, and handing them
back reformatted would hide what was actually sent.

`renderer/message-text.ts` owns both paths, so the rule they share cannot
drift: **nothing is ever assembled as an HTML string.** Every node is created
and every leaf filled through `textContent` or a text node, so raw HTML in a
message is shown as the characters the agent wrote. Verified against a
message carrying `<img src=x onerror=...>` and a `<script>` tag: both come
out as escaped text with no element created. Two things are deliberately not
rendered — a bare URL does not become a link, and a remote image is not
fetched, both being the renderer acting on an address out of a transcript.
Only http(s) links become anchors, matching what `shell:open-external`
accepts, so the app never draws an affordance that would silently fail; every
other address keeps its label and carries its target in a tooltip. Newlines
inside a paragraph stay line breaks rather than being reflowed, because
reflowing an agent's deliberate line breaks is exactly the invented
formatting this view exists to avoid.

Three constructs used to render *wrongly* rather than merely plainly, which
is the worse failure and the reason they are called out here:

- **A setext underline.** `Sub Title` over `---------` produced a paragraph
  *and* a horizontal rule. The underline now closes the paragraph above it as
  a heading, which is where it outranks the thematic-break reading of `---`.
  A `---` after a blank line, with no paragraph above it, is still a rule.
- **`\[` is display math in TeX and an escaped bracket in markdown**, and
  agents write both. Nothing in the delimiters says which, so the content
  decides: real math carries operators, digits or a backslash macro, and a
  single token with no spaces is a variable. `\[not a link\]` has none of
  that and goes to the escape rule. The asymmetry is deliberate —
  typesetting a sentence as an equation is far worse than leaving one that
  was meant as math — and it applies on the plain path too, so a `text`
  message cannot be turned into algebra either.
- **Four-space indented code.** Read as a paragraph, the inline pass ran over
  it and `*ptr` became emphasis, altering the code on screen. A line that is
  also a list item is still a list: an agent indenting a whole list is
  commoner here than one relying on indented code.

**Links and images are scanned with balanced brackets, not matched with a
regex.** A link's label can contain brackets, and the commonest case is an
image wrapped in a link — which is what every badge is. A `[^\]]*` label
stops at the image's own `]`, so `[![alt](src)](href)` produced a link
captioned `![alt` pointing at the *image*, with the real address left as
characters. The scanner counts depth and skips escapes, and the same routine
serves images, links, and both by reference.

Reference links (`[text][label]`, `[text][]`) and reference images
(`![alt][label]`) resolve against definitions lifted out of the flow
alongside the footnote ones. An undefined reference stays literal text, the
same answer an orphan footnote gets. The shortcut form (`[label]` alone) is
deliberately not supported — it would swallow ordinary bracketed prose — and
neither is a bare URL linked.

**Dollar-delimited TeX** is supported, because agents emit `$...$` far more
often than `\(...\)`. `$$` is unambiguous and is handled both inline and as a
block opened by `$$` alone on a line — the inline rule cannot see that form,
since a paragraph reaches the inline pass one line at a time. A single `$` is
ambiguous, because money looks the same, so it must hug its content, must not
be followed by a digit, and must contain a character belonging to TeX rather
than to a price. That last test is deliberately stricter than `looksLikeMath`:
a digit alone is enough to call `\(2\)` math, but would typeset "$5 and $10"
as well.

**Character references are decoded from a table**, not by handing a string to
an HTML parser, which keeps the promise at the top of `message-text.ts`
literally true. A reference the table does not know stays as written, and a
code span keeps every character it was given — decoding happens on prose runs
only. Decoded angle brackets are still text: `&lt;tag&gt;` shows `<tag>` as
characters and creates no element.

GFM footnotes are supported. Definitions are lifted out of the block flow
before parsing — a definition is not a paragraph wherever the agent happened
to write it — and the *references* fix both the numbering and the order,
because that is the order a reader meets them in. A reference whose
definition is missing stays literal text: inventing a marker for a note that
does not exist is the same mistake as inventing formatting. A definition
nothing referenced is still listed rather than dropped, since it is something
the agent wrote. Marks scroll within the pane rather than navigating, so they
are buttons wired to their elements — an `href="#id"` would need ids unique
across every message on screen and would move the renderer's own URL — and a
brief highlight is what says "here" when nothing scrolled.

## A local image is shown; a remote one stays a link

A markdown image carries an address written by the agent, and the two useful
answers are different for different addresses:

- **`data:`** — already trusted from structured tool results, shown directly.
- **A readable local file** — read by `main/local-image.ts` and returned as a
  `data:` URL, so what reaches the renderer is the same trusted shape.
- **Anything else** — remote, missing, outside the session's folder, or not
  actually an image — keeps the labelled link it already had.

The read happens in the main process because the renderer is a web page: it
cannot open a `file://` path, and letting it fetch an arbitrary address out of
a transcript is exactly what the conversation view avoids. The link is
rendered synchronously and *upgraded* to a picture only if the read succeeds,
so every way it can fail leaves the link that was already there — the failure
mode and the fallback are the same thing.

Three bounds, each failing to `null`:

- **Scope is the session's own folder.** The path resolves against the cwd
  from `SessionSnapshot` — never a value the message supplied — and must
  still be inside it, so a transcript cannot widen its own reach. Without
  that check, message text could make the app read any file on disk and hand
  it to the renderer. Worktrees beneath a repository are covered by the same
  prefix test the permission rules use. **This is narrower than "anywhere on
  the machine"**; a temp-dir screenshot outside the folder stays a link.
- **It must actually be an image**, decided by magic bytes rather than the
  extension, so a `.png` that is really something else is not sent. SVG is
  deliberately never inlined: it can carry script, and this is a page.
- **It must be small enough to inline** (8MB), since a data URL is base64 in
  the renderer's memory.

Resolved reads are cached, so the once-a-second repaint does not re-read a
file per image. A file that changes on disk keeps the bytes the message was
first shown with, which is the right answer for a transcript: it records what
the agent produced, not what that path holds now.
