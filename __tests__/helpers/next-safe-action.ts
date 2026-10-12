import type { z } from 'zod';

/**
 * A stand-in for `next-safe-action`, used only under Jest.
 *
 * The real package is ESM-only and ts-jest's CommonJS transform cannot load it, which is
 * why the review tests historically mirrored the action bodies rather than calling them.
 * Mirroring tests a re-implementation: it passes happily while the real action does
 * something else entirely.
 *
 * This double replaces the dispatcher, not the action. It applies the same Zod schema the
 * action declares and then calls the action's own body, so what the tests exercise is the
 * production code path. What it deliberately does not reproduce is next-safe-action's
 * own behaviour — middleware, `validationErrors` shaping, serialisation. Those belong to
 * the library and are not this project's to assert.
 */

interface ActionDefinition<TOutput> {
  (input: unknown): Promise<TOutput | { serverError: string }>;
}

export function createSafeActionClient(options: {
  handleServerError(error: Error): string;
}) {
  return {
    schema<TSchema extends z.ZodTypeAny>(schema: TSchema) {
      return {
        action<TOutput>(
          handler: (args: { parsedInput: z.infer<TSchema> }) => Promise<TOutput>,
        ): ActionDefinition<TOutput> {
          return async (input: unknown) => {
            // Schema failures surface as a throw here rather than as the library's
            // `validationErrors` envelope. Tests that care about a rejected input assert
            // the throw; no test should assert the envelope, which is library behaviour.
            const parsedInput = schema.parse(input) as z.infer<TSchema>;
            try {
              return await handler({ parsedInput });
            } catch (error) {
              return { serverError: options.handleServerError(error as Error) };
            }
          };
        },
      };
    },
  };
}
