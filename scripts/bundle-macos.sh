#!/usr/bin/env bash
# Build the release app bundle: dist/Forest Ranger.app
#   scripts/bundle-macos.sh            build it
#   scripts/bundle-macos.sh --install  build, then copy it to /Applications
#   scripts/bundle-macos.sh --install --minor   …as a minor release (0.9.3 → 0.10.0)
#   scripts/bundle-macos.sh --install --no-bump …keeping the current version (a rebuild)
set -euo pipefail
cd "$(dirname "$0")/.."

INSTALL=0 MINOR=0 BUMP=1
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --minor) MINOR=1 ;;
    --no-bump) BUMP=0 ;;
    *) echo "unknown option: $arg (use --install, optionally with --minor or --no-bump)" >&2; exit 1 ;;
  esac
done
if [ "$MINOR" = 1 ] && [ "$BUMP" = 0 ]; then
  echo "--minor and --no-bump contradict each other" >&2
  exit 1
fi
if [ "$MINOR" = 1 ] && [ "$INSTALL" = 0 ]; then
  echo "--minor goes with --install (it picks the version bump)" >&2
  exit 1
fi

# --install bumps the version first — patch (0.9.1 → 0.9.2), or with --minor the
# minor, resetting the patch (0.9.3 → 0.10.0); the build updates Cargo.lock — and
# commits the bump once installed, with CHANGELOG.md's "## Unreleased" heading
# stamped as this version and today's date.
if [ "$INSTALL" = 1 ] && [ "$BUMP" = 1 ]; then
  if [ "$MINOR" = 1 ]; then
    perl -0pi -e 's/^version = "(\d+)\.(\d+)\.(\d+)"/"version = \"$1.".($2+1).".0\""/me' Cargo.toml
  else
    perl -0pi -e 's/^version = "(\d+)\.(\d+)\.(\d+)"/"version = \"$1.$2.".($3+1)."\""/me' Cargo.toml
  fi
fi

NAME="Forest Ranger"
ID="dev.forestranger.app" # same bundle id as the old Electron app, so OS permissions carry over
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
APP="dist/$NAME.app"
RES="$APP/Contents/Resources"

cargo build --release

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES"
cp target/release/forest-ranger "$APP/Contents/MacOS/forest-ranger"
cp assets/icon.icns "$RES/icon.icns"

# Agents: the npm adapters, run with the system's `node`, driving the user's installed
# `claude` / `codex` (the app looks in Contents/Resources first; see acp.rs). The
# agents' own bundled engines are optional dependencies, left out.
mkdir -p "$RES/agents"
cp agents/package.json agents/package-lock.json "$RES/agents/"
(cd "$RES/agents" && npm ci --omit=dev --omit=optional --no-audit --no-fund --silent)
# Not needed at runtime: source maps, type declarations, docs.
find "$RES/agents/node_modules" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -iname '*.md' \) -delete

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$ID</string>
  <key>CFBundleExecutable</key><string>forest-ranger</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

# Sign with a stable identity when there is one, so macOS keeps the app's privacy
# permissions (Downloads, Full Disk Access, …) across rebuilds — an ad-hoc signature
# changes every build, and macOS then asks again. FR_SIGN_ID overrides; create the
# default with scripts/make-signing-cert.sh. Not notarized either way (local use).
SIGN_ID="${FR_SIGN_ID:-Forest Ranger Local}"
if security find-identity -v -p codesigning | grep -qF "\"$SIGN_ID\""; then
  codesign --force --deep --sign "$SIGN_ID" "$APP"
else
  echo "note: no '$SIGN_ID' signing identity — signing ad-hoc (permissions reset each build)"
  codesign --force --deep --sign - "$APP"
fi

# The bundle is rebuilt at the same path, so Finder/Dock can keep a stale (blank)
# icon: bump its date and re-register it with LaunchServices.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
touch "$APP"
"$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true

echo "Built $APP ($(du -sh "$APP" | cut -f1))"

if [ "$INSTALL" = 1 ]; then
  rm -rf "/Applications/$NAME.app"
  cp -R "$APP" /Applications/
  "$LSREGISTER" -f "/Applications/$NAME.app" >/dev/null 2>&1 || true
  echo "Installed /Applications/$NAME.app"
  if [ "$BUMP" = 1 ]; then
    # The changelog's "## Unreleased" section becomes this release, dated today.
    if grep -q '^## Unreleased$' CHANGELOG.md; then
      perl -pi -e 's/^## Unreleased$/## '"$VERSION"' — '"$(date +%F)"'/' CHANGELOG.md
      echo "Stamped CHANGELOG.md: $VERSION"
    fi
    git commit -q -m "$VERSION" -- Cargo.toml Cargo.lock CHANGELOG.md && echo "Committed $VERSION"
  fi
fi
