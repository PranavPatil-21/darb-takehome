import Link from 'next/link';
import { resolveActor } from '@/lib/platform/identity';
import { applyEnvironmentConfig } from '@/lib/platform/bootstrap';
import { modulePath } from '@/lib/platform/module-config';
import { getChargeRegister } from '@/lib/platform/charge-register';
import {
  AGE_BUCKET_LABEL,
  TRANSACTION_STATUS,
  type AgeBucket,
  type TransactionDocumentationStatus,
} from '@/lib/platform/transaction-status';
import { formatDay, formatMinorUnits } from '@/lib/format';
import { ChargeStatusPill } from '@/components/charges/charge-status-pill';
import { FilterChips } from '@/components/charges/filter-chips';
import { SearchBox } from '@/components/charges/search-box';

/**
 * The charge register — every card transaction, categorised.
 *
 * This is the screen the brief never asked for and a finance team cannot work without:
 * the review queue answers "what needs deciding", and this answers "where does this
 * specific charge stand", which is the question asked when an auditor samples a line or a
 * driver disputes one.
 *
 * All filter state lives in the URL. A filtered register is the thing people send each
 * other — "the twelve over a month old, here" — and state held in the client cannot be
 * pasted into a message.
 */

export const dynamic = 'force-dynamic';

const STATUSES: TransactionDocumentationStatus[] = [
  'MISSING',
  'IN_REVIEW',
  'REJECTED',
  'DOCUMENTED',
];

export default async function ChargeRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; age?: string; q?: string }>;
}) {
  applyEnvironmentConfig();

  const params = await searchParams;
  const actor = await resolveActor();

  const status = STATUSES.includes(params.status as TransactionDocumentationStatus)
    ? (params.status as TransactionDocumentationStatus)
    : undefined;
  const age = (['0-7', '8-30', '31-60', '60+'] as AgeBucket[]).includes(params.age as AgeBucket)
    ? (params.age as AgeBucket)
    : undefined;

  const register = await getChargeRegister(
    actor,
    { status, age, query: params.q },
    new Date(),
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Charges</h1>
        <p className="mt-1 text-sm text-muted-foreground tabular-nums">
          {register.matchedCount} {register.matchedCount === 1 ? 'charge' : 'charges'} ·{' '}
          {formatMinorUnits(register.matchedValue)}
          {status || age || params.q ? ' matching this filter' : ' in total'}
        </p>
      </header>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <FilterChips
          counts={register.statusCounts}
          activeStatus={status}
          activeAge={age}
          query={params.q}
        />
        <SearchBox defaultValue={params.q ?? ''} status={status} age={age} />
      </div>

      {age ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing undocumented charges aged {AGE_BUCKET_LABEL[age].toLowerCase()}.{' '}
          <Link href={modulePath('transactions')} className="underline underline-offset-4">
            Clear
          </Link>
        </p>
      ) : null}

      {register.rows.length === 0 ? (
        <div className="mt-8 rounded-lg border bg-card p-10 text-center">
          <p className="font-medium">Nothing matches this filter</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Try a different status, or clear the search.
          </p>
          <Link
            href={modulePath('transactions')}
            className="mt-4 inline-block text-sm underline underline-offset-4"
          >
            Show all charges
          </Link>
        </div>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[46rem] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Merchant</th>
                <th className="py-2 pr-4 text-right font-medium">Amount</th>
                <th className="py-2 pr-4 font-medium">Date</th>
                <th className="py-2 pr-4 font-medium">Card</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Age</th>
              </tr>
            </thead>
            <tbody>
              {register.rows.map((row) => (
                <tr key={row.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2.5 pr-4">
                    <Link
                      href={modulePath('transactions', String(row.id))}
                      className="underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {row.merchantName}
                    </Link>
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">
                    {formatMinorUnits(row.amount, row.currency)}
                  </td>
                  <td className="py-2.5 pr-4 tabular-nums text-muted-foreground">
                    {formatDay(row.transactionAt)}
                  </td>
                  <td className="py-2.5 pr-4 tabular-nums text-muted-foreground">
                    ••••{row.cardLast4}
                  </td>
                  <td className="py-2.5 pr-4">
                    <ChargeStatusPill
                      status={row.status}
                      awaitingVerification={row.awaitingVerification}
                    />
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                    {row.status === 'DOCUMENTED' ? '—' : `${row.age}d`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {register.truncated ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the first {register.rows.length} of {register.matchedCount}. Narrow the filter
          to see the rest.
        </p>
      ) : null}

      <p className="mt-6 text-xs text-muted-foreground">
        Status is derived from the charge&rsquo;s confirmed document, not stored — so it cannot
        drift from the attachment it describes. {TRANSACTION_STATUS.MISSING.hint}
      </p>
    </main>
  );
}
