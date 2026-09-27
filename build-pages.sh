#!/bin/bash
set -e

# Move the WAC into /app inside the deployment directory.
mkdir -p trycord-client/app

find trycord-client \
  -mindepth 1 \
  -maxdepth 1 \
  ! -name app \
  -exec mv {} trycord-client/app/ \;

# Put the public website at the deployment root.
cp -r public/. trycord-client/
