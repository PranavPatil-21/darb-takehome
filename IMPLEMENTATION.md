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
   The one exception proves the rule: if WhatsApp media cannot be fetched there are no
   bytes, so there is no content hash and no `Document` to park in `FAILED` — nothing was
   stored, and a `200` would tell Meta the receipt was delivered and lose it permanently.
   That case alone answers `503`, which asks for the redelivery the rule above exists to
   avoid everywhere else. Messages that did succeed are still reported, and dedupe absorbs
   them on the retry.
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

A signal that could not be read is **omitted from the breakdown**, excluded from the
weighted average, and the remaining weights are renormalised.

This is the single most consequential choice in the scoring code. Scoring a missing card
number as `0` would mean most receipts could never clear the auto-match threshold, and
the system would push into manual review exactly the work it exists to remove. "Not on
the document" and "on the document and contradictory" are different claims, and the
stored breakdown preserves the difference: an unavailable signal has no key at all, a
contradictory one has a key whose value is `0`. The reviewer sees `n/a` rather than a
zero bar.

Omission rather than a `null` value is also what keeps the stored shape exactly the
`Record<string, number>` the brief specifies — callers test availability with
`'cardLast4' in signals`.

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
example — receipt 57.50, charge 63.25 — is a 10% gap and scores `0.74` on amount; against
the seeded charge the document lands at `0.8435` overall and routes to review. It gets
there on the amount-gap gate described below rather than on that number, which is the
point of that gate.

### Date proximity, and why there are two windows

Dates are scored in whole UTC days of drift against a fixed curve, and vetoed past the
window:

| Days apart | 0 | 1 | 2 | 3 | 4+ |
|---|---|---|---|---|---|
| `DATE_PROXIMITY_CURVE` | `1.00` | `0.85` | `0.70` | `0.55` | `0.30` |

A step table rather than a formula because the shape is not smooth and should not pretend
to be. Same day is the claim the receipt actually makes. The next three days fall off
steadily — that span covers a driver photographing a receipt the following morning and the
ordinary gap between authorisation and settlement. From day four the curve goes flat at
`0.30`: past that the date has stopped distinguishing one candidate from another, and a
curve that kept descending would imply a precision the evidence does not carry. The date is
the lowest-weighted signal (`0.15`) precisely because this is all it can honestly do.

**The window is not one number, because the two document types mean different things by
"date".** `maxDateDriftDaysFor()` picks it:

| Constant | Value | Applies to |
|---|---|---|
| `MAX_DATE_DRIFT_DAYS` | `7` | `RECEIPT`, and an `UNKNOWN`-type document that arrived by WhatsApp |
| `INVOICE_MAX_DATE_DRIFT_DAYS` | `45` | `TAX_INVOICE`, and an `UNKNOWN`-type document that arrived by email |

A photographed till receipt is printed *at* the till, so its date and the card
authorisation are the same event. A week of slack covers a driver clearing their camera
roll on Sunday plus the odd settlement delay; past that the date genuinely disagrees and
the candidate should go.

A supplier tax invoice is dated when it was *raised*, which is a different event from when
the card settled — and it reaches the fleet manager's inbox later still, after the
supplier's billing run and a forward. Thirty-day terms are ordinary, so 45 days is 30-day
terms plus the slack either side. Holding invoices to the receipt window vetoed invoices
that agreed on amount, card *and* merchant, which is as close to certain as this engine
gets: one signal in its tail was discarding three signals in agreement.

The fallback is keyed on what the document *is*, with the channel deciding only when the
type could not be read — an invoice forwarded as a WhatsApp photo is still an invoice, and
an unreadable email is more likely a forwarded invoice than a till slip.

Widening the window does not make a stale date look fresh, because the curve is already
flat at its tail: everything from day four onward scores `0.30` either way. The date simply
stops discriminating instead of vetoing. Two consequences worth naming:

- The curve has exactly 8 entries, spanning the 7-day receipt window. Beyond it the lookup
  is clamped (`Math.min(drift, length - 1)`, with a `?? 0` behind it), so the 45-day window
  needs no second curve. The config comment flags the window length and the curve length as
  two numbers that must agree; the clamp is what keeps a future widening safe rather than
  silently out of range.
- `candidateWindow` — the query bound in `selectCandidateTransactions` — calls the **same**
  `maxDateDriftDaysFor()`, plus a day of slack on each side because the query compares
  instants while `scoreDate` counts whole calendar days. The query must always be the wider
  of the two: a query narrower than the matcher drops candidates the matcher would have
  scored, and a candidate that never arrives cannot be overruled by a reviewer. The veto
  inside the matcher stays the authority on the rule. When the document carries no
  parseable date there is nothing to anchor on, so the query falls back to 30 days either
  side of delivery — and the date signal is absent in that case anyway, so widening it
  further would buy nothing.

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
| `MIN_CORROBORATING_SIGNALS` | `2` | See below. |
| `MAX_DATE_DRIFT_DAYS` | `7` | The receipt window. See above. |
| `INVOICE_MAX_DATE_DRIFT_DAYS` | `45` | The invoice window. See above. |
| `DATE_PROXIMITY_CURVE` | `[1, .85, .7, .55, .3, .3, .3, .3]` | See above. |

### Renormalisation needs a floor, or one signal becomes a certainty

`MIN_CORROBORATING_SIGNALS = 2` is the counterweight to the renormalisation rule above,
and the two have to be read together.

Excluding unavailable signals and reweighting the rest is right: a thermal receipt that
does not show a card number should not be punished for it. But taken alone that rule has a
sharp edge at its limit. A document where OCR read *only* a total renormalises that single
signal to the full weight and scores a flawless `1.00` — and `1.00` clears every threshold
in the table above. The engine would then attach a VAT document to the first charge in the
window carrying that amount, with no merchant, no date and no card corroborating it, mark
it `AUTO_CONFIRMED`, and never show it to anyone.

