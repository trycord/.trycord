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

# Publish the client's assets at the deployment root. The public pages and the
# client both reference /assets/... absolutely, and the client tree now lives
# under /app, so without this the static build 404s every brand image. This is
# what makes public/assets a duplicate rather than a second source.
cp -r trycord-client/app/assets trycord-client/assets
