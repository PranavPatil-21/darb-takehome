import {
  WORK_KINDS,
  classifyWorkItem,
  getWorkQueue,
  getWorkCounts,
  getWorkKindCounts,
  WORK_QUEUE_LIMIT,
  isDecidable,
  type WorkKind,
} from '@/lib/platform/work-queue';
import { DOCUMENT_STATUSES } from '@/lib/domain/enums';
import { MATCH_REASONS } from '@/lib/services/transaction-matcher';
import { resetDatabase, seedMinimalWorld } from './helpers/db';
import prisma from '@/lib/prisma';
import { t, workKindLabel, workKindNextStep, workKindWhy } from '@/lib/content/messages';

/**
 * The work queue's taxonomy.
 *
 * This replaced two partial indexes — a flat NEEDS_REVIEW list and a separate "exceptions"
 * page — which between them left five documents in neither. The property that matters is
 * not that the groups look tidy but that **nothing can fall through**: every state the
 * pipeline can leave a document in maps to exactly one kind, and a new reason code added
 * to the matcher fails this suite rather than silently vanishing from the interface.
 */

const ACTOR = {
  id: 'tester',
  displayName: 'Tester',
  capabilities: ['view', 'decide'] as const,
  clientIds: null,
};

describe('the taxonomy is exhaustive', () => {
  test('every matcher reason classifies to a known kind', () => {
    // Asserted, not guarded. This read `if (kind !== null) expect(...)`, which made the
    // test incapable of failing the way it was written to fail: a new reason code with no
    // home falls through to `null`, the guard skipped the assertion, and the document
    // silently vanished from the queue. The whole point is that it cannot.
    //
    // None of these three statuses can legitimately produce `null` — that is reserved for
    // MATCHED/RECEIVED/EXTRACTED, which are not work.
    for (const reason of MATCH_REASONS) {
      for (const status of ['NEEDS_REVIEW', 'UNMATCHED', 'FAILED'] as const) {
        const kind = classifyWorkItem({ status, failureReason: reason, clientId: 1 });

        expect(kind).not.toBeNull();
        expect(WORK_KINDS).toContain(kind);
      }
    }
  });

  test('every document status that needs a human classifies', () => {
    const needsAHuman = DOCUMENT_STATUSES.filter(
      (s) => s === 'NEEDS_REVIEW' || s === 'UNMATCHED' || s === 'FAILED',
    );

    for (const status of needsAHuman) {
      const kind = classifyWorkItem({ status, failureReason: null, clientId: 1 });
      expect(kind).not.toBeNull();
    }
  });

  test('settled documents are not work', () => {
    expect(classifyWorkItem({ status: 'MATCHED', failureReason: null, clientId: 1 })).toBeNull();
    expect(classifyWorkItem({ status: 'RECEIVED', failureReason: null, clientId: 1 })).toBeNull();
    expect(classifyWorkItem({ status: 'EXTRACTED', failureReason: null, clientId: 1 })).toBeNull();
  });
});