So an auto-match requires at least two signals to have been *scored*, not merely to have
scored well. The candidate is still surfaced and still ranked; it simply cannot settle
itself.

Two rather than three: requiring three would exclude the common and entirely legitimate
case of a receipt showing a total and a date and nothing else. Two is the smallest number
at which a coincidence has to be a coincidence twice over.

This interacts with the merchant rule below. Treating an uninformative acquirer string
("POS 04 RUH", which normalises to no tokens at all) as an *absent* signal rather than a
contradicting one is correct — otherwise reading a merchant name off the receipt lowers
confidence, which is absurd — but it moves such documents into the fewer-signals state
this floor governs. The floor has to exist first for that change to be safe.

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

### An unexplained amount gap gates the auto-match

If the top candidate's **amount signal scores below the VAT-rounding plateau** — that is,
anything the ±5-halala band does not already cover — the document goes to review as
`UNEXPLAINED_AMOUNT_GAP`. Every tip, every service charge and every undercharge is in
scope; there is no percentage band here, which is exactly why it reads as a gate rather
than as another tolerance.

**It is a gate on auto-matching, not a cap on the confidence.** The distinction is the
whole point. A cap would rewrite the number the reviewer sees, so the screen would show a
confidence that no longer corresponds to how well the evidence agrees, and the signal
breakdown underneath it would add up to something else. Instead the score stays honest —
`0.8435` is still reported as `0.8435` — and a separate rule says this one may not settle
itself. That is the same separation `MIN_EXTRACTION_CONFIDENCE_FOR_AUTO` keeps, and the
reason both of them are readable.

The evidence for needing it at all is the brief's own worked example. Receipt 57.50 against
a 63.25 charge scores `0.74` on amount, and whether that document auto-attached used to
depend on **how the acquirer abbreviated the merchant name**:

| Acquirer string | Merchant signal | Overall | Outcome before the gate |
|---|---|---|---|
| `NAJD VILLAGE REST RUH` | `0.7373` | `0.8435` | review — by `0.0065` under `AUTO_MATCH_THRESHOLD` |
| `NAJD VILLAGE RESTAURANT RUH` | `1.0` | `0.896` | **auto-attached** |

Both strings are equally realistic output from the same terminal. Three of the four
plausible renderings auto-attached, and the test that pinned the brief's expected outcome
was passing on a margin of `0.0065` — it was asserting a coincidence of string
abbreviation, not a property of the engine. For a VAT filing, a receipt that does not
substantiate the amount actually charged is precisely what a person is there to look at,
and that should not turn on spelling.

### OCR confidence gates but does not dilute

`extractionConfidence` is kept out of the match score entirely and used only as an
auto-match gate. Folding it in would make the breakdown shown to a reviewer dishonest —
they would see "amount 100%, merchant 90%" and a total that matches neither, with no
indication why. The signals describe document-versus-transaction evidence; OCR confidence
is a separate axis and is displayed separately. The `email-02-low-confidence` fixture has
every signal at 100% and still routes to review.

### The order the reasons are checked in

Several of the rules above can fire on the same document, and only one of them becomes the
`reason` the reviewer reads. The order is therefore part of the design, and it is ordered
by **what the reviewer has to decide** rather than by how the code happens to read:

1. `TRANSACTION_ALREADY_DOCUMENTED` — the charge already holds a receipt. *Which document
   does it keep?*
2. `AMBIGUOUS_TOP_CANDIDATES` — two charges fit equally well. *Which charge is it?*
3. `UNEXPLAINED_AMOUNT_GAP` — the totals do not agree. *Is the difference a tip?*
4. `WEAK_EVIDENCE` / `MID_CONFIDENCE` — everything is merely weak. *Is this the right
   charge at all?*
5. `INSUFFICIENT_CORROBORATION` — one signal, scoring perfectly. *What else agrees?*
6. `LOW_EXTRACTION_CONFIDENCE` — the signals agree, the read does not. *Is the scan
   legible?*
7. `AUTO_MATCHED` / `CONFIDENT_SINGLE_CANDIDATE`.

Each question is more specific than the one below it, and answering it dispatches the
document to a different action — and often to a different person. The generic confidence
check (4) used to run first, which meant it swallowed the two above it: a duplicate receipt
and an unexplained gap both surfaced as `MID_CONFIDENCE`, which is true but burying the one
fact that changes what the reviewer does. A headline that is accurate and useless is worse
than no headline, because it looks like it has been answered.

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

### Added: `reason` on `MatchResult`

The brief's `MatchResult` carries `outcome` and `candidates`. This one adds a third field,
`reason` — a closed union naming *why* the engine landed where it did
(`AMBIGUOUS_TOP_CANDIDATES`, `WEAK_EVIDENCE`, `TRANSACTION_ALREADY_DOCUMENTED`, and eight
others — eleven in all, listed in `MATCH_REASONS`).

It exists because `NEEDS_REVIEW` on its own tells a reviewer nothing. Two documents can
reach the review queue for opposite reasons — one because two transactions tie perfectly,
another because almost nothing could be read off the page — and the work required to clear
them is completely different. The outcome is the same; the question being asked of the human
is not. `reason` is what the review queue shows as the headline, and it is stored on the
document so the queue does not have to re-derive it.

The addition is additive: `outcome` and `candidates` keep the exact shape and semantics the
brief specifies, and `MatchCandidate` is unchanged (`signals` is `Record<string, number>` as
written).

### The `types/` directory is an index, not a home

The brief's project-structure diagram ends with a `types/` folder and does not say what goes
in it. Relocating declarations into it would move types away from the code they describe:
the extractor contract belongs at `lib/extraction/types.ts`, where the brief itself puts it,
and the domain unions belong next to the Zod schemas that validate against them.

So `types/index.ts` is a type-only re-export of the surfaces a consumer actually types
against — the extractor and media seams, the matcher's inputs and outputs, the domain
lifecycle unions. Each declaration stays in the module that owns it; this is the published
index over them. It emits no runtime code, so importing it cannot pull the database or the
extractor into a consumer's bundle.

