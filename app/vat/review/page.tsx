/**
 * The review queue, inside the module shell.
 *
 * The implementation lives at `app/review/page.tsx` and is re-exported rather than
 * duplicated. `/review` is the path requirements.md names, so it keeps working exactly as
 * specified and does not move just because the capability gained a home; this route is the
 * same screen reached through the module's own navigation.
 *
 * One screen, two mount points, no second copy to drift.
 */
export { default, dynamic } from '@/app/review/page';
