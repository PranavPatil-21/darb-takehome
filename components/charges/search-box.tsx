import { t } from '@/lib/content/messages';
import { modulePath } from '@/lib/platform/module-config';
import type { AgeBucket, TransactionDocumentationStatus } from '@/lib/platform/transaction-status';

/**
 * Free-text search over merchant and card.
 *
 * A plain GET form: no client component, no debounce, no state. Submitting navigates and
 * the result is a URL somebody can send. The hidden inputs carry the other filters so
 * searching inside a status does not silently discard it — losing the rest of the filter
 * on search is the small betrayal that teaches people not to trust a filter bar.
 */
export function SearchBox({
  defaultValue,
  status,
  age,
}: {
  defaultValue: string;
  status?: TransactionDocumentationStatus;
  age?: AgeBucket;
}) {
  return (
    <form action={modulePath('transactions')} method="get" className="flex items-center gap-2">
      {status ? <input type="hidden" name="status" value={status} /> : null}
      {age ? <input type="hidden" name="age" value={age} /> : null}

      <label className="sr-only" htmlFor="charge-search">
        Search merchant or card
      </label>
      <input
        id="charge-search"
        name="q"
        defaultValue={defaultValue}
        placeholder={t('charges.search.placeholder')}
        className="h-8 w-48 rounded-md border bg-background px-3 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <button
        type="submit"
        className="h-8 rounded-md border px-3 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Search
      </button>
    </form>
  );
}
