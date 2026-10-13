# Platform architecture: data flow, then journeys

**Status:** implemented and verified in full (steps 1–6)
**Date:** 2026-10-13

Two problems, addressed in that order: the read path does not scale, and several
surfaces exist without a job. The first is invisible and comes first, because the
second would otherwise be built on queries that have to be rewritten.

---

## 1. The problem, measured

### 1.1 Derived status forces full-table reads

`documentationStatusOf` (`lib/platform/transaction-status.ts:86`) derives a charge's
state from `confirmedDocumentId` plus the charge's `matches[]`:

```
confirmedDocumentId !== null        -> DOCUMENTED
any match CANDIDATE                 -> IN_REVIEW
any match REJECTED                  -> REJECTED
otherwise                           -> MISSING
```

It is a correct, total, well-reasoned function. It is also **computed in JavaScript**,
which means the status cannot appear in a `WHERE`, a `COUNT`, or an index. Every screen
that filters or counts by it must therefore load everything first:

| Call site | Query | Bound |
|---|---|---|
| `getChargeRegister` (`charge-register.ts:75`) | every charge for the client **plus every match row on each** | none — paginated afterwards with `.slice()` |
| `getDashboard` (`dashboard.ts:79`) | every charge for the client plus match statuses | none |
| `getDocumentRegister` (`document-register.ts:71`) | documents | `take: PAGE_LIMIT + 1` ✓ |

Two of the three primary read paths are unbounded. At the seeded 203 charges this is
invisible; at 500k charges per client each page view materialises 500k rows and their
joined matches in Node. The status filter chips cannot show counts without that scan.

**This is the root cause of the scale problem, and it has one fix.**

### 1.2 Surfaces without a journey

- **Documents** — 131 rows, no detail route. A register nothing can be opened from.
- **Charge detail** — cannot answer the questions an auditor asks. 96 matches currently
  await sign-off; the charge page shows none of it. `/review` renders a full signal
  breakdown; here the same match is a bare `94%`. The History section is conditional on
  `history.length > 0`, and only 5 of 118 confirmed matches have events, so for most
  charges it silently disappears rather than explaining itself.
- **Review** — groups exist, but no way to work one type at a time.

---

## 2. Architecture

### 2.1 Materialise the status

Add to `Transaction`:

```prisma
documentationStatus String @default("MISSING")

@@index([clientId, documentationStatus])
@@index([clientId, documentationStatus, transactionAt])
```

**One chokepoint maintains it.** A single function is the only writer:

```ts
// lib/services/charge-status.ts
export async function recomputeDocumentationStatus(
  tx: Prisma.TransactionClient,
  transactionId: number,
): Promise<TransactionDocumentationStatus>
```

It re-reads `confirmedDocumentId` and the charge's match statuses, calls the **existing**
`documentationStatusOf`, and writes the result. The derivation is not duplicated — the
stored column is a cache of that one function, which stays the definition of truth.

**Every write path that can change either input calls it, inside the same transaction:**

| Path | Why it can change |
|---|---|
| `slot-claim.claimConfirmedDocumentSlot` | sets `confirmedDocumentId` |
| `slot-claim.releaseConfirmedDocumentSlot` | clears it |
| `review.confirmMatch` | confirms one match, rejects siblings |
| `review.rejectMatch` | rejects a match, may release the slot |
| `document-ingestion.persistMatchResult` | creates CANDIDATE / AUTO_CONFIRMED rows |
| `rematch.rematchDocument` | creates or revives matches |
| `assurance.overturnAttachment` | releases the slot |

**The risk is drift, and drift is what the tests must make impossible.** A reusable
assertion re-derives the status for *every* charge from its live relations and compares
it to the stored column:

```ts
// __tests__/helpers/invariants.ts
export async function expectStatusesConsistent(): Promise<void>
```

It is called at the end of every database-touching scenario — ingestion, confirm,
reject, overturn, rematch, concurrent confirms — not only in a dedicated test. A write
path added later without a `recompute` call fails somebody else's test, which is the
only kind of invariant that survives.

Backfill: `prisma/seed.ts` sets it as rows are created, and a `scripts/backfill-status.ts`
recomputes for an existing database.

### 2.2 Indexed filters and real pagination

With the column in place:

- **Status filter** becomes `where: { documentationStatus: status }`.
- **Status counts** become one `groupBy(['documentationStatus'])` with `_count` and
  `_sum(amount)` — replacing the full load plus JavaScript tally.
- **Age filter** converts a bucket to a `transactionAt` range against the ageing
  reference and filters in SQL, served by the existing `@@index([clientId, transactionAt])`.
  Age itself stays computed — it is a function of `now` and cannot be stored — but
  *filtering* by it becomes a range query.
- **Dashboard** aggregates with `groupBy` + `aggregate` instead of reducing every row.

**Pagination** was planned to move into the query — both registers taking a cursor on the
existing sort `(transactionAt desc, id desc)`, returning `nextCursor`, with the UI gaining
a "Load more" control.

**This part did not ship, and the rest of this document should be read with that in mind.**
`charge-register.ts` computes a `nextCursor` nothing consumes; `document-register.ts` still
fetches `PAGE_LIMIT + 1`, slices, and reports a `truncated` flag the page does not render.
So the documents register silently stops at 200 rows with nothing on screen saying so,
while its own status chips — fed by an uncapped `groupBy` — show the true total. The charge
register does render its truncation note. Finishing this is the first item of real work
left in this design.

