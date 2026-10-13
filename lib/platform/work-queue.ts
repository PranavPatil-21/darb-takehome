import type { PrismaClient } from '@prisma/client';
import prismaDefault from '@/lib/prisma';
import { clientScopeFilter, type Actor } from '@/lib/platform/identity';
import { workKindLabel, workKindNextStep, workKindWhy } from '@/lib/content/messages';
import { decodeDocumentStatus } from '@/lib/domain/enums';

/**
 * Everything waiting on a person, in one taxonomy.
 *
 * This replaced two partial indexes: a flat `NEEDS_REVIEW` list on the review page, and a
 * separate "exceptions" register. Between them they managed to both duplicate and omit —
 * a possible-duplicate document appeared on both screens, while five documents that had
 * simply found no charge appeared on neither. Two hand-maintained definitions of "needs
 * attention" will always drift; one derived definition cannot.
 *
 * The grouping is **by what the person must do**, not by database status. A reviewer does
 * not care that one document is `NEEDS_REVIEW` and another `UNMATCHED`; they care that one
 * needs a charge picked and the other needs a sender registered. Those are different jobs,
 * often different people.
 */

export const WORK_KINDS = [
  /** Several charges fit. Somebody has to pick. */
  'CHOOSE_CHARGE',
  /** One lead, but the figures need a human eye before it is attached to money. */
  'CHECK_FIGURES',
  /** Merchant and date agree and nothing else could be read. */
  'WEAK_EVIDENCE',
  /** The charge already has a receipt. This may be a second copy of it. */
  'POSSIBLE_DUPLICATE',
  /** Nothing plausible to attach it to — yet. */
  'NO_CHARGE_FOUND',
  /** The document itself could not be read. */
  'UNREADABLE',
  /** We do not know whose document this is. */
  'SENDER_UNKNOWN',
] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

/**
 * Whether a reviewer can settle this with confirm/reject.
 *
 * The three `false` kinds have no candidate to confirm, so offering the buttons would be
 * an interface promising an action the data cannot support. Their next step is a different
 * job — re-photograph the receipt, register the sender, wait for the charge to post.
 */
const DECIDABLE: Readonly<Record<WorkKind, boolean>> = {
  CHOOSE_CHARGE: true,
  CHECK_FIGURES: true,
  WEAK_EVIDENCE: true,
  POSSIBLE_DUPLICATE: true,
  NO_CHARGE_FOUND: false,
  UNREADABLE: false,
  SENDER_UNKNOWN: false,
};

export function isDecidable(kind: WorkKind): boolean {
  return DECIDABLE[kind];
}

/** Order the queue is presented in: most actionable first, least last. */
const ORDER: readonly WorkKind[] = WORK_KINDS;

export interface ClassifiableDocument {
  status: string;
  failureReason: string | null;
  clientId: number | null;
}

/**
 * Which job this document represents, or null if it is not waiting on anyone.
 *
 * Pure, so the mapping is testable without a database — which is what lets
 * `work-queue.test.ts` assert that *every* matcher reason lands somewhere.
 */
