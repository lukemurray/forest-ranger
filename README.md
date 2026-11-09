# Forest Ranger

A desktop app for working across many git worktrees with AI coding agents — like
chat apps that organise work into projects, but centred on your **worktrees**.
Rust, built on [GPUI Kit](https://gpui-kit.com). (It replaced an earlier Electron
version; that code is in git history.)

## Run

```sh
cargo run            # first build takes a few minutes
```

Needs a recent stable Rust (`rust-toolchain.toml` pins `stable`; GPUI needs ≥ 1.93).
The first build also fetches libghostty-vt 1.0 (the terminal emulator, a prebuilt static
library from Ghostty's releases, checksum-verified) into `vendor/` via
`scripts/fetch-libghostty.sh`.

### Release app

```sh
scripts/bundle-macos.sh             # → dist/Forest Ranger.app (release build, ad-hoc signed)
scripts/bundle-macos.sh --install   # bump the patch version, build, copy to /Applications, commit the bump
scripts/bundle-macos.sh --install --minor   # …as a minor release instead (0.9.3 → 0.10.0)
scripts/make-signing-cert.sh        # once per Mac: a local signing identity
```

With the local signing identity, macOS keeps the app's privacy permissions (Downloads,
Desktop, Full Disk Access…) across rebuilds; signed ad-hoc, it asks again after each build.

The bundle carries only the agent adapters; it uses the `node`, `claude`, `codex`, `git`,
`gh` and `glab` on your machine.

### Agents

Chats talk to agents over [ACP](https://agentclientprotocol.com) through the npm
adapters in `agents/`, run with Node. They drive your installed CLIs and reuse their
logins (no API keys):

- **Claude** — your `claude` (Claude Code; found in ~/.local/bin, Homebrew or PATH;
  `CLAUDE_CODE_EXECUTABLE` overrides). Keep it current with `claude update` — the model
  list comes from it.
- **Codex** — your `codex` (`npm i -g @openai/codex` or `brew install codex`;
  `CODEX_PATH` overrides).

```sh
cd agents && npm install --omit=optional   # optional = the agents' own bundled engines
```

## Data

Everything lives in `~/.forest-ranger` (override with `FOREST_RANGER_DATA_DIR`):
`forest-ranger.db` (projects, worktrees, commands, integrations — created on first
run), `chats/<id>.jsonl` + `<id>.meta.json` (chat logs), `gpui-settings.json`,
`gpui-state.json` (open tabs and layout), `window-state.json`.

## What's here

Release by release in [CHANGELOG.md](CHANGELOG.md).

- **Sidebar** — projects as a collapsible tree of worktrees (labels, primary sprout,
  detached-origin names, last-activity times, working / unread / needs-answer dots).
  Resizable. Right-click menus (open in editor/terminal, reveal, rename, rename
  branch, remove worktree/project), hover ✦ review / + new worktree / rescan,
  double-click to edit a label, tooltips. Worktrees sync from `git worktree list`.
- **Chats** — Claude or Codex; sending in a saved chat resumes the agent's own
  context. Streaming markdown, tool runs folded into "N steps" strips with expandable
  output, inline diffs on agent edits, permission prompts, elicitation forms,
  model/mode/effort pickers (restored per chat), queue while working, ⌘↵ to steer
  into the running turn, Stop, attachments (paste/drag/+), slash commands, context/cost
  meter with Start fresh, ⌘F find, ⋯ Branch from here, plan strip. Open chats keep
  running across worktrees; idle agents stop after 30 min.
- **Title bar** — back/forward (⌘[ ⌘], ⌃- ⌃=), project / branch, ✦ Chat (▾ for the
  other agent and past chats), open in editor, ▶ run commands, ⋯, and Review / Files /
  Search buttons that open or close the side panel on that view (⌘B toggles).
- **Review panel** (⌘1 / ⌘2 / ⌘⇧F) — branch status vs base and tracking, stage /
  commit (⌘↵) / push / update from base, changes as folder trees with keyboard nav
  (`s` stages), commits vs a chosen base, Reattach, Push & open PR/MR, MR/PR + pipeline
  status via `gh` / `glab`; Files (file tree) and Search (git grep). Files open in the
  code editor (tree-sitter, ⌘S / ⌥⌘S); changes open as diff tabs (split/unified).
- **Palettes** — ⌘T / ⌘K jump to any worktree or project; ⌘P open a file or diff.
- **Tabs & window** — tabs and layout restored per worktree, preview tabs, drag tabs
  to reorder/move/split, resizable splits, double-click to rename; window bounds
  remembered; OS notification + Dock badge when a chat needs you.
- **Project view** — worktree cards with Editor / Terminal / run-command buttons, base
  sync bar (ahead/behind origin, Fetch/Update, recent commits), Branches tab
  (ahead/behind, + Worktree, delete, clean up merged), Settings tab (run commands, code
  host, review prompt), ✦ Review a branch.
- **Terminal tabs** (titlebar terminal icon, ⌃`) — your login shell in the worktree
  ([libghostty-vt](https://lib.ghostty.org)): 256/true color, selection (double-click
  word, triple-click line) + ⌘C (⇧-drag in mouse apps), ⌘V (bracketed paste), 10k lines of
  scrollback, input methods / dead keys, Kitty keyboard protocol, mouse reporting for TUIs.
  Run commands open in one unless set to "External terminal"; tabs reopen as fresh shells.
- **Settings** (sidebar footer) — theme, editor, external terminal, default agent and
  mode, GitHub / GitLab via the `gh` / `glab` CLIs.

Not here yet: a notarized/distributable build. Remaining parity notes from the port are in [docs/PARITY.md](docs/PARITY.md).

## Checks

```sh
cargo test
cargo run -- --check                                       # loads your data, read-only
FOREST_RANGER_DATA_DIR=$(mktemp -d) cargo run -- --agent   # live chat: persist → reopen → resume
```
