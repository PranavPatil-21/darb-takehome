import type { ReviewActionResult } from '@/lib/actions/review';

/**
 * Calls a server action and returns its result.
 *
 * Under Jest, `next-safe-action` is replaced by the double in `next-safe-action.ts`,
 * which returns the handler's value directly rather than the library's
 * `{ data, serverError, validationErrors }` envelope. TypeScript still resolves the real
 * package's types, so the two disagree at the call site and nowhere else. This is the one
 * place that reconciles them, rather than scattering casts through the tests.
 */
export async function runAction(
  action: (input: { matchId: number }) => Promise<unknown>,
  matchId: number,
): Promise<ReviewActionResult> {
  const result = await action({ matchId });
  if (result && typeof result === 'object' && 'serverError' in result) {
    throw new Error(`Action failed: ${String((result as { serverError: unknown }).serverError)}`);
  }
  return result as ReviewActionResult;
}