describe('classification routes by what the person must do', () => {
  const cases: Array<[string, Parameters<typeof classifyWorkItem>[0], WorkKind]> = [
    ['a tie between charges', { status: 'NEEDS_REVIEW', failureReason: 'AMBIGUOUS_TOP_CANDIDATES', clientId: 1 }, 'CHOOSE_CHARGE'],
    ['a mid-confidence lead', { status: 'NEEDS_REVIEW', failureReason: 'MID_CONFIDENCE', clientId: 1 }, 'CHECK_FIGURES'],
    ['a distrusted scan', { status: 'NEEDS_REVIEW', failureReason: 'LOW_EXTRACTION_CONFIDENCE', clientId: 1 }, 'CHECK_FIGURES'],
    ['one lone signal', { status: 'NEEDS_REVIEW', failureReason: 'INSUFFICIENT_CORROBORATION', clientId: 1 }, 'CHECK_FIGURES'],
    ['merchant and date only', { status: 'NEEDS_REVIEW', failureReason: 'WEAK_EVIDENCE', clientId: 1 }, 'WEAK_EVIDENCE'],
    ['a second receipt', { status: 'NEEDS_REVIEW', failureReason: 'TRANSACTION_ALREADY_DOCUMENTED', clientId: 1 }, 'POSSIBLE_DUPLICATE'],
    ['nothing plausible', { status: 'UNMATCHED', failureReason: 'NO_PLAUSIBLE_CANDIDATE', clientId: 1 }, 'NO_CHARGE_FOUND'],
    ['no charges at all', { status: 'UNMATCHED', failureReason: 'NO_CANDIDATE_TRANSACTIONS', clientId: 1 }, 'NO_CHARGE_FOUND'],
    ['an unreadable scan', { status: 'FAILED', failureReason: 'boom', clientId: 1 }, 'UNREADABLE'],
    ['garbage OCR', { status: 'UNMATCHED', failureReason: 'UNUSABLE_EXTRACTION', clientId: 1 }, 'UNREADABLE'],
    ['a stranger', { status: 'UNMATCHED', failureReason: null, clientId: null }, 'SENDER_UNKNOWN'],
  ];

  test.each(cases)('%s -> %s', (_name, input, expected) => {
    expect(classifyWorkItem(input)).toBe(expected);
  });

  test('an unknown sender outranks a matching outcome', () => {
    // Registering the sender is the unblocking act; the matching outcome is downstream of
    // it and would otherwise send the reviewer chasing a charge that cannot be scoped.
    expect(
      classifyWorkItem({ status: 'UNMATCHED', failureReason: 'NO_PLAUSIBLE_CANDIDATE', clientId: null }),
    ).toBe('SENDER_UNKNOWN');
  });

  test('but an unreadable document outranks an unknown sender', () => {
    // Each group states one next step, so a document must land in the group whose fix
    // actually moves it forward. Registering a sender does not rescue a scan that
    // produced nothing; a better photo does, whoever sent it.
    expect(classifyWorkItem({ status: 'FAILED', failureReason: null, clientId: null })).toBe(
      'UNREADABLE',
    );
  });
});

describe('decidability', () => {
  test('a reviewer can decide the kinds that have candidates', () => {
    expect(isDecidable('CHOOSE_CHARGE')).toBe(true);
    expect(isDecidable('CHECK_FIGURES')).toBe(true);
    expect(isDecidable('WEAK_EVIDENCE')).toBe(true);
    expect(isDecidable('POSSIBLE_DUPLICATE')).toBe(true);
  });

  test('a reviewer cannot confirm or reject what has no candidate', () => {
    expect(isDecidable('NO_CHARGE_FOUND')).toBe(false);
    expect(isDecidable('UNREADABLE')).toBe(false);
    expect(isDecidable('SENDER_UNKNOWN')).toBe(false);
  });
});

describe('the queue itself', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedMinimalWorld();
  });

  const make = (externalId: string, status: string, failureReason: string | null, clientId: number | null) =>
    prisma.document.create({
      data: {
        source: 'WHATSAPP',
        externalId,
        contentHash: `hash-${externalId}`,
        senderIdentifier: '966551234567',
        clientId,
        status,
        failureReason,
      },
    });

  test('surfaces documents that were previously in no list at all', async () => {
    await make('a', 'UNMATCHED', 'NO_PLAUSIBLE_CANDIDATE', 1);
    await make('b', 'UNMATCHED', 'NO_CANDIDATE_TRANSACTIONS', 1);

    const groups = await getWorkQueue(ACTOR);
    const noCharge = groups.find((g) => g.kind === 'NO_CHARGE_FOUND');

    expect(noCharge?.items).toHaveLength(2);
  });

  test('does not list a settled document', async () => {
    await make('c', 'MATCHED', null, 1);

    const groups = await getWorkQueue(ACTOR);
    expect(groups.flatMap((g) => g.items)).toHaveLength(0);
  });

  test('lists a document exactly once', async () => {
    await make('d', 'NEEDS_REVIEW', 'TRANSACTION_ALREADY_DOCUMENTED', 1);

    const groups = await getWorkQueue(ACTOR);
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(1);
  });

  test('every group states what the person should do about it', async () => {
    await make('e', 'FAILED', 'extraction died', 1);
    await make('f', 'UNMATCHED', null, null);

    const groups = await getWorkQueue(ACTOR);
    for (const group of groups) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.nextStep.length).toBeGreaterThan(0);
    }
  });

  test('scopes to the actor', async () => {
    await make('g', 'NEEDS_REVIEW', 'MID_CONFIDENCE', 2);

    const groups = await getWorkQueue({ ...ACTOR, clientIds: [1] });
    expect(groups.flatMap((g) => g.items)).toHaveLength(0);
  });
});

