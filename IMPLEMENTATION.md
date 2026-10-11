# Implementation notes

What I built, why the numbers are the numbers, where I deviated from the brief, and what
I would do next.

---

## 1. Shape of the solution

```
POST /api/webhooks/{email,whatsapp}
   │  Zod validates the raw body (400 on malformed)
   │  HMAC verified over the raw bytes, before parsing
   ▼
lib/services/document-ingestion.ts
   │  1. dedupe        externalId, or (sender, contentHash) → return existing, 200
   │  2. resolve scope sender → SenderIdentity → clientId / driverPhone
   │  3. PERSIST       the document is durable before anything that can fail runs
   │  4. extract       DocumentExtractor interface; MockExtractor is the default
   │  5. select        candidate transactions, scoped and date-bounded
   │  6. match         matchDocument() — pure, no I/O
   │  7. persist       ranked candidates + per-signal breakdown, in one transaction
   ▼
MATCHED  ·  NEEDS_REVIEW  ·  UNMATCHED  ·  FAILED
```

Three properties drove every structural decision, in this order:

1. **The webhook never loses a document and never 500s.** Storage happens before
   extraction. Everything after step 3 is wrapped so a failure moves the document to a
   terminal state and reports it, rather than propagating. A 500 would make the provider
   redeliver a message we already accepted.
2. **The matcher is pure.** No database, no clock, no mutation. Every edge case in the
   brief is therefore a plain unit test with no fixtures beyond two object literals.
3. **The rules live in the database where they can.** Idempotency and
   one-confirmed-document-per-transaction are constraints, not `if` statements.

### Why `matchDocument` takes `hasConfirmedDocument` as an argument

The rule "a transaction that already has a confirmed document must not auto-match a
second one" needs persisted state, and the brief also requires the matcher to be pure.
Those are only in tension if the matcher does the lookup. The caller loads the flag in
`selectCandidateTransactions` and passes it in on each `CandidateTransaction`. Purity
survives, and the rule is still enforced.

---

## 2. Scoring design

### Signals and weights

| Signal | Weight | Why that weight |
|---|---|---|
| **Amount** | 0.40 | The strongest discriminator available. Within one client's statement for one day, the exact halala total is very nearly a primary key. |
| **Card last 4** | 0.25 | Near-unique when present, but OCR reads it off well under half of crumpled thermal receipts. It cannot outrank a signal that is almost always available. |
| **Merchant** | 0.20 | Always present on both sides, but fuzzy and chain-repetitive — ten Alfanar stations are indistinguishable here. Corroborating, not deciding. |
| **Date** | 0.15 | Weakest alone (a fleet books dozens of transactions a day) but an effective tiebreaker between two otherwise equal candidates. |

All weights live in `lib/matching/scoring-config.ts` with the reasoning inline, so tuning
the engine is a one-file diff.

### Missing signals are renormalised, not zeroed

A signal that could not be read returns `null`, is **excluded from the weighted average**,
and the remaining weights are renormalised.

This is the single most consequential choice in the scoring code. Scoring a missing card
number as `0` would mean most receipts could never clear the auto-match threshold, and
the system would push into manual review exactly the work it exists to remove. `null`
("not on the document") and `0` ("on the document and contradictory") are different
claims, and the stored breakdown preserves the difference so a reviewer sees `n/a`
rather than a zero bar.

The emailed tax invoice fixture demonstrates this: it has no card number at all and still
auto-matches at 100%, on amount + merchant + date renormalised to 1.0.

### Amount is asymmetric — the most useful refinement in the engine

Amounts are integer minor units (halalas), so there is no floating-point epsilon to
chase, only genuine business tolerance:

| Case | Score | Reasoning |
|---|---|---|
| Exact | `1.00` | — |
| Within 5 halalas | `0.97` | VAT rounding drift. Symmetric and tiny. |
| Card charged **more**, up to +25% | `0.90 → 0.50`, linear | Tips and service charges. Everyday, and always in this direction. |
| Card charged **less**, up to −2% | `0.45` | Split bill or partial capture. Possible, rare, weak evidence. |
| Anything further | **veto** | Not the same purchase. |

The direction matters because tips only ever push the card *above* the printed receipt.
A flat symmetric tolerance would score a 10%-under charge the same as a 10% tip, when
one is routine and the other is an anomaly worth a human's attention. The brief's worked
example — receipt 57.50, charge 63.25 — scores `0.74` on amount and lands the document at
`0.84` overall: just under the auto threshold, which is the intended outcome.

### Merchant similarity

