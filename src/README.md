# Forest Ranger

A desktop app for browsing and managing git worktrees by recency. Built with
Electron, React, and Vite (via electron-vite) for hot module replacement.

## Getting Started

```bash
# Install dependencies (also rebuilds native modules for Electron)
bun install

# Development with HMR
bun run dev

# Type-check
bun run typecheck

# Build the production bundle (out/)
bun run build

# Build and package a distributable (.dmg) via electron-builder
bun run dist
```

Native modules (`better-sqlite3`, `node-pty`) must be compiled against
Electron's ABI. `bun install` runs `electron-builder install-app-deps`, and you
can rebuild them manually any time with `bun run rebuild`.

## How it works

`electron-vite dev` starts the Vite dev server and the Electron main process
together; the renderer loads from the dev server (HMR) in development and from
`out/renderer/index.html` in a production build. The main process exposes a
single `forestRanger` bridge to the renderer through a context-isolated preload
(`invoke` for request/response, `send` for fire-and-forget, `onEvent` for
main→renderer pushes).

## Project Structure

```
├── src/
│   ├── main/                # Electron main process
│   │   ├── index.ts         # App lifecycle, window, IPC wiring
│   │   ├── db.ts            # SQLite store (better-sqlite3)
│   │   ├── terminals.ts     # PTY sessions (node-pty)
│   │   ├── agentChat.ts     # Claude Code stream-json chat driver
│   │   ├── git.ts           # git CLI wrapper
│   │   ├── gitlab.ts        # GitLab integration
│   │   └── apps.ts          # Editor/terminal detection + launching
│   ├── preload/
│   │   └── index.ts         # contextBridge → window.forestRanger
│   ├── shared/
│   │   └── types.ts         # IPC contract shared by main + renderer
│   └── mainview/            # React renderer
│       ├── App.tsx
│       ├── main.tsx
│       ├── index.html
│       └── index.css
├── electron.vite.config.ts  # electron-vite (main/preload/renderer) config
└── package.json             # scripts + electron-builder config
```

## Customizing

- **React components**: edit files in `src/mainview/`
- **Build/dev config**: edit `electron.vite.config.ts`
- **Window settings**: edit `createWindow()` in `src/main/index.ts`
- **App metadata / packaging**: edit the `build` field in `package.json`
