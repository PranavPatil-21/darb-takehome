# Darb Portal — Receipt & Invoice OCR Matching

Receipts arrive by WhatsApp and invoices by email. They are extracted by OCR, scored
against card transactions on four weighted signals, and either attached automatically or
routed to a review queue with the evidence behind every score.

Design decisions, threshold justifications and trade-offs are in
**[`IMPLEMENTATION.md`](./IMPLEMENTATION.md)** — that is the document to read second.

---

## Setup

Requires Node 20+. No database server: SQLite, no Docker, no API keys.

```bash
npm install          # postinstall creates .env from .env.example, then runs `prisma generate`
npm run db:reset     # create prisma/dev.db, push the schema, seed it
npm run dev          # http://localhost:3000
```

`.env` is gitignored, so setup materialises it from `.env.example` — there are no secrets
to supply. If your npm blocks lifecycle scripts (npm 11 does by default) and
`node_modules/.prisma/client` is missing, run `npx prisma generate` once.

Then, in a second terminal:

```bash
npm run webhooks:demo
```

That fires nineteen sample payloads through both webhooks and prints what the pipeline
decided for each, annotated with the behaviour it demonstrates. Between them they reach
**every one of the nine reason codes the matcher can return**, so the script doubles as an
executable tour of the engine. Expected output:

| Payload | Outcome | Why |
|---|---|---|
| `whatsapp-01-exact-match` | `AUTO_MATCHED` 98% | Every signal agrees |
| `whatsapp-01-exact-match` *(again)* | `DUPLICATE` | Idempotency — no second document |
| `whatsapp-02-ambiguous` | `NEEDS_REVIEW` | Two transactions tie at 100% |
| `whatsapp-03-tip-mismatch` | `NEEDS_REVIEW` 84% | Receipt 57.50 vs charge 63.25 |
| `whatsapp-04-orphan` | `UNMATCHED` | No such transaction — retryable |
| `whatsapp-05-garbage` | `UNMATCHED` | OCR returned noise, no crash |
| `whatsapp-06-generic-merchant` | `AUTO_MATCHED` 98% | Picks Petromin over Alfanar |
| `whatsapp-07-wrong-client` | `UNMATCHED` | Another client's driver; scoping blocks it |
| `email-01-tax-invoice` | `AUTO_MATCHED` 100% | No card number; signals renormalise |
| `email-02-low-confidence` | `NEEDS_REVIEW` | Signals agree, OCR confidence 0.42 |
| `email-03-unknown-sender` | `UNMATCHED` | No `SenderIdentity` for this address |

It then posts the Kudu receipt's late-arriving transaction to `POST /api/transactions`,
which rescues that document automatically:

```json
{"created":[23],"rematch":{"scanned":3,"changed":1,
 "documents":[{"documentId":4,"from":"UNMATCHED","to":"MATCHED"}]}}
```

Finally it fires eight scenarios that each isolate one scoring rule. They belong to a
driver (card `5520`) nothing else is scoped to, so they cannot become stray candidates for
the scenarios above — or for each other:

| Payload | Outcome | Rule it isolates |
|---|---|---|
| `whatsapp-08-vat-rounding` | `AUTO_MATCHED` 99% | Receipt 88.45 vs charge 88.50 — VAT rounding inside tolerance |
| `whatsapp-09-date-drift` | `AUTO_MATCHED` 90% | Dated six days before settlement; the date is a weight, not a veto |
| `whatsapp-10-card-veto` | `UNMATCHED` | Everything agrees except the card digits |
| `whatsapp-11-currency-mismatch` | `UNMATCHED` | 199.00 USD against a 199.00 SAR charge |
| `whatsapp-12-undercharge` | `UNMATCHED` | Receipt 150.00, card paid 140.00 — no tip explains that |
| `whatsapp-13-second-receipt` | `NEEDS_REVIEW` 100% | A second claim on a transaction already documented |
| `whatsapp-14-faded-receipt` | `NEEDS_REVIEW` 60% | Merchant and date only — capped below the auto bar |
| `whatsapp-15-new-driver` | `UNMATCHED` | Driver onboarded before any of her transactions posted |

Open **http://localhost:3000** for the pipeline overview and
**http://localhost:3000/review** to confirm or reject candidates.

`requests.http` has the same requests for the VS Code REST Client or the JetBrains HTTP
Client, including the malformed payloads that return `400`.

---

## Tests

```bash
npm test           # 195 tests, 9 suites
npm run typecheck  # tsc --noEmit, strict
npm run build      # production build
```

Integration tests create their own throwaway `prisma/test.db`; they do not touch `dev.db`.