Acquirer names are hostile input: `ALFANAR FUEL ST 04 RUH` against `Alfanar Fuel Station`.
`normaliseMerchant` uppercases, strips diacritics, splits on punctuation, and discards
bare branch numbers, legal forms (`LLC`, `TRADING`, `EST`), and city codes (`RUH`, `JED`).

Comparison blends two measures because each covers the other's blind spot:

- **Token containment** handles one side carrying extra words — after normalisation both
  examples above reduce to `ALFANAR FUEL`, giving containment `1.0`.
- **Dice coefficient on character bigrams** handles spelling drift and concatenation that
  tokenisation cannot see. Dice rather than Levenshtein because it is order- and
  length-tolerant, and word reordering is the common acquirer failure mode; edit distance
  punishes both the reorder and the extra word.

`score = 0.55 × containment + 0.45 × dice`.

**The generic-token discount.** A match resting only on sector vocabulary (`FUEL`,
`STATION`, `RESTAURANT`, `MARKET`) is multiplied by `0.4`. Half the merchants in a fleet's
statement contain the word FUEL; that overlap carries almost no discriminating power and
must not manufacture confidence. `ALFANAR FUEL STATION` vs `PETROMIN FUEL STATION` scores
below `0.45` because of this, and the `whatsapp-06-generic-merchant` fixture proves it
end-to-end by picking the right station out of a set containing both.

### Thresholds

| Constant | Value | Reasoning |
|---|---|---|
| `AUTO_MATCH_THRESHOLD` | `0.85` | A lone candidate at 0.85 has essentially every available signal agreeing. Below this there is always at least one signal in real disagreement. |
| `MIN_CANDIDATE_THRESHOLD` | `0.45` | Below this a transaction is not worth a reviewer's screen space. Showing weak candidates trains reviewers to click through without reading. |
| `AMBIGUITY_MARGIN` | `0.05` | See below. |
| `MIN_EXTRACTION_CONFIDENCE_FOR_AUTO` | `0.60` | Agreement computed from a bad read is not evidence. |
| `WEAK_EVIDENCE_CONFIDENCE_CAP` | `0.60` | Merchant + date alone cannot attach money. |

### The ambiguity margin is the heart of it

If `top1 − top2 < 0.05`, the document goes to review **even when `top1` clears 0.85**.

This is the rule that makes the system safe to run unattended. Two same-amount, same-day
transactions at the same chain both score `1.00` — every signal agrees with both, because
the signals genuinely cannot tell them apart. Without the margin, the engine would attach
the receipt to whichever sorted first, be wrong half the time, and look confident doing
it. A near-tie is not a weak lead; it is positive evidence that the available signals are
insufficient, and the correct response is to ask a human.

`0.05` is deliberately generous. The asymmetric cost justifies it: a wrongly auto-attached
receipt is a silent VAT-compliance defect nobody looks for, while an unnecessary review is
fifteen seconds of a human's time.

### Vetoes versus low scores

Four conditions eliminate a candidate outright rather than scoring it low:

- **Wrong scope** — different client, or a WhatsApp document reaching another driver's card.
- **Contradicting card last 4** — both sides present and different.
- **Currency mismatch.**
- **Amount or date out of tolerance.**

A veto cannot be outvoted by other signals. A SAR receipt is not an AED charge no matter
how well the merchant name matches, and no weighted average should be able to conclude
otherwise.

### OCR confidence gates but does not dilute

`extractionConfidence` is kept out of the match score entirely and used only as an
auto-match gate. Folding it in would make the breakdown shown to a reviewer dishonest —
they would see "amount 100%, merchant 90%" and a total that matches neither, with no
indication why. The signals describe document-versus-transaction evidence; OCR confidence
is a separate axis and is displayed separately. The `email-02-low-confidence` fixture has
every signal at 100% and still routes to review.

---

## 3. Deviations from the brief, and why

### SQLite cannot do `enum` or `Json`

Prisma's SQLite connector supports neither. `DocumentSource`, `DocumentStatus`,
`MatchStatus` and `signals` are therefore `String` columns.

Type safety is recovered at the application boundary rather than lost:
`lib/domain/enums.ts` defines the union types and Zod schemas, and every value crossing
the persistence boundary passes through them. The domain model is unchanged; pointing the
datasource at Postgres would make these real enums with no application-code edits.

### Added: the `SenderIdentity` model

The brief's schema carries `clientId` and `driverPhone` on `Transaction`, but nothing maps
an **email address** to a client — which makes "an email document may only match that
client's transactions" unimplementable as given. `SenderIdentity` is that missing link.
It is the one schema extension that was not optional.

