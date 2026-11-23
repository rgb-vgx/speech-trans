#!/bin/sh
# Build loadable folders: dist/chrome (MV3 service worker) and dist/firefox (event page).
set -eu
cd "$(dirname "$0")"
rm -rf dist/chrome dist/firefox
mkdir -p dist/chrome dist/firefox
cp -r src icons dist/chrome/
cp -r src icons dist/firefox/
cp manifest.json dist/chrome/manifest.json
cp manifest.firefox.json dist/firefox/manifest.json
echo "built dist/chrome and dist/firefox"