/* ========================================================================== */
/* Copy that has to agree with the counts it describes                        */
/* ========================================================================== */

describe('queue copy', () => {
  test('agrees in number with a single decidable document', () => {
    expect(t('review.subtitle.decidable', { count: 1 })).toBe('1 needs a decision');
    expect(t('review.subtitle.blocked', { count: 1 })).toBe('1 needs something else');
  });

  test('agrees in number with several', () => {
    expect(t('review.subtitle.decidable', { count: 4 })).toBe('4 need a decision');
    expect(t('review.subtitle.blocked', { count: 2 })).toBe('2 need something else');
  });

  test('every kind has a label, a reason and a next step', () => {
    for (const kind of WORK_KINDS) {
      // A group that names a problem without naming its remedy is a complaint, not a
      // queue — and a missing key renders as the key itself, which this would catch.
      expect(workKindLabel(kind)).not.toBe(kind);
      expect(workKindWhy(kind).length).toBeGreaterThan(0);
      expect(workKindNextStep(kind).length).toBeGreaterThan(0);
    }
  });
});

/* ========================================================================== */
/* Filtering the queue to one kind of work                                    */
/* ========================================================================== */

describe('filtering by kind', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedMinimalWorld();
  });

  const make = (externalId: string, status: string, failureReason: string | null) =>
    prisma.document.create({
      data: {
        source: 'WHATSAPP',
        externalId,
        contentHash: `hash-${externalId}`,
        senderIdentifier: '966551234567',
        clientId: 1,
        status,
        failureReason,
      },
    });

  test('returns only the requested kind', async () => {
    await make('f1', 'NEEDS_REVIEW', 'AMBIGUOUS_TOP_CANDIDATES');
    await make('f2', 'UNMATCHED', 'NO_PLAUSIBLE_CANDIDATE');

    const groups = await getWorkQueue(ACTOR, { kind: 'CHOOSE_CHARGE' });

    expect(groups.map((g) => g.kind)).toEqual(['CHOOSE_CHARGE']);
    expect(groups[0]!.items).toHaveLength(1);
  });

  test('an unfiltered queue still returns every kind present', async () => {
    await make('f3', 'NEEDS_REVIEW', 'AMBIGUOUS_TOP_CANDIDATES');
    await make('f4', 'UNMATCHED', 'NO_PLAUSIBLE_CANDIDATE');

    const groups = await getWorkQueue(ACTOR);
    expect(groups.map((g) => g.kind).sort()).toEqual(['CHOOSE_CHARGE', 'NO_CHARGE_FOUND']);
  });

  test('counts are of the whole queue, not the filtered view', async () => {
    // The chips have to show what *would* be there if you clicked them, so the counts
    // cannot come from the filtered result — a filter that reported its own size would
    // show every chip as either its own total or zero.
    await make('f5', 'NEEDS_REVIEW', 'AMBIGUOUS_TOP_CANDIDATES');
    await make('f6', 'UNMATCHED', 'NO_PLAUSIBLE_CANDIDATE');
    await make('f7', 'UNMATCHED', 'NO_PLAUSIBLE_CANDIDATE');

    const counts = await getWorkKindCounts(ACTOR);

    expect(counts.CHOOSE_CHARGE).toBe(1);
    expect(counts.NO_CHARGE_FOUND).toBe(2);
    expect(counts.UNREADABLE).toBe(0);
  });

  test('a kind with nothing in it yields an empty queue, not every document', async () => {
    await make('f8', 'NEEDS_REVIEW', 'AMBIGUOUS_TOP_CANDIDATES');

    const groups = await getWorkQueue(ACTOR, { kind: 'UNREADABLE' });
    expect(groups.flatMap((g) => g.items)).toHaveLength(0);
  });
});