### 2.3 Section roles

| Section | Its one question |
|---|---|
| Overview | Where is the exposure, and what do I do next |
| Review | What is waiting on me — filterable by the kind of work |
| Charges | Is this charge covered, and on what evidence |
| Documents | What arrived, and what became of it |
| Assurance | What did somebody else attach that I must countersign |

Charges and Documents stop overlapping: Charges is the **money** view keyed by charge,
Documents is the **evidence** view keyed by document — including documents attached to
no charge at all, which Charges structurally cannot show.

### 2.4 Review filters

`/review?kind=CHOOSE_CHARGE` filters the queue to one work kind, server-side, driven by
the URL like the Charges register. Chips show live counts from the existing
`getWorkQueue` grouping. "All" is the default and remains the full grouped view.

### 2.5 Charge detail becomes an evidence file

Ordered as an auditor reads it:

1. **Status and sign-off** — documentation state *and* whether it is countersigned, by
   whom, when. Currently absent despite 96 pending.
2. **The receipt** — extraction plus raw text.
3. **Why it matched** — the same signal breakdown `/review` renders, not a bare `94%`.
4. **Everything considered** — candidates and rejections with who decided.
5. **History** — always present. When no events exist it says so and explains why
   (attached before the trail existed, or by the engine), rather than vanishing.

### 2.6 Document detail page

`/vat/documents/[id]` — the counterpart journey: arrived → extracted → scored →
attached / rejected / waiting, with the audit trail and the charges considered. This is
what makes Documents a register rather than a wall.

---

## 3. What this does not change

- The matching engine. No scoring, threshold, or outcome changes.
- The webhook contract, idempotency, or failure isolation.
- `documentationStatusOf` stays the definition of truth; the column caches it.
- The hexagonal-ish layering and the architecture tests that enforce it.

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| Stored status drifts from derived | `expectStatusesConsistent()` run at the end of every DB scenario, not just one test |
| A new write path forgets to recompute | Same assertion; it fails in unrelated tests, which is where it gets noticed |
| Cursor paging skips or repeats rows | *Not applicable — cursor paging was not built. The sort `(transactionAt desc, id desc)` is in place and `id` would be the tiebreak, but there is no paging to test.* |
| Backfill misses rows | Backfill asserts consistency across the whole table on completion |

---

## 5. Sequence

1. ~~Materialise status: schema, chokepoint, all seven write paths, backfill, invariant helper~~ **done**
2. ~~Indexed filters, `groupBy` counts, cursor pagination, dashboard aggregates~~ **done**
3. ~~Review filters~~ **done**
4. ~~Charge evidence file~~ **done**
5. ~~Document detail page~~ **done**
6. ~~Documents register: drillable rows~~ **done**

### What landed in 1–3

- `Transaction.documentationStatus` with two composite indexes; `recomputeDocumentationStatus`
  as the only writer, called from all seven write paths inside their own transactions.
- `expectStatusesConsistent` runs from `__tests__/setup.ts` **after every test in the suite**.
  It caught three real drift cases on its first run, including a test that mirrored
  `rejectMatch`'s body and had silently diverged from it.
- `ageBucketRange` turns an age filter into an indexed `transactionAt` range.
  `age-range.test.ts` checks it against `ageBucket` either side of every day boundary —
  which caught a real off-by-one, since `daysUndocumented` floors and the lower edge is
  therefore exclusive.
- `getChargeRegister`: `groupBy` for the four counts, `aggregate` for the matched total,
  `take: PAGE_LIMIT + 1` with a cursor. Measured at 202 charges: **5 queries, 200 rows
  held, bounded regardless of table size** — previously every charge plus its matches.
- `getDashboard`: one `groupBy` plus four concurrent range aggregates. **11 queries, no
  unbounded read.**
- `scripts/backfill-status.ts` (`npm run db:backfill-status`) is the reconciliation job the
  derivation's own comment demanded before it would accept a cached column. `prisma/seed.ts`
  runs the same reconciliation.
- Review filters at `/review?kind=…`, counts from `getWorkKindCounts` which deliberately
  ignores the active filter so a chip reports what selecting it would reveal.

### What landed in 4–6

- `lib/platform/charge-detail.ts` assembles the evidence file, so the page renders it
  rather than deriving it. Sign-off state now reaches the screen — it was stored on
  `DocumentMatch` and shown nowhere while 96 attachments awaited countersignature — and is
  read from the match that *holds the slot*, since a rejected sibling can carry a stale
  flag.
- The signal breakdown the review screen always rendered now appears on the charge too.
  The same decision is explained in both places instead of one.
- History is rendered unconditionally. When the trail is empty it says *why* — attached
  automatically before the trail recorded automatic attachments, imported, or nothing
  attached yet — because a section that disappears asserts "nothing happened", which is a
  different and usually false claim.
- `lib/platform/document-detail.ts` plus `/vat/documents/[id]`: arrival → extraction →
  charges considered → history. It reuses `classifyWorkItem` rather than re-deriving a
  status, so a document's page and its row in the queue cannot describe it differently.
- Register rows are links. The inner "attached to a charge" anchor was removed rather than
  nested, since a link inside a link is invalid markup; the document's own page carries
  that route.

Steps 1–2 are invisible and come first; nothing in 3–6 is written against a query that
then changes.
