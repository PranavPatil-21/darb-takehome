import { configureModule, type MakerCheckerMode } from '@/lib/platform/module-config';

/**
 * Configuration from the environment.
 *
 * A mounted deployment calls `configureModule` directly from its own startup with its own
 * settings. This exists for the case where there is no host — running this repository on
 * its own — so the control posture can still be set without editing code, and so the
 * sample deployment can demonstrate maker-checker without that becoming the default for
 * everyone who mounts the module.
 *
 * Invalid values are ignored rather than thrown on. A typo in an environment variable
 * should not take a capability down at boot, and the safe reading of an unrecognised
 * control mode is the one that changes nothing.
 */

const MODES: readonly MakerCheckerMode[] = ['OFF', 'POST_HOC', 'BLOCKING'];

function parseMode(raw: string | undefined): MakerCheckerMode | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase() as MakerCheckerMode;
  return MODES.includes(upper) ? upper : null;
}

function parseNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

let applied = false;

export function applyEnvironmentConfig(): void {
  if (applied) return;
  applied = true;

  const mode = parseMode(process.env.DARB_MAKER_CHECKER);
  const threshold = parseNumber(process.env.DARB_MATERIALITY_THRESHOLD);
  const sampleRate = parseNumber(process.env.DARB_SAMPLE_RATE);
  const basePath = process.env.DARB_BASE_PATH?.trim();

  // Nothing is passed through unless it was actually set, so an unset variable leaves the
  // default in place rather than overwriting it with a parsed `undefined`.
  configureModule({
    ...(basePath ? { basePath } : {}),
    makerChecker: {
      ...(mode ? { mode } : {}),
      ...(threshold !== null ? { materialityThreshold: threshold } : {}),
      ...(sampleRate !== null ? { sampleRate: Math.min(sampleRate, 1) } : {}),
    } as never,
  });
}