### Grown: seed and fixture counts

The brief asks for "~15 transactions across 2 clients" and "at least 6 fixture documents".
This seeds **205 charges** — 22 scripted, 180 generated, and 3 created for specific demo
states — and ships 18 fixtures.

It also seeds **work for a person to do**, which it previously did not. Every seeded
document was `MATCHED`, so a fresh `db:reset` produced a product that looked finished and
empty: the review queue — the screen the whole system exists to feed — had nothing in it,
the audit trail had no events, and the charge register showed two of its four states.
Everything unsettled was reachable only by starting a server and firing
`npm run webhooks:demo`, which is a lot to ask of somebody who just wants to look at it.

**Those documents are not hand-written rows.** Each is built with plausible extracted
fields and then passed through `selectCandidateTransactions` → `matchDocument` →
`persistMatchResult`, the same three calls the webhook pipeline makes. The confidences,
the per-signal breakdowns and the reason codes on screen are whatever the engine actually
computed — so if a threshold moves, these rows move with it. The decisions are made
through the same primitives the server actions use, so the audit trail holds real events.

After `npm run db:reset`, with no server and no webhooks:

| Surface | What is there |
|---|---|
| Review queue | 9 documents across **all seven** work kinds |
| Charge register | all four documentation states, including `REJECTED` |
| Document register | `MATCHED`, `NEEDS_REVIEW` and `UNMATCHED` |
| Audit trail | a maker's confirmation, a maker's rejection, a checker's sign-off |
| Assurance queue | 91 attachments awaiting an independent check, one already signed off |

They are built on the *background* cards deliberately. The scripted scenarios on cards
4412/5520/6604 are left untouched, so `npm run webhooks:demo` still demonstrates the live
pipeline end to end — see `SCENARIO_CRITICAL_CARDS`.

The two groups exist for different reasons and it is worth being precise about which:

- **The 22 scripted charges are each reached by exactly one demo scenario.** The brief's six
  edge cases needed roughly its suggested volume; demonstrating the remaining scoring rules
  end-to-end (the VAT tolerance, the date curve, the three vetoes, the already-documented
  rule, weak evidence, an empty candidate set) needed a charge apiece. Transactions 17-22 and
  the last eight fixtures exist for that. See § 4a.
- **The 180 background charges are volume, and nothing is scripted against them.** They exist
  so the dashboard, ageing buckets and register filters have something realistic to show. An
  earlier revision of this document claimed every seeded row served a scenario; that was true
  of the 22 and never of the 180.

The generator draws only on cards **8899**, **1155** and **7731** — deliberately *not* the
cards the scripted scenarios run on. That separation is load-bearing rather than tidy: when
background volume was generated onto card 4412, it gave the orphan receipt (whose entire
purpose is to have no plausible charge) four candidates at 0.67, which turned a demonstrated
`UNMATCHED` into a review item — and because the re-match sweep only revisits `UNMATCHED`
documents, it also made the late-arrival rescue in § 6 silently stop working. The separation
is now a `SCENARIO_CRITICAL_CARDS` list that the seed **throws** on rather than a comment
asking the next person to remember. The demo table
in the README is regenerated from a real run for exactly this reason.

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
reject the incumbent, then confirm the correct document. It uses the same compare-and-set
shape as `confirmMatch` — an `updateMany` predicated on the status it read — and raises
`ConcurrentDecisionError` when it updates zero rows, so two reviewers deciding the same
match at once produce one decision and one refusal rather than two writes.

### `Document.status` has one writer

`Document.status` is a cached roll-up of the document's match rows, and it was being
written from six places — each one computing the new value from what it happened to know.
That drifts, and it did: **rejecting a `CANDIDATE` sibling flipped the document to
`UNMATCHED` while it still held an `AUTO_CONFIRMED` match and the charge still pointed at
it.** The document was reported as having no evidence behind it, from the same row the
charge was citing as its evidence. In a VAT-compliance product that is the worst shape a
bug can take: the two screens disagree and neither is obviously wrong.

The fix is the same discipline as the slot claim, applied to a derived value rather than a
contended one. `lib/domain/document-status.ts` derives the status purely from the set of
match statuses; `recomputeDocumentStatus()` in `lib/services/document-status.ts` is the
**only** writer once matching has run. It re-reads the match rows rather than trusting what
its caller believes, and runs inside the transaction that changed them. A caller confident
it already knows the answer is exactly the caller that can be wrong.

Ingestion keeps its own direct writes for the pre-match lifecycle (`RECEIVED` →
`EXTRACTED` → `FAILED`) because those are properties of extraction, not of matches, and the
function deliberately refuses to invent them. This mirrors `charge-status.ts`, which already
did the same job on the transaction side — the document side was simply missing its half.

### Idempotency of the review actions

Both actions short-circuit on an already-decided match and report `ALREADY_DECIDED`
rather than erroring or writing twice. The disabled button in the UI is a courtesy; the
protection is the server action and the constraint behind it, because a disabled button
protects nobody against a second browser tab.

---

## 4a. The demo scenarios

The unit tests prove the engine is right. They do not let anyone *see* it be right, and a
reviewer reading this in twenty minutes should not have to run Jest to believe a claim.
`npm run webhooks:demo` therefore fires all eighteen payloads through the real webhooks
against a real database — one of them twice, to show the duplicate path — and between them
they reach **nine of the eleven reason codes `matchDocument` can return**:

