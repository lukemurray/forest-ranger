# Agent notes for Forest Ranger

Rust desktop app on GPUI Kit (crate at the repo root). See README.md for what it does.

## Every change updates the changelog

Add a line to `CHANGELOG.md` for each user-facing change, in the same commit, under the
version it will ship in (the top heading). Use the existing area groups (Sidebar, Chats,
Title bar, Review panel, Project page, Tabs/terminals/window, Settings), or **Fixed**
for bug fixes.

`scripts/bundle-macos.sh --install` bumps the patch version in `Cargo.toml`
(`--install --minor` the minor). If the top heading is already released — `Cargo.toml`
has reached it — start a new heading for the next version.

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
