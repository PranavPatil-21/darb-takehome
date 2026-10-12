'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { DEV_ACTOR_COOKIE, DEVELOPMENT_ACTOR, DEVELOPMENT_CHECKER } from '@/lib/platform/identity';

/**
 * Switch between the two development identities.
 *
 * Exists only because there is no authentication: the maker and the checker hold disjoint
 * capabilities by design, so without a way to move between them the four-eyes control
 * cannot be demonstrated or tested by hand. A host application mounts its own resolver and
 * this becomes dead code, which is the intended end state.
 */
export async function switchDevActor(actorId: string): Promise<void> {
  const next = actorId === DEVELOPMENT_CHECKER.id ? DEVELOPMENT_CHECKER.id : DEVELOPMENT_ACTOR.id;

  const store = await cookies();
  store.set(DEV_ACTOR_COOKIE, next, { httpOnly: true, sameSite: 'lax', path: '/' });

  // Every screen in the module is permission-sensitive, so the whole module re-renders.
  revalidatePath('/', 'layout');
}
