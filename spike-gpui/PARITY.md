# GPUI parity plan

From the parity audit (Electron vs spike-gpui), 2026-11-06. Out of scope: terminal, Home, OAuth/token integrations, packaging.

I deduped about 95 reported gaps down to about 70 distinct items and grouped them into 11 packages over 4 waves. I verified some claims against the code (5 confirmed, 2 stale):
- Confirmed: files.rs:22-26 creates an editable empty buffer when the read fails, so a binary file can be overwritten. review.rs:376 clears the commit message before the commit runs. data.rs:291 set_label is never called. main.rs:992 opens a fixed 1440x900 window. ChatView emits no events at all.
- Stale: the ⌘T/⌘K/⌘P palettes now exist (palette.rs, main.rs:256-333, bindings at 976-978). The main.rs line numbers cited in the gaps are shifted by about +100.

Coordination rules that keep each wave's packages on disjoint files:
1. Each module can sit in its own file without touching main.rs. A new module under chat.rs goes in src/chat/<name>.rs, declared with `mod name;` inside chat.rs. The same works under sidebar.rs and project_view.rs.
2. sidebar.rs and any new file can add `impl ForestRanger` blocks and call main.rs's private methods (select, reload, sync_all, new_chat, open_diff), because they are descendants of the crate root.
3. Sidebar UI state such as an inline-edit InputState goes in a `Global` (as settings.rs:26 does), not in new ForestRanger fields.
4. Exactly one package per wave owns main.rs.
5. Wave 1 sets up the cross-wave APIs ahead of time, so wave 2 never depends on another package in the same wave:
   - the ChatEvent enum with all its variants
   - attention() and mark_read() on ChatView
   - the default_mode setting
   - settings::try_open_in
   - the session_state store

Waves:
- **Wave 1:** chat transcript, the ACP and log protocol, shell tabs/editor/window, sidebar and worktree actions, and the review panel.
- **Wave 2:** chat behaviour, shell integration (status dots, OS notifications, tab rename), and settings/code host.
- **Wave 3:** the project view, run commands and the review-a-branch flow.
- **Wave 4:** the Branches tab, and split panes with tab drag.

## Wave 1 · W1-A Chat transcript rendering (L)

**Owns:** spike-gpui/src/chat.rs  
**New:** spike-gpui/src/chat/transcript.rs, spike-gpui/src/chat/agent_diff.rs

**Gaps:**
- Tool output disclosure (high)
- Process strips / folded tool runs (high)
- Inline diffs on edit tools, rendering part (high)
- Message ⋯ menu: Copy text (high; Branch is in W2-A)
- Thinking block disclosure (medium)
- Sticky turn headers + long-message clamp (medium)
- Activity indicator, forest words (medium)
- Plan/todo strip (medium)
- Permission card details (medium)
- Copy button on chat code blocks (medium)
- Time dividers + message timestamps (low)
- Links in user messages (low)
- Image attachments: sent chip + lightbox (low)
- Blank / rule-only assistant chunks (low)
- API prep for W2: ChatEvent, attention/unread, custom title

**Brief:** Move row rendering out of chat.rs:522-608 into a new chat/transcript.rs, declared with `mod transcript;` in chat.rs.

1. Keep tool output and ts. The Row enum (chat.rs:24-32) and Rows::apply (49-108) currently drop the tool `output`/content, `ts`, oldText/newText (chat.rs:117-119) and the 'plan' event (acp.rs:498). Keep all of them.
2. Tool rows (ChatPane.tsx:1715-1753):
   - Header: glyph, title, then a one-line muted preview of the output.
   - Click toggles the full output, rendered with TextView::markdown.
   - A failed tool keeps its red first line.
3. Process strips (ChatPane.tsx:1347-1364, 1386-1427):
   - Fold a run of 2 or more consecutive tool rows into one collapsed '<N> steps · <last tool title>' strip.
   - The dot pulses (use an animation) while it is the live strip of a working turn.
   - Click expands the strip to show the individual tool rows.
4. Edit and Write tools (ChatPane.tsx:1702-1714, AgentDiff.tsx:20-55), in chat/agent_diff.rs:
   - Line-diff oldText against newText. The `similar` crate or a small LCS is fine.
   - Render an inline colored diff, open by default, per file: file name, +N/−N, unchanged runs collapsed to ⋯.
   - Add a 'View diff' button that emits ChatEvent::OpenDiff{path, old, new}. W2-B handles it.
5. Thinking (ChatPane.tsx:1660-1668): a collapsed 'Thinking' disclosure that shows the full text when expanded, replacing the 280-character truncation at chat.rs:557-561.
6. Hide assistant and thinking rows whose text trimmed is empty or only '---'/'***' lines (ChatPane.tsx:1924-1927). Strip thematic breaks before markdown (Markdown.tsx:84).
7. Code blocks: add `.code_block_actions()` to every TextView::markdown, so code blocks get a Copy button (the kit supports it; see gpui-base text_view.rs:384).
8. Message ⋯ menu (ChatPane.tsx:1635-1656) on assistant rows that have a messageId. Items:
   - 'Copy text', which writes the raw markdown via cx.write_to_clipboard.
   - 'Branch from here', which emits ChatEvent::BranchRequested(message_id). W2-A implements it.
9. Turns (ChatPane.tsx:1325-1339, 970-990): group rows into turns, each starting at a user row.
   - Render the turn's user bubble as a sticky header inside its turn container, until the next turn pushes it off.
   - Clamp user bubbles taller than about 80px, with a Show more / Show less toggle (1464-1509).
10. User text:
   - Linkify http(s) URLs, leaving trailing punctuation `.,;:!?)]` out of the link. Click calls cx.open_url (ChatPane.tsx:1431-1460).
   - Sent attachments show 🖼 for images (isImage) and 📎 for other files.
   - Clicking a composer thumbnail opens a full-size lightbox overlay, closed with Esc or a click (1106-1114, 1258-1262).
11. Time (ChatPane.tsx:1300-1323): put a divider before any turn that starts more than 1h after the previous row's ts. Show a tooltip with the clock time on message hover.
12. Activity indicator (ChatPane.tsx:876-902, 1000-1021):
   - Under the transcript, while working and not while assistant text is streaming: tree icon plus '<Word>…'.
   - The word rotates every 7s from the same forest word list and doesn't repeat any of the last 7.
   - Show 'Lacing up…' while starting.
13. Plan strip (ChatPane.tsx:1051-1067): above the composer, a collapsible 'Plan · d/n done' strip. Entries are marked ● done, ◐ in progress, ○ pending. The latest plan event replaces the previous one.
14. Permission card (ChatPane.tsx:1675-1699, 1929-1937):
   - Title 'Allow <tool>?'.
   - Detail line from rawInput: command, file_path, path, url or pattern, else JSON truncated to 300 chars.
   - Allow-kind buttons are primary or outline; reject-kind buttons are danger/ghost.
15. API prep for W2. Add `pub enum ChatEvent { OpenDiff{path,old,new}, BranchRequested(String), Branched{log_id:String,title:String}, StatusChanged, TitleChanged }` and `impl EventEmitter<ChatEvent> for ChatView`. Also add:
   - `pub enum Attention { NeedsAnswer, Working, Unread, Idle }` and `pub fn attention(&self)`. NeedsAnswer means a pending permission (elicitation is added in W2). Unread is set when a turn's result arrives while `!self.focused_by_user`.
   - `pub fn mark_read(&mut self, cx)`.
   - `pub fn set_custom_title(&mut self, Option<String>, cx)`. Persist it in the meta name, and stop auto-naming once it is set, as SessionWorkspace.tsx:136-143 does.
   - Emit StatusChanged whenever attention() changes.

Don't touch the composer queue logic (W2-A).

## Wave 1 · W1-B ACP + chat log protocol layer (M)

**Owns:** spike-gpui/src/acp.rs, spike-gpui/src/log.rs

**Gaps:**
- Elicitation, protocol side (medium)
- Fork / branch chat at a message, protocol + log side (high)
- Adapter crash / exit reporting (medium)
- Steer outcome: tag only on 'injected' (low)
- Mode picker fallback, session modes + set_mode (low)
- Codex initial permission mode (medium)
- Legacy .json chat logs (medium, data-compat)
- Meta updatedAt for untimestamped logs (low, data-compat)

**Brief:** Only add new public functions and event JSON shapes. The current signatures used by chat.rs must keep compiling.

1. Elicitation (agentChatAcp.ts:482-530, 588):
   - In initialize clientCapabilities (acp.rs:153), advertise `elicitation:{form:{},url:{}}`, matching what Electron sends.
   - In on_request (acp.rs:347-377), handle the elicitation/create method that Electron handles. Instead of answering -32601, emit `{type:'elicitation', id, mode:'form'|'url', message, requestedSchema|url}` with the same JSON shape Electron writes to the log, and park the responder.
   - Add `pub fn answer_elicitation(&self, id:&str, action:&str /*accept|decline|cancel*/, content:Option<Value>)`, which replies and emits the same 'elicitation_done' event Electron logs.
2. Fork (agentChat.ts:642-700, agentChatAcp.ts fork()):
   - Add `pub fn fork(&self, message_id:&str) -> Result<new_session_id>` that sends session/fork with `_meta.jetbrains.air.fork.messageId`.
   - In log.rs, add `pub fn fork_log(src:&ChatLog, message_id, new_session_id, title:'⑂ <name>') -> ChatLog`. It copies events up to and including that message, drops unanswered prompts, appends a turn-closing result event, and writes the meta exactly as Electron's forkChat does.
3. Adapter exit (agentChatAcp.ts:540-560): acp.rs:165 always emits exited code 0. Capture the real exit status. On a nonzero exit or a spawn error, emit `{type:'error', message:'<Claude|Codex> adapter exited with code N'}` before `exited`.
4. Steer: make the steer call report its outcome. Emit `{type:'steer_result', id, injected:bool}`, or return it through the existing callback, so chat only tags 'steered in' on injected (agentChat.ts steer).
5. Session modes: when session/new or session/load returns `modes`, emit `{type:'modes', current, available}` as Electron does. Add `pub fn set_session_mode(&self, id)` using session/set_mode.
6. Codex initial mode (agentChatAcp.ts:105-110, 124-127): replace the hardcoded INITIAL_AGENT_MODE='agent' (acp.rs:133) with a spawn parameter `initial_mode: Option<&str>`, mapped from the default permission mode (read-only, agent, full-access). Default to 'agent' when None.
7. Legacy logs (agentChat.ts:40-42, 175-205): in ChatLog::open (log.rs:55-77), when <id>.json exists and is newer than <id>.jsonl (or the .jsonl is missing), read the legacy JSON event array. Migrate it by writing the .jsonl, which yields resume id and history, exactly as loadPersisted does. Leave the .json file in place.
8. updatedAt (agentChat.ts:81-95): in log.rs:143, when no event has a ts, fall back to the existing meta's updatedAt, not now_ms, so opening and closing a chat doesn't reorder recency.

## Wave 1 · W1-C Shell: tabs, editor, window, persisted UI state (L)

**Owns:** spike-gpui/src/main.rs, spike-gpui/src/files.rs, spike-gpui/src/settings.rs, spike-gpui/src/palette.rs  
**New:** spike-gpui/src/session_state.rs

**Gaps:**
- Binary/unreadable file opens as editable buffer: data loss (high)
- Preview (temporary) tabs (high)
- Reopen open chat tabs / active tab per worktree after restart (high)
- Window size/position persistence (medium)
- Standard app/window menus (medium)
- Per-worktree remembered review-panel state (medium)
- Save all ⌥⌘S + Save button (medium)
- Re-opening an open file at a new line (medium)
- Diff view: split mode + full-context toggle (medium)
- Default mode per provider, the Settings field (medium; applied in W2-A)
- MRU focus when closing a tab (low)
- Resizable sidebar + persisted widths (low)
- Open-in-app failure feedback (low)
- Titlebar breadcrumb: branch vs label, upstream (low)
- Syntax highlight by filename (low)
- Reopened file returns to last cursor/scroll (low)
- ⌘P recent files first (low, palette partial)

**Brief:** Add `mod session_state;` in main.rs. session_state.rs has a serde struct saved to ~/.forest-ranger/gpui-state.json with an atomic write; read and write it only through this module. Electron's localStorage can't be read from GPUI, so this file is separate. It holds per-worktree records:
- open tabs: chat log ids, file and diff keys, in order
- the active tab key
- MRU order
- panel open, review view (review, files or search) and the files/commits toggle
plus global sidebar_width (200-520), panel_width (320-900), last panel state (inherited by unvisited worktrees, panelStore.ts:16-59) and recent files per worktree (terminalStore.ts:335-389, cap 50).

