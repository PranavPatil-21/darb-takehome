# Darb Portal — Receipt & Invoice OCR Matching

Receipts arrive by WhatsApp and invoices by email. They are extracted by OCR, scored
against card transactions on four weighted signals, and either attached automatically or
routed to a review queue with the evidence behind every score.

Design decisions, threshold justifications and trade-offs are in
**[`IMPLEMENTATION.md`](./IMPLEMENTATION.md)** — that is the document to read second.
Its **§ 7.5** is a written-down ledger of what is missing or unfinished, with the cost of
each gap and why it is still open.

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

The script signs every request with the HMAC secret from `.env`, so it behaves the same
under `npm run dev` and `npm start` — the latter runs in production mode, where unsigned
webhooks are always refused.

That fires nineteen requests — eighteen distinct payloads, one of them replayed — through
both webhooks and prints what the pipeline decided for each, annotated with the behaviour
it demonstrates. Between them they reach **nine of the matcher's eleven reason codes**, so
the script doubles as an executable tour of the engine. (The two it does not reach are
`MID_CONFIDENCE` and `INSUFFICIENT_CORROBORATION`, both covered by unit tests instead.)

The first eleven requests:

| Payload | Outcome | Why |
|---|---|---|
| `whatsapp-01-exact-match` | `AUTO_MATCHED` 98% | Every signal agrees |
| `whatsapp-01-exact-match` *(again)* | `DUPLICATE` | Idempotency — no second document |
| `whatsapp-02-ambiguous` | `NEEDS_REVIEW` | Two transactions tie at 100% |
| `whatsapp-03-tip-mismatch` | `NEEDS_REVIEW` 84% | Receipt 57.50 vs charge 63.25 — `UNEXPLAINED_AMOUNT_GAP` |
| `whatsapp-04-orphan` | `UNMATCHED` | No such transaction — retryable |
| `whatsapp-05-garbage` | `UNMATCHED` | OCR returned noise, no crash |
| `whatsapp-06-generic-merchant` | `AUTO_MATCHED` 98% | Picks Petromin over Alfanar |
| `whatsapp-07-wrong-client` | `UNMATCHED` | Another client's driver; scoping blocks it |
| `email-01-tax-invoice` | `AUTO_MATCHED` 100% | No card number; remaining signals renormalise |
| `email-02-low-confidence` | `NEEDS_REVIEW` | Signals agree, OCR confidence 0.42 |
| `email-03-unknown-sender` | `UNMATCHED` | No `SenderIdentity` for this address — never reaches the matcher |

It then posts the Kudu receipt's late-arriving transaction to `POST /api/transactions`,
which rescues that document automatically:

```json
{"created":[1199],"rematch":{"scanned":3,"changed":1,"truncated":false,
 "documents":[{"documentId":2705,"from":"UNMATCHED","to":"MATCHED"}]}}
```

(Ids depend on seed order; the shape and the `UNMATCHED → MATCHED` transition are the
point.) `POST /api/transactions` requires an `Idempotency-Key` header — it creates
financial records, and the sweep makes a client-side timeout likely enough that a blind
retry would otherwise double them.

Finally it fires eight scenarios that each isolate one scoring rule. Seven belong to a
driver (card `5520`) nothing else is scoped to, so they cannot become stray candidates for
the scenarios above — or for each other; the eighth is a newly-onboarded driver (card
`6604`) deliberately seeded with no charges at all:

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

[`docs/requests.http`](./docs/requests.http) has the same requests for the VS Code REST Client or the JetBrains HTTP
Client, including the malformed payloads that return `400`.

---

## Tests

```bash
npm test           # 495 tests, 32 suites
npm run typecheck  # tsc --noEmit, strict
npm run lint       # eslint, type-aware rules on lib/, app/ and components/
npm run build      # production build
npm run test:coverage  # coverage gates, below
```

Integration tests create their own throwaway `prisma/test.db`; they do not touch `dev.db`.

Coverage is gated per path rather than by one repo-wide number, as
statements/branches/functions/lines:

| Gated path | Gate | Actual |
|---|---|---|
| global (the rest of `lib`) | 87 / 73 / 83 / 89 | 88.29 / 74.92 / 84.64 / 89.96 |
| `lib/matching` | 95 / 95 / 95 / 95 | 98.85 / 96.42 / 100 / 100 |
| `lib/services/transaction-matcher.ts` | 97 / 92 / 95 / 99 | 97.57 / 92.30 / 100 / 99.20 |
| `lib/services/document-ingestion.ts` | 83 / 83 / 80 / 83 | 86.11 / 86.53 / 80 / 85.84 |

