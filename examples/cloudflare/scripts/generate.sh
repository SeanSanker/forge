#!/bin/sh
# Generates sdk/ from Cloudflare's OpenAPI document, as forge publishes it,
# with x-fern-pagination added by scripts/paginate.ts, using the forge of
# this repository. The document is pinned, and checked against its SHA-256.
set -eu
cd "$(dirname "$0")/.."

SPEC_URL='https://github.com/cloudflare/forge/releases/download/openapi%40416bb87d1d110124bf96bc97ebba799e324ebcf8/openapi.forge.json'
# The SHA-256 of the public document, which is not a secret.
SPEC_SHA256='5d4e532ae0863ba67c33e0eda68668fa3a7aa22b63b1585d3c9912739e84e1ef' # pragma: allowlist secret

mkdir -p .spec
if [ ! -f .spec/openapi.forge.json ]; then
  curl -fsSL -o .spec/openapi.forge.json "$SPEC_URL"
fi
if command -v sha256sum >/dev/null; then
  echo "$SPEC_SHA256  .spec/openapi.forge.json" | sha256sum -c -
else
  echo "$SPEC_SHA256  .spec/openapi.forge.json" | shasum -a 256 -c -
fi

node scripts/paginate.ts .spec/openapi.forge.json .spec/openapi.paged.json
cargo build --release --quiet --manifest-path ../../Cargo.toml --bin forge
rm -rf sdk
../../target/release/forge .spec/openapi.paged.json --target effect --out sdk --name @example/cloudflare-effect
