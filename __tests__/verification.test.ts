import {
  canVerify,
  decideVerification,
} from '@/lib/platform/verification';
import { configureModule, modulePath, resetModuleConfig } from '@/lib/platform/module-config';

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
    // docs/requirements.md describes.
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

describe('navigation follows the host configuration', () => {
  it('rebuilds links after the module is remounted at a different base path', async () => {
    const { configureModule, resetModuleConfig } = await import('@/lib/platform/module-config');
    const { visibleNavItems } = await import('@/lib/platform/navigation');
    const actor = {
      id: 'ops',
      displayName: 'Ops',
      capabilities: ['view', 'decide', 'verify', 'configure'] as const,
      clientIds: null,
    };

    try {
      configureModule({ basePath: '/compliance' });
      const hrefs = visibleNavItems({ ...actor, capabilities: [...actor.capabilities] }).map((i) => i.href);

      // The accessor claimed to rebuild per call so a host could mount this anywhere.
      // It copied an href computed once at import instead, so every link pointed at the
      // default mount no matter what the host asked for.
      expect(hrefs.every((href) => href.startsWith('/compliance'))).toBe(true);
    } finally {
      resetModuleConfig();
    }
  });
});

describe('module configuration refuses values it cannot honour', () => {
  it('falls back to the default rather than silently accepting an unsupported mode', async () => {
    // A blocking mode was declared, documented and accepted from the environment while
    // nothing implemented it. A compliance control that reports itself as configured and
    // then does something weaker is the one failure mode it must not have.
    const { resetModuleConfig, moduleConfig } = await import('@/lib/platform/module-config');
    const previous = process.env.DARB_MAKER_CHECKER;
    try {
      process.env.DARB_MAKER_CHECKER = 'BLOCKING';
      resetModuleConfig();
      // The documented default, whatever it is — the property under test is that an
      // unsupported value does not survive into the configuration.
      const { mode } = moduleConfig().makerChecker;
      expect(['OFF', 'POST_HOC']).toContain(mode);
    } finally {
      process.env.DARB_MAKER_CHECKER = previous;
      resetModuleConfig();
    }
  });

  it('does not read an empty threshold as zero', async () => {
    // `Number('')` is 0, which would make every attachment material.
    const { resetModuleConfig, moduleConfig } = await import('@/lib/platform/module-config');
    const previous = process.env.DARB_MATERIALITY_THRESHOLD;
    try {
      process.env.DARB_MATERIALITY_THRESHOLD = '';
      resetModuleConfig();
      expect(moduleConfig().makerChecker.materialityThreshold).toBeGreaterThan(0);
    } finally {
      process.env.DARB_MATERIALITY_THRESHOLD = previous;
      resetModuleConfig();
    }
  });
});

describe('the module mount is not a configurable lie', () => {
  it('ignores DARB_BASE_PATH, because the router serves a directory', () => {
    // Setting it rewrote every link while the App Router kept serving `app/vat/`, so the
    // whole product 404'd while reporting success. Verified live before the change:
    // `/receipts` and `/receipts/review` → 404, `/vat` → 200, and every nav href on the
    // page pointed at the 404s.
    const previous = process.env.DARB_BASE_PATH;
    try {
      process.env.DARB_BASE_PATH = '/receipts';
      resetModuleConfig();

      expect(modulePath()).toBe('/vat');
      expect(modulePath('review')).toBe('/vat/review');
    } finally {
      process.env.DARB_BASE_PATH = previous;
      resetModuleConfig();
    }
  });
});
