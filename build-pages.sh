#!/bin/bash
set -e

rm -rf dist
mkdir -p dist

# Public website → /
cp -r public/. dist/

# WAC → /app/
mkdir -p dist/app
cp -r trycord-client/. dist/app/
