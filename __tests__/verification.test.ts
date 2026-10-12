import {
  canVerify,
  decideVerification,
} from '@/lib/platform/verification';
import { configureModule, resetModuleConfig } from '@/lib/platform/module-config';

/**
 * The maker-checker control.
 *
 * Two properties matter more than any individual rule. The control must be inert until a
 * host asks for it, because adding a gate to a working system uninvited is how a
 * capability becomes unmountable. And a maker must never be able to check their own work,
 * because that is not a weaker control — it is no control at all, dressed up with an
 * extra database column.
 */

afterEach(() => resetModuleConfig());

const input = (overrides: Partial<Parameters<typeof decideVerification>[0]> = {}) => ({
  amount: 5_000,
  automatic: false,
  draw: 0.99,
  ...overrides,
});

describe('when the host has not asked for it', () => {
  it('requires nothing at all', () => {
    // The default. A deployment that configures nothing gets exactly the behaviour
    // requirements.md describes.
    const decision = decideVerification(input({ amount: 10_000_000, automatic: true, draw: 0 }));

    expect(decision.required).toBe(false);
    expect(decision.trigger).toBe('NOT_REQUIRED');
  });
});

describe('risk-based selection', () => {
  beforeEach(() => {
    configureModule({
      makerChecker: {
        mode: 'POST_HOC',
        materialityThreshold: 100_000,
        sampleRate: 0.1,
        verifyAutoMatches: true,
      },
    });
  });

  it('always takes an attachment at or above the materiality threshold', () => {
    expect(decideVerification(input({ amount: 100_000, draw: 0.99 }))).toMatchObject({
      required: true,
      trigger: 'MATERIAL',
    });
  });

  it('lets a trivial amount through when it is not sampled', () => {
    expect(decideVerification(input({ amount: 99_999, draw: 0.99 }))).toMatchObject({
      required: false,
    });
  });

  it('takes an automatic match even when it is small', () => {
    // The real gap. A human confirmation has already had one pair of eyes on it; an
    // auto-match has had none, and in a working deployment it is most of the volume.
    expect(decideVerification(input({ amount: 100, automatic: true, draw: 0.99 }))).toMatchObject({
      required: true,
      trigger: 'AUTOMATIC',
    });
  });

  it('samples a share of everything else, so "small" is not a blind spot', () => {
    expect(decideVerification(input({ amount: 100, draw: 0.05 }))).toMatchObject({
      required: true,
      trigger: 'SAMPLED',
    });
    expect(decideVerification(input({ amount: 100, draw: 0.5 }))).toMatchObject({
      required: false,
    });
  });

  it('reports the strongest reason when several apply', () => {
    // The checker is told why this is on their desk; "sampled" would understate a
    // material automatic attachment and change how carefully they read it.
    expect(
      decideVerification(input({ amount: 500_000, automatic: true, draw: 0 })).trigger,
    ).toBe('MATERIAL');
  });

  it('can be configured to leave automatic matches alone', () => {
    configureModule({
      makerChecker: {
        mode: 'POST_HOC',
        materialityThreshold: 100_000,
        sampleRate: 0,
        verifyAutoMatches: false,
      },
    });

    expect(decideVerification(input({ amount: 100, automatic: true, draw: 0.99 })).required).toBe(
      false,
    );
  });

  it('gives every decision a reason a person can read', () => {
    for (const i of [
      input({ amount: 500_000 }),
      input({ automatic: true }),
      input({ draw: 0 }),
      input(),
    ]) {
      expect(decideVerification(i).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('segregation of duties', () => {
  it('refuses to let a maker sign off their own attachment', () => {
    // This is the whole control. Without it the second column records a second click by
    // the same person, which is not a control — it is paperwork.
    expect(canVerify({ verifierId: 'faisal', makerId: 'faisal' })).toMatchObject({
      allowed: false,
    });
    expect(canVerify({ verifierId: 'faisal', makerId: 'faisal' }).reason).toMatch(/someone else/i);
  });

  it('allows a different person', () => {
    expect(canVerify({ verifierId: 'controller', makerId: 'faisal' }).allowed).toBe(true);
  });

  it('allows anyone to check an automatic match', () => {
    // An auto-match has no human maker, so every checker is independent of it. Treating
    // the absent maker as "unknown, therefore refuse" would make the one category that
    // most needs checking the one category nobody can check.
    expect(canVerify({ verifierId: 'anyone', makerId: null }).allowed).toBe(true);
  });

  it('does not treat the system actor as a person', () => {
    expect(canVerify({ verifierId: 'system', makerId: 'system' }).allowed).toBe(false);
    expect(canVerify({ verifierId: 'controller', makerId: 'system' }).allowed).toBe(true);
  });
});
