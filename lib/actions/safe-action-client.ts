import { createSafeActionClient } from 'next-safe-action';
import { log } from '@/lib/logger';

/**
 * Server-action client.
 *
 * `handleServerError` is overridden so a thrown error becomes a typed, user-safe string
 * instead of leaking a Prisma message (which would happily print a constraint name and
 * table schema to the browser).
 */
export const actionClient = createSafeActionClient({
  handleServerError(error) {
    log.error('Server action failed', { message: error.message });
    return 'Something went wrong while recording that decision. Please retry.';
  },
});
