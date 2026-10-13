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
    <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
      {/* The role's job, stated rather than implied — but as a tooltip, not as a sentence
          competing with the brand for the top bar. It used to run across the header and
          was the main reason that row read as cluttered. */}
      <span className="hidden lg:inline" title={ROLE_SUMMARY[actor.id]}>
        Acting as
      </span>

      {/* One segmented control, not two loose pills. The two identities are mutually
          exclusive, and a segmented control is the shape that says so. */}
      <div className="flex items-center rounded-lg border bg-surface-sunken p-0.5">
        {[DEVELOPMENT_ACTOR, DEVELOPMENT_CHECKER].map((candidate) => {
          const active = candidate.id === actor.id;
          return (
            <form key={candidate.id} action={switchDevActor.bind(null, candidate.id)}>
              <button
                type="submit"
                aria-current={active ? 'true' : undefined}
                title={`${candidate.displayName} — ${ROLE_SUMMARY[candidate.id]}`}
                className={
                  active
                    ? 'rounded-md bg-card px-2.5 py-1 font-medium text-foreground shadow-xs ring-1 ring-border/60'
                    : 'rounded-md px-2.5 py-1 transition-colors hover:text-foreground'
                }
              >
                {candidate.displayName}
              </button>
            </form>
          );
        })}
      </div>
    </div>
  );
}