| Reason code | Demonstrated by |
|---|---|
| `CONFIDENT_SINGLE_CANDIDATE` | `whatsapp-01-exact-match` — every signal agrees |
| `AMBIGUOUS_TOP_CANDIDATES` | `whatsapp-02-ambiguous` — two transactions tie exactly |
| `UNEXPLAINED_AMOUNT_GAP` | `whatsapp-03-tip-mismatch` — the brief's 57.50 / 63.25 case |
| `NO_PLAUSIBLE_CANDIDATE` | `whatsapp-04-orphan`, and each of the three veto scenarios |
| `UNUSABLE_EXTRACTION` | `whatsapp-05-garbage` — OCR returned noise |
| `LOW_EXTRACTION_CONFIDENCE` | `email-02-low-confidence` — signals agree, the read does not |
| `TRANSACTION_ALREADY_DOCUMENTED` | `whatsapp-13-second-receipt` — a second claim on taken money |
| `WEAK_EVIDENCE` | `whatsapp-14-faded-receipt` — merchant and date only |
| `NO_CANDIDATE_TRANSACTIONS` | `whatsapp-15-new-driver` — nothing in scope yet |

The two that are not on this list — `MID_CONFIDENCE` and `INSUFFICIENT_CORROBORATION` —
are both still reachable and are pinned by unit tests rather than by a fixture. Both now
need a narrow shape to reach: `MID_CONFIDENCE` requires an amount that either agrees within
VAT rounding or could not be read at all, *and* an overall score under `0.85`;
`INSUFFICIENT_CORROBORATION` requires a single signal scoring well enough to clear `0.85`
on its own. Constructing those as object literals is a two-line test and a contrived
fixture, so they are tested where they are cheap rather than demonstrated where they would
be artificial.

The last eight scenarios were added on an **isolated driver** (card `5520`, plus one driver
with no transactions at all). That isolation is deliberate and load-bearing: the demo script
fires sequentially against live state, so a new seed transaction landing near an existing
fixture's merchant, card and date would quietly become a second candidate for it and turn a
documented `AUTO_MATCHED` into `NEEDS_REVIEW`. Scoping every new scenario to a card nothing
else touches makes that class of interference impossible rather than merely unlikely. The
demo output is captured before any change and diffed after, so an interference of that kind
shows up as a line that moved rather than as a demo that quietly stopped demonstrating its
scenario. The only line the amount-gap gate moved is `whatsapp-03-tip-mismatch`, which it
was added to move.

`__tests__/fixtures.test.ts` guards the three ways this catalogue fails *silently* rather
than loudly — two fixtures sharing bytes (the second is rejected as a duplicate and proves
nothing), a media id pointing at a slug that no longer exists, a fixture missing from the
hash map (extracts to `UNKNOWN`). In each case the script still prints a `200` while the
scenario quietly stops demonstrating what its annotation claims. This project has already
paid for the first of those once.

---

## 4b. The interface

The brief asks for a minimal `/review` page as a bonus, and scores the engine rather than
the screen. Two screens exist anyway, because a matching product that cannot explain
itself to the person overruling it is only half-built — and because the explainability the
brief *does* weight at 30% only pays off if a human can read it.

### The decision is a comparison, not a score

The engine's output is four numbers. A number is a summary of a comparison, and the review
queue originally showed the summary: four coloured bars, a percentage, and the document's
own fields in a separate line of prose above them. The reader performed the diff in their
head, on the one screen where a mistake attaches a receipt to the wrong charge.

Each candidate now shows the two sides on one baseline, field by field, with a sentence
where the values alone do not explain themselves — a tip is named as a tip, an undercharge
is explicitly *not* explained away, a card mismatch says the receipt belongs to another
charge. `lib/ui/comparison.ts` is pure and tested, and it deliberately does not re-score
anything: `signals` on the match row stays the authority on confidence, and these rows
explain why that number came out as it did. Two code paths computing a verdict is how a
diagnostic ends up quietly disagreeing with the engine.

The per-signal scores are not deleted. They move into a collapsed *How the engine scored
this* — a matching product that cannot show its working is asking for trust it has not
earned, and the numeric confidence stays on every candidate because the brief asks for
ranked candidates.

### The hardest case gets less interface, not more

When two charges tie on every signal, every bar reads 100% for both. The interface has
nothing left to say with scores, and saying it louder would be worse: the engine routed
the document to review *because* it could not choose, so a "best" badge on one of them is
the UI placing a bet with someone's money.

So on `AMBIGUOUS_TOP_CANDIDATES` the rank numerals disappear and a callout names only the
fields that differ *between the two charges* — for the seed's Tamimi pair, the branch and
the time of day — and points at the paper receipt. `distinguishingFields()` returns an
empty list when nothing separates them at all, and the UI says so and suggests rejecting
both. An interface that presents a coin flip as a choice is how a wrong attachment gets
made and then looks reviewed.

### One queue, grouped by the job — not two partial lists

The review queue and a separate "exceptions" register were two hand-maintained answers to
the same question, and they disagreed in both directions. A possible-duplicate document was
`NEEDS_REVIEW`, so it appeared in the queue *and* in the exception register. Five documents
that had simply found no charge appeared in **neither** — not `FAILED`, not from an unknown
sender, so no exception; not `NEEDS_REVIEW`, so not in the queue. They were invisible, and
the two screens between them created the impression of coverage.

Two definitions of "needs attention" will drift. One derived definition cannot, so the
queue is now built from a single taxonomy in `lib/platform/work-queue.ts` that maps
`(status, failureReason, clientId)` to one of seven kinds, grouped by **what the person has
to do** rather than by database status. A reviewer does not care that one document is
`NEEDS_REVIEW` and another `UNMATCHED`; they care that one needs a charge picked and the
other needs a sender registered. Those are different jobs, often different people.

Three of the seven are marked `decidable: false`. They have no candidate to confirm, so the
interface does not offer buttons that cannot work — it states the next step instead
("Ask the driver for a clearer photo", "Register the sender"). Hiding them was what the
exception page did, and it is how documents fell into the gap.

The property worth testing is not that the groups look tidy but that **nothing can fall
through**: `work-queue.test.ts` asserts that every value in `MATCH_REASONS` classifies, so
a reason code added to the matcher fails the suite rather than quietly vanishing from the
interface. `MATCH_REASONS` is exported as a value for exactly that reason, with a
compile-time check that it and the `MatchReason` union cannot drift apart.

