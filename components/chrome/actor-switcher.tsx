import { switchDevActor } from '@/lib/actions/dev-actor';
import { DEVELOPMENT_ACTOR, DEVELOPMENT_CHECKER, type Actor } from '@/lib/platform/identity';

/**
 * Who you are, in development.
 *
 * Deliberately visible rather than hidden behind a query string: the point it makes is
 * that this capability has no users of its own, and that the maker and the checker are
 * genuinely different people with different permissions. Mounting the module inside a host
 * removes it — the host's session is the only identity that matters then.
 *
 * Two plain form buttons, so it works without client JavaScript like everything else here.
 */
export function ActorSwitcher({ actor }: { actor: Actor }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="hidden sm:inline">Acting as</span>
      {[DEVELOPMENT_ACTOR, DEVELOPMENT_CHECKER].map((candidate) => {
        const active = candidate.id === actor.id;
        return (
          <form key={candidate.id} action={switchDevActor.bind(null, candidate.id)}>
            <button
              type="submit"
              aria-current={active ? 'true' : undefined}
              title={`${candidate.displayName} — can ${candidate.capabilities.join(', ')}`}
              className={
                active
                  ? 'rounded-full bg-foreground px-2.5 py-1 text-background'
                  : 'rounded-full border px-2.5 py-1 transition-colors hover:text-foreground'
              }
            >
              {candidate.displayName}
            </button>
          </form>
        );
      })}
    </div>
  );
}
