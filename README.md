# Sertum

One window for every coding agent you have running.

Sertum is a desktop app for managing Claude Code, Codex, and Grok sessions across
different projects and Git worktrees. Every session gets a real embedded
terminal, while agent events provide reliable at-a-glance status such as
working, idle, or waiting for input.

![Sertum social preview](assets/github-social.png)

## What you can do

- Run Claude Code, Codex, and Grok side by side in one desktop window.
- Keep sessions organized by project, folder, and worktree.
- See which agents are working or need attention without reading terminal
  output heuristically.
- Create isolated worktree sessions from the New Session dialog.
- Discover supported agent sessions that were started outside Sertum.

## Requirements

Before starting Sertum, install:

- [Node.js](https://nodejs.org/) with npm
- [Git](https://git-scm.com/)
- At least one supported coding agent:
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code),
  [Codex](https://developers.openai.com/codex/), or
  [Grok](https://docs.x.ai/docs/grok-cli)

Make sure each agent you intend to use is installed and authenticated in your
normal terminal. Sertum searches your `PATH` and known installation locations;
Grok's default `~/.grok/bin` installation is supported even when it is not on
`PATH`.

Sertum's terminal and agent integrations are currently verified on macOS and
Windows.

## Run from source

Clone the repository, install dependencies, and start the Electron app:

```sh
git clone https://github.com/rsimmermon/Sertum.git
cd Sertum
npm install
npm start
```

The Electron Forge startup process rebuilds native dependencies such as
`node-pty` for the installed Electron version when needed.

## Start your first session

1. Launch Sertum with `npm start`.
2. Choose **New Session**.
3. Select a working folder with the native folder picker.
4. Choose Claude Code, Codex, or Grok.
5. Select the desired isolation option. Use the existing folder for ordinary
   work, or create a worktree when the task should be isolated.
6. Start the session and interact with the agent in its embedded terminal.

Sertum resolves installed agent binaries automatically. If an agent is not
found, open **Settings > Agents** to detect it again or select its executable
manually.

## Useful commands

```sh
npm start       # Run the app in development mode
npm run lint    # Lint the TypeScript source
npm run package # Build an unpacked application bundle
npm run make    # Create platform-specific distributables
```

## Current scope

Core terminal sessions and live status for Claude Code, Codex, and Grok,
external session discovery, binary configuration, and worktree management are
working. Diff review, additional settings, and split-pane layouts are still
planned.

## Contributing and architecture

The canonical technical guide is [AGENTS.md](AGENTS.md). It documents the
two-plane architecture, process lifecycle, agent adapters, external-session
discovery, worktree behavior, platform details, design references, and known
implementation constraints. It provides shared project context for Claude
Code, Codex, and Grok.

The UI source of truth is `SertumDesigns.pen` at the repository root. Frame
identifiers in source comments refer to frames in that file.
