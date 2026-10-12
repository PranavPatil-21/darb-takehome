import { resolveActor } from '@/lib/platform/identity';
import { moduleConfig } from '@/lib/platform/module-config';
import { visibleNavItems } from '@/lib/platform/navigation';
import { getNavCounts } from '@/lib/platform/counts';
import { ModuleNav } from '@/components/chrome/module-nav';

/**
 * The module shell.
 *
 * Everything the capability needs from the outside world is resolved once, here: who is
 * acting, what they may do, and what is waiting for them. Pages below receive nothing
 * implicitly — they resolve the actor themselves where they need it — but the navigation
 * is assembled in one place so a host mounting this at a different base path, or with a
 * restricted user, gets a coherent shell without touching a page.
 *
 * Deliberately not a global layout. The host owns the window; this owns a strip and the
 * content beneath it.
 */

export const dynamic = 'force-dynamic';

export default async function VatModuleLayout({ children }: { children: React.ReactNode }) {
  const actor = await resolveActor();
  const [counts, config] = await Promise.all([getNavCounts(actor), Promise.resolve(moduleConfig())]);

  return (
    <div>
      <ModuleNav
        items={visibleNavItems(actor)}
        counts={counts}
        moduleName={config.moduleName}
      />
      {children}
    </div>
  );
}
