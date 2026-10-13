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
 * configures nothing gets exactly the system described in docs/requirements.md; the controls
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
  | 'POST_HOC';

/**
 * A blocking mode — nothing material stands until a second person signs it off — is
 * **deliberately not offered**, and that is worth recording rather than leaving as an
 * absence.
 *
 * It was declared here as `'BLOCKING'`, documented as a supported value, and accepted
 * from `DARB_MAKER_CHECKER` — while `decideVerification` branched only on `OFF`. An
 * organisation required to run blocking four-eyes would have set the variable, seen no
 * error, and got post-hoc sampling: the one failure mode a compliance control must not
 * have, because it reports itself as working.
 *
 * Building it properly is not a config flag. It needs an attachment to be held in a
 * pending state that the registers and the VAT position both exclude, a route for the
 * checker to release it, and a decision about what happens to a filing deadline while a
 * charge waits. Until that exists, the honest shape is for the value to be unconfigurable
 * — `fromEnvironment` now rejects anything outside the union and falls back to the
 * documented default.
 */

export interface ModuleConfig {
  /**
   * Where the capability is mounted. **Read-only — not configurable from the environment.**
   *
   * It used to be settable via `DARB_BASE_PATH`, documented as "where the capability is
   * mounted", and setting it bricked the product: `modulePath()` rewrote every link while
   * the App Router kept serving the literal `app/vat/` directory, so with
   * `DARB_BASE_PATH=/receipts` every nav href and the host page's own entry link returned
   * 404 while `/vat` still worked. A knob that reports success and makes the product
   * unreachable is worse than no knob.
   *
   * Moving the mount is a directory rename (`app/vat` → `app/<name>`) plus this constant,
   * or a rewrite rule in the host. Both are deliberate acts, which is the honest shape for
   * something the filesystem decides.
   *
   * `/review` is additionally served at the root regardless, because docs/requirements.md
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

let current: ModuleConfig | null = null;

/**
 * Called once by the host at startup. Takes precedence over the environment.
 */
export function configureModule(config: Partial<ModuleConfig>): void {
  current = {
    ...DEFAULT_MODULE_CONFIG,
    ...config,
    makerChecker: { ...DEFAULT_MODULE_CONFIG.makerChecker, ...config.makerChecker },
  };
}

export function resetModuleConfig(): void {
  current = null;
}

/**
 * Configuration from the environment, for the case where there is no host.
 *
 * Resolved lazily on first read rather than from an explicit bootstrap call, because the
 * capability is entered from several places — a page render, a webhook route, a server
 * action — and a bootstrap that each of them had to remember to call is a bootstrap that
 * one of them will not. That failure is silent and asymmetric: ingestion would decide
 * verification against the default while the screens read the configured value, and the
 * queue would simply be empty with nothing to indicate why.
 *
 * Invalid values are ignored rather than thrown on. A typo in an environment variable
 * should not take a capability down at boot, and the safe reading of an unrecognised
 * control mode is the one that changes nothing.
 */
function fromEnvironment(): ModuleConfig {
  // Narrowed by the guard, not asserted ahead of it. `as MakerCheckerMode` on the line
  // that *reads* the variable states the assumption before anything has checked it, which
  // is the pattern `lib/domain/enums.ts` exists to avoid.
  const rawMode = process.env.DARB_MAKER_CHECKER?.trim().toUpperCase();
  const mode = isMakerCheckerMode(rawMode) ? rawMode : DEFAULT_MODULE_CONFIG.makerChecker.mode;

  const num = (raw: string | undefined, fallback: number) => {
    // Shape-checked before conversion. `Number('')` is 0 and `Number('0x10')` is 16, so
    // an empty or malformed variable read as a *valid* number — and a materiality
    // threshold of 0 turns a targeted control into a blanket one, which is precisely the
    // design this module argues against. A decimal string, or the default.
    if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw.trim())) return fallback;
    const value = Number(raw.trim());
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };

  // `basePath` is deliberately absent here. See its declaration: the App Router serves a
  // filesystem directory, so rewriting the links without moving the routes only produces
  // 404s.
  return {
    ...DEFAULT_MODULE_CONFIG,
    makerChecker: {
      mode,
      materialityThreshold: num(
        process.env.DARB_MATERIALITY_THRESHOLD,
        DEFAULT_MODULE_CONFIG.makerChecker.materialityThreshold,
      ),
      sampleRate: Math.min(
        num(process.env.DARB_SAMPLE_RATE, DEFAULT_MODULE_CONFIG.makerChecker.sampleRate),
        1,
      ),
      verifyAutoMatches: DEFAULT_MODULE_CONFIG.makerChecker.verifyAutoMatches,
    },
  };
}

export function moduleConfig(): ModuleConfig {
  if (current === null) current = fromEnvironment();
  return current;
}

/** Builds a path inside the module, so no component hardcodes the mount point. */
const MAKER_CHECKER_MODES = ['OFF', 'POST_HOC'] as const;

/** Type guard, so the narrowing is the check rather than a claim about it. */
function isMakerCheckerMode(value: string | undefined): value is MakerCheckerMode {
  return value !== undefined && (MAKER_CHECKER_MODES as readonly string[]).includes(value);
}

export function modulePath(...segments: string[]): string {
  const base = moduleConfig().basePath.replace(/\/$/, '');
  if (segments.length === 0) return base || '/';
  return `${base}/${segments.map((s) => String(s).replace(/^\//, '')).join('/')}`;
}
