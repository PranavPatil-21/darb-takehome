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
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAYLOAD_DIR="${ROOT_DIR}/fixtures/payloads"

# Sign every request when a secret is available.
#
# `npm run dev` accepts unsigned requests so this script works out of the box, but
# `npm start` runs in production mode where unsigned webhooks are always refused — a
# security default that fails closed. Signing here means the demo behaves identically in
# both, and exercises the HMAC path rather than skipping past it.
if [ -f "${ROOT_DIR}/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "${ROOT_DIR}/.env"; set +a
fi

sign() {
  local body="$1" secret="$2"
  [ -z "${secret:-}" ] && return 0
  command -v openssl >/dev/null 2>&1 || return 0
  printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -hex 2>/dev/null |
    sed 's/^.*= /sha256=/'
}

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }

send() {
  local endpoint="$1" file="$2" note="$3"
  bold "→ ${file}"
  dim  "  ${note}"

  local body signature header secret
  body=$(cat "${PAYLOAD_DIR}/${file}.json")
  if [ "$endpoint" = "whatsapp" ]; then
    header='x-hub-signature-256'; secret="${WHATSAPP_WEBHOOK_SECRET:-}"
  else
    header='x-darb-signature';    secret="${EMAIL_WEBHOOK_SECRET:-}"
  fi
  signature=$(sign "$body" "$secret")

  local response
  if [ -n "${signature:-}" ]; then
    response=$(curl -sS -X POST "${BASE_URL}/api/webhooks/${endpoint}" \
      -H 'content-type: application/json' \
      -H "${header}: ${signature}" \
      --data-binary "${body}" 2>&1)
  else
    response=$(curl -sS -X POST "${BASE_URL}/api/webhooks/${endpoint}" \
      -H 'content-type: application/json' \
      --data-binary "${body}" 2>&1)
  fi

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
send whatsapp whatsapp-07-wrong-client    "Nujood driver sends a receipt matching a Rawabi transaction exactly → scoping blocks it."

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

echo
bold "─── Scoring rules, one scenario each ───"
dim  "Driver Saad (card 5520) exists only for these. Nothing else is scoped to that card,"
dim  "so each scenario isolates exactly one rule."
echo

send whatsapp whatsapp-08-vat-rounding      "Receipt 88.45 vs charge 88.50 - VAT rounding, inside tolerance -> AUTO_MATCHED."
send whatsapp whatsapp-09-date-drift        "Receipt dated six days before settlement -> still AUTO_MATCHED, at 0.895 not 0.99."
send whatsapp whatsapp-10-card-veto         "Everything agrees except the card digits -> vetoed, UNMATCHED."
send whatsapp whatsapp-11-currency-mismatch "199.00 USD against a 199.00 SAR charge -> vetoed, UNMATCHED."
send whatsapp whatsapp-12-undercharge       "Receipt 150.00, card paid 140.00 - no tip explains that -> vetoed, UNMATCHED."
send whatsapp whatsapp-13-second-receipt    "Cardholder slip for a transaction already documented -> TRANSACTION_ALREADY_DOCUMENTED."
send whatsapp whatsapp-14-faded-receipt     "Merchant and date survived, amount and card did not -> WEAK_EVIDENCE, capped at 0.6."
send whatsapp whatsapp-15-new-driver        "Driver onboarded before any of her transactions posted -> NO_CANDIDATE_TRANSACTIONS."

bold "Done. Open ${BASE_URL} for the overview and ${BASE_URL}/review for the queue."
