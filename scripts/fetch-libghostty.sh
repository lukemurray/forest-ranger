#!/usr/bin/env bash
# Fetch libghostty-vt (the terminal emulator behind terminal tabs) into vendor/:
# the prebuilt macOS static library + headers from the official release, checksum-verified.
# build.rs runs this when vendor/ghostty-vt.xcframework is missing.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=1.0.1
SHA256=c0f9631277f726154c8f521954d17cdc41aac4626fc0df8cf925a19ee58e829b
ZIP="ghostty-vt-$VERSION.xcframework.zip"
mkdir -p vendor
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://release.files.ghostty.org/libghostty-vt/$VERSION/$ZIP" -o "$tmp/$ZIP"
echo "$SHA256  $tmp/$ZIP" | shasum -a 256 -c - >/dev/null
unzip -q "$tmp/$ZIP" -d "$tmp/out"
rm -rf vendor/ghostty-vt.xcframework
mv "$tmp/out/ghostty-vt.xcframework" vendor/
echo "$VERSION" > vendor/ghostty-vt.version
echo "libghostty-vt $VERSION → vendor/ghostty-vt.xcframework"
