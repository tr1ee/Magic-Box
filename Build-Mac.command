#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Please run this script on macOS.' >&2
  exit 1
fi
if [[ "$(sw_vers -productVersion | cut -d. -f1)" -lt 14 ]]; then
  echo 'This build requires macOS 14 or later.' >&2
  exit 1
fi
if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo 'Install Apple Command Line Tools first: xcode-select --install' >&2
  exit 1
fi
case "$(uname -m)" in
  arm64) arch=arm64; checksum=cc04a76a09f79290194c0646f48fec40354d88969bec467789a5d55dd097f949 ;;
  x86_64) arch=x64; checksum=00df9c5df3e4ec6848c26b70fb47bf96492f342f4bed6b17f12d99b3a45eeecc ;;
  *) echo 'Unsupported Mac architecture.' >&2; exit 1 ;;
esac
mkdir -p .cache/mac-build
archive="node-v22.20.0-darwin-$arch.tar.gz"
if [[ ! -f ".cache/mac-build/$archive" ]]; then
  curl --fail --location --retry 3 "https://nodejs.org/dist/v22.20.0/$archive" -o ".cache/mac-build/$archive.download"
  mv ".cache/mac-build/$archive.download" ".cache/mac-build/$archive"
fi
echo "$checksum  .cache/mac-build/$archive" | shasum -a 256 -c -
tar -xzf ".cache/mac-build/$archive" -C .cache/mac-build
export PATH="$PWD/.cache/mac-build/node-v22.20.0-darwin-$arch/bin:$PATH"
npm ci --no-audit --no-fund
npm run build
node --test test/macos-package.test.mjs
node scripts/build-macos.mjs
echo 'DMG build completed. See release/macos.'
if [[ "${CI:-}" != true ]]; then open release/macos; fi
