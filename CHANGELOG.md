# Changelog

What changes in each release of Forest Ranger. Newest first; every change adds a line
under `## Unreleased`, which the install script stamps with the version and date.

## 0.17.2 — 2026-11-12

### Fixed
- Desktop notifications were never shown: the old macOS notification API delivers
  nothing on current macOS. They now use the current one (Forest Ranger asks for
  permission once), and Settings → General says when macOS has notifications turned
  off for the app, with a button to System Settings.

### Review panel
- Files follows the tab you're on: switching to a file or diff tab opens its folders
  in the tree, scrolls it into view and marks it.

### Chats
- The / menu finds every command the agent offers, not just the first few skills:
  best matches first (exact, then names starting with what you typed — shortest first,
  so `/m` offers `/mcp` and `/model` — then parts like `/review` → `mr-review`, then
  anywhere), a scrolling list, and ↑ / ↓ with Tab or Enter to complete.

## 0.17.1 — 2026-11-12

### Fixed
- Worktrees made outside the app (a terminal, an agent's `git worktree add`) show up
  in the sidebar and ⌘T on their own — checked when the window comes to the front and
  every minute — instead of only after a rescan or relaunch.
- Branch pickers keep their list open while you type, with an exact match first and
  marked ✓ — typing or pasting a full name no longer just closes the list (it looked
  like nothing matched).
- Review a branch finds branches pushed since your last fetch: it fetches origin in
  the background when it opens ("Checking origin for new branches…") and refreshes
  the list, keeping what you've typed.
- Tab and ⇧Tab in a terminal go to the shell (completion) instead of moving focus out
  of the terminal.

## 0.17.0 — 2026-11-11

### Sidebar
- One signal per source: a worktree's word and dot are always its agent's (working /
  ready / needs you, else the time), and a running terminal is only ever its own
  pulsing terminal icon (hover for what's running). No more "running" that could be
  either.
- A terminal command that ran 10s or more and finished while you weren't looking
  shows as finished: the terminal icon (on the row and its tab) gets a green dot until
  you open that terminal. Hover says what finished and when.

### Chats
- A message's time no longer pops up over the text you're reading: it shows faintly
  beside the message while you hover it (with the agent's actions, or next to your
  bubble); hover the time for the full date.

### Settings
- Desktop notifications when something's ready — a chat finished, or a long terminal
  run finished — while the app isn't in front; clicking one goes to that chat or
  terminal. Off by default (Settings → General). "Needs you" notifications (a
  permission or question waiting) are always on.

## 0.16.1 — 2026-11-10

### Sidebar
- A running terminal no longer hides a chat's state: the word (working / ready / needs
  you) is always the chat's, with a terminal icon beside it while one runs; with no
  chat to report, the row says **running**.

### Project page
- Branch pickers are type-to-search boxes — in Review a branch (focused when it opens)
  and New worktree's base branch: type (or ↓) for matching branches, paste an exact
  name to pick it, ↑ / ↓ and Enter to pick, Enter again to start / create.

## 0.16.0 — 2026-11-10

### Fixed
- Review on a merge/pull request is instant when its latest commit is already fetched,
  and works for PRs from forks (it fetched a branch name origin doesn't have).

## 0.15.0 — 2026-11-10

### Chats
- Mark an agent message unread (⋯ → Mark unread): the chat shows as ready again in
  its tab and the sidebar, and opening it later lands on that message.

### Review panel
- Re-review latest is a menu: in a new chat, or continue in the current chat (the one
  in view, else the last one used; queued if it's mid-turn).

### Tabs, terminals and window
- Pop a worktree out into its own window (titlebar ↗, or right-click → Open in new
  window): its tabs, splits and side panel without the sidebar. Running chats and
  terminals move across without restarting. The main window still lists it, greyed,
  with its working / ready dots; clicking it brings that window forward. Closing the
  window puts the worktree back in the main one. Popped-out windows reopen on the
  next launch, each where you last put it; removing the worktree closes its window.

### Fixed
- Review a branch: the branch picker has focus when the dialog opens.

## 0.14.1 — 2026-11-10

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
