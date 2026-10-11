#!/usr/bin/env bash
#
# Fires every sample payload at a running dev server and prints what the pipeline decided.
#
#   npm run dev            # in one terminal
#   npm run webhooks:demo  # in another
#
# Each payload is annotated with the behaviour it is meant to demonstrate, so the output
# doubles as a walkthrough of the matching engine.

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
PAYLOAD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/fixtures/payloads"

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }

send() {
  local endpoint="$1" file="$2" note="$3"
  bold "→ ${file}"
  dim  "  ${note}"

  local response
  response=$(curl -sS -X POST "${BASE_URL}/api/webhooks/${endpoint}" \
    -H 'content-type: application/json' \
    --data-binary "@${PAYLOAD_DIR}/${file}.json" 2>&1)

  if command -v jq >/dev/null 2>&1; then
    printf '%s\n\n' "$(echo "$response" | jq -c '.')"
  else
    printf '%s\n\n' "$response"
  fi
}

bold "Darb webhook demo → ${BASE_URL}"
echo

send whatsapp whatsapp-01-exact-match     "Every signal agrees → AUTO_MATCHED to transaction 1."
send whatsapp whatsapp-01-exact-match     "The exact same message again → DUPLICATE, no second document."
send whatsapp whatsapp-02-ambiguous       "Two Tamimi transactions, same amount, same day → NEEDS_REVIEW."
send whatsapp whatsapp-03-tip-mismatch    "Receipt 57.50 vs charge 63.25 (tip) → NEEDS_REVIEW, not a silent attach."
send whatsapp whatsapp-04-orphan          "Good receipt, no such transaction → UNMATCHED (retryable later)."
send whatsapp whatsapp-05-garbage         "OCR returned noise → terminal state, no crash."
send whatsapp whatsapp-06-generic-merchant "Petromin vs Alfanar: both 'FUEL STATION' → still picks Petromin."
send whatsapp whatsapp-07-wrong-client    "Nujood driver sends Rawabi's receipt: scoping hides Rawabi's identical txn, card veto kills their own."

send email    email-01-tax-invoice        "Tax invoice, no card number → auto-matches via renormalised signals."
send email    email-02-low-confidence     "Signals agree but OCR confidence is 0.42 → NEEDS_REVIEW."
send email    email-03-unknown-sender     "Unregistered sender → stored but unscoped, so UNMATCHED."

echo
bold "The Kudu receipt above is UNMATCHED because its transaction has not posted yet."
dim  "Posting it now should rescue the document automatically — no human, no re-run of OCR."
echo

bold "→ POST /api/transactions  (late-arriving transaction)"
response=$(curl -sS -X POST "${BASE_URL}/api/transactions" \
  -H 'content-type: application/json' \
  -d '{"transactions":[{"clientId":1,"cardLast4":"4412","driverPhone":"966551234567","merchantName":"KUDU REST 118 RUH","amount":3300,"currency":"SAR","transactionAt":"2025-06-19T13:12:00Z"}]}' 2>&1)
if command -v jq >/dev/null 2>&1; then
  printf '%s\n\n' "$(echo "$response" | jq -c '.')"
else
  printf '%s\n\n' "$response"
fi

bold "Done. Open ${BASE_URL} for the overview and ${BASE_URL}/review for the queue."
