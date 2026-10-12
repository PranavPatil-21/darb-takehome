# Architecture

`IMPLEMENTATION.md` covers the matching engine and the pipeline — the things the brief
grades. This document covers the layer built on top of them: how the capability is
structured, where its boundaries are, what will break first at scale, and which decisions
were reversed and why.

---

## 1. The shape

Four layers, each depending only on the one below it.

```
app/                     routes — Server Components, no business logic
components/              presentation — pure, no data access
lib/platform/            the capability: identity, controls, read models
lib/services/            the engine: matching, ingestion, re-match, slot claim
lib/domain/ lib/matching/  pure domain: unions, scoring, normalisation
prisma/                  persistence
```

The rule that keeps this honest: **`lib/services` and below know nothing about
`lib/platform`.** The matching engine does not know an actor exists; ingestion does not
know what a nav badge is. The dependency only ever points inward, so the engine stays
testable with no database, no request and no user — which is why 98 of the 285 tests run
in under a second with nothing mocked.

### Why `lib/platform` is a separate layer from `lib/services`

They answer different questions and change for different reasons. `lib/services` answers
"does this receipt belong to this charge" and changes when the matching rules change.
`lib/platform` answers "who is asking, may they, and what should they see" and changes when
the operating model changes. Collapsing them would mean a change to a nav badge touching
the file that owns the correctness guarantee.

---

## 2. The host boundary

The capability is built to mount inside another application. That is enforced by there
being exactly **two seams** and no others:

| Seam | What the host supplies |
|---|---|
| `setActorResolver(() => Promise<Actor>)` | identity, capabilities, tenant scope |
| `configureModule({ basePath, makerChecker, … })` | mount path, control posture, thresholds |

Everything else is internal. In particular **nothing below `app/` reads a session, a
cookie or a header** — `resolveActor` is the only place that touches `next/headers`, and it
does so behind a dynamic import so the same module works from the ingestion pipeline and
from tests, where there is no request at all.

`modulePath()` builds every internal link, so a host mounting at `/finance/receipts`
gets correct navigation with no code change. `/review` is the one hardcoded path, because
`requirements.md` names it and a contract does not move because the implementation grew a
home. It is a three-line re-export of the module's queue, sharing the same chrome.

**Known limit.** The resolver is module-level state. That is correct for a single mounted
instance and wrong for a process serving several tenants' hosts simultaneously; that case
needs the actor threaded through a request-scoped context.

---

## 3. Data model decisions

### Derived rather than stored status

`Transaction` has no documentation-status column. The truth is already in
`confirmedDocumentId`, which the compare-and-set writes under a unique constraint. A
status column would be a second copy of that fact, maintained by application code, free
to drift — and when the two disagree the UI reports a coverage figure that is wrong.

The cost is real and stated: filtering by status needs the matches loaded, so the charge
register narrows in SQL by everything the database can express and applies status and age
in memory. **This is the first thing that breaks at scale.** The fix is not a hand-written
column but a projection maintained by the same transaction that writes the slot;
`ChargeRegisterResult` is deliberately shaped as what such a projection would return, so
the swap is a change of source rather than of contract.

### Additive-only schema changes

`ReviewEvent` is a new model; the four maker-checker columns on `DocumentMatch` are
nullable with inert defaults. No existing column changed meaning. A deployment with the
control switched off behaves exactly as it did before those columns existed, which is the
only honest way to add a control to something that already works.

### The audit trail is not a foreign key

`ReviewEvent.transactionId` is a plain integer. A charge may be purged under a retention
policy long after the trail must still read sensibly, and an event that vanishes with its
transaction defeats the point of keeping one. Pinned by a test that deletes the charge and
asserts the event survives.

### Decoding at the persistence boundary

SQLite has no enum type, so `status`, `source` and `signals` are `String` columns typed as
`string`. `decodeDocumentStatus` / `decodeMatchStatus` / `decodeDocumentSource` parse them
through the same Zod unions the domain defines. The **direction of each fallback is the
safety argument**: an unknown document status reads as `UNMATCHED`, never `MATCHED`, so a
corrupt row cannot inflate the coverage figure; an unknown match status reads as
`CANDIDATE`, so it surfaces for a human rather than silently holding a charge's slot. They
log and continue rather than throw, because one bad row must not blank a register.

---

## 4. The correctness guarantee

One confirmed document per transaction, enforced by a unique constraint on
`Transaction.confirmedDocumentId` and claimed by a compare-and-set in `slot-claim.ts`.

Every path that attaches or detaches goes through those two functions — auto-match,
human confirm, human reject, and a checker's overturn. There is no second write path to
that column, and that is the single invariant the whole product rests on. When maker-checker
was added, `overturnAttachment` was written to call `releaseConfirmedDocumentSlot` rather
than to write `confirmedDocumentId = null`, for exactly this reason.

---

## 5. Decisions that were reversed

Recording these because the reasoning matters more than the outcome.

**Segregation by role → segregation by item.** The two identities first held disjoint
capabilities: one could attach, the other sign off. That is stricter than the control
requires — the person accountable for the filing could not do the product's main job — and
weaker than it looks, because it invites the belief that the capability check *is* the
control. The only thing preventing self-approval is `canVerify` comparing two identities
on one attachment. Both identities now hold both powers; the rule is per item.

**Blocking maker-checker → post-hoc, risk-based.** A gate in front of every attachment
puts a human round-trip in front of money already spent and doubles the length of the only
screen that produces value. A control that halves throughput gets switched off, after which
the *material* attachments are unverified too. Materiality carries the expensive path, a
sample rate covers the rest, and automatic matches — the ones no human has ever seen, and
most of the volume — are always selected.

**Explicit bootstrap → lazy configuration.** The capability is entered from a page render,
a webhook route and a server action. A bootstrap each had to remember to call is one that
ingestion did not, so ingestion decided verification against the default while the screens
read the configured value, and the queue was silently empty. Configuration now resolves on
first read.

**A minimal two-route UI → a full capability.** The first design round optimised for
take-home restraint and produced something coherent but thin. That was the wrong target.

---

## 6. What breaks first

Honest list, in the order it would bite.

1. **Status filtering in memory** (§3). Fine at hundreds of charges; wrong at millions.
   Fix: a projection table, same contract.
2. **`getDashboard` loads every charge** to reduce them in one pass. Same fix.
3. **Candidate selection is unbounded** within its date window. A fleet with thousands of
   charges in one week would score all of them. Fix: a cap plus a stricter pre-filter.
4. **The actor resolver is module-level state** (§2). Fix: request-scoped context.
5. **OCR runs inline on the webhook thread.** Already flagged in `IMPLEMENTATION.md` §7 —
   storage happens first, so the structure is right; production enqueues after persisting.

None of these are latent bugs. They are the points where a correct design for this size
becomes the wrong design for a larger one, and each has a known fix that does not change a
contract.

---

## 7. Testing strategy

285 tests, 16 suites, and the split is deliberate.

- **Pure and fast** — the matcher, scoring boundaries, merchant similarity, comparison,
  coverage arithmetic, status derivation, verification policy, boundary decoders. No
  database, no fixtures, no mocks; they run in about a second, which is the actual reason
  they get run on every change.
- **Against a real database** — ingestion idempotency, slot contention, re-match, review
  actions, the audit trail. These properties are enforced by unique constraints, and a
  mocked client would only prove the code *intends* to be safe.

Where a test pins a decision rather than a behaviour, the comment says which decision and
why, so a future change that breaks it can tell whether it is fixing a bug or discarding
an argument.