Then:
1. Restore tabs (terminalStore.ts:139-196, 216-235; SessionWorkspace.tsx:111-118). On the first visit to a worktree after launch, reopen its saved chat tabs with ChatView::open (history plus resume) and its file and diff tabs, then focus the saved active tab. Save on every tab open, close or focus. Restored chats must not start agents until the user sends.
2. Preview tabs (terminalStore.ts:290-332, 390-395):
   - Each worktree has at most one preview tab, title in italics.
   - open_diff and open_file (main.rs:387-419) replace the preview tab's content in place unless the key is already open.
   - Double-clicking the tab pins it.
   - FileView pins itself on its first edit: add `pub enum FileEvent{Edited, Saved}` with EventEmitter and subscribe to it.
3. MRU (terminalStore.ts:426-440): when the active tab closes, focus the most recently used remaining tab, replacing main.rs:462's index-based choice.
4. Re-open at a line (FileEditor.tsx:116-125): when open_file hits an existing tab with Some(line), call a new `FileView::goto_line(line, window, cx)` that sets the cursor and scrolls it into view (centred if the kit allows). This replaces the early return at main.rs:413-416.
5. files.rs:
   - When read_file returns Err, render 'Binary file — can't edit as text.' or the error, create no editor, and make save a no-op. This fixes the data-loss bug at files.rs:22-26.
   - Add a header Save button that is disabled when the buffer is clean and reads 'Saving…' while saving.
   - `pub fn save(&mut self, cx)` and `pub fn is_dirty()`.
   - Pick the language by filename first (Makefile, Dockerfile, CMakeLists.txt, etc.), then the alias table (.vue, .svelte, .svg→xml, .mdx→markdown, .jsonc→json, .tf/.tfvars→hcl), then the extension (monaco.ts:60-67).
   - Keep a per-file cursor/scroll cache (200-entry LRU, static Mutex), written on drop and restored when the file opens without a line (monaco.ts:75-90).
6. Bind ⌥⌘S globally to a SaveAll action that calls save() on every dirty FileView in every worktree (RootLayout.tsx:36-40).
7. Diff tabs: add a split/unified toggle and a 'full file' toggle in the diff tab header, via DiffState::set_mode(DiffMode::Split) and set_context_lines(large). Default to split, as in DiffView.tsx:51-62.
8. Window state (index.ts:1390-1456): read and write ~/.forest-ranger/window-state.json ({width,height,x,y}, the same file and format Electron uses). Restore bounds only if they intersect a connected display, otherwise centre. Save on resize, move and close. This replaces Bounds::centered at main.rs:992.
9. Menus (index.ts:1501-1516), replacing main.rs:958-972:
   - App menu: About (shows the version), Hide ⌘H, Hide Others ⌥⌘H, Show All, Quit.
   - Edit menu: kept as it is.
   - Window menu: Minimize ⌘M, Zoom, Close Window ⇧⌘W.
10. Wrap the sidebar in a resizable panel (200-520) and persist its width. Persist the review panel width (main.rs resizable_panel, 480 default). Make show_diff per worktree from session_state rather than the global flag at main.rs:45/102. Persist the review view by calling set_review_view on enter.
11. Breadcrumb (WorktreeView.tsx:105-106, 307-317):
   - Show the real branch rather than the label, '(detached)' when detached, and '→ <upstream>' when there is a tracking branch. Upstream is available from git::detail or a quick `git rev-parse --abbrev-ref @{u}` run in the background.
   - The project crumb is clickable: for now it selects or expands the project; in W3 it routes to the project view.
   - Tooltip shows the worktree path.
