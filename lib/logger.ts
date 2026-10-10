type Meta = Record<string, unknown>;

/**
 * Minimal structured logger, per the brief's boilerplate.
 *
 * Deliberately not a logging framework: the point is that every pipeline decision leaves
 * a greppable trace with the document id attached, which is what makes a stuck document
 * diagnosable in production.
 */
export const log = {
  info: (message: string, meta?: Meta) => console.log(`[INFO] ${message}`, meta ?? ''),
  warn: (message: string, meta?: Meta) => console.warn(`[WARN] ${message}`, meta ?? ''),
  error: (message: string, meta?: Meta) => console.error(`[ERROR] ${message}`, meta ?? ''),
};
