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

The rule that keeps this honest, stated precisely enough to be checkable:

- **`lib/domain` and `lib/matching` depend on nothing but themselves** — no `lib/platform`,
  no Prisma, no `next/*`. The matching engine does not know an actor exists.
- **`lib/services` declares the platform capabilities it uses.** Two files do, and the
  test names both:
  - `document-ingestion.ts` imports `lib/platform/audit` and `lib/platform/verification`,
    because it writes an audit event when it attaches a document itself and decides
    whether that attachment needs sign-off.
  - `charge-status.ts` imports `lib/platform/transaction-status`, because it maintains the
    cached documentation status and must call the function that *defines* that status
    rather than restate it.

  Nothing else in the layer may, and an import not on that list fails the test — the rule
  is "no *undeclared* dependency", not "no dependency".

The second exception exposes a real asymmetry worth naming rather than hiding: the charge
side's derivation (`documentationStatusOf`) lives in `lib/platform`, while its document-side
twin (`documentStatusOf`) lives in `lib/domain`. That is why `charge-status.ts` needs an
exception and `document-status.ts` does not. The honest reading is that
`documentationStatusOf` carries presentation concerns (labels, tones, ageing bands) that
kept it in the platform layer; the pure half of it could move down, and that is the fix if
the exception ever stops being worth it.

Earlier versions of this document claimed the stronger rule — that `lib/services` knew
nothing about `lib/platform` at all — and that was simply false. The rule is now the
weaker, true one, and `__tests__/architecture.test.ts` enforces it, along with the purity
of the matcher and the confinement of `next/headers`. A rule that lives only in a document
is a wish.

The test itself had two holes that are now closed, both of the same kind: it matched only
single-quoted module specifiers, so a forbidden import written with double quotes passed
unseen; and it scanned `lib` and `components` but not `app`, which is how route and page
files importing the database directly stayed invisible to a suite whose stated job is to
notice exactly that. A linter that can be evaded by pressing a different key is not a
linter.

The payoff is unchanged: the engine is testable with no database, no request and no user.
The six matcher and comparison suites — 186 tests — run in about 0.4 seconds with nothing
mocked.

### Why `lib/platform` is a separate layer from `lib/services`

They answer different questions and change for different reasons. `lib/services` answers
"does this receipt belong to this charge" and changes when the matching rules change.
`lib/platform` answers "who is asking, may they, and what should they see" and changes when
the operating model changes. Collapsing them would mean a change to a nav badge touching
the file that owns the correctness guarantee.

---

## 2. The host boundary

The capability is built to mount inside another application. There are **five** exported
setters — an earlier version of this section said two, which was wrong by three and
contradicted §6 of this same document, where `configureMessages` is advertised as the way
a host adapts vocabulary. Counted and grouped by who is expected to call them:

| Seam | Kind | What it supplies |
|---|---|---|
| `setActorResolver(() => Promise<Actor>)` | host | identity, capabilities, tenant scope |
| `configureModule({ basePath, makerChecker, … })` | host | mount path, control posture, thresholds |
| `configureMessages({ 'nav.charges': '…' })` | host | copy overrides, per key (§6) |
| `setExtractor(DocumentExtractor)` | implementation | swap the stub OCR for a real provider |
| `setMediaStore(MediaStore)` | implementation | swap fixture media for the WhatsApp media API |

The types a caller needs to implement any of them are re-exported from `types/index.ts`,
which is the published surface: a consumer writes `import type { MatchResult } from '@/types'`
and is not coupled to the internal layout. It is type-only, so importing it pulls no
runtime code.

**No test enforces that this list is complete.** It was produced by grepping for exported
setters, which is exactly what a test should do, and does not.

Everything else is internal. In particular **nothing below `app/` reads a session, a
cookie or a header except `lib/platform/identity.ts`**, which both reads the development
identity (`resolveActor`) and writes it (`setDevelopmentActorCookie`). Both go through a
dynamic import, so the same module works from the ingestion pipeline and from tests, where
there is no request at all.

The write half used to live in `lib/actions/dev-actor.ts` and imported `next/headers`
directly, which made this paragraph untrue. It is now enforced by a test rather than
asserted here.

`modulePath()` builds every internal link, so a host mounting at `/finance/receipts`
gets correct navigation with no code change — which was a claim before it was true.
`NAV_ITEMS` used to hold finished hrefs and `visibleNavItems` "rebuilt" them with
`{ ...item, href: item.href }`, copying a string computed at module-import time. Because
`moduleConfig()` memoises on first read, importing the file before the host called
`configureModule` froze the base path permanently, under a comment asserting the opposite.
The table now stores a path *segment* and `modulePath()` is called per invocation against
live configuration; a test in `verification.test.ts` pins it.

