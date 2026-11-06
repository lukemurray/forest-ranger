#!/usr/bin/env bash
# Create a local, self-signed code-signing identity ("Forest Ranger Local") that
# scripts/bundle-macos.sh signs with, so macOS keeps the app's privacy permissions
# across rebuilds. Only meaningful on this Mac. Asks for your password once (to trust
# the certificate for code signing).
set -euo pipefail
NAME="Forest Ranger Local"
if security find-identity -v -p codesigning | grep -qF "\"$NAME\""; then
  echo "'$NAME' already exists"; exit 0
fi
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/ext.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
/usr/bin/openssl req -x509 -newkey rsa:2048 -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -days 3650 -nodes -config "$tmp/ext.cnf" 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$NAME" -out "$tmp/id.p12" -passout pass:tmp
security import "$tmp/id.p12" -k ~/Library/Keychains/login.keychain-db -P tmp -T /usr/bin/codesign
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db "$tmp/cert.pem"
echo "Created '$NAME'"