| Suite | Tests | Covers |
|---|---|---|
| `transaction-matcher` | 33 | All six brief edge cases, vetoes, purity, determinism |
| `matcher-edge-cases` | 65 | Every threshold probed on both sides of its edge |
| `webhooks` | 21 | 400 on malformed, never 500, HMAC, production fails closed |
| `document-ingestion` | 19 | Idempotency incl. concurrent, failure isolation, scoping |
| `merchant` | 18 | Normalisation and similarity on real acquirer strings |
| `rematch` | 12 | Late arrivals, rejections are permanent, late sender registration |
| `transactions-route` | 12 | Transaction ingestion and the re-match trigger |
| `review-actions` | 11 | Confirm/reject lifecycle, double-submit, slot contention |
| `fixtures` | 4 | The demo catalogue's own invariants |

---

## Layout

```
app/
  api/webhooks/email/route.ts       inbound email webhook
  api/webhooks/whatsapp/route.ts    inbound WhatsApp webhook
  api/transactions/route.ts         transaction ingestion — triggers re-matching
  review/page.tsx                   review queue
  page.tsx                          pipeline overview
lib/
  domain/enums.ts                   union types + Zod at the persistence boundary
  extraction/                       DocumentExtractor interface + MockExtractor
  matching/
    scoring-config.ts               every threshold, with its reasoning
    merchant.ts                     normalisation + similarity
  media/media-store.ts              MediaStore seam (WhatsApp media id → bytes)
  services/
    transaction-matcher.ts          the matching engine — pure, no I/O
    document-ingestion.ts           webhook → document pipeline
    candidate-selection.ts          scoped, date-bounded candidate query
    slot-claim.ts                   atomic one-document-per-transaction claim
    rematch.ts                      re-match sweep for late transactions
  actions/review.ts                 confirm / reject server actions
  webhooks/                         Zod schemas, HMAC, response helpers
prisma/schema.prisma, seed.ts       2 clients · 8 senders · 22 transactions
fixtures/                           18 documents + their webhook payloads
```

---

## How matching works

Four signals, each scored `0..1`, combined as a weighted average **over the signals that
are present**:

| Signal | Weight |
|---|---|
| Amount | 0.40 |
| Card last 4 | 0.25 |
| Merchant (fuzzy) | 0.20 |
| Date proximity | 0.15 |

A signal that could not be read is **omitted** from the breakdown and excluded from the
average — the remaining weights renormalise. "Not on the document" (no key) and `0`
("present and contradictory") are different claims and are never conflated.

Outcomes:

- **`AUTO_MATCHED`** — one candidate at or above `0.85`, clear of the runner-up by more
  than `0.05`, OCR confidence at least `0.60`, and the transaction not already documented.
- **`NEEDS_REVIEW`** — anything plausible that fails one of those. Candidates are
  persisted ranked, each with its signal breakdown.
- **`UNMATCHED`** — nothing plausible. Still retryable when a transaction arrives later.
- **`FAILED`** — terminal; extraction failed.

Scope is a **filter, not a signal**: a WhatsApp document reaches only that driver's
transactions, an email document only that client's. Wrong scope, a contradicting card
number, a currency mismatch, or an out-of-tolerance amount or date all **veto** a
candidate rather than lowering its score — none of them can be outvoted.

---

## Swapping in a real OCR provider

Everything is coded against `DocumentExtractor`:

```ts
export interface DocumentExtractor {
  extract(file: Buffer, mimeType: string): Promise<ExtractedDocument>;
}
```

`MockExtractor` is the only implementation and is selected in one place
(`lib/extraction/index.ts`). No other file in the codebase knows a concrete extractor
exists, so adding a real provider — LLM vision, Textract, Document AI — is a change to
that one file. The mock stays the default so the repository runs with no keys.

`MediaStore` is the same seam for WhatsApp media: `FixtureMediaStore` resolves ids from
`fixtures/`, a real one would call the Graph API.

---

## Webhook signatures

HMAC-SHA256 over the **raw request body**, before parsing:

- Email: `x-darb-signature`, secret `EMAIL_WEBHOOK_SECRET`
- WhatsApp: `x-hub-signature-256`, secret `WHATSAPP_WEBHOOK_SECRET`

`ALLOW_UNSIGNED_WEBHOOKS=true` (the development default) lets unsigned requests through so
the sample scripts work. A signature that is present but **wrong** is rejected regardless.

Set `ALLOW_UNSIGNED_WEBHOOKS=false` to require signatures:

```bash
BODY=$(cat fixtures/payloads/whatsapp-01-exact-match.json)
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WHATSAPP_WEBHOOK_SECRET" | awk '{print $2}')"
curl -X POST localhost:3000/api/webhooks/whatsapp \
  -H "content-type: application/json" -H "x-hub-signature-256: $SIG" --data "$BODY"
```

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run db:reset` | Push schema and reseed (safe while `npm run dev` is running) |
| `npm run db:studio` | Prisma Studio |
| `npm run webhooks:demo` | Fire all sample payloads at a running server |
| `npm run payloads:generate` | Rebuild `fixtures/payloads/` from the fixture documents |
| `npm test` | Jest |
| `npm run typecheck` | `tsc --noEmit` |