`/review` is the one hardcoded path, because
`docs/requirements.md` names it and a contract does not move because the implementation grew a
home. `app/review/page.tsx` holds the implementation; `app/vat/review/page.tsx` is an
eleven-line re-export of it, so the module's own navigation and the path the brief names
reach one screen with no second copy to drift.

**Known limit.** The resolver is module-level state. That is correct for a single mounted
instance and wrong for a process serving several tenants' hosts simultaneously; that case
needs the actor threaded through a request-scoped context.

---

## 3. Data model decisions

### Derived first, then materialised under stated conditions

`Transaction.documentationStatus` is a `String` column defaulting to `MISSING`, with
`@@index([clientId, documentationStatus])` and `@@index([clientId, documentationStatus, transactionAt])`
behind it. Earlier drafts of this section argued at length that the column should not
exist. The argument was right about the danger and right about the remedy, and it named
the condition under which materialising would be acceptable — "a maintained column with a
reconciliation job, not a column written by hand from four call sites, which is how the
drift starts." That condition is now met, so the column shipped. The refactor is written
up in `specs/2026-10-13-platform-architecture-design.md`, including the measurements
that forced it.

What forced it: a status computed in JavaScript cannot appear in a `WHERE`, a `COUNT` or an
index, so every screen that filtered or tallied by it had to load every charge *and every
match row on each* into Node first. Two of the three primary read paths were unbounded.
Now `getChargeRegister` filters on `documentationStatus` in SQL, pages by cursor, and gets
its four filter-chip counts from one `groupBy`; `getDashboard` does the same for counts and
value, with one indexed aggregate per ageing band.

Four things make the cache safe, and they are the reason it is a cache rather than a second
source of truth:

1. **`documentationStatusOf` remains the definition.** The column stores its output.
2. **One writer.** `recomputeDocumentationStatus` (`lib/services/charge-status.ts`) is the
   only code that writes the column, and it *calls* the derivation rather than restating
   it. There is no second copy of the rule to disagree with.
3. **It re-reads rather than trusting the caller.** A caller that already believes it knows
   the new state is a caller that can be wrong; the recompute looks at the live relations
   inside the same database transaction as the change.
4. **A global invariant.** `expectStatusesConsistent` re-derives *every* charge in the
   database and runs in `afterEach` for the whole suite, not in one dedicated test. A write
   path added later without a recompute fails somebody else's test, which is where an
   invariant actually gets noticed.

The reconciliation job the original argument asked for is `scripts/backfill-status.ts`.

### The same discipline on the document side

`Document.status` is now written by one function too — `recomputeDocumentStatus`
(`lib/services/document-status.ts`), deriving through the pure `documentStatusOf`
(`lib/domain/document-status.ts`). This closed a real bug rather than tidying a pattern.

A document can hold a confirmed match on one charge *and* a live candidate on another: an
auto-match persists the whole ranked list, winner `AUTO_CONFIRMED` and runners-up
`CANDIDATE`. `Document.status` was written from six call sites, and the one in the reject
path counted only `CANDIDATE` rows — so rejecting a runner-up flipped the document to
`UNMATCHED` while a charge still carried it as confirmed evidence. The register then
reported a receipt as unfiled that was, in fact, filed.

`documentStatusOf` is total over its inputs and takes the current status as well as the
matches, because two states are genuinely not derivable from matches: a failed extraction
is terminally `FAILED` however its matches look, and a document that has not reached
matching yet is `RECEIVED`/`EXTRACTED` rather than unmatched. Ingestion keeps its own direct
writes for that pre-match lifecycle; the function deliberately refuses to invent them.

