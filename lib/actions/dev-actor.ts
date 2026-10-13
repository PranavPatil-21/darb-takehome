'use server';

import { revalidatePath } from 'next/cache';
import { setDevelopmentActorCookie } from '@/lib/platform/identity';

/**
 * Switch between the two development identities.
 *
 * Exists only because there is no authentication: the maker and the checker hold disjoint
 * capabilities by design, so without a way to move between them the four-eyes control
 * cannot be demonstrated or tested by hand. A host application mounts its own resolver and
 * this becomes dead code, which is the intended end state.
 */
export async function switchDevActor(actorId: string): Promise<void> {
  // The cookie is written through the identity seam rather than here, so `next/headers`
  // stays confined to one module.
  await setDevelopmentActorCookie(actorId);

  // Every screen in the module is permission-sensitive, so the whole module re-renders.
  revalidatePath('/', 'layout');
}
