import {
  can,
  canSeeClient,
  clientScopeFilter,
  DEVELOPMENT_ACTOR,
  DEVELOPMENT_CHECKER,
  resetActorResolver,
  resolveActor,
  setActorResolver,
  ROLE_SUMMARY,
  type Actor,
} from '@/lib/platform/identity';
import { canVerify } from '@/lib/platform/verification';

/**
 * The seam between this capability and whatever application mounts it.
 *
 * These tests are about a boundary rather than a feature, and the thing they protect is
 * that the boundary stays narrow: one resolver, injected once, and scoping expressed as a
 * query fragment that a caller cannot silently omit. A capability that reads a session
 * directly somewhere deep in a page is no longer mountable, and that regression is
 * invisible until somebody tries.
 */

afterEach(() => resetActorResolver());

const actor = (overrides: Partial<Actor> = {}): Actor => ({
  id: 'u1',
  displayName: 'Test User',
  capabilities: ['view'],
  clientIds: null,
  ...overrides,
});

describe('resolving the actor', () => {
  it('falls back to a development identity when no host has mounted it', async () => {
    expect(await resolveActor()).toEqual(DEVELOPMENT_ACTOR);
  });

  it('uses the host resolver once one is supplied', async () => {
    const hostUser = actor({ id: 'host-42', displayName: 'Layla' });
    setActorResolver(async () => hostUser);

    expect(await resolveActor()).toEqual(hostUser);
  });

  it('makes the controller a superset of the reviewer, not a different half', async () => {
    // Two earlier shapes were wrong. Disjoint powers made the person accountable for the
    // filing unable to attach a receipt. Identical powers removed the distinction
    // entirely, so switching role changed nothing anybody could see. A finance team is a
    // hierarchy: a clerk works the queue, a controller works the same queue and also signs
    // off and configures.
    for (const capability of DEVELOPMENT_ACTOR.capabilities) {
      expect(can(DEVELOPMENT_CHECKER, capability)).toBe(true);
    }

    expect(can(DEVELOPMENT_ACTOR, 'decide')).toBe(true);
    expect(can(DEVELOPMENT_CHECKER, 'decide')).toBe(true);
  });

  it('gives only the controller the two supervisory powers', async () => {
    expect(can(DEVELOPMENT_ACTOR, 'verify')).toBe(false);
    expect(can(DEVELOPMENT_ACTOR, 'configure')).toBe(false);
    expect(can(DEVELOPMENT_CHECKER, 'verify')).toBe(true);
    expect(can(DEVELOPMENT_CHECKER, 'configure')).toBe(true);
  });

  it('describes what each role is for, in words the interface can show', async () => {
    // Two names in a corner tell a reader nothing. The difference between them is the
    // reason there are two, so it is stated rather than implied.
    for (const actorId of [DEVELOPMENT_ACTOR.id, DEVELOPMENT_CHECKER.id]) {
      expect(ROLE_SUMMARY[actorId]).toBeTruthy();
    }
    expect(ROLE_SUMMARY[DEVELOPMENT_ACTOR.id]).toMatch(/cannot sign off/i);
  });

  it('still refuses a controller signing off their own attachment', async () => {
    // The hierarchy is not the control. Holding `verify` lets Layla sign off other
    // people's work; it does not let her approve her own, and that rule is per attachment.
    expect(canVerify({ verifierId: 'controller', makerId: 'controller' }).allowed).toBe(false);
    expect(canVerify({ verifierId: 'controller', makerId: 'reviewer' }).allowed).toBe(true);
  });
});

describe('client scoping', () => {
  it('lets an unrestricted actor see every client', () => {
    const operator = actor({ clientIds: null });

    expect(canSeeClient(operator, 1)).toBe(true);
    expect(canSeeClient(operator, 99)).toBe(true);
    expect(clientScopeFilter(operator)).toEqual({});
  });

  it('limits a restricted actor to their own clients', () => {
    const customer = actor({ clientIds: [1] });

    expect(canSeeClient(customer, 1)).toBe(true);
    expect(canSeeClient(customer, 2)).toBe(false);
    expect(clientScopeFilter(customer)).toEqual({ clientId: { in: [1] } });
  });

  it('treats an actor with no clients as seeing nothing, not everything', () => {
    // The dangerous reading of an empty list is "no constraint". A filter that widens
    // when the permission set is empty is how a tenancy leak happens.
    const nobody = actor({ clientIds: [] });

    expect(canSeeClient(nobody, 1)).toBe(false);
    expect(clientScopeFilter(nobody)).toEqual({ clientId: { in: [] } });
  });

  it('refuses an unscopeable row to a restricted actor', () => {
    // A document from an unrecognised sender carries no client. An operator may triage
    // it; a customer must not see another fleet's stray receipt.
    expect(canSeeClient(actor({ clientIds: [1] }), null)).toBe(false);
    expect(canSeeClient(actor({ clientIds: null }), null)).toBe(true);
  });

  it('produces a filter that is always safe to spread into a query', () => {
    // The caller spreads this unconditionally; this function decides whether it
    // constrains. That is what stops a query forgetting the check and still compiling.
    for (const a of [actor({ clientIds: null }), actor({ clientIds: [1, 2] }), actor({ clientIds: [] })]) {
      const filter = clientScopeFilter(a);
      expect(typeof filter).toBe('object');
      expect(Array.isArray(filter)).toBe(false);
    }
  });
});
