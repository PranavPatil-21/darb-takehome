/**
 * A no-op `next/cache` for Jest.
 *
 * `revalidatePath` reaches into Next's per-request static-generation store and throws
 * outside one. That store is the framework's, not this project's: what the action tests
 * assert is the decision and the rows it writes, and a cache bust is neither.
 *
 * Stubbing it keeps the action bodies callable under test without reshaping production
 * code to suit the runner — the alternative would be moving revalidation behind a seam
 * that exists only because a test could not reach it.
 */
export function revalidatePath(): void {}
export function revalidateTag(): void {}