Jest removes a path-specific threshold group from the global one, so the global row is
measured over `lib` *minus* the three paths below it. That is why it reads lower than the
coverage summary's "All files" row (89.89 / 78.87 / 85.87 / 91.19), which includes them.

| Suite | Tests | Covers |
|---|---|---|
| `matcher-edge-cases` | 72 | Every scoring threshold probed on both sides of its edge |
| `transaction-matcher` | 34 | All six of the brief's edge cases, vetoes, purity, determinism |
| `comparison` | 37 | The document-vs-charge diff, and what separates two tied charges |
| `work-queue` | 35 | The taxonomy is exhaustive; nothing waiting can fall out of the queue |
| `matcher-corroboration` | 24 | Minimum evidence, uninformative merchant names, card formats |
| `architecture` | 26 | Layering, matcher purity, request-state confinement, single-writer rules |
| `webhooks` | 21 | 400 on malformed, never 500, HMAC, production fails closed |
| `messages` | 34 | The content layer: interpolation, pluralisation, missing keys, reason coverage |
| `document-ingestion` | 19 | Idempotency incl. concurrent, failure isolation, scoping |
| `merchant` | 18 | Normalisation and similarity on real acquirer strings |
| `transaction-status` | 13 | Derived documentation status, precedence, ageing |
| `verification` | 16 | Maker-checker selection policy and segregation of duties |
| `review-actions` | 12 | Confirm/reject lifecycle, double-submit, slot contention |
| `rematch` | 12 | Late arrivals, rejections are permanent, late sender registration |
| `transactions-route` | 13 | Transaction ingestion and the re-match trigger |
| `coverage` | 12 | Receipt coverage and the 15/115 VAT extraction |
| `identity` | 11 | The host seam, capabilities and tenant scoping |
| `audit-integrity` | 9 | The trail outlives the document; sibling rejections; un-reject |
| `document-detail` | 8 | A document's journey: extraction, charges considered, scoping |
| `comparison-nway` | 8 | Three-way ties, and every distinct value reported |
| `rematch-bounds` | 7 | Sweep limits, truncation reporting, batch idempotency |
| `charge-detail` | 7 | The evidence file: sign-off, signals, history that explains itself |
| `audit` | 7 | The append-only trail and what it survives |
| `charge-status` | 7 | The materialised status tracks the derivation on every path |
| `age-range` | 6 | The SQL age range selects exactly what the bucket function would |
| `action-refusals` | 6 | A refusal is reported, not thrown |
| `pipeline-isolation` | 5 | One failing attachment or message costs only itself |
| `enums` | 5 | Decoding untrusted values at the persistence boundary |
| `fixtures` | 4 | The demo catalogue's own invariants |
| `dashboard-ageing` | 2 | A charge ages the same however it is filtered; a waiting document ages against now |
| `charge-register` | 2 | Status chips count every charge; status and age filters compose |
| `assurance-actions` | 3 | Overturn and uphold driven to completion |

---

## Documents

| File | What it covers |
|---|---|
| `IMPLEMENTATION.md` | The matching engine, the pipeline, scoring design, deviations from the brief |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Layering, the host boundary, data-model decisions, scaling limits, reversed decisions |
| `docs/specs/2026-10-13-platform-architecture-design.md` | The platform-architecture design note behind the module/host split |
| [`docs/requests.http`](./docs/requests.http) | Every sample request for the VS Code REST Client / JetBrains HTTP Client |
| [`docs/requirements.md`](./docs/requirements.md) | The original brief, kept in the repository for reference |

---

## Layout