export function classifyWorkItem(document: ClassifiableDocument): WorkKind | null {
  const { status, failureReason, clientId } = document;

  // Settled, or still in flight. Neither is work.
  if (status === 'MATCHED' || status === 'RECEIVED' || status === 'EXTRACTED') return null;

  // Unreadable outranks unknown-sender, and the order is the whole decision.
  //
  // A document that produced nothing usable cannot be matched no matter whose it is, so
  // registering the sender would not unblock it — the unblocking act is a better photo.
  // The reverse is not true: a perfectly readable document from a stranger is waiting
  // only on the sender being registered. Routing by whichever fix actually moves the
  // document forward is what keeps each group's stated next step honest.
  if (status === 'FAILED' || failureReason === 'UNUSABLE_EXTRACTION') return 'UNREADABLE';

  // Readable, but we do not know whose it is. Until it can be scoped to a client, every
  // diagnosis downstream of scoping is noise.
  if (clientId === null) return 'SENDER_UNKNOWN';

  switch (failureReason) {
    case 'AMBIGUOUS_TOP_CANDIDATES':
      return 'CHOOSE_CHARGE';
    case 'MID_CONFIDENCE':
    case 'LOW_EXTRACTION_CONFIDENCE':
    case 'INSUFFICIENT_CORROBORATION':
      return 'CHECK_FIGURES';
    case 'WEAK_EVIDENCE':
      return 'WEAK_EVIDENCE';
    case 'TRANSACTION_ALREADY_DOCUMENTED':
      return 'POSSIBLE_DUPLICATE';
    case 'NO_PLAUSIBLE_CANDIDATE':
    case 'NO_CANDIDATE_TRANSACTIONS':
      return 'NO_CHARGE_FOUND';
    default:
      break;
  }

  // A reason the taxonomy has not met yet. Falling back on status rather than dropping
  // the document is deliberate: an unrecognised reason is a reason to look, not a reason
  // to disappear. `work-queue.test.ts` fails if a *known* reason reaches here.
  if (status === 'NEEDS_REVIEW') return 'CHECK_FIGURES';
  return 'NO_CHARGE_FOUND';
}

export interface WorkItem {
  id: number;
  merchantName: string | null;
  totalAmount: number | null;
  currency: string | null;
  documentDate: Date | null;
  receivedAt: Date;
  senderIdentifier: string;
  source: string;
}

export interface WorkGroup {
  kind: WorkKind;
  label: string;
  /** Why these are here, in one sentence. */
  why: string;
  /** What the person should actually do. */
  nextStep: string;
  decidable: boolean;
  items: WorkItem[];
}

/** Bounded: a queue is for working, not for scrolling. */
export const WORK_QUEUE_LIMIT = 200;

export interface WorkQueueFilter {
  /** Show only this kind of work. Omit for the whole queue. */
  kind?: WorkKind | undefined;
}

export async function getWorkQueue(
  actor: Actor,
  filter: WorkQueueFilter = {},
  prisma: PrismaClient = prismaDefault,
): Promise<WorkGroup[]> {
  const documents = await prisma.document.findMany({
    where: {
      // One query covering every unsettled state. The taxonomy below decides what each
      // one means; the query's only job is to exclude what nobody needs to look at.
      status: { in: ['NEEDS_REVIEW', 'UNMATCHED', 'FAILED'] },
      ...clientScopeFilter(actor),
    },
    // Oldest first: the longest-waiting document is the one closest to a filing deadline.
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    take: WORK_QUEUE_LIMIT,
    select: {
      id: true,
      merchantName: true,
      totalAmount: true,
      currency: true,
      documentDate: true,
      receivedAt: true,
      senderIdentifier: true,
      source: true,
      status: true,
      failureReason: true,
      clientId: true,
    },
  });

  const byKind = new Map<WorkKind, WorkItem[]>();
  for (const document of documents) {
    const kind = classifyWorkItem(document);
    if (kind === null) continue;
    const bucket = byKind.get(kind) ?? [];
    bucket.push({
      id: document.id,
      merchantName: document.merchantName,
      totalAmount: document.totalAmount,
      currency: document.currency,
      documentDate: document.documentDate,
      receivedAt: document.receivedAt,
      senderIdentifier: document.senderIdentifier,
      source: document.source,
    });
    byKind.set(kind, bucket);
  }

  return ORDER.filter((kind) => (byKind.get(kind)?.length ?? 0) > 0)
    .filter((kind) => filter.kind === undefined || kind === filter.kind)
    .map((kind) => ({
      kind,
      label: workKindLabel(kind),
      why: workKindWhy(kind),
      nextStep: workKindNextStep(kind),
      decidable: DECIDABLE[kind],
      items: byKind.get(kind) ?? [],
    }));
}