### Deduplication follows the brief exactly

`contentHash` is globally `@unique`, as specified: "the same file content (hash it) must
not create a duplicate `Document`." A redelivery under a different `messageId`, or the
same photo forwarded by a second person, resolves to the existing document and returns
`DUPLICATE` — never a 500, and never a second row.

I considered scoping it to `@@unique([senderIdentifier, contentHash])` instead. The
argument for scoping: two drivers forwarding the same supplier receipt would collide
under a global constraint, and the second submission — a legitimate compliance document
for a *different* transaction — is silently absorbed into the first. That is invisible
until an audit.

I implemented the brief's version. It is unambiguous about this, the collision is
genuinely rare in the described workflow (drivers photograph their own receipts; the
pixels differ), and inventing a different uniqueness rule would be me substituting my
judgement for a stated requirement. The observation is recorded under § 7 as something to
raise with the team rather than decide unilaterally.

Both directions are tested: `collapses the same photo sent twice under different message
ids`, and `collapses identical file content regardless of which sender submitted it`.

### Changed: scoping is a filter, not a scored signal

The brief lists sender scoping among the signals. Scoring it `0..1` would let a strong
amount-and-merchant match outvote it and attach one client's receipt to another client's
transaction. In a VAT-compliance product that is a correctness bug, not a ranking
preference.

It is enforced twice: as a `WHERE` clause in `selectCandidateTransactions`, and as a hard
veto inside the matcher. Defence in depth — a careless future caller cannot widen scope by
passing a sloppier candidate set.

---

## 4. One confirmed document per transaction

The brief asks for this "at the data layer, not just in UI logic", twice. Getting there
took two passes, and the second one is the interesting part.

**First attempt:** `confirmedDocumentId Int? @unique` on `Transaction`. This gives:

- *One confirmed document per transaction* — structurally, because the column is
  single-valued.
- *One transaction per confirmed document* — from the unique index.

**What a test caught:** neither of those stops an **overwrite**. A second
`confirmMatch` on the same transaction issues `update({ data: { confirmedDocumentId } })`,
which succeeds and silently replaces the first document's confirmation. No constraint
fires, because updating a row to a different value is not a violation. The first
document's evidence just disappears.

**The fix** (`lib/services/slot-claim.ts`) is a conditional `updateMany` — a
compare-and-set:

```ts
updateMany({
  where: { id: transactionId,
           OR: [{ confirmedDocumentId: null },          // free
                { confirmedDocumentId: documentId }] }, // already ours (idempotent)
  data: { confirmedDocumentId: documentId },
})
// count === 0  →  somebody else holds it
```

The database decides, atomically, in one statement. A read-then-write check would let two
concurrent reviewers both pass the read. Both the auto-match path and the review action
go through this helper, and the tests call the same helper the production code calls, so
the guarantee under test is the real one.

`rejectMatch` is the inverse: rejecting a *confirmed* match releases the slot. That is the
undo path for a wrong auto-match and the mechanism behind the duplicate-receipt flow —
reject the incumbent, then confirm the correct document.

### Idempotency of the review actions

Both actions short-circuit on an already-decided match and report `ALREADY_DECIDED`
rather than erroring or writing twice. The disabled button in the UI is a courtesy; the
protection is the server action and the constraint behind it, because a disabled button
protects nobody against a second browser tab.

---

## 5. Testing

**116 tests across 7 suites.** Distribution follows the brief's instruction to put most
effort into the matcher.

| Suite | Tests | Covers |
|---|---|---|
| `transaction-matcher` | 32 | All six edge cases, signal behaviour, veto rules, purity, determinism |
| `merchant` | 18 | Normalisation and similarity against real acquirer strings |
| `document-ingestion` | 19 | Idempotency (including concurrent), failure isolation, scoping |
| `webhooks` | 15 | 400 on malformed, never 500, HMAC verification |
| `transactions-route` | 12 | Transaction ingestion and the re-match trigger |
| `review-actions` | 11 | Confirm/reject lifecycle, double-submit, slot contention |
| `rematch` | 9 | Late-arriving transactions, sweep scope, no OCR replay |

Two deliberate choices:

- **Matcher tests are pure** — no database, no fixtures, no mocks. They run in ~0.1s.
- **Ingestion and review tests hit a real SQLite database.** The properties under test are
  enforced by unique constraints; a mocked Prisma client would assert that the code
  *intends* to be idempotent, not that it *is*. `__tests__/global-setup.ts` creates a
  throwaway `prisma/test.db`.