**This side is enforced less than the charge side**, and the asymmetry should not be read as
symmetry. There is no global `afterEach` re-derivation for `Document.status`. The specific
bug above is pinned by a regression test in `__tests__/review-actions.test.ts` ("keeps the
document MATCHED when a confirmed match survives the rejection"), and the status is asserted
through the action suites — but a seventh write path added later would not fail an unrelated
test the way the charge side would.

### Additive-only schema changes

`ReviewEvent` is a new model; the **six** maker-checker columns on `DocumentMatch` are
`verificationRequired`, `verifiedBy`, `verifiedAt`, `verificationOutcome`,
`verificationTrigger` and `verificationReason`. Five are nullable; `verificationRequired` is
`Boolean @default(false)`, which is not nullable. The substantive claim survives the
correction — the inert value is reached either way, so a deployment with the control
switched off behaves exactly as it did before those columns existed, which is the only
honest way to add a control to something that already works.

### The audit trail is not a foreign key

`ReviewEvent.transactionId` is a plain integer. A charge may be purged under a retention
policy long after the trail must still read sensibly, and an event that vanishes with its
transaction defeats the point of keeping one. The tested case is the neighbouring one:
`__tests__/audit-integrity.test.ts` deletes the *document* and asserts its events survive.
The charge-deletion case is argued from the schema — nothing can cascade into
`ReviewEvent` — rather than exercised.

### Decoding at the persistence boundary

SQLite has no enum type, so `status`, `source`, `documentationStatus` and `signals` are
`String` columns typed as `string`. **Four** enum decoders parse them through the same Zod
unions the domain defines — `decodeDocumentStatus`, `decodeDocumentationStatus`,
`decodeMatchStatus`, `decodeDocumentSource` (`decodeSignals` sits alongside them but is a
JSON codec, not a union decode). The **direction of each fallback is the safety argument**:

| Decoder | Falls back to | Because |
|---|---|---|
| `decodeDocumentStatus` | `UNMATCHED` | an unknown status must never count as covered |
| `decodeDocumentationStatus` | `MISSING` | same figure, same direction — a VAT return is filed against it |
| `decodeMatchStatus` | `CANDIDATE` | "not decided", so a bad row surfaces for a human rather than silently holding or releasing a charge's slot |
| `decodeDocumentSource` | `EMAIL` | changes no scoping decision |

They log and continue rather than throw, because one bad row must not blank a register.
`__tests__/enums.test.ts` asserts three of the four — `decodeDocumentationStatus` is not
covered there, and is pinned indirectly by `__tests__/charge-register.test.ts`, which
feeds the register an unrecognised stored value and asserts it still counts as unsettled.

---

## 4. The correctness guarantee

One confirmed document per transaction, enforced by a unique constraint on
`Transaction.confirmedDocumentId` and claimed by a compare-and-set in `slot-claim.ts`.

Every path that attaches or detaches goes through those two functions — auto-match,
human confirm, human reject, and a checker's overturn. When maker-checker was added,
`overturnAttachment` was written to call `releaseConfirmedDocumentSlot` rather than to
write `confirmedDocumentId = null`, for exactly this reason.

Be precise about what the database buys and what it does not. The column being scalar is
what gives "at most one confirmed document per transaction"; `@unique` is what stops one
document holding two charges' slots. **Neither stops a future caller writing
`update({ data: { confirmedDocumentId } })` and stomping a live claim** — that is what the
compare-and-set exists to prevent, and nothing mechanical prevents it being bypassed.

This was, until recently, **the single invariant the whole product rests on with no test
enforcing it** — `lib/actions/assurance.ts` carried a comment saying a direct write would
be a second path, which is a wish by this document's own standard.

It is now a rule: `__tests__/architecture.test.ts` → *"no module outside
`lib/services/slot-claim.ts` writes `confirmedDocumentId`"*, matching the field in a write
position (`data: { confirmedDocumentId: … }`) across `lib`, `app` and `components`.

A guard that cannot fail is decoration, so two things were checked rather than assumed.
A companion test pins that the pattern distinguishes a write from a read, so `select:` and
`where:` uses — which the registers rely on — do not trip it. And the rule was verified
against a deliberately planted violation in `lib/platform/counts.ts`, which it reported by
name before the file was restored.

---

## 5. Decisions that were reversed

Recording these because the reasoning matters more than the outcome.

**The role model, twice.** It first held *disjoint* capabilities — one identity could
attach, the other sign off. That made the person accountable for the filing unable to do
the product's main job, and implied the capability check was the control. Correcting that,
both identities were given *identical* powers — which fixed the hierarchy and destroyed the
distinction, since switching role then changed nothing anybody could see.

The shape that is true of a finance team is a **superset**: a clerk works the queue; a
controller works the same queue *and* signs off other people's attachments *and* sets
thresholds. Two mechanisms then do separate jobs, which is why both exist:

| Mechanism | Answers |
|---|---|
| Capabilities (`decide`, `verify`, `configure`) | what kind of work this person does at all |
| `canVerify`, per attachment | whether *this* person may sign off *this* item |

Neither substitutes for the other. Holding `verify` lets a controller sign off colleagues'
work; it never lets her approve her own. The interface has to make that visible or the
control is only a claim — so own attachments appear in the assurance queue greyed with
"you attached this" rather than filtered away, the header states how many of the waiting
items are the reader's own, and the dashboard offers a work doorway only for work the
reader can actually pick up.

The seed deliberately attributes a minority of attachments to each human identity. With
everything attributed to `system`, nobody is ever a maker, `canVerify` never refuses, and
the rule is invisible no matter how correct the code is.

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

## 6. Content

Every sentence the capability shows is a keyed entry in `lib/content/messages.ts`, read
through `t(key, params)`. Components contain keys, never prose.

Inline copy has three costs that only appear later. Changing a wording means finding every
component that happens to contain it. A host mounting the module cannot adapt one phrase to
their own vocabulary without forking it. And the product cannot be translated at all —
which for a Saudi VAT product is not a future nicety, since Arabic is the language the
people doing this work read receipts in.

| Concern | Mechanism |
|---|---|
| Change a wording | edit one catalogue entry |
| Host uses different vocabulary | `configureMessages({ 'nav.charges': 'Transactions' })` |
| Second language | a full catalogue is an override of every key |
| Counting | `singular\|plural` templates selected by `params.count` |
| Values inside sentences | `{name}` placeholders, substituted at render |

Two deliberate failure modes. An unsupplied placeholder renders as `{amount}` rather than
collapsing to a blank, and an unknown key renders as the key. Both are copy bugs, and both
should be visible the first time anybody looks at the screen — a sentence with a silently
missing value reads as finished and says the wrong thing.

The catalogue covers the whole surface, not the screens that were easy. That includes the
copy tables — status labels, ageing bands, sign-off triggers, role summaries, work-queue
kinds — which read like plain objects but are defined as getters so a host override reaches
them. Building those tables once at module load would be the obvious implementation and the
wrong one: overrides would apply on some screens and not others, which is worse than not
supporting them. `__tests__/messages.test.ts` asserts an override reaches each table, and
those assertions fail if any of them is rewritten as a literal.

Not a dependency. A full i18n library brings locale negotiation, plural-rule tables, and
date and currency formatting, all of which this already has or does not need for one
locale. The point at which it earns its place is a language with richer plural categories
than English, which would supply its own selector alongside its catalogue.

---

## 7. Build output is separate from the dev server

`next dev` and `next build` both write to `.next` by default, and they write incompatible
things into it. Running a build while a dev server is up leaves that server serving a
half-overwritten client manifest, and every affected route then fails with
`Could not find the module … in the React Client Manifest` — an error naming the React
Server Components bundler and saying nothing about the cause.

It is not theoretical: it happened three times during development, and it would happen to
anybody who opens a second terminal to check the project compiles. `next.config.ts` reads
`distDir` from `NEXT_DIST_DIR`, and `npm run build` / `npm run start` set it to
`.next-build`. The two no longer share an output directory, so both can run at once.

---

### One dev server at a time

The same reasoning extends to running two dev servers. When port 3000 is taken, Next does
not stop — it moves to 3001 and keeps going, sharing the first server's `.next`. Two
Turbopack processes writing one build directory corrupt each other, and the symptom is a
500 on every route, including API routes that render no React at all. Nothing in that
symptom points at the cause, so the time gets spent on the application instead.

`scripts/check-dev-port.mjs` runs before `next dev` and refuses to start, naming the pid
that holds the port. A second server is legitimate if it has its own build directory, so
the override says exactly that: `NEXT_DIST_DIR=.next-alt PORT=3002 DARB_ALLOW_SECOND_DEV=1`.

The same hazard applies to deleting `.next` under a running server — it does not recover,
it 500s on everything. Stop the server first.

---

## 8. What breaks first

Honest list, in the order it would bite.

The first two entries on this list used to be in-memory status filtering in the register
and the dashboard. Both are now indexed SQL (§3), which is what the stored status bought.
What remains:

1. **Candidate selection is unbounded** within its date window. A fleet with thousands of
   charges in one week would score all of them. Fix: a cap plus a stricter pre-filter.
   Widening the invoice window to 45 days made this more pressing, not less.
2. **The actor resolver is module-level state** (§2). Fix: request-scoped context.
3. **OCR runs inline on the webhook thread.** Already flagged in `IMPLEMENTATION.md` §7 —
   storage happens first, so the structure is right; production enqueues after persisting.

None of these are latent bugs. They are the points where a correct design for this size
becomes the wrong design for a larger one, and each has a known fix that does not change a
contract.

---

## 9. Testing strategy

485 tests, 32 suites, and the split is deliberate.

- **Pure and fast** — the matcher, scoring boundaries, merchant similarity, comparison,
  coverage arithmetic, both status derivations (`documentationStatusOf` for a charge,
  `documentStatusOf` for a document), verification policy, boundary decoders. No database,
  no fixtures, no mocks; the whole suite finishes in a couple of seconds, which is the
  actual reason it gets run on every change.
- **Against a real database** — ingestion idempotency, slot contention, re-match, review
  actions, the audit trail. These properties are enforced by unique constraints, and a
  mocked client would only prove the code *intends* to be safe.

Two modules are replaced under Jest, both under `__tests__/helpers/`. `next-safe-action`
ships ESM only and ts-jest's CommonJS transform cannot load it; `revalidatePath` reaches
into a per-request store that does not exist outside a request. Before the doubles, the
review tests mirrored the action bodies rather than calling them — and a mirror is a
re-implementation, so it passes happily while the real action does something else. The
doubles replace the dispatcher and the cache bust, not the action, so what the tests run
is the production path. Neither stub asserts library behaviour, which is not this
project's to assert.

Where a test pins a decision rather than a behaviour, the comment says which decision and
why, so a future change that breaks it can tell whether it is fixing a bug or discarding
an argument.

### A refusal is not an error

Every write is gated twice: by capability, and — for sign-off — by segregation. Both gates
originally answered by throwing, and `handleServerError` flattens any throw into "Something
went wrong while recording that decision. Please retry."

That sentence is wrong twice over for a refusal. It presents a control that is working
exactly as designed as a fault in the software, which teaches operators that permissions
are flaky rather than deliberate. And it tells them to retry something that cannot ever
succeed, so the advice is not merely unhelpful but false. Both gates now return a typed
`REFUSED` result carrying its own sentence, which the interface renders where it already
renders every other outcome. `__tests__/action-refusals.test.ts` fails if either goes back
to throwing.

### Type safety is now checked, not observed

`next/typescript` ships the *untyped* recommended ESLint set, so the whole `no-unsafe-*`
tier and `no-floating-promises` were switched off. The repo had no `any`, which made "lint
is clean" mean less than it looked: an `any` arriving from an untyped boundary would have
flowed through unflagged, and an unawaited promise anywhere in the ingestion pipeline would
not have been an error. `eslint.config.mjs` now enables type-aware linting over
`lib/`, `app/` and `components/` — the five `no-unsafe-*` rules, `no-floating-promises`,
`no-misused-promises`, and `no-unused-vars` raised from warn to error.

---

## 10. What is enforced, and what is written down

This document says a rule that lives only in a document is a wish. Applying that to its own
contents, every invariant it states, and what actually holds it:

| Invariant | Enforced by |
|---|---|
| `lib/domain` / `lib/matching` import no platform, no Prisma, no `next/*` | `__tests__/architecture.test.ts` |
| `transaction-matcher.ts` imports no I/O at all | `__tests__/architecture.test.ts` |
| `lib/services` has no *undeclared* `lib/platform` import | `__tests__/architecture.test.ts` (allowlist of two files) |
| Only `lib/platform/identity.ts` touches `next/headers` | `__tests__/architecture.test.ts` (scans `lib`, `components`, `app`) |
| `Transaction.documentationStatus` equals its derivation | `expectStatusesConsistent`, in `afterEach` for every test |
| An unknown stored enum never reads as settled | `__tests__/enums.test.ts` |
| `ReviewEvent` survives deletion of its document | `__tests__/audit-integrity.test.ts` (the charge case is argued, not tested) |
| A host copy override reaches every copy table | `__tests__/messages.test.ts` |
| A refused write returns `REFUSED` rather than throwing | `__tests__/action-refusals.test.ts` |
| `configureModule({ basePath })` reaches the nav hrefs | `__tests__/verification.test.ts` |
| Rejecting a runner-up leaves a confirmed document `MATCHED` | `__tests__/review-actions.test.ts` |
| `slot-claim.ts` is the only writer of `confirmedDocumentId` | `__tests__/architecture.test.ts` (§4) |
| **`Document.status` has one writer** | **no global invariant; only the action suites and one regression test (§3)** |
| **The seam list in §2 is complete** | **nothing — produced by grep, not by a test (§2)** |

The two bold rows are the honest state of it. Both are cheap to close; neither is closed.
The third — the single-writer rule on the slot — was closed and is listed above with the
test that now carries it.
