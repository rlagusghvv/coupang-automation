#!/usr/bin/env bash
set -euo pipefail

URL="${1:-}"
if [[ -z "$URL" ]]; then
  echo "Usage: ./scripts/retry_upload.sh \"<domeggook_url>\""
  exit 1
fi

INTERVAL_SEC="${INTERVAL_SEC:-120}"
MAX_TRIES="${MAX_TRIES:-20}"

for ((i=1; i<=MAX_TRIES; i++)); do
  echo ""
  echo "== Try $i/$MAX_TRIES =="
  node src/pipeline/steps/step20_upload_from_url.js "$URL" || true
  if [[ $i -lt $MAX_TRIES ]]; then
    echo "Waiting ${INTERVAL_SEC}s..."
    sleep "$INTERVAL_SEC"
  fi
done

echo "Done."