The six edge cases from the brief map to named `describe` blocks so they are greppable.

The real `confirmMatch` / `rejectMatch` server actions were additionally exercised over
HTTP against a running dev server, not only through the harness above: confirming a
candidate attached it and auto-rejected its sibling, and rejecting the confirmed match
released the transaction's slot back to `null`. The Jest harness mirrors the action
bodies because `'use server'` modules cannot be invoked outside a Next request context,
but it calls the same `slot-claim` helpers the actions call, so the concurrency guarantee
under test is the production one.

`any` appears nowhere in the codebase. Strict mode is on and `npm run typecheck` is clean.

---

## 6. Bonus items

The brief lists five. Four are implemented. The fifth is a design sketch, which is what
the brief asks for — see § 7.

| Bonus | Status |
|---|---|
| `/review` page with ranked candidates | Built |
| Re-match `UNMATCHED` documents when transactions arrive | Built, **with a trigger** |
| Webhook signature verification (HMAC) | Built |
| Multi-transaction invoice | Design sketch (§ 7) — *"a design sketch is enough"* |
| Swap the mock for a real extractor | Not built — see below |

### The re-match trigger — why `POST /api/transactions` exists

The bonus is "re-run matching for `UNMATCHED` documents **when new transactions are
ingested**". A sweep service alone would not satisfy that: nothing in the system created
transactions, so no code path could ever invoke it. A reviewer reading `rematch.ts` would
have found a well-tested function that production never runs.

`app/api/transactions/route.ts` closes the loop. It validates and inserts a batch, then
sweeps the unmatched backlog **for the affected clients only** — a global sweep would
rescan every unmatched document in the system on every batch — and reports what it
rescued:

```json
{"created":[17],"rematch":{"scanned":2,"changed":1,
 "documents":[{"documentId":4,"from":"UNMATCHED","to":"MATCHED"}]}}
```

Re-matching never re-runs OCR. The extraction is already persisted on the `Document` row,
and OCR is the expensive, non-deterministic, paid part of the pipeline — replaying it on
every new transaction would be the costliest possible mistake here. A test asserts this by
substituting an extractor that throws if it is ever called.

### Not built: a real extractor

The seam is in place and is the thing the brief actually grades — "keep the pipeline coded
against the interface so a real provider could be swapped in". `MockExtractor` is the only
implementation, selected in one place (`lib/extraction/index.ts`), and no other file knows
a concrete extractor exists. Adding a provider is a change to that file alone.

I did not add one. The brief makes the mock the default explicitly so reviewers can run
without keys, and a second implementation would add a dependency and a credential path
without demonstrating anything the interface does not already demonstrate.

---

## 7. What I would do next

**Move processing off the webhook thread.** Steps 4–7 run inline. Storage already happens
first, so the structure is right, but a real deployment should enqueue after persisting
and have a worker call `processDocument`. That function is already separate and takes a
document id for exactly this reason. OCR latency does not belong on a provider's timeout
budget.

**Store the file bytes.** Documents are extracted and discarded. Production needs blob
storage keyed by `contentHash` so a document can be re-extracted when the OCR model
improves, and so a reviewer can *see the receipt* — which today they cannot, and which is
the single biggest gap in the review UI.

### Multi-transaction invoices — design sketch

*The brief says a sketch is enough here, so this is a sketch rather than an
implementation. It is the design I would build.*

A monthly fleet statement covers many transactions at once, which the current
one-document-one-transaction model cannot express.

**Model it by changing the unit of claim, not by adding a special case.** A receipt makes
one claim about money ("someone paid 125.00 at Alfanar on 14 June"); a statement makes one
per line. So rather than teaching the system about statements, I would make *every*
document a list of claims — a plain receipt simply has a list of one:

- a `DocumentLineItem` model (`documentId`, `lineNumber`, `merchantName?`, `amount?`,
  `lineDate?`, `cardLast4?`, `reference?`, `status`), with nullable fields because a
  statement line usually omits what the header already states;
- `DocumentMatch` keyed on `lineItemId` instead of `documentId`;
- `Transaction.confirmedDocumentId` becomes `confirmedLineItemId`, keeping the
  compare-and-set guarantee from § 4 intact at line granularity.

The matching engine itself needs **no change**. It already matches "an extracted thing" to
a transaction, and a line item is that thing — the claim handed to it fills blank line
fields from the document header. The alternative (leaving matches on `Document` and adding
an optional line reference) would leave two confirmation paths on `Transaction` forever,
with a rule about which one wins.