```
app/
  api/webhooks/email/route.ts       inbound email webhook
  api/webhooks/whatsapp/route.ts    inbound WhatsApp webhook
  api/transactions/route.ts         transaction ingestion — triggers re-matching
  review/page.tsx                   review queue — the decision screen
  page.tsx                          overview — receipt coverage in riyals
lib/
  domain/enums.ts                   union types + Zod at the persistence boundary
  domain/document-status.ts         pure derivation of a document's status
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
    document-status.ts              the single writer of Document.status
    charge-status.ts                the single writer of the charge-side status
  actions/review.ts                 confirm / reject server actions
  webhooks/                         Zod schemas, HMAC, response helpers
  ui/
    comparison.ts                   document-vs-charge diff, pure and tested
    coverage.ts                     receipt coverage + VAT at risk (15/115)
    vocabulary.ts                   six pipeline states → four words a reader uses
types/index.ts                      the published type surface (type-only re-exports)
components/
  review/                           the decision: comparison, candidates, actions
  dashboard/                        coverage headline, worklists
  chrome/, documents/               nav and the one place status becomes colour
  assurance/, charges/, shell/, ui/ maker-checker, charge views, layout, primitives
prisma/schema.prisma, seed.ts       2 clients · 8 senders · 202 transactions (22 scripted + 180 background)
fixtures/                           18 documents + their webhook payloads
__tests__/                          32 suites, mirroring the modules above
scripts/                            seed/demo tooling — the sample-webhook runner lives here
docs/                               ARCHITECTURE.md, requests.http, the brief, design notes
```

Only `README.md` and `IMPLEMENTATION.md` sit at the root alongside configuration, because
those two are the brief's named deliverables. Everything else that is prose — the
architecture note, the sample requests, the original brief — lives under `docs/`. The
remaining root entries are files their tooling requires there: `package.json`,
`tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`,
`components.json` and `jest.config.ts` are all resolved from the project root.

The brief's required project structure is satisfied in full — both webhook routes,
`lib/prisma.ts`, the extractor interface and its mock, `document-ingestion.ts`,
`transaction-matcher.ts`, `lib/actions/review.ts`, `prisma/schema.prisma` and `seed.ts`,
`fixtures/`, and `types/`. The last is now present as a type-only index, so a consumer of
the matcher imports from one path instead of the internal layout.

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

Because of that renormalisation, an auto-match additionally requires **at least two
signals to have been scored**. One signal renormalises to the full weight and scores
`1.00`, which would otherwise let a lone matching amount attach a document to money with
nothing corroborating it. Single-signal candidates still appear in the queue; they just
cannot settle themselves.

Outcomes:

- **`AUTO_MATCHED`** — one candidate at or above `0.85`, clear of the runner-up by more
  than `0.05`, OCR confidence at least `0.60`, no unexplained amount gap (below),
  and the transaction not already documented.
- **`NEEDS_REVIEW`** — anything plausible that fails one of those. Candidates are
  persisted ranked, each with its signal breakdown.
- **`UNMATCHED`** — nothing plausible. Still retryable when a transaction arrives later.
- **`FAILED`** — terminal; extraction failed.

Two rules a reviewer re-running the demo will notice, both added after the first pass:

- **An amount gap beyond VAT rounding gates the automatic attachment.** It is a gate, not
  a confidence cap — the reported score is unchanged, which is why the tip case still
  reads 84% but now returns `UNEXPLAINED_AMOUNT_GAP` rather than a mid-confidence review.
  Before it existed the outcome of the brief's own 57.50-vs-63.25 example depended on how
  the acquirer had abbreviated the merchant name.
- **Two date windows.** `maxDateDriftDaysFor()` holds a `TAX_INVOICE` to 45 days and a
  `RECEIPT` to 7; an `UNKNOWN` type takes 45 if it arrived by email and 7 otherwise.
  `candidate-selection.ts` calls the same function, so the query is never narrower than
  the matcher. A supplier invoice agreeing on amount, card and merchant used to be vetoed
  outright at eight days.

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
| `npm run dev` | Dev server. Refuses to start a second one on a busy port — see below |
| `npm run db:reset` | Push schema and reseed (safe while `npm run dev` is running) |
| `npm run db:studio` | Prisma Studio |
| `npm run webhooks:demo` | Fire all sample payloads at a running server |
| `npm run payloads:generate` | Rebuild `fixtures/payloads/` from the fixture documents |
| `npm test` | Jest |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, with type-aware rules on `lib/`, `app/` and `components/` |

### If every route returns 500

Two dev servers sharing one `.next` corrupt each other, and the symptom is a 500 on
everything — including API routes that render no React. Next does not warn: when port 3000
is busy it quietly moves to 3001 and reuses the same build directory. `npm run dev` now
refuses to start in that situation and names the process holding the port.

Deleting `.next` while a server is running produces the same symptom; the server does not
recover. Stop it first.

To run two servers deliberately, give the second its own build directory:

```bash
NEXT_DIST_DIR=.next-alt PORT=3002 DARB_ALLOW_SECOND_DEV=1 npm run dev
```