/**
 * How much work of each kind is waiting, before any filter.
 *
 * The filter chips have to show what *would* be there if you clicked them, so these
 * counts deliberately ignore the current selection. Deriving them from the filtered
 * result would show the active chip as its own total and every other chip as zero, which
 * makes the control useless exactly when a reviewer is using it.
 */
export async function getWorkKindCounts(
  actor: Actor,
  prisma: PrismaClient = prismaDefault,
): Promise<Record<WorkKind, number>> {
  const counts = Object.fromEntries(WORK_KINDS.map((kind) => [kind, 0])) as Record<
    WorkKind,
    number
  >;

  for (const group of await workKindGroups(actor, prisma)) {
    counts[group.kind] += group.count;
  }
  return counts;
}

/**
 * The backlog tallied by kind, counted in SQL rather than in Node.
 *
 * These were derived from `getWorkQueue(...).items.length`, which inherits its `take` —
 * so every total was capped at the page size, and because the page is ordered oldest
 * first, a newer work kind could be absent from the counts entirely while its documents
 * sat in the database. A badge that stops counting at 200 cannot distinguish a manageable
 * queue from an emergency.
 *
 * `classifyWorkItem` needs only the status, the failure reason, and whether the sender is
 * known — three columns of bounded cardinality — so the whole taxonomy can be tallied
 * from two groupings regardless of how many documents there are. The classification stays
 * in one place: this reads the same function the queue does.
 */
async function workKindGroups(
  actor: Actor,
  prisma: PrismaClient,
): Promise<{ kind: WorkKind; count: number }[]> {
  const unsettled = { status: { in: ['NEEDS_REVIEW', 'UNMATCHED', 'FAILED'] } };
  const scope = clientScopeFilter(actor);

  // An unknown-sender document has `clientId: null` — it belongs to nobody until someone
  // registers the sender — so it is in scope only for an operator who can see every
  // client. `getWorkQueue` already behaves this way, because `clientId: { in: [...] }`
  // does not match NULL in SQL, and a count that disagrees with the queue it describes is
  // worse than no count.
  //
  // Spelled out rather than spread, deliberately. `{ ...scope, clientId: null }` merges
  // two predicates that use the *same key*, so the later one replaced the scope outright
  // and handed every scoped tenant a tally of documents that were not theirs.
  const seesUnownedWork = actor.clientIds === null;

  // Split on sender-known, because that is the only thing `classifyWorkItem` needs the
  // client id for and grouping by the id itself would be unbounded.
  const [known, unknown] = await Promise.all([
    prisma.document.groupBy({
      by: ['status', 'failureReason'],
      where: { ...unsettled, ...scope, NOT: { clientId: null } },
      _count: { _all: true },
    }),
    seesUnownedWork
      ? prisma.document.groupBy({
          by: ['status', 'failureReason'],
          where: { ...unsettled, clientId: null },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);

  const tally = (
    groups: { status: string; failureReason: string | null; _count: { _all: number } }[],
    clientId: number | null,
  ) =>
    groups
      .map((group) => ({
        kind: classifyWorkItem({
          status: decodeDocumentStatus(group.status),
          failureReason: group.failureReason,
          clientId,
        }),
        count: group._count._all,
      }))
      .filter((row): row is { kind: WorkKind; count: number } => row.kind !== null);

  return [...tally(known, 1), ...tally(unknown, null)];
}

/** Totals for the navigation badge and the dashboard, counted in SQL. */
export async function getWorkCounts(
  actor: Actor,
  prisma: PrismaClient = prismaDefault,
): Promise<{ total: number; decidable: number; blocked: number }> {
  let decidable = 0;
  let blocked = 0;

  for (const group of await workKindGroups(actor, prisma)) {
    if (isDecidable(group.kind)) decidable += group.count;
    else blocked += group.count;
  }

  return { total: decidable + blocked, decidable, blocked };
}
