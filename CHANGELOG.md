# Changelog

What changes in each release of Forest Ranger. Newest first; every change adds a line
under the version it will ship in.

## 0.14.1 — unreleased

### Fixed
- Plan approvals show the plan as Markdown (scrolling when long) instead of a cut-off
  line of JSON.

## 0.14.0 — 2026-11-10

### Chats
- Pin an agent message (the pin on hover, or ⋯ → Pin) to keep it in a strip at the
  top of the chat while it goes on: read it in full there, Jump to it, Open beside
  (a read-only tab split next to the chat), or Unpin. Pins are saved with the chat.

### Fixed
- C# files had no syntax highlighting (the grammar parsed but had no colour rules);
  they're coloured again, in the editor and in diffs.

## 0.13.0 — 2026-11-09

The first changelog entry: everything Forest Ranger does today.

### Sidebar
- Projects as a collapsible tree of worktrees: labels, primary sprout, detached-origin
  names, last-used times, working / unread / needs-answer dots. Resizable; expanded
  projects and where you were are restored on launch.
- Worktrees ordered by last use — git activity or chat activity, whichever is newer;
  a chat starting work moves its worktree to the top.
- A terminal running something shows the working dot on its worktree and project.
- A worktree's state reads in words where its time goes — **working** (pulsing),
  **ready**, **needs you** — and a finished or waiting one has its name in bold.
- Each project shows how many open MRs/PRs need you (polled every 3 minutes).
- Right-click menus (open in editor/terminal, reveal, rename, rename branch, remove
  worktree/project); hover ✦ review / + new worktree / rescan; double-click to rename.

### Chats
- Claude or Codex over ACP, using your installed CLIs and their logins. Sending in a
  saved chat resumes the agent's own context.
- Streaming markdown, tool runs folded into "N steps", inline diffs on agent edits,
  permission prompts, question forms (single- and multi-select), model / mode / effort
  pickers, queue while working, ⌘↵ to steer, Stop, attachments, slash commands,
  context/cost meter with Start fresh, ⌘F find, Branch from here, plan strip.
- Open chats keep running across worktrees; idle agents stop after 30 minutes.

### Title bar
- Back / forward, project / branch, ✦ Chat (▾ for the other agent and past chats),
  open in editor, new terminal.
- Run commands as buttons, or a split ▶ button past two that reruns the last one used.
- Review / Files / Search as a segmented control: opens the side panel on that view,
  or closes it (⌘1 / ⌘2 / ⌘⇧F; ⌘B toggles).

### Review panel
- Branch status vs base and tracking, stage / commit (⌘↵) / push / publish / update
  from base (rebase, merge or agent merge), changes as folder trees with keyboard nav,
  commits vs a chosen base, Reattach.
- MR/PR and pipeline status via `gh` / `glab`, Push & open MR/PR, and "Re-review latest"
  to check new commits against the review threads.
- Files (file tree) and Search (git grep). Files open in the code editor (tree-sitter,
  ⌘S); changes open as diff tabs (split / unified).

### Project page
- Merge requests / Pull requests tab (the default): open MRs sorted by what they need
  from you, with Open worktree / Review.
- Worktree cards with editor / terminal / run-command buttons, base sync bar, Branches
  tab (ahead/behind, + Worktree, delete, clean up merged), Settings tab (run commands,
  code host, review prompt), ✦ Review a branch.
- Clean up worktrees: fetches first, asks the code host which MRs/PRs merged (squash
  merges included), and ticks only the merged ones; pushed or not-yet-started worktrees
  are listed unticked.

### Tabs, terminals and window
- Tabs and split layout restored per worktree, preview tabs, drag to reorder / move /
  split, rename; cycle with ⌘⇧] / ⌘⇧[ and ⌃Tab.
- Terminal tabs on libghostty-vt: true color, selection, paste, 10k lines of
  scrollback, input methods, Kitty keyboard protocol, mouse reporting.
- Asks before closing a tab whose agent is working or terminal is running, before
  quitting with anything busy, and warns when removing a busy worktree.
- ⌘T / ⌘K jump to a worktree or project; ⌘P open a file. OS notifications and a Dock
  badge when a chat needs you.

### Fixed
- Syntax highlighting for `.csproj` / `.props` / `.targets` (as XML), C and C++
  (`.c`, `.h`, `.cpp`, `.hpp`…) and `.mdc`, in the editor and in diffs.

### Settings
- Theme, editor, external terminal, default agent and mode, GitHub / GitLab via the
  `gh` / `glab` CLIs.