describe('counts are counts, not the length of a capped page', () => {
  /**
   * `getWorkQueue` deliberately returns at most `WORK_QUEUE_LIMIT` rows — a queue nobody
   * can work through in one sitting should not be fetched in one query. But the totals
   * were derived from that same capped list, so the nav badge, the dashboard and the
   * filter chips all reported 200 whatever the real backlog was, and whole work kinds
   * vanished because the cap is ordered oldest-first.
   */
  beforeEach(async () => {
    await resetDatabase();
    await seedMinimalWorld();
    await prisma.documentMatch.deleteMany();
    await prisma.transaction.updateMany({ data: { confirmedDocumentId: null } });
    await prisma.document.deleteMany();

    // One more than the cap, all the same kind, plus one newer document of a different
    // kind that the oldest-first window would push off the end.
    const rows = Array.from({ length: WORK_QUEUE_LIMIT + 1 }, (_, i) => ({
      source: 'WHATSAPP' as const,
      externalId: `wamid.bulk-${i}`,
      contentHash: `bulk-hash-${i}`,
      senderIdentifier: '966551234567',
      status: 'UNMATCHED' as const,
      clientId: 1,
      failureReason: 'NO_PLAUSIBLE_CANDIDATE',
      receivedAt: new Date(2025, 0, 1 + i),
    }));
    await prisma.document.createMany({ data: rows });
    await prisma.document.create({
      data: {
        source: 'WHATSAPP', externalId: 'wamid.newest', contentHash: 'newest-hash',
        senderIdentifier: '966551234567', status: 'NEEDS_REVIEW', clientId: 1,
        failureReason: 'TRANSACTION_ALREADY_DOCUMENTED',
        receivedAt: new Date(2026, 0, 1),
      },
    });
  });

  test('getWorkCounts reports the whole backlog, not the page size', async () => {
    const counts = await getWorkCounts(ACTOR);

    expect(counts.total).toBe(WORK_QUEUE_LIMIT + 2);
  });

  test('a kind pushed off the end of the page still appears in the counts', async () => {
    const counts = await getWorkKindCounts(ACTOR);

    expect(counts.POSSIBLE_DUPLICATE).toBe(1);
    expect(counts.NO_CHARGE_FOUND).toBe(WORK_QUEUE_LIMIT + 1);
  });
});

describe('the counts respect the actor’s client scope', () => {
  /**
   * An unknown-sender document has `clientId: null` — it belongs to nobody until somebody
   * registers the sender. `getWorkQueue` already excludes it for a scoped actor, because
   * `clientId: { in: [...] }` does not match NULL in SQL. The counts must agree with the
   * queue they describe.
   *
   * They did not. The scoped filter and the null-client predicate were merged with an
   * object spread, so `{ ...scope, clientId: null }` replaced the scope key outright and
   * every scoped tenant was handed a tally of documents that were not theirs.
   */
  const SCOPED = {
    id: 'scoped',
    displayName: 'Scoped',
    capabilities: ['view', 'decide'] as const,
    clientIds: [1],
  };
  const scopedActor = () => ({ ...SCOPED, capabilities: [...SCOPED.capabilities] });

  beforeEach(async () => {
    await resetDatabase();
    await seedMinimalWorld();
    await prisma.documentMatch.deleteMany();
    await prisma.transaction.updateMany({ data: { confirmedDocumentId: null } });
    await prisma.document.deleteMany();

    await prisma.document.createMany({
      data: [
        {
          source: 'EMAIL', externalId: 'scope-mine', contentHash: 'scope-c1',
          senderIdentifier: 'fleetops@rawabi-logistics.example', clientId: 1,
          status: 'NEEDS_REVIEW', failureReason: 'MID_CONFIDENCE',
          receivedAt: new Date('2025-01-01'),
        },
        ...Array.from({ length: 5 }, (_, i) => ({
          source: 'WHATSAPP' as const, externalId: `scope-unknown-${i}`,
          contentHash: `scope-cu${i}`, senderIdentifier: '966500000000', clientId: null,
          status: 'UNMATCHED' as const, failureReason: 'NO_CANDIDATE_TRANSACTIONS',
          receivedAt: new Date('2025-01-03'),
        })),
      ],
    });
  });

  test('a scoped actor is not counted documents that are not theirs', async () => {
    const counts = await getWorkKindCounts(scopedActor());

    expect(counts.SENDER_UNKNOWN).toBe(0);
  });

  test('the totals match the queue the actor can actually see', async () => {
    const [counts, queue] = await Promise.all([
      getWorkCounts(scopedActor()),
      getWorkQueue(scopedActor(), {}),
    ]);
    const visible = queue.reduce((sum, group) => sum + group.items.length, 0);

    expect(counts.total).toBe(visible);
  });

  test('an unrestricted operator still sees the unknown-sender backlog', async () => {
    const counts = await getWorkKindCounts(ACTOR);

    expect(counts.SENDER_UNKNOWN).toBe(5);
  });
});