The nav badge and the overview figure now come from the same taxonomy, so the number on the
tab and the number of rows behind it cannot disagree. The overview counts the two kinds
separately — "1 needs a decision · 2 need something else" — because one number would
flatter the first figure and misdescribe the second.

### The candidate comparison is not written for one example

That logic was right and its reach was not. It compared `charges[0]` and `charges[1]` and
rendered only when the reason code was `AMBIGUOUS_TOP_CANDIDATES`, which made it read as
copy written for one fixture — a third tied outlet of the same chain was dropped from the
one screen meant to show everything competing, and a two-candidate document under any other
reason got no comparison at all.

`chargeDifferencesAcross` now takes any number of charges, reports a field as differing if
*any* pair differs, and lists **every** distinct value — a reviewer choosing between three
outlets needs all three branch numbers. The heading is derived from the situation rather
than fixed: how many charges, and whether their scores genuinely tie. "Equally good matches"
is a claim about the scores, and saying it of a clear leader would overstate the difficulty
and invite a coin toss over a decision the engine had nearly made.

One judgement worth recording: "the branch" is used only when *every* pair reads as the same
chain. One unrelated merchant among three outlets makes the whole set a merchant difference,
because telling a reviewer to check the branch when the names genuinely differ sends them
looking for the wrong thing.

### Things that were on screen and should not have been

`a100 · c100 · m88 · d100` under every confidence figure was a debug print of a
`Record<string, number>`. The eight-column table of every document, sorted by database id,
was built for whoever was debugging the matcher. `Documents ingested` and `Transactions
seeded` go up whether or not anything is wrong. Six `DocumentStatus` values became four
words — `RECEIVED` and `EXTRACTED` are moments inside one request nobody observes in a
list, while `UNMATCHED` and `FAILED` stay distinct because they route to different people.
Document and transaction ids are not identifiers to a reader; merchant, amount, day and
card are.

Two fields were stored and shown nowhere. `rawText` is on every document, so a reviewer
was being asked to judge a receipt they could not see; it is now rendered with `dir="auto"`
because KSA receipts are routinely bilingual. `vatNumber` is the field that decides whether
a document is usable for a filing at all.

### What the front page answers

It opened with a count of documents. It now opens with the operator's question — how much
of the period's card spend has no receipt behind it — because that is what an auditor asks.
`vatWithin()` extracts VAT with **15/115**, not 15/100: transaction amounts are what the
card was charged, so the tax is already inside the number, and the naive form overstates
the position by SAR 56 on the seed data. The period is derived from `max(transactionAt)`
rather than the clock, so the page does not read 0% covered to anyone running this after
June 2025.

It stops there. There is no filing-date field in the schema, so there is no deadline and no
countdown — and the VAT line describes the document ("No VAT number on this document")
rather than asserting anything about what is recoverable, which is a question for the
operator's accountant.

### What it cost

No new runtime dependencies, no charts, no client-side state. Everything is a Server
Component except `MatchActions`, which was already the only client component. The focused
document lives in `?doc=`, so the queue survives a confirm without client state, a
half-finished review can be handed over as a link, and the back button behaves.

Every decision still goes through the existing `confirmMatch` / `rejectMatch` server
actions and the compare-and-set slot claim in § 4. No new write path, no new server action,
no API route for review — verified by exercising both actions over HTTP against the
rebuilt UI.

---

## 5. Testing

**495 tests across 32 suites.** Distribution follows the brief's instruction to put most
effort into the matcher — 146 of them exercise the matching engine alone
(`matcher-edge-cases`, `transaction-matcher`, `matcher-corroboration`, `merchant`).

Coverage is gated rather than merely measured — `npm run test:coverage` fails the build on
any of these, statements / branches / functions / lines:

| Scope | Gate | Measured |
|---|---|---|
| `lib/matching/**` | 95 / 95 / 95 / 95 | 98.85 / 96.42 / 100 / 100 |
| `lib/services/transaction-matcher.ts` | 97 / 92 / 95 / 99 | 97.57 / 92.30 / 100 / 99.20 |
| `lib/services/document-ingestion.ts` | 83 / 83 / 80 / 83 | 86.11 / 86.53 / 80 / 85.84 |
| Everything else under `lib` | 87 / 73 / 83 / 89 | 88.29 / 74.92 / 84.64 / 89.96 |

Each gate sits just under what the suite achieves, so the coverage is locked in rather than
left as headroom that erodes quietly. Two things the table would otherwise mislead on. The
global row is **not** the summary table's "All files" line (89.89 / 78.87 / 85.87 / 91.19):
Jest removes a path-specific group from the global one, so the global number is measured
over `lib` *minus* the three scopes above it — which are the well-covered ones — and is
lower by construction. And the global floor is deliberately modest rather than aspirational:
much of `lib/platform` and `lib/ui` is read-model and presentation code exercised through
the pages, and chasing a higher number there invites tests written to move the number.
Where the correctness lives, the gate is 95+.

| Suite | Tests | Covers |
|---|---|---|
| `matcher-edge-cases` | 72 | Every scoring threshold probed on both sides of its edge |
| `transaction-matcher` | 34 | All six of the brief's edge cases, vetoes, purity, determinism |
| `comparison` | 37 | The document-vs-charge diff, and what separates two tied charges |
| `work-queue` | 35 | The taxonomy is exhaustive; nothing waiting can fall out of the queue |
| `matcher-corroboration` | 24 | Minimum evidence, uninformative merchant names, card formats |
| `architecture` | 26 | Layering, matcher purity, request-state confinement, the single writer of `confirmedDocumentId` |
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
| `audit` | 7 | The append-only trail and what it survives |
| `charge-detail` | 7 | The evidence file: sign-off, signals, history that explains itself |
| `charge-status` | 7 | The materialised status tracks the derivation on every path |
| `age-range` | 6 | The SQL age range selects exactly what the bucket function would |
| `action-refusals` | 6 | A refusal is reported, not thrown |
| `pipeline-isolation` | 5 | One failing attachment or message costs only itself |
| `enums` | 5 | Decoding untrusted values at the persistence boundary |
| `fixtures` | 4 | The demo catalogue's own invariants |
| `dashboard-ageing` | 2 | A charge ages the same however it is filtered; a waiting document ages against now |
| `charge-register` | 2 | Status chips count every charge; status and age filters compose |
| `assurance-actions` | 3 | Overturning and upholding an attachment, driven to completion |

