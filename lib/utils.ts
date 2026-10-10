import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges Tailwind class names, resolving conflicts in favour of the later class.
 *
 * This is the implementation the brief specifies. The shadcn CLI's current preset wires
 * its components to a third-party `cn` package instead; those imports are redirected here
 * so the UI has one fewer dependency and `components.json`'s own `utils` alias is honest.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
