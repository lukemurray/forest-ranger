# Agent notes for Forest Ranger

Rust desktop app on GPUI Kit (crate at the repo root). See README.md for what it does.

## Every change updates the changelog

Add a line to `CHANGELOG.md` for each user-facing change, in the same commit, under
`## Unreleased` at the top (create that heading if it isn't there). Don't guess a version
number. Use the existing area groups (Sidebar, Chats, Title bar, Review panel, Project
page, Tabs/terminals/window, Settings), or **Fixed** for bug fixes.

Releasing is `scripts/bundle-macos.sh --install` (patch bump) or `--install --minor`: it
renames `## Unreleased` to `## <version> — <date>` and commits it with the bump.

## Build and check

```sh
cargo build
cargo test
cargo run -- --check     # loads the real data, read-only
FOREST_RANGER_DATA_DIR=$(mktemp -d) perl -e 'alarm 8; exec @ARGV' ./target/debug/forest-ranger   # smoke run
```

## Careful

- Real data lives in `~/.forest-ranger`. Never delete anything there; point anything that
  writes (tests, smoke runs) at a temp dir with `FOREST_RANGER_DATA_DIR`.
- GPUI: never read or update an entity from inside its own update — defer with
  `window.defer` (it has crashed the app before).
- Commit only when asked.