Three deliberate choices:

- **Every threshold is tested on both sides.** `matcher-edge-cases` exists because a test
  sitting comfortably inside a band only proves the band exists; a test sitting exactly on
  the edge proves the edge is in the right place and that the comparison is the right way
  round. An off-by-one between `<` and `<=` in the scoring code is not an abstract defect —
  it attaches a real receipt to the wrong transaction. So each constant in
  `lib/matching/scoring-config.ts` is pinned at its exact value, one step inside, and one
  step outside: the VAT plateau in both directions, a tip at exactly `MAX_TIP_RATIO` and one
  halala past it, a gap of exactly `AMBIGUITY_MARGIN` and one hundredth under it, an
  extraction confidence of exactly `MIN_EXTRACTION_CONFIDENCE_FOR_AUTO` and a hundredth
  below. Alongside those sit the degenerate inputs that OCR actually produces — unparseable
  dates, names that normalise away to nothing, 500-character merchant strings, emoji,
  whitespace-padded card digits — each asserted to degrade to a null or a zero rather than
  throw.
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
{"created":[1199],"rematch":{"scanned":3,"changed":1,
 "documents":[{"documentId":2705,"from":"UNMATCHED","to":"MATCHED"}]}}
```

That is real output from `npm run webhooks:demo`, not an illustration: the script posts the
late transaction with an `idempotency-key` header, so the orphaned receipt from earlier in
the same run is rescued where a reviewer can watch it happen.

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

What follows is the gap between a take-home and something a fleet would actually run.
Nothing here is required by the brief; it is what I would build next, in the order I would
build it, because that ordering is itself a judgement worth stating.

### 7.1 Authentication — there is no "who" in this system yet

Every decision this codebase records is attributed to whatever `resolveActor()` returns,
and with no host mounted that is one of two development identities
(`lib/platform/identity.ts`). The seam is real — a host supplies its own resolver and
nothing else changes — but the identity behind it is still a fiction, and that is
indefensible for a VAT-compliance product: `decidedBy` exists precisely so an auditor can
ask *who attached this receipt to this charge*.

I would add session-based auth before any other production work, because everything in 7.2
depends on there being a caller to reason about.

- **Shape:** Auth.js (NextAuth) with an email/OIDC provider, a `User` model, and a
  `Session` carrying `userId` and `clientId`. Fleet operators are an organisational
  customer, so SSO against their IdP matters more than a password form.
- **The one change that matters most:** `resolveActor` stops returning a development
  identity and returns `session.user.id`. `decidedBy` becomes a real foreign key to `User`, and the audit trail
  becomes worth the column it occupies.
- **Drivers do not log in.** They send a WhatsApp photo. Their identity is the phone number,
  already modelled as `SenderIdentity` — which is why that model is the right seam: it is
  an identity table for people who will never have a password.

### 7.2 Authorization — the scoping rule is enforced once, in the wrong half of the system

This is the more interesting half, and it is where I would expect a production incident if
it were skipped.

`selectCandidateTransactions` scopes documents to a client, and `scopeVeto` enforces it
again inside the matcher. Both protect the *matching* path. **Neither protects the read
path.** `/review`, `/` and the server actions query by document id with no notion of who is
asking — so in a multi-tenant deployment, any authenticated user could read, confirm or
reject another fleet's documents by guessing an integer. The data model already knows which
client owns every row; the application simply never asks.

The fix is not a permission check sprinkled at call sites — that is the pattern that leaks,
because the leak is always the one call site nobody remembered.

- **Carry the tenant in the query, not in an `if`.** Every read becomes
  `where: { clientId: session.clientId, ... }`. A missing scope then returns *nothing*
  rather than someone else's data — the failure mode is a blank screen, not a breach.
  Prisma client extensions can apply this automatically so a new query cannot forget.
- **Re-check on write.** `confirmMatch(matchId)` must load the match, assert its document's
  `clientId` matches the session, and refuse otherwise — the same compare-and-set
  transaction from § 4, with ownership as an additional predicate in the `WHERE`. Enforced
  at the data layer, for the same reason the one-document rule is.
- **Roles, because "can see the fleet" is not "can decide for the fleet":**

  | Role | Can |
  |---|---|
  | Driver | Submit documents (via WhatsApp; no portal access) |
  | Fleet manager | View own client's documents and transactions; confirm/reject |
  | Finance / auditor | Read everything for the client, including the decision history; confirm nothing |
  | Darb operator | Cross-tenant read for support, every access written to an audit log |

  The split that matters is auditor-versus-manager: the person checking the books must not
  be able to alter them.
- **Test it like a rule, not a feature.** One test per role per action asserting the
  *denied* case. Authorization bugs are invisible in happy-path tests by construction.

### 7.3 Real OCR behind the existing interface

The extractor already sits behind `DocumentExtractor`, and `lib/extraction/index.ts` has a
one-line swap point, so this is deliberately a small change — the architecture was chosen to
make it small.

```ts
export class VisionExtractor implements DocumentExtractor {
  async extract(file: Buffer, mimeType: string): Promise<ExtractedDocument> { ... }
}
```

What actually needs care is not the API call:

- **`extractionConfidence` must mean something.** The matcher already gates auto-attach on
  it (`MIN_EXTRACTION_CONFIDENCE_FOR_AUTO`), so a provider that returns a flat `0.99` for
  everything silently disables that safety rail. A model that does not self-report usefully
  needs a derived score — field-presence, checksum of the VAT number, whether the line items
  sum to the stated total.
- **The mock stays the default.** Reviewers and CI must run with no keys, which is also why
  the fixtures are hash-keyed and deterministic.
- **Validate the model's output, do not trust it.** A vision model will happily return
  `totalAmount: 12500` for a blurry 125.00 *or* 1250.00. The extraction should pass through
  a Zod schema at that boundary like any other untrusted input, and disagreement between the
  parsed total and the summed line items should lower confidence rather than be discarded.
- **Cost and latency make the queue in 7.4 mandatory, not optional.** A per-document vision
  call is ~1–3 seconds and real money; it cannot sit on a webhook's timeout budget, and
  repeated extraction of the same `contentHash` must be cached.
- **Arabic.** Saudi receipts are routinely bilingual, and merchant names on the Arabic half
  will not normalise with the Latin-oriented rules in `lib/matching/merchant.ts`. That is a
  genuine piece of work, not a configuration flag.

### 7.4 The rest, in priority order

**Move processing off the webhook thread.** Steps 4–7 run inline. Storage already happens
first, so the structure is right, but a real deployment should enqueue after persisting
and have a worker call `processDocument`. That function is already separate and takes a
document id for exactly this reason. OCR latency does not belong on a provider's timeout
budget.

**Store the file bytes.** Documents are extracted and discarded. Production needs blob
storage keyed by `contentHash` so a document can be re-extracted when the OCR model
improves, and so a reviewer can *see the receipt* — which today they cannot, and which is
the single biggest gap in the review UI.

**Postgres.** The String-column compromises in § 3 exist only because SQLite was mandated.
A datasource swap turns them into real enums and `Json` with no application-code edits, and
brings row-level locking that is stronger than the compare-and-set in § 4.

**Observability.** `lib/logger.ts` is a `console` wrapper, as the brief supplies it. The
numbers worth alerting on are already computable: auto-attach rate, review-queue age, and
the share of documents reaching `UNMATCHED`. A sustained drop in auto-attach rate is the
signal that an acquirer changed their merchant-name format — the kind of silent regression
that otherwise surfaces as a reviewer complaining months later.

**Retention and PII.** Receipts carry card digits and merchant history. Production needs a
retention policy tied to the VAT statutory period, deletion on client offboarding, and
`rawText` treated as sensitive — it is OCR output from a document that may contain more than
anyone intended.

**Rate limiting and replay defence.** HMAC verification proves a request came from the
provider; it does not prove it is fresh. A captured valid payload can be replayed
indefinitely. Production wants a timestamp-tolerance window and nonce tracking alongside the
existing signature check.


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
floor, that transaction is not already documented, **and** the line carries its own readable
amount that agrees with the charge at least as closely as VAT rounding. Without that last
condition, "the totals add up" would be the only evidence — and promoting on merchant and
date alone is precisely what `WEAK_EVIDENCE_CONFIDENCE_CAP` exists to prevent. The sum
tolerance should scale with line count (`VAT_ROUNDING_TOLERANCE_HALALAS × lines`), since
per-line rounding accumulates.

These are two different comparisons and the distinction has to survive into the
implementation. The sum tolerance compares *the invoice total against the sum of its
lines*; the amount-gap gate compares *one line against one charge*. So a statement line
carrying a tip is a review item **even when the invoice total reconciles perfectly** —
reconciliation evidences that the set of lines is complete, not that any one line
substantiates the amount charged. Letting a clean total promote a line whose own amount
disagrees would re-open exactly the hole the gate was added to close, one indirection
further away from where anyone would look for it.

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

### 7.5 Known gaps, written down rather than left implicit

The sections above are the things worth building next. This one is the honest ledger of
what is *missing or imperfect right now* — found by reviewing this codebase against itself
rather than by remembering what I skipped. Each entry says what is wrong, what it costs,
and why it is still open. Nothing here is a surprise waiting for a reviewer to find.

#### Infrastructure the exercise did not call for

| # | Gap | Cost today | Why it is open |
|---|---|---|---|
| 1 | **No `prisma/migrations/`.** The scripts use `prisma db push`. | No migration history, no rollback, no review of a schema change. `db push` against a real database can drop a column silently. | `db push` is the right tool for a disposable SQLite demo. The moment this has a shared environment it is wrong, and generating a baseline migration is the first thing to do. |
| 2 | **SQLite on a local file.** `prisma/dev.db`. | A serverless filesystem is ephemeral and often read-only, so this cannot deploy to Vercel-style hosting as configured. No Dockerfile, no CI config. | The brief mandated SQLite. Postgres is already named in § 7.4; this adds the deployment consequence, which that section does not state. |
| 3 | **No request body limit on webhooks.** `lib/webhooks/schemas.ts` caps neither `contentBase64` length nor the `attachments`/`messages` array. | One email with 200 attachments is accepted and processed sequentially — measured at 0.65s and growing linearly. An unauthenticated endpoint should not let a caller choose its own cost. | `/api/transactions` already caps its array at 500; the webhooks should borrow that. One `.max()` per array and a byte cap on the base64. |
| 4 | **Module-level mutable config singletons.** `extraction/index.ts`, `media-store.ts`, `identity.ts`, `messages.ts`, `module-config.ts`. | Correct for a host that configures once at boot. On serverless, each instance re-initialises, and any per-request `set*` call would leak across concurrent requests in the same instance. | The seams themselves are right. What is missing is a guard that refuses configuration after the first read, which would make the boot-only contract enforced rather than assumed. |

#### Things that work but are not finished

| # | Gap | Cost today | Why it is open |
|---|---|---|---|
| 5 | **No pagination anywhere.** Both registers cap at 200 and say so; `charge-register` computes a `nextCursor` nothing consumes. | Past 200 rows the only recourse is narrowing the filter. | The design is written up in `docs/specs/` and explicitly marked as not shipped. It is a day of work, and it needs a "Load more" control to be worth anything. |
| 6 | **`getAssuranceQueue` is unbounded** (`lib/platform/assurance-queue.ts`) — the only read model with no `take`. | A large backlog renders every row. | Not reachable at demo scale; it is the one place the 200-row discipline was not applied. |
| 7 | **`getAssuranceQueue` and parts of `getDashboard` scope one side of the join.** They filter `document: scope` and leave the `transaction` side unconstrained. | Safe *only* because the matcher never pairs across clients — a correctness property enforced elsewhere, not here. | Defence in depth is one extra `where` clause each. It is open because the invariant it leans on is real and tested; it should not stay open. |
| 8 | **The architecture tests check direct imports only, by regex.** `__tests__/architecture.test.ts` | A transitive import (`lib/domain` → a new pure-looking `lib/services` wrapper → `@/lib/prisma`) passes. So does a raw-SQL slot write, a `data` object built in a variable, and a `data: { nested: {}, confirmedDocumentId }` shape — the pattern stops at the first `}`. | They catch the mistakes people actually make, which is most of their value. Making them robust needs real module-graph analysis (`dependency-cruiser` or ts-morph) rather than a regex over source text. `docs/ARCHITECTURE.md` now states this limit instead of implying the rules are airtight. |
| 9 | **Roughly eight tests would survive the rule they name being deleted.** Identified by mutation testing; the worst — `work-queue.test.ts`'s `if (kind !== null)` guard — is fixed. The rest are in `audit.test.ts`, `review-actions.test.ts:129` and a few threshold assertions that are true by construction. | A green suite overstates its own coverage in those spots. | Each is a small rewrite. They are listed here rather than quietly fixed because knowing *which* tests are weak is more useful than a number. |
| 10 | **`lib/services/charge-status.ts` and `document-status.ts` sit at 0% branch coverage.** The modules are exercised — mutation testing kills changes to them — but their early-return branches are not. | The null-return path (row deleted underneath the write) is argued, not tested. | Two small tests. Worth doing precisely because these are the single-writer modules the correctness argument rests on. |

#### Product gaps a user would notice

| # | Gap | Cost today |
|---|---|---|
| 11 | **No way to act on a document that matched nothing.** `UNMATCHED` documents appear in the queue with a next step ("register the sender", "wait for the charge") but no control to do either. | The queue tells you what to do and makes you leave to do it. |
| 12 | **Unknown-sender documents are invisible to a scoped tenant** — by design, since `clientId: null` belongs to nobody — but that means the work kind whose next step is *"register the sender"* can only be seen by an unrestricted operator. | A real deployment needs an explicit triage surface for unscoped documents rather than this emergent behaviour. |
| 13 | **No bulk actions, no keyboard shortcuts in the queue.** | A reviewer clearing 200 documents does it one click at a time. The single-document focus is right for the ambiguous cases and wrong for the obvious ones. |
| 14 | **No audit export.** The trail is append-only and complete, but only readable in the UI. | A VAT filing needs it as a file. |

#### Where the demo data is doing too much work

| # | Gap | Cost today |
|---|---|---|
| 15 | **202 seeded transactions against the brief's "~15".** 22 scripted plus 180 generated. | The registers and ageing buckets need volume to be worth looking at, so the extra rows earn their place on the dashboard. They also mean the eleven graded scenarios are ~11% of the data, and finding scenario 7 by hand is harder than it should be. A `--minimal` seed flag would give a reviewer both. |

---

**One thing worth saying plainly about this list.** Most of it was found by reviewing the
remediation work in this repository *after* it was written, not while writing it — and a
meaningful share of the defects that review turned up were introduced by that same
remediation pass, in code that was green at the time. The tests did not catch them because
the invariant they violated had no test. That is the argument for the global `afterEach`
checks in `__tests__/setup.ts`, and it is the reason item 10 above is on this list rather
than silently closed: the modules that enforce correctness are the ones whose own branches
most need covering.

## 8. Assumptions

- WhatsApp numbers are E.164 without a leading `+`; emails are lowercased. Both are
  normalised at ingestion (`normaliseSenderIdentifier`).
- Every amount everywhere is integer minor units. Money is never a float in this codebase.
- A document from an unregistered sender is stored **and extracted**, then left
  `UNMATCHED` rather than `FAILED`, so registering the sender later and running the sweep
  resolves it without re-ingestion. Extraction deliberately happens *before* scoping: OCR
  needs bytes, not a client, and the bytes exist only for the lifetime of the webhook
  request. Skipping extraction for an unknown sender would have stranded the document
  permanently — the promise in the sentence above is only keepable because the extraction
  is already on the row by the time anyone registers the sender.
- The re-match sweep touches only `UNMATCHED` documents. `NEEDS_REVIEW` documents belong
  to a human and must not be reshuffled underneath them; `MATCHED` documents are settled.
- **A rejection is permanent, and it is about a pairing rather than a document.** This
  distinction is load-bearing. `UNMATCHED` is reached two ways — nothing ever matched, or a
  reviewer rejected everything that did — and the column cannot tell them apart. Re-scoring
  the second kind finds the same best candidate it found the first time and re-attaches it,
  overwriting `decidedBy` from the reviewer back to `system`: the record that a human said
  no is destroyed, in a product whose purpose is an auditable trail. So the sweep excludes
  transactions already rejected for that document, and `persistMatchResult` refuses to
  upsert over a `REJECTED` row whatever its caller asks for. Scoping it to the *pairing*
  keeps the document open to a genuinely new transaction — otherwise "reject" would quietly
  mean "discard forever". Both directions are pinned in `__tests__/rematch.test.ts`.
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
- Signature verification allows unsigned requests outside production
  (`ALLOW_UNSIGNED_WEBHOOKS`, default permissive) so the sample scripts run without
  signing. **In production the flag is ignored and unsigned requests are always refused** —
  a security default has to fail closed, or a deploy that merely forgets the variable
  accepts forged webhooks from anyone who knows the URL, silently. A signature that is
  *present but wrong* is rejected in every environment regardless; permissiveness never
  extends to accepting a forgery.
