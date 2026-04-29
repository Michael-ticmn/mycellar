#!/usr/bin/env bash
# Regenerate architecture.pdf from architecture.html via headless Chrome.
# Run from any cwd. Requires Chrome installed at the standard Windows path.

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"

if [ ! -x "$CHROME" ]; then
  echo "Chrome not found at: $CHROME"
  echo "Edit this script to point at your Chrome install, or install from https://www.google.com/chrome/"
  exit 1
fi

"$CHROME" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --no-pdf-header-footer \
  --print-to-pdf="$HERE/architecture.pdf" \
  "file:///$HERE/architecture.html"

echo "Wrote: $HERE/architecture.pdf"
