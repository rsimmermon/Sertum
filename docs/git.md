# Committing, and opening a pull request

Part of [Sertum's technical guide](../AGENTS.md), which states the rules this
file records the evidence for. Keep verified detail here and the invariant
there.

C15 is reached from C11's Commit & push button and writes through Git alone
(`main/diff-review.ts`). Four decisions are worth keeping:

- **The inventory on screen never authorises the write.** `commitDiff`
  re-resolves the repository and re-reads its changes before touching
  anything, exactly as `discardDiff` does. A path the user chose that Git no
  longer reports as changed fails the whole commit rather than being dropped
  quietly -- a commit silently missing a file someone selected is worse than
  one that did not happen.
- **The commit is pathspec-limited.** `git commit -- <paths>` means a file
  staged outside Sertum stays in the index instead of being swept in. C11 has
  no hunk selection, so a chosen path is committed whole. Untracked paths are
  staged first, since a pathspec commit only accepts paths Git already knows.
- **Committing and pushing are reported independently.** `DiffCommitResult`
  carries the commit and the push outcome separately, so a commit that lands
  behind a push that fails is shown as exactly that. The sheet stays open
  saying "Committed <sha>. Not pushed -- <reason>" instead of implying the
  work was lost.
- **The push destination is resolved before it is offered, not assumed.**
  `resolvePushTarget` prefers the branch's upstream, adopts a lone remote
  explicitly, and otherwise declines with a reason; the same answer labels the
  checkbox and performs the push, so the control names where the push will
  actually land rather than promising `origin`. Verified against real repos in
  all six states, including detached HEAD and two remotes with no upstream.

Sertum does not compose the commit message. The sheet opens with an empty
field and a placeholder: an invented summary would be committed under the
user's name, and inferring one from a terminal is what the two planes forbid.
No trailer of any kind is appended.

## C16 goes through the GitHub CLI

`main/pull-request.ts` shells out to `gh` rather than calling the REST API,
for one reason: **`gh` already owns the credential**. Reimplementing auth here
would mean discovering, storing or prompting for a token the user has already
handed to a tool built to hold it.

Two things the CLI's contract dictates, both verified against gh 2.89.0:

- **`gh pr view` exits 1 when a branch has no pull request**, printing to
  stderr, so it cannot distinguish "none" from "failed". Existence detection
  uses `gh pr list --head <branch> --json ...`, which exits 0 and returns `[]`.
- **`gh pr create` cannot open a request for commits GitHub has never seen**,
  and running it non-interactively means its own offer to push simply fails.
  Rather than refuse, the sheet says so on its button -- "Push and create pull
  request" -- and performs the push first, reusing the same `pushBranch` and
  the same resolved target C15 uses.

Every other precondition is answered before the sheet offers anything, in the
same spirit as a declined agent capability: no `gh`, signed out, detached
HEAD, sitting on the default branch, or a branch that already has a pull
request each produce a reason the user can act on rather than a button that
fails when pressed.

Title and body are seeded only from a **lone** commit's own subject and body.
Those are the user's words. Several commits have no such answer, so the fields
stay empty rather than being invented -- the same rule the commit message
follows.

`shell:open-external` was added for the resulting URL and is restricted to
http(s). `shell.openExternal` hands any other scheme to whatever the OS
registered for it, which is how a renderer bug or a hostile string turns into
launching a local program -- and these URLs come from `gh`'s output.