12. settings.rs:
   - Keep `open_in(app, path)` with the same signature. Add `pub fn try_open_in(app, path) -> Result<(), String>` that checks the exit status and errors with 'No editor found' or 'No terminal found' when app is None.
   - The titlebar editor button uses try_open_in and shows a notification toast on Err ('Couldn't open in X: …', openTargets.ts:69-79).
   - Add `default_mode_by_provider: HashMap<String,String>` to Settings with serde default. Add a 'Default mode' select per provider in the Agents section, with options from the known mode ids: default, acceptEdits, plan, bypassPermissions, auto; Codex: read-only, agent, full-access (chatConfig.ts:20, 221-225; AgentsManager.tsx:47-70). W2-A reads this field.
13. palette.rs: when the ⌘P item list is built (main.rs:286-305), sort recent files from session_state first (FilePalette.tsx:31-109). Record a recent file on every open_file.

## Wave 1 · W1-D Sidebar row actions + worktree lifecycle (L)

**Owns:** spike-gpui/src/sidebar.rs, spike-gpui/src/data.rs, spike-gpui/src/git.rs  
**New:** spike-gpui/src/sidebar/dialogs.rs

**Gaps:**
- Sidebar right-click row menus (high)
- Remove project (medium)
- Sidebar project hover actions: New worktree, Rescan (high; the ✦ review button is in W3-A)
- New worktree dialog (high, data-compat on worktree_dir/naming)
- Remove worktree dialog (high)
- Worktree label edit, inline + Rename dialog (medium)
- Rename branch (medium)
- Open in terminal (medium)
- Rescan worktrees on demand (medium)

**Brief:** Put dialogs in sidebar/dialogs.rs (declared from sidebar.rs) using window.open_dialog as settings.rs:121-128 does. Keep inline-edit state in a `Global` struct defined in sidebar.rs; add no ForestRanger fields. Call the existing ForestRanger methods (select, reload, sync_all, new_chat) directly from the `impl ForestRanger` in sidebar.rs.

1. Context menus (RowMenu.tsx:9-76, Sidebar.tsx:296-307, 387-394). Use the kit's context_menu or on_mouse_down(Right) with a DropdownMenu.
   - Project row: Reveal in Finder; Remove project, behind a confirm dialog (Sidebar.tsx:413-421).
   - Worktree row: Open in editor (settings::open_in with Settings.editor), Open in terminal (Settings.terminal), Reveal in Finder, Rename…, Rename branch… (when not detached), Remove worktree… (not on the primary).
2. Hover buttons on project rows (Sidebar.tsx:245-281, 423-434): '+' (New worktree dialog) and '↻' (calls data::sync_worktrees for that project, then reload).
3. data.rs:
   - `remove_project(id)`, with the same DB deletes as Electron's removeProject at index.ts:474. If the removed project or its worktree was selected, clear the selection.
   - `set_worktree_dir(project_id, dir)` (projects.worktree_dir, index.ts:378).
   - `project_worktree_dir(id)`.
4. git.rs:
   - `worktree_add(repo, path, branch, new_branch_from:Option<&str>)`.
   - `worktree_remove(repo, path, force)`.
   - `worktree_status(path) -> {uncommitted, unpushed, has_upstream}` (index.ts:635-680).
   - `delete_branch(repo, name, force)`.
   - `rename_branch(path, new)` (index.ts:749-758).
   - `list_branches(repo) -> local + origin`, for the base picker.
5. New worktree dialog (NewWorktreeDialog.tsx:31-127; index.ts:782-846):
   - Fields: optional branch name, empty meaning 'worktree-<6 hex>'; base branch, a filterable list defaulting to the detected base; Location, prefilled from projects.worktree_dir or Electron's default parent.
   - Checkboxes: 'Start a Claude chat in the new worktree' and 'Open in editor'.
   - Naming: origin/foo becomes foo. The folder is the slugified branch with a -2, -3 suffix on collision, exactly as Electron does it, so both apps put worktrees in the same place. Save the chosen location back to worktree_dir.
   - Show inline errors. On success, sync_worktrees, reload, select the new worktree, and optionally new_chat with the default provider or open the editor.
6. Remove worktree dialog (RemoveWorktreeDialog.tsx:17-155):
   - Show the branch and path, then status lines: N uncommitted changes, N unpushed commits, or 'Not pushed to any remote'.
   - A 'Force remove' checkbox appears only when the worktree is dirty, and is required before Remove is enabled.
   - 'Also delete branch <x>' warns when unpushed commits would be lost.
   - Run worktree_remove, then a best-effort `branch -D`, then sync, reload and select the project.
7. Labels (Sidebar.tsx:159-175, 320-356, 399-411; RenameWorktreeDialog.tsx:37-43):
   - Double-clicking a worktree row swaps the label for an Input. Enter or blur saves via data::set_label; Esc cancels; a blank value or the branch name clears the label (None).
   - Rename… opens the same as a dialog.
   - Rename branch… is a dialog that runs git::rename_branch, then sync.
8. Keep the existing resume_dot logic untouched: dot scope is fixed in W2-B.

## Wave 1 · W1-E Review panel parity (L)

**Owns:** spike-gpui/src/review.rs, spike-gpui/src/tree.rs, spike-gpui/src/codehost.rs  
**New:** spike-gpui/src/review/change_tree.rs

**Gaps:**
- Keyboard navigation of file trees incl. 's' to stage (high)
- Create MR/PR, 'Push & open PR/MR' (high)
- Changes shown as folder tree (medium)
- Folder-level tri-state stage checkbox (medium)
- ⌘↩ to commit (medium)
- Commit message cleared before commit succeeds (medium)
- Reattach detached worktree button (medium)
- Base-branch combobox type-to-filter (medium)
- Change-section filter, diffstat totals, collapsible sections (medium)
- Search: live debounced, grouped by file (low)
- Update-from-base hidden on primary + status badges (low)
- Commit rows: ± stats, chevron, async load (low)
- Ignored-folder placeholders + async listing (low)

**Brief:** Do not edit git.rs (W1-D owns it). Call existing git functions only, inside cx.background_spawn.

1. Change trees. In review/change_tree.rs, port buildTree, collapseDir and aggregate (ReviewPanel.tsx:1072-1136), reusing tree.rs where possible.
   - The Uncommitted, Changes and per-commit file lists become collapsible folder trees: expanded by default, single-child chains collapsed, folder rows showing the file count and summed +/−.
   - These replace the flat lists at review.rs:721-723, 742 and 819.
2. Keyboard (ReviewPanel.tsx:681-803). Give each tree, and the Files uniform_list, a FocusHandle with a roving focused row. Keys:
   - ↑/↓ move; Home/End jump.
   - → expands, or moves to the first child; ← collapses, or moves to the parent.
   - Enter or Space activates: opens a diff or a file.
   - s stages or unstages the focused file, or the whole folder.
3. Folder checkbox (ReviewPanel.tsx:738-747, 809-851): stages or unstages every file under the folder. Shows indeterminate when partly staged.
4. Commit box:
   - ⌘↩ in the message Textarea commits. Intercept the key via on_key_down or a context key binding.
   - Placeholder 'Commit message…  (⌘↵ to commit)'.
   - Clear the message only after the act() result is Ok. Move the clear at review.rs:376 into the success path (ReviewPanel.tsx:156-170).
5. Summary strip (ReviewPanel.tsx:224-234, 294, 329-343):
   - 'Reattach to <branch>' button when the worktree is detached and detached_from is known, calling git::reattach (fast-forward only), with a tooltip.
   - Hide 'Update from <base>' on the primary worktree.
   - Add primary, detached and locked badges.
6. Create PR/MR (BranchIntegrationBar.tsx:69-83, 99-107; index.ts:912). Add `codehost::create_review_request(project, worktree_path, branch, base) -> Result<{number,url}>` using `gh pr create --head <branch> --base <base> --title <branch> --fill` or `glab mr create -s <branch> -b <base> -t <branch> --fill -y`. When there is no PR/MR and a base is set, show 'Push & open PR' / 'Push & open MR'. It runs git::push, then create, toasts '#N opened', calls cx.open_url and refresh_host. This replaces the static text at review.rs:275-277.
7. Base picker (BranchCombobox.tsx:19-58): add a filter Input at the top of the dropdown that selects all on focus and filters local and origin branches, with 'No matching branch' when empty.
8. Section heads (ReviewPanel.tsx:464-525): collapsible; 'N files +X −Y' totals; a 'Filter files…' input when there are more than 3 files.
9. Search (ReviewPanel.tsx:887-968):
   - Autofocus the input when the Search view opens.
   - Debounce 200ms on Change and run in the background; drop stale results.
   - Group hits under a file header (name, dim dir, count) with a line-number gutter.
10. Commit rows (ReviewPanel.tsx:603-630): chevron, hash, subject, +ins −del, relative time. Load commit_files in the background with a 'Loading…' row, replacing the synchronous call at review.rs:435-442.
11. Ignored folders (ReviewPanel.tsx:970-1069): list_dir runs in the background with a 'Loading…' row; '(empty)' for an empty result.
12. Leave the ReviewEvent enum variants unchanged. Double-click to pin a preview tab is added in W2-B.

## Wave 2 · W2-A Chat behaviour: elicitation, branch, find, queue/steer, modes, lifecycle (L)

**Owns:** spike-gpui/src/chat.rs, spike-gpui/src/chat/transcript.rs, spike-gpui/src/chat/agent_diff.rs  
**New:** spike-gpui/src/chat/find.rs, spike-gpui/src/chat/elicitation.rs, spike-gpui/src/chat/fresh.rs

**Gaps:**
- Elicitation forms, UI + log replay (medium)
- Branch from here / fork (high)
- ⌘F find in chat (high)
- Queue: Cancel restores text, per-item Steer now, Stop drains queue (medium)
- Steer fallback when agent can't steer + correct 'steered in' tag (low)
- Start fresh (meter menu) + cold-cache reopen banner (medium)
- Default mode per provider applied on first start (medium)
- Mode picker fallback to session modes (low)
- Provider switch while working (low)
- Adapter exit: error row + queue drain (medium)
- Idle stop of agents after 30 min (medium)

**Brief:** Builds on the W1-A ChatEvent and Attention API and the W1-B acp/log API.

1. Elicitation (ChatPane.tsx:1755-1921), in chat/elicitation.rs:
   - Rows::apply handles 'elicitation' and 'elicitation_done' events, which also replays Electron-written logs.
   - Form mode renders the message plus fields from requestedSchema: string becomes an Input; number/integer a numeric Input; boolean a Checkbox; enum an inline radio group; array of enum multiselect checkboxes. Required fields get '*'. Submit (validates required fields) calls acp.answer_elicitation(id,'accept',content); Decline sends 'decline'.
   - URL mode renders 'Open link' (cx.open_url, then accept) and 'Dismiss' (cancel).
   - A pending elicitation makes attention() return NeedsAnswer.
2. Branch (ChatPane.tsx:703-733; agentChat.ts:642-700). On BranchRequested(msg_id), with an agent running (start one if not):
   - Call acp.fork(msg_id), then log::fork_log.
   - Emit ChatEvent::Branched{log_id, title:'⑂ <name>'}. W2-B opens the tab.
   - On error, show an error row.
3. Find (ChatPane.tsx:811-869, 931-959), in chat/find.rs, with a ChatView key context:
   - ⌘F opens a find bar over user and assistant text and shows 'n / total' or 'No matches'.
   - Enter steps to an older hit, ⇧Enter to a newer one. Scroll the hit row to the centre via the list scroll handle. Highlight all matches, and the current one more strongly; use TextView highlights or wrap user text in highlighted runs.
   - Esc closes it.
4. Queue (ChatPane.tsx:578-589, 636-673, 1022-1048):
   - Cancel on a queued item puts its text and attachments back into the composer.
   - Each queued item gets a 'Steer now' button.
   - Stop calls cancel and moves all queued text back into the composer, joined with blank lines, so the cancelled turn's result doesn't drain the queue (chat.rs:362-368, 902-906).
5. Steer (ChatPane.tsx:597-634):
   - If the agent lacks steering, show a toast: 'This agent can't take messages mid-turn — stopped it and sent yours instead'. Then cancel, and send the message when the result arrives or after a 3s grace timer.
   - Tag a message 'steered in' only on steer_result injected=true. Otherwise send it as the next prompt (chat.rs:435-437).
6. Start fresh (ChatPane.tsx:1177-1192, 679-701, 1527-1577, 189-205, 1069-1082), in chat/fresh.rs:
   - The meter becomes a dropdown button with 'Start fresh — empty chat' and 'Start fresh with the last 3/5/10 messages'. That builds a carry-over first message with the same template and length cap as Electron, and emits ChatEvent::Branched{log_id of a new ChatLog with that prompt queued, title}.
   - On open, if tokens ≥150k and the last activity was more than 1h ago, show the banner 'This chat is Nk tokens and was last used X ago…' with Start fresh ▾ and Continue here.
7. Modes (agentChat.ts:463-482):
   - On the first ensure_agent in this run, for new chats and saved chats alike, apply Settings.default_mode_by_provider[provider] if set, rather than the chat's last saved mode. Restore the chat's own mode only on relaunches after an idle stop.
   - Pass the Codex initial_mode to acp spawn.
   - mode_picker (chat.rs:818-819): if there is no 'mode' config option, use the 'modes' event list with acp.set_session_mode; otherwise use the built-in permission-mode list (ChatPane.tsx:1194-1215).
8. Provider switch while working (ChatPane.tsx:406-414): update the picker straight away, and relaunch the agent with the new provider when the turn ends, rather than returning early at chat.rs:487-490.
9. Exit: on 'exited', show the error row emitted by acp, set agent=None, and if the queue is non-empty start a new agent and drain it.
10. Idle stop (agentChat.ts:625-635): a 60s timer kills the agent when it has been idle for 30 min with no turn running and no open permission or elicitation. The next send relaunches it with resume and restores the chat's config.

## Wave 2 · W2-B Shell integration: status dots, notifications, tab rename, chat-driven tabs (M)

**Owns:** spike-gpui/src/main.rs, spike-gpui/src/sidebar.rs, spike-gpui/src/data.rs, spike-gpui/src/review.rs, spike-gpui/src/session_state.rs  
**New:** spike-gpui/src/notify.rs

**Gaps:**
- Working / unread / needs-answer status dots in sidebar + tabs (high)
- OS notifications + dock badge (high)
- Sidebar 'chat here' dot scope (medium)
- Tab rename by double-click (medium)
- Open chat ⋯ Branch / Start fresh results as new tabs (high, wiring)
- 'View diff' from inline agent diff opens a diff tab (high, wiring)
- Chat ▾ reopen list times (low)
- Double-click a review row to pin the preview tab (low)

**Brief:** 1. Subscribe to every ChatView's ChatEvent when its tab is created or restored.
   - OpenDiff{path,old,new}: build a unified patch from the two texts (`similar` or git diff --no-index on temp files in the scratch dir) and open a Diff tab, as a preview tab.
   - Branched{log_id,title}: open ChatView::open(log_id) as a new tab, focus it, and persist it to session_state.
   - TitleChanged: persist the title.
   - StatusChanged: recompute the dots and badge, then cx.notify.
2. Dots (index.ts:1246-1380; Sidebar.tsx:282-292, 374-382; SessionWorkspace.tsx:97-109, 379-381, 426-431; attentionStore.ts):
   - Tabs, worktree rows and project rows (aggregated) show a dot from the highest attention across their chats: NeedsAnswer (amber), then Working (pulsing), then Unread (accent).
   - When a chat tab becomes active and the window is focused, call mark_read. Also call it on window activation for the visible tab.
   - Replace the existing working dot at main.rs ~602-606/689.
3. Hollow 'chat here' dot (Sidebar.tsx:41-55): show it only for worktrees with an open chat tab or with saved tabs in session_state. data::chat_worktrees (data.rs:170-179) is no longer used for the dot.
4. notify.rs (index.ts:1283-1286, 1305-1371):
   - When the window isn't active and a chat moves into NeedsAnswer (title 'Permission needed' or 'Input needed') or finishes a turn ('Chat finished'), post a macOS notification through UNUserNotificationCenter or NSUserNotification via objc2, which main.rs already uses for set_dock_icon. Clicking it activates the app and selects that worktree and tab.
   - Set the dock badge (NSDockTile setBadgeLabel) to the count of open permissions plus elicitations, empty at 0.
5. Tab rename (SessionWorkspace.tsx:136-146, 382-424): double-clicking a non-preview tab swaps its title for an Input; Enter saves, Esc cancels. For chats, call set_custom_title. For file and diff tabs, store the title override in session_state.
6. Chat ▾ list (WorktreeView.tsx:231-238): add updated_at to data::ChatMeta, read from meta.json updatedAt (data.rs:182-185), and show relative_time on the right of each entry.
7. review.rs: add `ReviewEvent::Pin`, emitted on a row double-click (ReviewPanel.tsx:833-835, terminalStore.ts:390-394), which pins the current preview tab.

## Wave 2 · W2-C Settings + code host: host field, test connection, per-project override, review prompt store (M)

**Owns:** spike-gpui/src/settings.rs, spike-gpui/src/codehost.rs

**Gaps:**
- Code host settings: editable host field + Test connection (medium)
- Per-project code host override, the widget (low)
- Per-project review prompt template, the store (medium, data-compat)

**Brief:** 1. Integrations section (IntegrationsManager.tsx:72-78, 220-249; index.ts:962, 1026):
   - Make Host an editable Input. Today it is display-only text at settings.rs:193.
   - 'Use gh/glab sign-in' passes the typed host, via a new `codehost::use_cli_host(provider, host)`, while keeping use_cli(p) for compat. It runs `gh auth status --hostname H` or `glab auth status --hostname H` and stores the host in the same DB integration row Electron uses.
   - Add a 'Test connection' button that shows '@user on host' or the error.
2. Per-project override (ProjectView.tsx:243-250, 288-347; index.ts:1062-1095; db.ts:73-76, 145). Add `pub fn project_code_host_section(project_id, repo, window, cx) -> AnyElement`:
   - Shows the origin host/path.
   - Picker 'Auto (<detected>)' / GitHub / GitLab / None, which writes projects.integration (the column codehost.rs:485-510 already reads).
   - Status line, e.g. 'Using GitLab via glab as @user', 'Turned off for this project', or '<host> isn't connected — set it up in Settings → Integrations'.
   - W3-A mounts it.
3. Review prompt (ReviewDialog.tsx:11-14, 126-151; chatConfig.ts:38, 197, 216-218):
   - Add `review_prompt_by_project: HashMap<String,String>` to Settings (gpui-settings.json).
   - Copy DEFAULT_REVIEW_PROMPT verbatim from Electron.
   - `pub fn review_prompt(project_id) -> String` and `pub fn render_review_prompt(project_id, branch, base)`, which substitutes {branch} and {base}.
   - Data-compat: Electron stores this in renderer localStorage, which GPUI can't read. Record it as a known one-way gap, or later move it to the DB in both apps.

## Wave 3 · W3-A Project view, run commands, base sync bar, review-a-branch (L)

**Owns:** spike-gpui/src/main.rs, spike-gpui/src/sidebar.rs, spike-gpui/src/data.rs, spike-gpui/src/git.rs, spike-gpui/src/sidebar/dialogs.rs  
**New:** spike-gpui/src/project_view.rs, spike-gpui/src/project_view/commands.rs, spike-gpui/src/project_view/sync_bar.rs

**Gaps:**
- Project view screen, route + titlebar (high)
- Run commands in titlebar + on worktree cards (high, data-compat: shared project_commands)
- Review a branch dialog + flow (high)
- Worktree cards grid (medium)
- Commands CRUD, project Settings tab + CommandDialog (medium)
- Base-branch sync bar, Fetch/Update + recent commits (medium)
- Project Settings tab: review prompt + code host override (mounts W2-C)

**Brief:** 1. Route. In main.rs, add a selection enum Worktree(id) | Project(id).
   - Clicking the project name in the sidebar opens the project view; the chevron still toggles expansion (Sidebar.tsx:236-243). The breadcrumb crumb also routes here.
   - Project titlebar (ProjectView.tsx:96-143): name, '· N worktrees', Refresh (sync_worktrees, then reload branches and the sync bar) and Reveal.
   - Tabs: Worktrees / Settings. Branches comes in W4-A, which adds `mod branches;`.
2. Worktree cards (WorktreeCard.tsx:56-180):
   - A responsive grid. Each card has the label, primary/detached/locked badges, ~path, short HEAD hash, last activity and a Reveal icon, plus Editor and Terminal buttons and ▶ per command.
   - Clicking a card selects the worktree. Right-click reuses the W1-D worktree menu.
   - A New worktree button reuses the W1-D dialog.
3. Commands (db.ts:35, 170-184; index.ts:848-881; CommandDialog.tsx:53-104):
   - data.rs: list_commands (sorted by sort, then created_at), add_command, update_command and delete_command on the shared project_commands table, using Electron's columns exactly, including dir and run_target.
   - Run: open the external terminal (Settings.terminal) at worktree_path joined with dir, and run the command (Terminal/iTerm/Ghostty via an AppleScript or `open -a` + command as Electron's runCommand does). In-app run_target is out of scope (no terminal); treat it as external.
   - Titlebar: ▶ buttons per command, folding into 'Run ▾' past 2. Right-click a button for Edit/Delete. ⋯ → 'Add run command…' (WorktreeView.tsx:163-180, 265-343; RunCommands.tsx:15-71).
   - Project Settings tab lists commands (label, dir/, command) with Edit and Delete, plus Add command.
   - Command dialog: Label, Command, optional dir (trim leading ./ and /), Run in Default/External. Enter saves; Save is disabled until label and command are filled.
4. Sync bar (BranchSyncBar.tsx:17-95; index.ts:682-703):
   - git.rs: `fetch_base(repo, base)`, `base_status(repo, base) -> {behind, ahead}` vs origin, and `base_log(repo, base, n)`.
   - Bar: 'N behind origin' or 'up to date with origin', plus 'M ahead'. The Fetch button becomes a primary Update button when behind; it toasts 'Fetched <base>' and refreshes all worktrees.
   - Below: the 3 latest base commits (hash, subject, author, time), with 'Show N more' up to 20.
5. Review a branch (ReviewDialog.tsx:21-123; useProjectActions.ts:46-80; index.ts:790-822):
   - Entry points: a ✦ hover button on sidebar project rows and a button in the project view.
   - Dialog: branch picker (base excluded, filterable), a 'Customize the review prompt' checkbox revealing a textarea prefilled from settings::render_review_prompt, and Start review.
   - Start review reuses an existing worktree on that branch, or creates one with git::worktree_add (checking out the real branch, the detach=review semantics). It then selects the worktree and opens a new_chat with the default provider, titled 'Review <branch>', and sends the prompt via ChatView::send_text.
6. Project Settings tab: a 'Review prompt' textarea with {branch}/{base} help and 'Reset to default' when customized (ProjectView.tsx:252-259), saved via Settings.review_prompt_by_project. Mount settings::project_code_host_section.

## Wave 4 · W4-A Branches tab (branch graph + branch actions) (M)

**Owns:** spike-gpui/src/project_view.rs, spike-gpui/src/git.rs  
**New:** spike-gpui/src/project_view/branches.rs

**Gaps:**
- Branches tab, branch graph (medium)
- Create worktree from a branch row (medium)
- Delete branch / force-delete confirm / clean up merged (medium)

**Brief:** Add `mod branches;` and the Branches tab in project_view.rs.

1. git.rs (index.ts:716-780):
   - `branch_graph(repo, base)`: each local and origin branch with its last commit time, ahead/behind vs base, and the worktrees that have it checked out.
   - `merged_into(repo, base)`.
2. branches.rs (ProjectBranches.tsx:23-271):
   - A filter box and the total count.
   - Groups: Local only / Local & origin / Origin only, newest first, 12 per group until 'Show all N'.
   - Each row: origin chip, ↑ahead/↓behind, relative time, then either chips that select the worktrees using it, or '+ Worktree' and Delete.
3. '+ Worktree' (ProjectBranches.tsx:56-70): on a local branch, worktree_add checks it out. On an origin-only branch, it creates a local branch of the same name from origin/<name>, using W1-D's naming and worktree_dir. Then select the new worktree, or toast 'Couldn't create worktree: …'.
4. Delete (ProjectBranches.tsx:38-41, 72-94, 129-137, 174-199): a safe `-d` first. If git refuses because the branch isn't merged, confirm 'Force-delete branch?' and run -D.
5. 'Clean up N': after a confirm, delete every local branch fully merged into base that has no worktree, then toast 'Deleted N merged branches, M skipped'.

## Wave 4 · W4-B Split panes + draggable tabs (L)

**Owns:** spike-gpui/src/main.rs, spike-gpui/src/session_state.rs  
**New:** spike-gpui/src/panes.rs

**Gaps:**
- Split panes and drag tabs: reorder / move / split (medium)

**Brief:** Port SessionWorkspace.tsx:182-361, 405-421 and terminalStore.ts:461-485.

1. Replace the per-worktree flat Tabs with a layout tree of groups (in panes.rs). Each group has its own tab strip and active tab.
2. Tabs are draggable with gpui on_drag/on_drop:
   - Drop on a tab strip to reorder, or to move the tab to another group.
   - Drop on a pane edge (left, right, top or bottom) to split.
3. Splits are resizable. New tabs open in the focused group, and closing a group's last tab collapses that group.
4. Persist the layout per worktree in session_state, including the per-group MRU, preview tab and the restore from W1-C.

## Dropped

- ⌘K / ⌘T worktree+project jump palette: already implemented in spike-gpui/src/palette.rs, bound at main.rs:976-977 and wired at main.rs:256-333, so the gap report is stale.
- ⌘P file quick-open palette: already implemented (palette.rs Item::File/Diff/ignored, main.rs:978, 286-305). The one real remainder, recent files first, is folded into W1-C.
- Duplicate: 'Fork / branch chat at a message' (agent-lifecycle) is merged with 'Message ⋯ menu (Branch from here / Copy text)'. Copy text is in W1-A, Branch in W1-B + W2-A + W2-B.
- Duplicate: 'Elicitation (agent questions / forms / URL)' (agent-lifecycle) is merged with 'Elicitation forms' (chat). The protocol is in W1-B, the UI in W2-A.
- Duplicate: 'Stop with queued messages' is merged into 'Queue: Cancel loses text, no per-item Steer, Stop drops queue' (W2-A).
- Duplicate: the second 'Steer fallback when agent can't steer' is merged; its steered-tag detail is kept in W1-B + W2-A.
- Duplicate: 'Default mode per provider / Codex initial permission mode' is merged with 'Default mode per provider'. The setting is in W1-C, the protocol in W1-B, applying it in W2-A.
- Duplicate: 'Tab rename + chat tab attention/unread indicator' (chat) and 'Tab rename by double-click' (shell) are merged into W2-B (with the set_custom_title API in W1-A).
- Duplicate: 'Attention / unread status dots (tabs + sidebar)' (shell) is merged with 'Working / unread / needs-answer status dots' (W2-B).
- Duplicate: 'Restore open tabs/layout per worktree across restarts' (shell) is merged with 'Reopen open chat tabs after restart' (W1-C). The split-layout part is in W4-B.
- Duplicate: the second 'Preview tabs' (review area) is merged with the shell 'Preview (temporary) tabs' (W1-C, with review double-click pin in W2-B).
- Duplicate: 'Save all editors ⌥⌘S and the Save button' (review) is merged with '⌥⌘S save all open editors' (shell) (W1-C).
- Duplicate: 'Remove worktree (⋯ menu + dialog)' (shell) is merged with 'Remove worktree dialog' (project) (W1-D).
- Duplicate: 'Worktree/project context menus' (project) is merged with 'Sidebar right-click row menus' (W1-D). Card menus reuse it in W3-A.
- Duplicate: 'Rename worktree label / rename branch' (project) is merged with 'Worktree label edit' (shell) (W1-D).
- Duplicate: 'Sidebar project hover actions' is split: + and ↻ are in W1-D, ✦ is in W3-A. 'Rescan worktrees on demand' is merged into the same package.
- Duplicate: 'Base-branch fetch/sync bar' (review) is merged with 'Base-branch sync bar (Fetch/Update + recent commits)' (project) (W3-A).
- Duplicate: 'Project command run-buttons on worktree cards' is merged with 'Run commands in titlebar' and 'Commands CRUD' (W3-A).
- Duplicate: 'New worktree dialog' is listed once (W1-D). The project-view entry point reuses it in W3-A.
- Partial out of scope: the 'In-app' run_target option for project commands needs the in-app terminal, which is deferred. W3-A treats it as external.

## All reported gaps

- **Project view screen (route + titlebar)** (missing, high, M) — In Electron, clicking a project name opens a project page. Its titlebar shows the project name, a '· N worktrees' count, and Refresh and Reveal buttons, with Worktrees / Branches / Settings tabs below. In GPUI, clicking a project row only expands or collapses it. There is no project-level screen at all, so every feature below has nowhere to live.  
  Electron: src/src/mainview/routes/ProjectView.tsx:96-143; components/Sidebar.tsx:236-243 · GPUI: spike-gpui/src/sidebar.rs:174-179 (project row click only toggles expand); main.rs:565-575 ('Pick a worktree' placeholder)
- **Worktree cards grid** (missing, medium, M) — Electron's Worktrees tab shows one card per worktree. Each card has the label, primary/detached/locked badges, the ~path, short HEAD hash, last-activity time and a Reveal icon, plus Editor and Terminal buttons. Clicking a card opens the worktree. GPUI has only the sidebar row: no hash, no locked badge, no path, and no grid.  
  Electron: src/src/mainview/components/WorktreeCard.tsx:56-180; routes/ProjectView.tsx:179-187 · GPUI: none
- **Project command run-buttons on worktree cards** (missing, high, M) — In Electron, each saved project command (e.g. 'Run' → 'npm run dev') appears as a ▶ button on every worktree card. It runs in that worktree, from the command's optional subdirectory, in the external terminal or in-app depending on run_target. GPUI never reads the project_commands table, so commands set up in Electron can't be run.  
  Electron: src/src/mainview/components/WorktreeCard.tsx:80-89; main/index.ts:873-879 (runCommand joins cmd.dir, runs in terminal app) · GPUI: none (no reader of project_commands anywhere in spike-gpui/src)
- **Commands CRUD (project Settings tab + CommandDialog)** (missing, medium, M) — Electron lists commands as label, dir/ and command, each with Edit and Delete. 'Add command' opens a dialog with Label, Command, an optional working dir (leading ./ and / trimmed), a Run in Default/In-app/External choice, Enter to save, and Save disabled until label and command are filled. It writes project_commands (sorted by sort, then created_at). GPUI has no way to view, add, edit or delete commands.  
  Electron: src/src/mainview/routes/ProjectView.tsx:200-240,272-281; components/CommandDialog.tsx:53-104; main/index.ts:848-871; main/db.ts:35,170-184 · GPUI: none
- **Base-branch sync bar (Fetch/Update + recent commits)** (missing, medium, M) — At the top of Electron's Worktrees tab is a bar for the project's base branch. It shows 'N behind origin' or 'up to date with origin', plus 'M ahead', and a Fetch button that turns into a primary Update button when behind. Clicking it runs fetchProject (a git fetch of base), toasts 'Fetched <base>' and refreshes every worktree. Below are the base branch's latest 3 commits (hash, subject, author, time), with 'Show N more' up to 20. GPUI has no project-level fetch or base status.  
  Electron: src/src/mainview/components/BranchSyncBar.tsx:17-95; main/index.ts:682-703 · GPUI: none (review.rs only fetches/updates the selected worktree vs base)
- **Branches tab (branch graph)** (missing, medium, L) — Electron's Branches tab lists every branch with a filter box and total count. Branches are grouped as Local only / Local & origin / Origin only, newest commit first, 12 per group until 'Show all N'. Each row has an origin chip, ↑ahead/↓behind vs base, last-commit time, and either chips linking to the worktrees that have it checked out or '+ Worktree' and Delete buttons. GPUI has no branch browser.  
  Electron: src/src/mainview/components/ProjectBranches.tsx:23-201,205-271; main/index.ts:716-746 · GPUI: none
- **Create worktree from a branch row** (missing, medium, S) — In Electron, '+ Worktree' on a local branch checks that branch out in a new worktree. On an origin-only branch it creates a local branch of the same name from origin/<name>. It then navigates to the new worktree, or toasts 'Couldn't create worktree: …' on failure. GPUI has no such action.  
  Electron: src/src/mainview/components/ProjectBranches.tsx:56-70; main/index.ts:782-846 · GPUI: none
- **Delete branch / force-delete confirm / clean up merged** (missing, medium, S) — Electron's trash button on a branch row runs a safe delete. If git refuses because the branch isn't merged, it asks 'Force-delete branch?' before running -D. A 'Clean up N' button deletes every local branch fully merged into base that has no worktree, after a confirm, then toasts 'Deleted N merged branches, M skipped'. GPUI has no branch deletion at all.  
  Electron: src/src/mainview/components/ProjectBranches.tsx:38-41,72-94,129-137,174-199; main/index.ts:760-780 · GPUI: none
- **New worktree dialog** (missing, high, M) — In Electron, the + on a sidebar project row (or 'New worktree' in the project view) opens a dialog. It has an optional branch name (auto-generated if blank), a base-branch combobox (defaults to the detected base), and a Location field prefilled from the project's remembered worktree_dir. Two checkboxes: 'Start a Claude chat in the new worktree' and 'Open in editor'. It shows inline errors and navigates to the new worktree. GPUI cannot create a worktree. When it does, it must honour and write projects.worktree_dir and use the same folder/branch naming so both apps put worktrees in the same place.  
  Electron: src/src/mainview/components/NewWorktreeDialog.tsx:31-127; Sidebar.tsx:257-267 (+ button); ProjectView.tsx:169-175; main/index.ts:782-846 (branch name or worktree-xxxxxx, origin/foo → foo, slugified folder with -2 suffix, location saved to projects.worktree_dir via index.ts:378) · GPUI: none (sidebar.rs project row has no + action; data.rs has no worktree add)
- **Review a branch dialog + review flow** (missing, high, M) — In Electron, the sparkle button (sidebar row or project view) opens 'Review a branch'. You pick a branch (base excluded), can tick 'Customize the review prompt' to edit it, and Start review. That creates or reuses a worktree on that branch, navigates there, and opens a default-agent chat named 'Review <branch>' with the filled-in prompt already sent. GPUI has no review entry point. Its chat has no seeded-first-prompt or pre-named review chat path from a project action.  
  Electron: src/src/mainview/components/ReviewDialog.tsx:21-123; lib/useProjectActions.ts:46-80; Sidebar.tsx:245-256 (sparkle button); ProjectView.tsx:162-168; main/index.ts:790-822 (detach=review: reuse existing worktree on that branch, else check out the real branch) · GPUI: none
- **Per-project review prompt template** (missing, medium, S) — Electron's project Settings tab has a 'Review prompt' textarea. {branch} and {base} are substituted, and 'Reset to default' appears once it's customized. It is stored per project in renderer localStorage (chatConfig reviewPromptByProject), so GPUI can't read prompts saved in Electron: data-compat break. GPUI would need its own store (e.g. gpui-settings.json) or a move to the DB in both apps, plus the same DEFAULT_REVIEW_PROMPT text.  
  Electron: src/src/mainview/components/ReviewDialog.tsx:11-14,126-151; routes/ProjectView.tsx:252-259; lib/chatConfig.ts:38,197,216-218 (stored in renderer localStorage, not the DB) · GPUI: none (settings.rs only has theme/editor/terminal/agent)
- **Remove worktree dialog** (missing, high, M) — Electron's 'Remove worktree…' (card or row menu, hidden for primary) shows the branch and path, then status lines: uncommitted changes, unpushed commits vs tracking, or 'Not pushed to any remote'. A 'Force remove' checkbox appears only when dirty and is required before removing. 'Also delete branch <x>' warns when that would discard unpushed commits. It runs git worktree remove (and best-effort branch -D). GPUI can't remove worktrees.  
  Electron: src/src/mainview/components/RemoveWorktreeDialog.tsx:17-155; WorktreeCard.tsx:105-115; main/index.ts:635-680 · GPUI: none (data.rs/git.rs have no worktree remove)
- **Rename worktree label / rename branch** (missing, medium, S) — In Electron you can 'Rename…' a worktree: an inline sidebar edit or a dialog sets worktrees.name, and blank clears it. 'Rename branch…' runs git branch -m on non-detached worktrees. GPUI shows labels set in Electron but gives no UI to set or clear one, and no branch rename.  
  Electron: src/src/mainview/components/WorktreeCard.tsx:93-104,117-133; Sidebar.tsx:325-340 (inline label edit, Enter/Escape); components/RenameBranchDialog.tsx:39; main/index.ts:749-758 · GPUI: spike-gpui/src/data.rs:291 (set_label exists but nothing calls it)
- **Worktree/project context menus (Open in editor/terminal/Reveal)** (partial, medium, S) — In Electron, right-clicking any worktree card or row offers Open in editor, Open in terminal, Reveal in Finder, Rename…, Rename branch… and Remove worktree…. Right-clicking a project offers Reveal in Finder and Remove project. GPUI has no context menus. You can only Reveal or open-in-editor the currently selected worktree from the titlebar, and there's no open-in-terminal for a worktree row.  
  Electron: src/src/mainview/components/RowMenu.tsx:56-75; WorktreeCard.tsx:91; Sidebar.tsx:296-307 · GPUI: spike-gpui/src/main.rs:543-552 (titlebar ⋯ has only Reveal in Finder for the selected worktree); sidebar.rs:140-179,205-240 (no right-click menu)
- **Remove project** (missing, medium, S) — Electron's project row menu has 'Remove project' behind a confirm, which deletes the project from the DB and leaves the page if you're on it. GPUI can add projects with + but never remove them.  
  Electron: src/src/mainview/components/Sidebar.tsx:181-185,302-307,420; main/index.ts:474 · GPUI: none (data.rs has add_project only)
- **Rescan worktrees on demand** (missing, medium, S) — Electron has a Rescan (refresh) button on each sidebar project row and a Refresh button in the project titlebar. Both re-sync from git worktree list and reload branches and the sync bar. GPUI syncs only once at launch, so worktrees added or removed outside the app, or by Electron while GPUI is running, don't appear until restart.  
  Electron: src/src/mainview/components/Sidebar.tsx:268-279; routes/ProjectView.tsx:104-113 · GPUI: spike-gpui/src/main.rs:110,116-128 (sync_all only at startup)
- **Per-project code host override (Settings → Code host)** (partial, low, S) — Electron's project Settings shows the origin (host/path) and an Auto (GitHub) / GitHub / GitLab / None picker that writes projects.integration. A status line follows, e.g. 'Using GitLab via glab as @user', 'Turned off for this project', or 'isn't connected — set it up in Settings → Integrations'. GPUI follows an override set in Electron but has no UI to view origin/effective status or change the choice, so SSH-alias or custom-domain projects can't be fixed from GPUI.  
  Electron: src/src/mainview/routes/ProjectView.tsx:243-250,288-347; main/index.ts:1062-1095; main/db.ts:73-76,145 · GPUI: spike-gpui/src/codehost.rs:485-510 (reads projects.integration) ; settings.rs (no per-project UI)
- **⌘K / ⌘T worktree+project jump palette** (missing, high, M) — In Electron ⌘K or ⌘T opens a modal where you type to fuzzy-jump to any worktree in any project (by label, real branch or project name, label-prefix ranked first) or to a project, with arrow keys and Enter. In GPUI the keys do nothing, so the only way to switch worktree is clicking in the sidebar tree.  
  Electron: src/src/mainview/components/CommandPalette.tsx:22-33,40-80; routes/RootLayout.tsx:111 · GPUI: none (main.rs:864-878 binds no cmd-k/cmd-t; README 'Not here yet: palettes')
- **⌘P file quick-open palette** (missing, high, M) — In Electron ⌘P inside a worktree lists every file, recently opened ones first. Each changed file also gets a 'diff' entry (working tree if uncommitted, else vs base), plus gitignored loose files tagged 'ignored'. Enter opens a file or diff tab. GPUI has no ⌘P, so files can only be opened from the review panel's Files/Search views.  
  Electron: src/src/mainview/components/FilePalette.tsx:31-109; lib/terminalStore.ts:335-389 (recordRecentFile) · GPUI: none (main.rs:864-878)
- **Run commands in titlebar (external terminal)** (missing, high, M) — Electron shows a ▶ button per saved project command (they fold into a 'Run ▾' dropdown past 2). Clicking runs it in the chosen external terminal at the worktree path. Right-clicking a button gives Edit/Delete, and ⋯ → 'Add run command…' opens CommandDialog. GPUI shows none of the commands stored in the shared DB and has no way to add, edit, delete or run them.  
  Electron: src/src/mainview/routes/WorktreeView.tsx:163-180,265,274-278,334-343; components/RunCommands.tsx:15-71; lib/openTargets.ts:90-100; main/index.ts:873-881 · GPUI: none (main.rs:477-560 titlebar has no command buttons; data.rs never reads project_commands)
- **Remove worktree (⋯ menu + dialog)** (missing, high, M) — In Electron, ⋯ → 'Remove worktree…' (not offered on the primary worktree) opens a dialog that shows uncommitted and unpushed counts. It requires 'force' when the worktree is dirty, can optionally delete the branch, and then goes to the project. GPUI cannot remove a worktree.  
  Electron: src/src/mainview/routes/WorktreeView.tsx:284-291,344-352; components/RemoveWorktreeDialog.tsx:17-60+ · GPUI: main.rs:544-553 (⋯ menu has only 'Reveal in Finder')
- **Sidebar right-click row menus** (missing, high, S) — Right-clicking a project row in Electron offers Reveal in Finder and 'Remove project' (with a confirm). Right-clicking a worktree row offers Open in editor, Open in terminal, Reveal in Finder and Rename…. In GPUI right-click does nothing, and you cannot remove a project from the app at all.  
  Electron: src/src/mainview/components/Sidebar.tsx:296-307 (project: Reveal in Finder, Remove project + ConfirmDialog 413-421), 387-394 (worktree: Open in editor / Open in terminal / Reveal in Finder / Rename…); components/RowMenu.tsx:9-76 · GPUI: sidebar.rs:136-179, 205-240 (on_click only, no context menu)
- **Sidebar project hover actions (Review a branch, New worktree, Rescan)** (missing, high, M) — Electron project rows have hover buttons: ✦ opens ReviewDialog to review a branch, + opens NewWorktreeDialog, and ↻ rescans worktrees. GPUI has none of them, and because it syncs `git worktree list` only at launch, a worktree created outside the app does not appear until restart.  
  Electron: src/src/mainview/components/Sidebar.tsx:245-281,423-434 · GPUI: sidebar.rs:140-179 (chevron + name + dot only); main.rs:110 sync_all runs only at startup
- **Worktree label edit (double-click inline + Rename dialog)** (missing, medium, S) — In Electron, double-clicking a worktree row turns it into an input: Enter or blur saves, Esc cancels, and a blank value or the branch name clears the label. Rename… does the same in a dialog. In GPUI you cannot set or clear a label, though labels set in Electron are displayed.  
  Electron: src/src/mainview/components/Sidebar.tsx:159-175,320-356,399-411; components/RenameWorktreeDialog.tsx:37-43 · GPUI: data.rs:291 set_label exists but is never called; sidebar.rs:205-240
- **Preview (temporary) tabs** (missing, high, S) — In Electron, opening a file or diff (single click in review or files) reuses one italic 'preview' tab per worktree. The tab is swapped in place until you edit or double-click it, which pins it. In GPUI every distinct file or diff opened adds a permanent tab, so browsing changes piles up tabs.  
  Electron: src/src/mainview/lib/terminalStore.ts:290-332,391-395; components/SessionWorkspace.tsx:402,423-424 · GPUI: main.rs:292-332 (open_diff/open_file always push_tab unless same key is open)
- **Split panes and drag tabs (reorder / move / split)** (missing, medium, L) — In Electron you can drag a tab to reorder it, drop it on another group, or drop it on a pane edge to split left/right/top/bottom. Splits are resizable, the layout is saved per worktree, and new tabs open in the focused group. GPUI has one non-draggable tab strip and shows one tab at a time.  
  Electron: src/src/mainview/components/SessionWorkspace.tsx:182-361,405-421; lib/terminalStore.ts:461-485 · GPUI: main.rs:584-650 (single flat tab strip, no drag)
- **Restore open tabs/layout per worktree across restarts** (missing, medium, M) — When Electron relaunches and you enter a worktree, it reopens the chats that were open there, resuming by session id, in the saved split layout and on the last-active tab. GPUI starts every worktree with no tabs and the hint 'reopen from the Chat ▾ menu'. It also does not write the `forest-ranger:sessions` state.  
  Electron: src/src/mainview/lib/terminalStore.ts:138-200; components/SessionWorkspace.tsx:83-94,110-119 · GPUI: main.rs:97 (tabs: in-memory HashMap), main.rs:664-670
- **MRU focus when closing a tab** (partial, low, S) — When you close the focused tab, Electron returns to the tab you were last on in that worktree (most-recently-used order). GPUI selects the tab next to it by position, so after hopping between tabs you often land on the wrong one.  
  Electron: src/src/mainview/lib/terminalStore.ts:426-440 · GPUI: main.rs:375-386 (active = min(old index, len-1))
- **Tab rename by double-click** (missing, low, S) — In Electron, double-clicking a non-preview tab turns its title into an input (Enter saves, Esc cancels) to rename that chat or tab. GPUI tab titles cannot be edited.  
  Electron: src/src/mainview/components/SessionWorkspace.tsx:136-146,382-397,423 · GPUI: main.rs:612-648 (tab has only click/close)
- **Attention / unread status dots (tabs + sidebar)** (partial, medium, M) — Electron tabs and sidebar rows show distinct dots for 'needs your answer', 'working' and 'finished — unread'. The hollow 'chat here' dot shows only for chats that are open or would be restored. In GPUI, tabs show only a working dot. The sidebar shows only the hollow dot, and on every worktree or project that ever had a saved chat, so it cannot signal that a chat needs you.  
  Electron: src/src/mainview/components/SessionWorkspace.tsx:426-431; components/Sidebar.tsx:40-54,282-292,374-382 · GPUI: main.rs:602-606 (working dot only); sidebar.rs:173,238 + data.rs:170-180
- **Per-worktree remembered review-panel state** (partial, medium, S) — Electron remembers, per worktree and across restarts, whether the panel is open, which view it shows (review, files or search) and the files/commits toggle. A worktree you have not visited yet inherits the last state. In GPUI ⌘B open/closed is one global flag, reset to open on every launch, and the view resets to its default on restart.  
  Electron: src/src/mainview/lib/panelStore.ts:16-59; routes/WorktreeView.tsx:60 · GPUI: main.rs:44,99 (single global show_diff=true, not persisted); main.rs:251-277 (view per worktree in memory only)
- **Resizable sidebar and persisted panel widths** (partial, low, S) — In Electron you can drag the sidebar edge (200–520px), and both the sidebar width and the review-panel width (320–900) are kept across restarts. GPUI's sidebar is a fixed 264px, and its review panel resizes but returns to 480px every launch.  
  Electron: src/src/mainview/routes/RootLayout.tsx:86-104,114; routes/WorktreeView.tsx:52-54,190-206 · GPUI: sidebar.rs:28 (fixed 264px); main.rs:715-722 (resizable_panel 480px, not saved)
- **Open in terminal** (missing, medium, S) — Electron offers 'Open in terminal' on worktree rows, which opens the chosen external terminal at the worktree path. In GPUI you can pick a terminal in Settings but nothing uses it.  
  Electron: src/src/mainview/components/RowMenu.tsx:64-68; lib/openTargets.ts:85-87 · GPUI: settings.rs:92 open_in exists; only called for the editor (main.rs:541); Settings.terminal is never used
- **Open-in-app failure feedback** (partial, low, S) — If no editor or terminal is installed, or the open fails, Electron shows a toast ('No editor found…' or 'Couldn't open in X: …'). GPUI spawns `open` and ignores the result: with no editor configured it silently opens the folder in Finder, and on failure it shows nothing.  
  Electron: src/src/mainview/lib/openTargets.ts:69-79 · GPUI: settings.rs:92-99
- **Titlebar breadcrumb: branch vs label, upstream** (partial, low, S) — Electron's titlebar shows the real branch name, not the custom label, with '(detached)' when detached and '→ origin/x' for the tracking upstream. Its project name is a clickable crumb, and hovering shows the path as a tooltip. GPUI shows the custom label with the branch in parentheses, no upstream, and plain-text project name.  
  Electron: src/src/mainview/routes/WorktreeView.tsx:105-106,307-317 · GPUI: main.rs:446-475
- **⌥⌘S save all open editors** (missing, low, S) — In Electron ⌥⌘S saves every dirty file tab. In GPUI it does nothing, so you have to focus each file tab and press ⌘S.  
  Electron: src/src/mainview/routes/RootLayout.tsx:36-40 · GPUI: main.rs:864-878 (only cmd-s in FileView context)
- **Chat ▾ reopen list times** (partial, low, S) — In Electron each past chat in the Chat ▾ list shows its relative last-updated time ('2h ago'). GPUI lists names only, so chats with the same name ('New chat') cannot be told apart.  
  Electron: src/src/mainview/routes/WorktreeView.tsx:231-238 · GPUI: main.rs:530-535; data.rs:182-185 (ChatMeta has no updatedAt)
- **Tool output disclosure** (missing, high, S) — In Electron, a finished tool row shows its name plus a one-line preview of the output, and clicking it expands the full output rendered as Markdown. In GPUI a tool row is just a glyph and its title. The output is never visible, except the first line when the tool failed, so you can't read what a Bash or Read call returned.  
  Electron: src/src/mainview/components/ChatPane.tsx:1715-1753 · GPUI: spike-gpui/src/chat.rs:562-585
- **Process strips (folded tool runs)** (missing, high, M) — Electron folds runs of 2 or more consecutive tool calls into one collapsed '<N> steps · <last tool>' strip, with a dot that pulses while it is the live strip, and you expand it to see the steps. GPUI shows every tool call as its own row, so agentic turns become long stacks of tool lines between the prose.  
  Electron: src/src/mainview/components/ChatPane.tsx:1347-1364, 1386-1427 · GPUI: spike-gpui/src/chat.rs:522-608
- **Inline diffs on edit tools** (missing, high, M) — In Electron, Edit and Write tool calls render an inline colored diff, open by default, for each file: file name, +N/−N stats, context collapsed to ⋯, and a 'View diff' button that opens the side-by-side diff tab. GPUI throws away the oldText/newText and shows only an 'edited <path>' line, with no diff and no way to open one.  
  Electron: src/src/mainview/components/ChatPane.tsx:1702-1714; src/src/mainview/components/AgentDiff.tsx:20-55 · GPUI: spike-gpui/src/chat.rs:29,117-119,581
- **Message ⋯ menu (Branch from here / Copy text)** (missing, high, M) — In Electron each assistant message that has a messageId gets a ⋯ menu. 'Branch from here' forks the agent session at that point and opens it as a new '⑂ <name>' tab with the same context. 'Copy text' copies the raw markdown. GPUI renders bare markdown with no menu, and acp.rs has no session/fork call, although log.rs does keep messageId.  
  Electron: src/src/mainview/components/ChatPane.tsx:1635-1656, 705-733; src/src/main/agentChat.ts:642-690 · GPUI: spike-gpui/src/chat.rs:556
- **⌘F find in chat** (missing, high, M) — In Electron, ⌘F in a chat opens a find bar. It searches every question and answer, shows 'n / total' or 'No matches', steps with Enter (older) and ⇧Enter (newer), scrolls the hit to the centre and highlights all matches plus the current one. Esc closes it. GPUI has no find in the chat; the only ⌘⇧F is the review-panel search.  
  Electron: src/src/mainview/components/ChatPane.tsx:811-869, 931-959 · GPUI: none
- **Elicitation forms** (missing, medium, M) — When the agent asks for structured input, Electron shows a card: the message, then fields (text or number inputs, a checkbox, inline radio groups, multiselect checkboxes, '*' on required fields) with Submit and Decline. A URL-mode request shows 'Open link' and 'Dismiss'. GPUI's on_request answers anything that isn't fs or permission with -32601 'not supported', so the request fails. elicitation events in Electron-written logs are ignored by Rows::apply.  
  Electron: src/src/mainview/components/ChatPane.tsx:1755-1921; src/src/main/agentChatAcp.ts:482-505 · GPUI: spike-gpui/src/acp.rs:347-377
- **Plan/todo strip** (missing, medium, S) — Electron shows a collapsible 'Plan · 3/7 done' strip above the composer, listing entries marked ● (done), ◐ (in progress) or ○ (pending). In GPUI, acp.rs emits the plan event but ChatView::apply and Rows::apply drop it, so the agent's todo list never appears.  
  Electron: src/src/mainview/components/ChatPane.tsx:1051-1067 · GPUI: spike-gpui/src/acp.rs:498-502 (emitted); chat.rs:337-388 (ignored)
- **Start fresh (meter menu) + cold-cache reopen banner** (missing, medium, M) — In Electron the usage meter is a button that opens 'Start fresh — empty chat' and 'Start fresh with the last 3/5/10 messages'. That opens a new chat whose first message carries those messages over, with a cap on length. Reopening a chat that is at least 150k tokens and idle for over 1h also shows a banner: 'This chat is Nk tokens and was last used X ago…' with Start fresh ▾ and Continue here. In GPUI the meter is plain text (amber at 150k or more); there is no Start fresh and no banner.  
  Electron: src/src/mainview/components/ChatPane.tsx:1177-1192, 679-701, 1527-1577, 189-205, 1069-1082 · GPUI: spike-gpui/src/chat.rs:881-886, 1069-1071
- **Thinking block** (partial, medium, S) — In Electron, thinking is a collapsed 'Thinking' disclosure that you expand to read all of it. GPUI always shows the first 280 characters in faint italics, cut off with '…', and you can't expand it, so long reasoning can't be read and short reasoning is never hidden.  
  Electron: src/src/mainview/components/ChatPane.tsx:1660-1668 · GPUI: spike-gpui/src/chat.rs:557-561
- **Sticky turn headers + long-message clamp** (missing, medium, M) — Electron groups the transcript into turns, and each turn's question sticks to the top while you scroll through its answer until the next turn pushes it off. User bubbles taller than 80px are clamped with a Show more / Show less toggle. GPUI renders a flat list: questions scroll away and a large paste shows at full height.  
  Electron: src/src/mainview/components/ChatPane.tsx:1325-1339, 970-990, 1464-1509 · GPUI: spike-gpui/src/chat.rs:527-555
- **Activity indicator (forest words)** (missing, medium, S) — While working, and not while the answer itself is streaming, Electron shows a tree icon and a rotating forest word ('<Word>…', which changes every 7s and doesn't repeat the last 7) under the transcript. It shows 'Lacing up…' while starting. GPUI only shows a small 'Starting…' in the composer bar while starting. While working there is nothing in the transcript, only a dimmer sparkle on the settings button.  
  Electron: src/src/mainview/components/ChatPane.tsx:876-902, 1000-1021 · GPUI: spike-gpui/src/chat.rs:1073
- **Queue: Cancel loses text, no per-item Steer, Stop drops queue** (partial, medium, S) — In Electron, Cancel on a queued message puts its text and attachments back in the composer. Each queued item also has a 'Steer now' button, and Stop moves all queued text back into the composer. In GPUI, Cancel deletes the message for good, queued items have no Steer now, and Stop only cancels, so queued messages stay and get sent after the stopped turn.  
  Electron: src/src/mainview/components/ChatPane.tsx:655-673, 636-641, 578-589, 1022-1048 · GPUI: spike-gpui/src/chat.rs:971-992, 902-906
- **Steer fallback when agent can't steer** (partial, low, S) — In Electron, ⌘↩ or 'Steer now' on an agent without steering support shows a toast ('This agent can't take messages mid-turn — stopped it and sent yours instead'), cancels the turn and sends the message, with a 3s grace timer. In GPUI the message quietly goes to the queue and waits for the turn to finish, with no notice.  
  Electron: src/src/mainview/components/ChatPane.tsx:598-634 · GPUI: spike-gpui/src/chat.rs:409-417
- **Permission card details** (partial, medium, S) — Electron's card reads 'Allow <tool>?' and adds a detail line from the tool input (the command, file_path, path, url or pattern, else JSON up to 300 chars). Allow buttons and Deny buttons get different styles. GPUI shows only the tool title plus buttons, with only allow_once highlighted. The input is in the event but never shown, so you approve without seeing the exact command or path.  
  Electron: src/src/mainview/components/ChatPane.tsx:1675-1699, 1929-1937 · GPUI: spike-gpui/src/chat.rs:586-605; acp.rs:409-415
- **Default mode per provider** (missing, medium, S) — Electron has a Settings choice for each provider's starting mode (e.g. 'auto'). It is applied when the agent first starts in a run, for new chats and for saved chats after an app restart. GPUI Settings offers only 'Default agent for new chats', and ensure_agent never sets a mode, so every chat starts in the agent's own default mode.  
  Electron: src/src/mainview/components/ChatPane.tsx:331; src/src/main/agentChat.ts:471-481; src/src/mainview/lib/chatConfig.ts:20,221-225 · GPUI: spike-gpui/src/settings.rs:329-336; chat.rs:309-335
- **Mode picker fallback (session modes / permission modes)** (partial, low, S) — When an agent has no 'mode' config option, Electron falls back to the agent's session modes (the 'modes' event, set through session/set_mode). Failing that it shows the built-in permission-mode list. GPUI's mode_picker returns None without a mode config option and ignores the 'modes' event, so agents that only report session modes (e.g. some Codex builds) get no Mode picker.  
  Electron: src/src/mainview/components/ChatPane.tsx:1194-1215, 297-300, 437-440 · GPUI: spike-gpui/src/chat.rs:818-819
- **Provider switch while working** (partial, low, S) — In Electron, choosing another provider mid-turn updates the picker at once and relaunches after the turn ends. In GPUI set_provider returns early while not Idle, so the pick is silently ignored: the menu closes and nothing changes.  
  Electron: src/src/mainview/components/ChatPane.tsx:406-414, 442-450 · GPUI: spike-gpui/src/chat.rs:487-490
- **Tab rename + chat tab attention/unread indicator** (missing, medium, M) — In Electron, double-clicking a chat tab renames it, and the name sticks (auto-naming stops). Chat tabs also show 'needs attention' when a permission or elicitation is waiting, and 'unread' when a turn finished in the background. In GPUI the tab title is always derived from the first message, there is no rename, and the tab only distinguishes working (dot) from idle (sparkle). A chat waiting on a permission prompt looks like any other working chat.  
  Electron: src/src/mainview/components/SessionWorkspace.tsx:136-143, 379-424; src/src/mainview/lib/attentionStore.ts:1-36 · GPUI: spike-gpui/src/main.rs:687-693; chat.rs:301-303
- **Time dividers + message timestamps** (missing, low, S) — Electron puts a time divider before a turn that starts more than 1h after the previous one, and hovering a message shows its clock time. GPUI's Row drops ts, so there are no dividers and no timestamps, and a chat resumed days later reads as one continuous conversation.  
  Electron: src/src/mainview/components/ChatPane.tsx:1300-1323, 971-975, 1623, 1633 · GPUI: spike-gpui/src/chat.rs:24-32
- **Links in user messages** (missing, low, S) — Electron turns http(s) URLs in sent user bubbles into links that open in the browser, leaving trailing punctuation out of the link. GPUI renders user text as a plain string, so a pasted URL can't be clicked.  
  Electron: src/src/mainview/components/ChatPane.tsx:1431-1460, 1499 · GPUI: spike-gpui/src/chat.rs:546-554
- **Image attachments: sent chip + lightbox** (partial, low, S) — In Electron, clicking a composer image thumbnail opens a full-size lightbox, and sent messages mark images with 🖼 and files with 📎. In GPUI thumbnails can't be clicked to view, and every sent attachment shows 📎 even though isImage is recorded.  
  Electron: src/src/mainview/components/ChatPane.tsx:1106-1114, 1258-1262, 1487-1489 · GPUI: spike-gpui/src/chat.rs:533-544, 996-1003
- **Blank / rule-only assistant chunks** (partial, low, S) — Electron hides assistant and thinking rows that contain only blank lines or '---', and drops thematic breaks inside markdown. GPUI renders every assistant chunk with TextView::markdown, so narration separators show up as empty padded rows or horizontal rules between steps.  
  Electron: src/src/mainview/components/ChatPane.tsx:1631, 1661, 1924-1927; src/src/mainview/components/Markdown.tsx:84 · GPUI: spike-gpui/src/chat.rs:556
- **Reopen open chat tabs after restart** (missing, high, M) — Electron saves the open chat tabs per worktree to localStorage (forest-ranger:sessions) and reopens them, history included, the first time you visit that worktree after a restart. GPUI starts every worktree with no tabs after a restart, so the user has to reopen each chat one at a time from the Chat ▾ 'Reopen' menu. GPUI also doesn't remember which tab was active.  
  Electron: src/src/mainview/lib/terminalStore.ts:139-196,216-235; src/src/mainview/components/SessionWorkspace.tsx:111-118 · GPUI: spike-gpui/src/main.rs:42 (tabs HashMap lives in memory only); main.rs:437 open_saved
- **Working / unread / needs-answer status dots (sidebar + tabs)** (missing, high, M) — Electron gives each project row, worktree row and chat tab a dot for 'needs your answer' (an open permission or question), 'working' (turn running) or 'unread' (the turn finished while you weren't looking at that chat, tracked with chatRead and window focus). GPUI's sidebar only shows a calm hollow dot. Nothing in the sidebar says a chat in another worktree is working, waiting on a permission, or has finished. Tabs show working only, with no attention or unread state.  
  Electron: src/src/main/index.ts:1246-1380 (handleChatStatus, statusSets, markChatRead); src/src/mainview/components/Sidebar.tsx:282-286,374-378; SessionWorkspace.tsx:97-109,379-381; mainview/lib/attentionStore.ts · GPUI: spike-gpui/src/sidebar.rs:173,238 (hollow resume_dot only); main.rs:689 (tab shows a working dot only)
- **OS notifications + dock badge** (missing, high, M) — When the window isn't focused, Electron posts an OS notification for 'Permission needed', 'Input needed' and 'Chat finished'. Clicking it brings the window forward and jumps to that worktree. The dock badge counts unanswered permission and question requests. GPUI does neither, so a background agent waiting on a permission gives no signal outside the app.  
  Electron: src/src/main/index.ts:1283-1286 (app.setBadgeCount), 1305-1322 (notifyUser with click-to-navigate), 1340-1371 · GPUI: none
- **Sidebar 'chat here' dot scope** (partial, medium, S) — In Electron the hollow dot means a chat is open, or will be restored, in that worktree. GPUI puts the dot on every worktree that has any .meta.json ever written, closed chats included. In GPUI nearly every worktree that ever had a chat shows a dot, so the dot no longer tells you anything.  
  Electron: src/src/mainview/components/Sidebar.tsx:41-55 (openChats + getRestorableSessions) · GPUI: spike-gpui/src/data.rs:170-179 chat_worktrees; sidebar.rs:173,238
- **Idle stop of agents** (missing, medium, S) — Electron kills a chat's adapter after 30 minutes with no running turn and no open question. The next message relaunches it, resumes the session and restores that chat's settings. In GPUI every open chat tab keeps its adapter process (Node or claude plus the CLI) alive until the tab closes, and tabs persist across worktree navigation. A day of opening chats piles up live agent processes.  
  Electron: src/src/main/agentChat.ts:625-635 (IDLE_STOP_MS 30min reaper, skips busy/openAsks) + ensureDriver relaunch/restore at 440-490 · GPUI: spike-gpui/src/chat.rs:309 ensure_agent (agent lives until the tab is closed)
- **Fork / branch chat at a message** (missing, medium, M) — Electron has a Branch action on agent messages. It forks the agent session at that message and opens a new '⑂ name' chat tab seeded with the transcript up to that point (unanswered prompts dropped, turn closed). The branch resumes the forked context. GPUI has no branch action.  
  Electron: src/src/main/agentChat.ts:642-700 forkChat; agentChatAcp.ts fork() (session/fork with _meta.jetbrains.air.fork.messageId); ChatPane.tsx:703-730,994 onBranch · GPUI: none (acp.rs has no session/fork; log.rs keeps messageId but nothing uses it)
- **Elicitation (agent questions / forms / URL)** (missing, medium, M) — Electron advertises elicitation, so the agent can ask the user structured questions: form fields (text, select, multiselect, boolean, number) or 'visit this URL'. They render inline with accept, decline and cancel. GPUI doesn't advertise it and rejects the request, so the agent can't ask. Chats saved by Electron that contain elicitation events show no trace of the question or answer in GPUI.  
  Electron: src/src/main/agentChatAcp.ts:482-530 createElicitation/completeElicitation, 588 (advertises elicitation:{form,url}); ChatPane.tsx:269-290,754 · GPUI: spike-gpui/src/acp.rs:153 (no elicitation capability), 372 (answers any other request 'not supported'); chat.rs:49-108 Rows ignores elicitation events
- **Stop with queued messages** (partial, medium, S) — In Electron, Stop cancels the turn and moves any queued follow-ups back into the composer so they aren't sent. In GPUI the queue survives Stop. The cancelled turn's 'result' event then sends the next queued message right away, so pressing Stop starts a new turn.  
  Electron: src/src/mainview/components/ChatPane.tsx:578-589 stop() · GPUI: spike-gpui/src/chat.rs:902-906 (Stop only calls cancel), 362-368 (result drains queue)
- **Steer fallback when agent can't steer** (partial, low, S) — When the agent doesn't support steering, Electron tells the user ('This agent can't take messages mid-turn — stopped it and sent yours instead'), cancels the turn and sends the message. In GPUI, ⌘Enter or 'Steer now' silently queues the message until the turn ends. Also, GPUI tags the message 'steered in' before the agent answers, even when the agent hands it back to be sent as a normal prompt. Electron only tags it on 'injected'.  
  Electron: src/src/mainview/components/ChatPane.tsx:597-633 (unsupported → notice + interruptAndSend with 3s grace); src/src/main/agentChat.ts:steer (marks steered only on 'injected') · GPUI: spike-gpui/src/chat.rs:409-417 (falls through to queue), 435-437 (marks steered before outcome)
- **Default mode per provider / Codex initial permission mode** (missing, medium, S) — Electron settings have a 'Default mode' per provider (for example auto or acceptEdits) that each new chat starts in, and that a saved chat gets after an app restart. Codex launches in a mode derived from the default permission mode (read-only, agent or full-access). GPUI has no default-mode setting and always launches Codex as 'agent'. On every start, including after a restart, GPUI restores the chat's last mode. So a chat last left in bypassPermissions comes back in bypass, where Electron would use the user's default.  
  Electron: src/src/main/agentChat.ts:463-482 (defaultMode applied on first start; chat's own config restored only after an idle stop this run); agentChatAcp.ts:105-110,124-127 codexMode→INITIAL_AGENT_MODE; mainview/components/AgentsManager.tsx:47-70 Default mode field; lib/chatConfig.ts defaultModeByProvider · GPUI: spike-gpui/src/settings.rs:17-47 (only theme/editor/terminal/provider); acp.rs:133 INITIAL_AGENT_MODE hardcoded 'agent'; chat.rs:324,345-359 (restores the chat's last config incl. mode on every start)
- **Adapter crash / exit reporting** (partial, medium, S) — If the adapter dies mid-turn, Electron shows an error row with the exit code. GPUI's chat just drops to idle with no message, and any queued messages sit there with nothing to trigger them.  
  Electron: src/src/main/agentChatAcp.ts:540-560 (proc error + exit: emits 'X adapter exited with code N' error, then exited); agentChat.ts track() drops the dead driver · GPUI: spike-gpui/src/acp.rs:165 (always emits exited code 0, no error); chat.rs:370-373 (exited: agent=None, Idle, no row, queue not drained)
- **Legacy .json chat logs** (missing, medium, S) — Chats from before the JSONL change, never reopened in Electron since, still show in GPUI's Reopen list (their meta exists), but open empty with no resume id. Sending starts a fresh agent session with no context. That writes a new .jsonl newer than the legacy .json, so Electron then prefers the .jsonl and the old history is hidden in both apps.  
  Electron: src/src/main/agentChat.ts:40-42,175-205 loadPersisted (reads <id>.json when newer than .jsonl and migrates it) · GPUI: spike-gpui/src/log.rs:55-77 ChatLog::open (reads only .jsonl)
- **Meta updatedAt for untimestamped logs** (partial, low, S) — Opening and closing an old chat whose events have no ts makes GPUI rewrite the meta with updatedAt = now. The chat jumps to the top of the Chat ▾ list and its worktree looks just-used. Electron keeps the previously saved time so that reopening doesn't change recency.  
  Electron: src/src/main/agentChat.ts:81-95 lastWorkAt (falls back to the saved meta's updatedAt) · GPUI: spike-gpui/src/log.rs:143 (falls back to now_ms); chat.rs:864-868 Drop writes meta on every close
- **Binary or unreadable file opens as an editable empty buffer** (partial, high, S) — In Electron, opening a binary file shows 'Binary file — can't edit as text.' and no editor is created. In GPUI, read_file's Err('binary file') goes into a small header error, but an empty editable EditorState is still created and ⌘S stays wired. If the user types anything and presses ⌘S, git::write_file overwrites the binary file (or a file that failed to read) with that text, so data is lost.  
  Electron: src/src/mainview/components/FileEditor.tsx:59,147-148; src/src/main/git.ts:789-797 · GPUI: spike-gpui/src/files.rs:23-31,52-58
- **Keyboard navigation of the file trees (incl. 's' to stage)** (missing, high, M) — In Electron, the Uncommitted, Changes, commit-file and Files trees are ARIA trees with a roving focus. Arrow keys move and expand or collapse, Enter or Space opens a diff or file, and 's' stages or unstages the focused file or a whole folder. In GPUI none of these lists can take keyboard focus. Every action needs the mouse.  
  Electron: src/src/mainview/components/ReviewPanel.tsx:681-803 (FileTree onKeyDown: ↑/↓, Home/End, ←/→ expand/collapse/parent, Enter/Space activate, s/S stage file or folder) · GPUI: spike-gpui/src/review.rs:444-531 (file_row), 887-936 (Files uniform_list): click handlers only, no focus handle or key handlers
- **Changes shown as a folder tree vs a flat list** (missing, medium, M) — Electron shows uncommitted files, committed changes and each commit's files as a collapsible folder tree. Folders are expanded by default, single-child chains are collapsed, and each folder row shows a file count and summed +/− lines. GPUI shows one flat row per file (name plus a dimmed dir), so large change sets cannot be collapsed or scanned by folder.  
  Electron: src/src/mainview/components/ReviewPanel.tsx:514-521,619-626,1072-1136 (FileTree + buildTree/collapseDir/aggregate for Uncommitted, Changes and commit files) · GPUI: spike-gpui/src/review.rs:742,819,721-723 (flat file_row lists); tree.rs is used only by the Files view (review.rs:855)
- **Folder-level stage checkbox (tri-state)** (missing, medium, S) — In Electron, a folder row's checkbox stages or unstages everything under that folder, and it shows indeterminate when only some of it is staged. GPUI offers only a per-file checkbox and a global Stage all / Unstage all, so staging one directory takes N clicks.  
  Electron: src/src/mainview/components/ReviewPanel.tsx:738-747,809-851 (stageNode on dirs; checkbox indeterminate when partially staged) · GPUI: spike-gpui/src/review.rs:470-489 (per-file checkbox only), 799-804 (Stage all)
- **⌘↩ to commit from the message box** (missing, medium, S) — In Electron, pressing ⌘↩ in the commit message commits the staged files. In GPUI it does nothing (or inserts a newline), so the user has to click the Commit button. The placeholder also drops the shortcut hint.  
  Electron: src/src/mainview/components/ReviewPanel.tsx:1171-1181 (onKeyDown meta/ctrl+Enter → onCommit; placeholder 'Commit message…  (⌘↵ to commit)') · GPUI: spike-gpui/src/review.rs:120,806 (Textarea with no key binding or subscription for cmd-enter)
- **Commit message cleared before the commit succeeds** (partial, medium, S) — GPUI clears the textarea before git commit runs. If the commit fails (pre-commit hook rejects it, identity not set, and so on), the error shows but the typed message is gone. Electron keeps the message on failure.  
  Electron: src/src/mainview/components/ReviewPanel.tsx:156-170 (setMessage('') only after res.ok) · GPUI: spike-gpui/src/review.rs:379-381
- **Reattach detached worktree button** (missing, medium, S) — When a worktree is detached and its origin branch is known, Electron shows a 'Reattach to <branch>' button in the summary strip (fast-forward only, with a tooltip). GPUI has the git logic and data::Worktree.detached_from, but no UI, so the user cannot reattach from the app.  
  Electron: src/src/mainview/components/ReviewPanel.tsx:224-234,329-338; src/src/main/index.ts:1009-1016 (reattachWorktree RPC) · GPUI: spike-gpui/src/git.rs:275 (git::reattach ported but never called; no button in review.rs:575-640)
- **Create MR/PR ('Push & open PR/MR')** (missing, high, M) — When the branch has no PR/MR and a base is set, Electron offers 'Push & open PR' / 'Push & open MR'. It pushes, creates the request titled with the branch, toasts the number and opens it in the browser. GPUI only shows static text and has no way to open a review request.  
  Electron: src/src/mainview/components/BranchIntegrationBar.tsx:69-83,99-107; src/src/main/index.ts:912 (createReviewRequest) · GPUI: spike-gpui/src/review.rs:275-277 (shows only 'No {noun} for this branch'); codehost.rs has no create function (only branch_status at :498)
- **Preview tabs (single-click reuses one temporary tab; double-click/edit pins)** (missing, high, M) — In Electron, clicking through changed files swaps the content of one italic preview tab per worktree. Double-clicking the row or tab, or editing the file, makes it permanent. In GPUI every distinct file or diff click opens a new permanent tab, so reviewing 20 files leaves 20 tabs. There is no double-click to pin.  
  Electron: src/src/mainview/lib/terminalStore.ts:294-332,390-394; ReviewPanel.tsx:833-835 (double-click → preview:false); FileEditor.tsx:87-90 (edit promotes) · GPUI: spike-gpui/src/main.rs:379-385 (push_tab always appends), 387-419 (open_diff/open_file)
- **Re-opening an open file at a new line (search hit)** (partial, medium, S) — In Electron, clicking a second search hit in a file whose tab is already open jumps to and centers that line. In GPUI the existing tab is only focused and the cursor stays where it was, so later hits in the same file seem to do nothing.  
  Electron: src/src/mainview/lib/terminalStore.ts:372-379; FileEditor.tsx:116-125 (updates target line, setPosition + revealLineInCenter) · GPUI: spike-gpui/src/main.rs:413-416 (focus_tab and return; `line` ignored)
- **Save all editors ⌥⌘S and the Save button** (missing, medium, S) — In Electron, ⌥⌘S saves every open editor tab at once, and each editor header has a Save button. GPUI only saves the focused editor with ⌘S. ⌥⌘S does nothing and there is no clickable Save.  
  Electron: src/src/mainview/routes/RootLayout.tsx:36-39; lib/fileSavers.ts:6-10; FileEditor.tsx:134-141 (Save button, 'Saving…', disabled when clean) · GPUI: spike-gpui/src/main.rs:988 (only cmd-s bound in FileView context); files.rs:74-86 (no Save button)
- **Diff view: side-by-side full-file vs unified hunks** (partial, medium, S) — Electron diffs show the whole before and after file side by side, so the user can scroll the full file in context. GPUI shows a unified patch with only 3 lines of context per hunk and no split/unified toggle, even though the kit's DiffState has set_mode and set_context_lines.  
  Electron: src/src/mainview/components/DiffView.tsx:41,51-62 (fileContents before/after → Monaco diff editor, renderSideBySide: true); main/git.ts:821-842 · GPUI: spike-gpui/src/main.rs:387-409 (unified patch → DiffState::new, default DiffMode::Unified, 3 context lines); kit supports DiffMode::Split / set_mode / set_context_lines
- **Base-branch combobox with type-to-filter** (partial, medium, S) — In Electron the user types into the 'vs' picker to filter branches, including origin/* ones. GPUI shows a scroll-only menu of every local and origin branch with no search, which is slow in repos with hundreds of branches.  
  Electron: src/src/mainview/components/BranchCombobox.tsx:19-58 (Combobox input, select-on-focus, filters, 'No matching branch') · GPUI: spike-gpui/src/review.rs:679-687 (Button + scrollable DropdownMenu of all branches)
- **Change-section filter, diffstat totals, collapsible sections** (missing, medium, S) — In Electron, the Uncommitted and Changes sections can each be collapsed, show 'N files +X −Y' totals, and get a 'Filter files…' box when they hold more than 3 files. GPUI shows a title and count with no filter, no totals and no collapse.  
  Electron: src/src/mainview/components/ReviewPanel.tsx:464-525 (filter input when >3 files, 'N files +ins −del', Collapsible section toggle) · GPUI: spike-gpui/src/review.rs:533-551 (section_head: title + count only), 818-822
- **Search: live debounced, grouped by file** (partial, low, S) — Electron searches as you type, focuses the input when the Search tab opens, and groups results under each file (name, dir, hit count) with a line-number gutter. GPUI needs Enter and shows a flat list repeating 'path:line' on every hit. Search flags are the same on both sides (git grep -F -i -I).  
  Electron: src/src/mainview/components/ReviewPanel.tsx:887-968 (autofocus, 200ms debounce on typing, groups hits under file header with count, line-number column) · GPUI: spike-gpui/src/review.rs:129-133 (search only on Enter), 944-987 (flat list of path:line + text, no autofocus)
- **Update-from-base shown on primary; status badges missing** (partial, low, S) — On the primary checkout (e.g. main) behind its chosen base, GPUI still offers 'Update from <base>' (rebase/merge/agent merge), which Electron hides. GPUI's summary strip also has no 'primary' / 'detached' / 'locked' badges.  
  Electron: src/src/mainview/components/ReviewPanel.tsx:294 (`!worktree.isPrimary`), 339-343 (primary/detached/locked badges) · GPUI: spike-gpui/src/review.rs:590-609 (no primary check), 575-640 (no badges)
- **Commit rows: +/− stats and loading** (partial, low, S) — GPUI commit rows leave out each commit's +insertions/−deletions, although Commit carries them, and have no expand chevron. Expanding a commit runs git show on the UI thread, which can stall the UI on big commits. Electron loads the files asynchronously with a 'Loading…' row.  
  Electron: src/src/mainview/components/ReviewPanel.tsx:603-630 (chevron, hash, subject, +ins −del, relative time; async commitFiles with 'Loading…') · GPUI: spike-gpui/src/review.rs:435-442 (git::commit_files run synchronously on the UI thread), 700-718 (no ± stats, no chevron)
- **Ignored-folder listing placeholders** (partial, low, S) — Both list ignored folders lazily. In GPUI, expanding an empty ignored folder shows nothing at all, where Electron shows '(empty)'. The listing also runs on the UI thread, so a large ignored folder such as node_modules with up to 2000 entries can stall the UI.  
  Electron: src/src/mainview/components/ReviewPanel.tsx:970-1069 ('Show contents…' row inside unlisted ignored folders, '(empty)' row, async listDir) · GPUI: spike-gpui/src/review.rs:826-845 (click lists synchronously via git::list_dir on UI thread; nothing shown for empty folders)
- **Base-branch fetch/sync bar** (missing, low, M) — Electron's project view shows whether the project's base branch is behind origin, with an Update/Fetch button and the most recent upstream commits. GPUI has no equivalent anywhere (the README lists the project view as not built yet), so there is no in-app way to fetch the base branch.  
  Electron: src/src/mainview/components/BranchSyncBar.tsx:18-96 (rendered in routes/ProjectView.tsx:158) · GPUI: none
- **Window size/position persistence** (missing, medium, S) — In Electron, if you resize or move the window and relaunch, it comes back at the same size and place. GPUI always opens a centred 1440x900 window, so the layout has to be fixed again after every launch. GPUI could reuse the existing ~/.forest-ranger/window-state.json ({width,height,x,y}).  
  Electron: src/src/main/index.ts:1390-1456 (window-state.json read in createWindow, saved on resize/move/close, kept only if the position is still on a connected display) · GPUI: spike-gpui/src/main.rs:992 (Bounds::centered 1440x900 on every launch)
- **Standard app/window menus (Hide, Minimize, Zoom, Close Window, About)** (partial, medium, S) — In Electron, Cmd+H hides the app, Opt+Cmd+H hides other apps, Cmd+M minimizes, Window > Zoom works, Shift+Cmd+W closes the window, and About shows the version. In GPUI the app menu has only Quit and there is no Window menu, so Cmd+H and Cmd+M do nothing and the only way to close the window is the traffic light.  
  Electron: src/src/main/index.ts:1501-1516 (role appMenu + editMenu + Window menu with minimize, zoom, Close Window on Shift+Cmd+W) · GPUI: spike-gpui/src/main.rs:958-972 (menu has only Quit plus the Edit items)
- **Copy button on chat code blocks** (missing, medium, S) — When the agent replies with a command or snippet in a fenced code block, Electron shows a Copy button on hover that copies the whole block in one click. GPUI has no button, so you have to drag-select the text exactly and press Cmd+C.  
  Electron: src/src/mainview/components/Markdown.tsx:20-35,86 (CodeBlock: hover 'Copy' button that writes the fenced code to the clipboard and shows 'Copied') · GPUI: spike-gpui/src/chat.rs:556 (TextView::markdown without .code_block_actions(); the kit supports it, see gpui-base text_view.rs:384)
- **Code host settings: host field and Test connection** (partial, medium, S) — With GitHub Enterprise or self-hosted GitLab, Electron lets you type the host (e.g. gitlab.mycorp.com), click 'Use glab sign-in' and test the connection. GPUI shows the host but you cannot edit it, so 'Use gh/glab sign-in' always checks github.com or gitlab.com unless the host was already saved from the Electron app. This is part of the CLI flow, not OAuth.  
  Electron: src/src/mainview/components/IntegrationsManager.tsx:220-226 (editable Host field), 246-249 (Test connection button), 72-78 (connectCli passes host); src/src/main/index.ts:962 testIntegration, 1026 integrationUseCli({type, host, enable}) · GPUI: spike-gpui/src/settings.rs:193 (host is display-only text); spike-gpui/src/codehost.rs:206-209 (use_cli(p) always uses the stored host or the default)
- **Syntax highlighting for files picked by name (Makefile, Dockerfile, ...)** (partial, low, S) — Open a Makefile, Dockerfile or other file with no extension: Electron highlights it because it matches by filename. GPUI passes "text" and shows plain uncoloured text, even though the kit knows 'makefile'. Alias extensions such as .tfvars and .mdx also stay plain in GPUI unless the kit happens to recognise them.  
  Electron: src/src/mainview/lib/monaco.ts:60-67 (language picked by filename first, then extension, plus an alias table for .vue/.svelte/.svg/.mdx/.jsonc/.tf) · GPUI: spike-gpui/src/files.rs:28 (language comes only from Path::extension(), falling back to "text")
- **Reopened file returns to where you left off** (missing, low, S) — Scroll halfway down a long file, close its tab, and open it again from the tree or Cmd+P: Electron puts the cursor and scroll back where they were. GPUI reopens it at the top.  
  Electron: src/src/mainview/components/FileEditor.tsx:82-86,95 + src/src/mainview/lib/monaco.ts:75-90 (cursor and scroll saved per file in a 200-entry cache when the editor unmounts or the tab closes, restored on reopen) · GPUI: spike-gpui/src/files.rs:22-37 (each FileView reads the file fresh and the cursor goes to the given line or the top)
