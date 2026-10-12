/**
 * Who is acting, and what they are allowed to do.
 *
 * This module is the seam between the matching capability and whatever application it is
 * mounted inside. The capability needs an actor for three reasons — to stamp decisions
 * for the audit trail, to decide which client's data is in scope, and to enforce
 * segregation of duties — and it must get all three from the host rather than growing its
 * own login, because the host already has one.
 *
 * Today there is no host and no authentication, so `resolveActor` returns a development
 * identity. That is deliberate and visible rather than hidden: the brief does not ask for
 * auth, the rest of the system is written as though the actor were real, and swapping in
 * `await auth()` from the host is a change to this one function.
 *
 * Nothing downstream may read a session, a header or a cookie directly. If it does, the
 * module stops being mountable.
 */

import { roleSummary } from '@/lib/content/messages';

/**
 * What a person may do inside this capability.
 *
 * Deliberately a small, closed set tied to the controls that exist rather than a generic
 * permission string. `verify` is separate from `decide` because that separation is the
 * whole point of a maker-checker control: the person who attached a receipt must not be
 * the person who signs it off.
 */
export type Capability =
  /** See documents, charges and the audit trail. */
  | 'view'
  /** Attach a document to a charge, or reject a candidate. The maker's act. */
  | 'decide'
  /** Sign off somebody else's decision. The checker's act. */
  | 'verify'
  /** Change thresholds and control settings. */
  | 'configure';

export interface Actor {
  /** Stable identifier, written to the audit trail. Never a display name. */
  id: string;
  /** Shown in the interface. */
  displayName: string;
  capabilities: readonly Capability[];
  /**
   * Which clients this actor may see. `null` means every client — a Darb operator rather
   * than a customer. An empty array means none, which is a valid and safe state.
   */
  clientIds: readonly number[] | null;
}

/**
 * Two roles, and the difference between them is a hierarchy rather than a split.
 *
 * This went through two wrong shapes before this one, and both are worth recording.
 *
 * First the two roles held *disjoint* powers — one could only attach, the other only sign
 * off. That made the person accountable for the VAT filing unable to do the product's main
 * job, and it implied that the capability check was the control, when the only thing
 * preventing self-approval is `canVerify` comparing two identities on one attachment.
 *
 * Then both roles held *identical* powers. That fixed the hierarchy and destroyed the
 * distinction: switching between them changed nothing anybody could see, which is a
 * perfectly correct model of a product that does not need two roles.
 *
 * The shape that is actually true of a finance team is a superset. A clerk works the
 * queue. A controller works the same queue *and* signs off other people's attachments
 * *and* sets the thresholds. Everything the clerk can do, the controller can also do —
 * which is why the queue is not hidden from either of them — and the controller holds two
 * powers on top.
 *
 * Segregation of duties then does the remaining work, per attachment rather than per
 * person: a controller who attached a receipt still cannot be the one who signs it off.
 * That is the sentence the interface has to make visible, and it is why both mechanisms
 * exist rather than one.
 */

/** The clerk. Works the review queue; cannot sign off anybody's work, including their own. */
export const DEVELOPMENT_ACTOR: Actor = {
  id: 'reviewer',
  displayName: 'Faisal · Reviewer',
  capabilities: ['view', 'decide'],
  clientIds: null,
};

/** The supervisor. Everything the reviewer can do, plus sign-off and configuration. */
export const DEVELOPMENT_CHECKER: Actor = {
  id: 'controller',
  displayName: 'Layla · Controller',
  capabilities: ['view', 'decide', 'verify', 'configure'],
  clientIds: null,
};


let hostResolver: (() => Promise<Actor>) | null = null;

/**
 * Mount point for the host application.
 *
 * The host calls this once at startup with its own session reader. Everything else in the
 * capability goes through `resolveActor`, so this single call is the whole identity
 * integration.
 */
export function setActorResolver(resolver: () => Promise<Actor>): void {
  hostResolver = resolver;
}

/** Test seam, mirroring `setExtractor` and `setMediaStore` elsewhere in the codebase. */
export function resetActorResolver(): void {
  hostResolver = null;
}

/**
 * The cookie the development switcher sets.
 *
 * It exists so the segregation-of-duties control can actually be exercised without an
 * authentication system: the two development identities hold disjoint capabilities, and
 * without a way to move between them the checker's queue is permanently unreachable and
 * the control is only a claim. A mounted host supplies a real resolver and this is never
 * consulted.
 */
export const DEV_ACTOR_COOKIE = 'darb_dev_actor';

export function developmentActorFor(cookieValue: string | undefined): Actor {
  return cookieValue === DEVELOPMENT_CHECKER.id ? DEVELOPMENT_CHECKER : DEVELOPMENT_ACTOR;
}

export async function resolveActor(): Promise<Actor> {
  if (hostResolver) return hostResolver();

  // Reading the cookie here rather than in each page keeps the rule that nothing
  // downstream touches a request directly. The import is dynamic because `next/headers`
  // is only available inside a request scope, and this module is also used from tests and
  // from the ingestion pipeline, where there is no request at all.
  try {
    const { cookies } = await import('next/headers');
    const store = await cookies();
    return developmentActorFor(store.get(DEV_ACTOR_COOKIE)?.value);
  } catch {
    return DEVELOPMENT_ACTOR;
  }
}

export function can(actor: Actor, capability: Capability): boolean {
  return actor.capabilities.includes(capability);
}

/**
 * Whether this actor may see this client's data.
 *
 * Written as a predicate taking the actor rather than a check inside each query, so the
 * callers that build queries can fold it into a `WHERE` clause — scoping that returns
 * nothing is safer than scoping that throws after the rows have been read.
 */
export function canSeeClient(actor: Actor, clientId: number | null): boolean {
  if (actor.clientIds === null) return true;
  if (clientId === null) return false;
  return actor.clientIds.includes(clientId);
}

/**
 * The `WHERE` fragment that limits a query to what this actor may see.
 *
 * Returns an empty object for an unrestricted actor so it can be spread into any Prisma
 * filter unconditionally. The point is that a caller cannot forget the check and still
 * compile a sensible query — the fragment is always spread, and it is this function that
 * decides whether it constrains anything.
 */
export function clientScopeFilter(actor: Actor): { clientId?: { in: number[] } } {
  if (actor.clientIds === null) return {};
  return { clientId: { in: [...actor.clientIds] } };
}

/**
 * One line describing what each role is for, from the content layer.
 *
 * A capability list tells a person what the system will let them press. It does not tell
 * them why the two roles exist, which is the question somebody meeting the module for the
 * first time actually has.
 */
export const ROLE_SUMMARY: Readonly<Record<string, string>> = {
  get reviewer() { return roleSummary('reviewer'); },
  get controller() { return roleSummary('controller'); },
};
