# Forest Ranger — GPUI Kit port

Forest Ranger's core UI in Rust on [GPUI Kit](https://gpui-kit.com), growing toward
feature parity with the Electron app (except the terminal, for now).

```sh
cd spike-gpui
cargo run            # first build takes a few minutes
```

It **shares `~/.forest-ranger` with the Electron app** — same SQLite DB, same chat
logs (`chats/<id>.jsonl` + `<id>.meta.json`, identical format), so chats started in
either app show up in both. Don't have the same chat open in both apps at once.

What's here:

- **Sidebar** — projects as a collapsible tree of worktrees (labels, primary sprout,
  detached-origin names, last-activity times, chat dots), Electron's palette, follows
  the system light/dark setting. Resizable. Right-click menus (open in editor/terminal,
  reveal, rename, rename branch, remove worktree/project), hover + (new worktree
  dialog) and rescan, double-click to edit a label.
- **Chats** — open saved chats or start new ones (Claude or Codex). Sending in a saved
  chat resumes the agent's own context. Streaming markdown, tool calls, permission
  prompts, model/mode/effort pickers (restored per chat), queue while working,
  ⌘Enter to steer into the running turn, Stop, and the context/cost meter. Open chats
  stay running when you switch worktrees. Tool runs fold into "N steps" strips with
  expandable output, inline diffs on agent edits, expandable thinking, copy buttons
  on code blocks, pinned turn question, time dividers, plan strip, forest-word
  activity, image lightbox. Legacy `<id>.json` logs are migrated on open. ⌘F find,
  elicitation forms, ⋯ Branch from here, Start fresh (meter menu, cold-cache banner),
  queued items with Steer now / Cancel, idle agents stopped after 30 min.
- **Title bar** — back/forward (⌘[ ⌘]), project / branch, ✦ Chat (▾ for the other
  agent and past chats), open in editor, ⋯ (Reveal in Finder), panel toggle (⌘B).
- **Review panel** (⌘1 / ⌘2 / ⌘⇧F) — branch status vs base and tracking, stage /
  unstage / commit, push, update from base (rebase or merge), changed files and
  commits vs a chosen base; Files (filter all files) and Search (git grep). Files
  open in the kit's code editor (tree-sitter, ⌘S saves); changes open as diff tabs.
  Changes as folder trees with keyboard nav (`s` stages), ⌘↵ commits, Reattach,
  Push & open PR/MR, filterable base picker.
- **Tabs & window** — tabs, MRU focus and panel state restored per worktree
  (`gpui-state.json`); preview tabs (italic, double-click pins); split/unified and
  full-file diffs; ⌥⌘S saves all; window bounds shared with Electron's
  `window-state.json`. Double-click a tab to rename it. Working / unread / needs-answer
  dots on tabs, worktrees and projects; OS notification and Dock badge when a chat
  needs you while the window is in the background. Drag tabs to reorder, move between
  groups, or split a pane by dropping on its edge; resizable splits; layout saved per worktree.
- **Settings** (sidebar footer) — theme, editor, external terminal, default agent;
  per-agent default mode; saved to `~/.forest-ranger/gpui-settings.json`. **+** adds a project.
  Integrations: per-provider host, gh/glab sign-in, Test connection.
- **Project view** (click a project name) — worktree cards with Editor / Terminal / run
  buttons; base sync bar (ahead/behind origin, Fetch/Update, recent commits); Settings
  tab with run commands, code host and review prompt. Run commands (▶ in the title bar)
  open in the external terminal. ✦ Review a branch starts a review chat in its worktree.
  Branches tab (local/origin groups, ahead/behind, + Worktree, delete with force confirm,
  clean up merged).
- Worktrees are synced from `git worktree list` into the shared DB, like Electron.

Not here yet: terminal (in-app run commands go external), Home.

Agents: Claude uses the standalone adapter in `vendor/claude-agent-acp/` when present
(no Node needed — from `claude-agent-acp-darwin-arm64.zip` on
github.com/agentclientprotocol/claude-agent-acp/releases; keep only `claude-agent-acp`,
not the bundled `claude`). It runs your installed `claude` CLI (found in ~/.local/bin,
Homebrew or PATH; `CLAUDE_CODE_EXECUTABLE` overrides). Without either, Node runs the
npm package from `../src/node_modules`. Codex always needs Node (no standalone build).
`FR_CLAUDE_ACP` points Claude at another adapter binary.

Checks (no UI):

```sh
cargo run -- --check                                   # loads your real data, read-only
FOREST_RANGER_DATA_DIR=$(mktemp -d) cargo run -- --agent   # persist → reopen → resume
```
