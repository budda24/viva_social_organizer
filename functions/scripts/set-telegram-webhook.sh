#!/usr/bin/env bash
# Register (or re-register) the Telegram webhook with the CORRECT allowed_updates.
#
# CRITICAL: allowed_updates MUST include "callback_query" or every inline button
# across the bot silently does nothing (Telegram only delivers the listed update
# types). A previous manual setWebhook used allowed_updates=["message"], which
# dropped all button taps — keep this in sync if you ever re-point the webhook.
#
# Usage (needs firebase CLI auth + Node 20):
#   bash functions/scripts/set-telegram-webhook.sh
#
# Reads the bot token + webhook secret from Secret Manager so nothing is hardcoded.

set -euo pipefail

REGION="europe-central2"
PROJECT="viva-social-organizer"
URL="https://${REGION}-${PROJECT}.cloudfunctions.net/telegramWebhook"

TOKEN=$(npx -y firebase-tools@latest functions:secrets:access TELEGRAM_BOT_TOKEN)
SECRET=$(npx -y firebase-tools@latest functions:secrets:access TELEGRAM_WEBHOOK_SECRET)

curl -s -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  --data-urlencode "url=${URL}" \
  --data-urlencode "secret_token=${SECRET}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]'
echo

echo "--- getWebhookInfo ---"
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" \
  | python3 -c "import sys,json; d=json.load(sys.stdin).get('result',{}); print('url:', d.get('url')); print('allowed_updates:', d.get('allowed_updates'))"
