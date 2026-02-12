#!/bin/zsh
set -euo pipefail

ROOT_DIR="/Users/kimhyunhomacmini/.openclaw/workspace/coupang-automation"
cd "$ROOT_DIR"

TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${TELEGRAM_CHAT_ID:-}"
STATUS_TOKEN="${STATUS_API_TOKEN:-}"
MSG_ID="${TELEGRAM_MESSAGE_ID:-}"

if [[ -z "$TOKEN" || -z "$CHAT_ID" || -z "$STATUS_TOKEN" ]]; then
  echo "missing env: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID/STATUS_API_TOKEN" >&2
  exit 2
fi

# Fetch summary
SUMMARY_JSON=$(curl -fsS -H "Authorization: Bearer ${STATUS_TOKEN}" "http://127.0.0.1:3000/api/status/summary")
TEXT=$(printf '%s' "$SUMMARY_JSON" | /usr/bin/python3 -c 'import json,sys; j=json.load(sys.stdin); print(j.get("text") or "status: (no text)")')

# Telegram edit if message_id provided, else send new
API="https://api.telegram.org/bot${TOKEN}"
if [[ -n "$MSG_ID" ]]; then
  curl -fsS -X POST "$API/editMessageText" \
    -d chat_id="$CHAT_ID" \
    -d message_id="$MSG_ID" \
    --data-urlencode text="$TEXT" \
    -d disable_web_page_preview=true >/dev/null || true
else
  curl -fsS -X POST "$API/sendMessage" \
    -d chat_id="$CHAT_ID" \
    --data-urlencode text="$TEXT" \
    -d disable_web_page_preview=true >/dev/null
fi

echo "ok"
