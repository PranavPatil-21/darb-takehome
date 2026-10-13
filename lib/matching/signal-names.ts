/**
 * The signals the matching engine scores.
 *
 * Separated from `scoring-config.ts` so the domain layer can name a signal without
 * importing the engine's weights — `lib/domain/enums.ts` needs the key set to type the
 * stored breakdown, and nothing else about how those keys are weighted.
 */
export const SIGNAL_NAMES = ['amount', 'cardLast4', 'merchant', 'date'] as const;

export type SignalName = (typeof SIGNAL_NAMES)[number];