**Three things that are not obvious until you work them through:**

*Lines compete for transactions.* Matching each line independently lets two lines both
claim the same transaction. I would resolve this greedily — rank every (line, candidate)
pair by confidence and assign in order, skipping lines and transactions already taken —
with one addition: if a line's winning candidate was also ranked within `AMBIGUITY_MARGIN`
by another line, demote it to review. That is the same rule § 2 already defends, applied
across lines instead of within one. True optimality is an assignment problem (Hungarian
algorithm); greedy-plus-contest-demotion is explainable to a reviewer, which matters more
here than optimality.

*Reconciliation is corroboration, not identification.* If the line amounts sum to the
invoice total, that is strong evidence the set is complete — so if 11 of 12 lines matched
confidently, the twelfth is near-certain. I would promote that last line only when: the
amounts reconcile, every other line matched, it has exactly one candidate above the review
floor, that transaction is not already documented, **and** the line has its own readable
amount above the VAT-rounding band. Without that last condition, "the totals add up" would
be the only evidence — and promoting on merchant and date alone is precisely what
`WEAK_EVIDENCE_CONFIDENCE_CAP` exists to prevent. The sum tolerance should scale with line
count (`VAT_ROUNDING_TOLERANCE_HALALAS × lines`), since per-line rounding accumulates.

*Document status becomes derived.* A document would be `MATCHED` only when every line is,
`PARTIALLY_MATCHED` when some are, `NEEDS_REVIEW` whenever any line needs a human. The
important part is that exactly one function computes it and every mutation path calls it —
four call sites each rolling up independently is how a document ends up reading `MATCHED`
with an unmatched line underneath.

**Learn the thresholds.** Every reviewer decision is labelled training data — the
`signals` JSON is a feature vector and the confirm/reject is the label. After a few
thousand decisions, the weights in `scoring-config.ts` should be fitted rather than
argued. I would keep the hand-tuned values as the fallback and as a sanity check on
whatever a model produces, since an explainable matrix is worth real money during an
audit.

**Operational metrics.** Auto-match rate, review-queue depth, and reviewer
agreement-with-the-engine (how often a reviewer picks the top-ranked candidate). The last
one is the honest measure of whether the scoring is any good, and it is free to collect.

**Per-client tuning.** A restaurant fleet and a logistics fleet have very different tip
distributions. `MAX_TIP_RATIO` wants to be per-client, or per-merchant-category.

**Raise the global content-hash question with the team.** Implemented as specified (§ 3),
`contentHash @unique` means two people forwarding the same supplier PDF produce one
document, and the second submission is absorbed. If that case turns out to be real in
production, the fix is to scope uniqueness to the sender and surface cross-sender
duplicates as a review reason rather than dropping them — but that changes a stated
requirement, so it is a conversation, not a unilateral decision.

---

## 8. Assumptions

- WhatsApp numbers are E.164 without a leading `+`; emails are lowercased. Both are
  normalised at ingestion (`normaliseSenderIdentifier`).
- Every amount everywhere is integer minor units. Money is never a float in this codebase.
- A document from an unregistered sender is stored but left `UNMATCHED` rather than
  `FAILED`, so registering the sender later and running the sweep resolves it without
  re-ingestion.
- The re-match sweep touches only `UNMATCHED` documents. `NEEDS_REVIEW` documents belong
  to a human and must not be reshuffled underneath them; `MATCHED` documents are settled.
- `MockExtractor` returns an `UNKNOWN` extraction for unrecognised content rather than
  throwing, because real OCR returns *something* for every input and the pipeline must
  handle a confident-looking nothing.
- **Supplier email addresses are mapped to a single client.** The seed registers
  `billing@alfanar-fuel.com.sa` as a `SenderIdentity` for Rawabi so the brief's sample
  payload resolves. This does not generalise — one supplier bills many fleets, so the
  same address would need to map to several clients. A production system would scope by
  the *receiving* inbox instead (a per-client alias such as
  `receipts+rawabi@darb.example.com`), which is unambiguous and costs nothing. I kept the
  sender-address mapping so the brief's payload works unmodified; the fleet-manager
  identity (`fleetops@rawabi-logistics.example`) is the shape that actually scales.
- Signature verification allows unsigned requests in development
  (`ALLOW_UNSIGNED_WEBHOOKS=true`) so the sample scripts run without signing. A signature
  that is **present but wrong** is always rejected regardless — permissiveness never
  extends to accepting a forgery.
