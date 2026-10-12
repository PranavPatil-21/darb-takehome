import { ModuleShell } from '@/components/chrome/module-shell';

/**
 * `/review` is the path requirements.md names, so it stays where it is — but it is the
 * same screen as the module's queue and must not look like a different product when
 * reached directly. Same chrome, same navigation, same place in the journey.
 */
export const dynamic = 'force-dynamic';

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return <ModuleShell>{children}</ModuleShell>;
}
