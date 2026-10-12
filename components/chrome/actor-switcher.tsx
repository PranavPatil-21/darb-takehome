import { switchDevActor } from '@/lib/actions/dev-actor';
import {
  DEVELOPMENT_ACTOR,
  DEVELOPMENT_CHECKER,
  ROLE_SUMMARY,
  type Actor,
} from '@/lib/platform/identity';

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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {/* The role's job, stated rather than implied. Two names in a corner tell a reader
          nothing; the difference between them is the whole point of there being two. */}
      <span className="order-last w-full sm:order-none sm:w-auto sm:max-w-sm sm:text-right">
        {ROLE_SUMMARY[actor.id]}
      </span>
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
