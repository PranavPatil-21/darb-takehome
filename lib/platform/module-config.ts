/**
 * How the host application configures this capability.
 *
 * A feature that other teams mount has to be configurable without being forked, and the
 * surface has to be small enough that a host can reason about it. Everything here is a
 * decision a deploying organisation genuinely makes differently — a base path, a control
 * posture, a materiality threshold — and nothing here is a decision this capability should
 * be making on their behalf.
 *
 * Every default reproduces the behaviour the brief specifies. A host that mounts this and
 * configures nothing gets exactly the system described in requirements.md; the controls
 * below are opt-in, which is the only honest way to add a control to something that
 * already works.
 */

export type MakerCheckerMode =
  /** No second pair of eyes. The brief's behaviour, and the default. */
  | 'OFF'
  /**
   * Attachments stand immediately and are sampled for sign-off afterwards. The control a
   * team can actually staff: it does not slow the queue, and it still produces evidence
   * that somebody independent looked.
   */
  | 'POST_HOC'
  /**
   * Nothing above the materiality threshold stands until a second person signs it off.
   * Stronger, and expensive — it puts a human round-trip in front of money that is
   * already spent. Offered because some organisations are required to run it, not
   * because it is usually the right trade.
   */
  | 'BLOCKING';

export interface ModuleConfig {
  /**
   * Where the capability is mounted. The host owns every other path.
   *
   * `/review` is additionally served at the root regardless, because requirements.md
   * names that path and the contract does not move just because the module gained a home.
   */
  basePath: string;

  /** Shown in the module's own navigation, so it reads as part of the host product. */
  moduleName: string;

  makerChecker: {
    mode: MakerCheckerMode;

    /**
     * Minor units. Attachments at or above this are treated as material.
     *
     * Risk-based rather than blanket, because a control applied to everything is a
     * control applied to nothing: a queue that doubles in length gets switched off, and
     * then the large attachments are unverified along with the small ones. Defaults to
     * SAR 1,000.
     */
    materialityThreshold: number;

    /**
     * Share of immaterial attachments sampled for sign-off, 0..1.
     *
     * Sampling below the threshold exists so that "under a thousand riyals" does not
     * become a known blind spot. Defaults to one in ten.
     */
    sampleRate: number;

    /**
     * Whether an automatic match may be signed off by the person who would otherwise
     * never see it. Auto-matches are the real gap in this product — the machine is the
     * maker and, without this, nobody is ever the checker.
     */
    verifyAutoMatches: boolean;
  };
}

export const DEFAULT_MODULE_CONFIG: ModuleConfig = {
  basePath: '/vat',
  moduleName: 'VAT receipts',
  makerChecker: {
    // OFF by default: adding a control to a working system without being asked is how a
    // capability becomes unmountable. The host turns it on.
    mode: 'OFF',
    materialityThreshold: 100_000,
    sampleRate: 0.1,
    verifyAutoMatches: true,
  },
};

let current: ModuleConfig = DEFAULT_MODULE_CONFIG;

/** Called once by the host at startup. */
export function configureModule(config: Partial<ModuleConfig>): void {
  current = {
    ...DEFAULT_MODULE_CONFIG,
    ...config,
    makerChecker: { ...DEFAULT_MODULE_CONFIG.makerChecker, ...config.makerChecker },
  };
}

export function resetModuleConfig(): void {
  current = DEFAULT_MODULE_CONFIG;
}

export function moduleConfig(): ModuleConfig {
  return current;
}

/** Builds a path inside the module, so no component hardcodes the mount point. */
export function modulePath(...segments: string[]): string {
  const base = moduleConfig().basePath.replace(/\/$/, '');
  if (segments.length === 0) return base || '/';
  return `${base}/${segments.map((s) => String(s).replace(/^\//, '')).join('/')}`;
}
