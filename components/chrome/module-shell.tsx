import { resolveActor } from '@/lib/platform/identity';
import { moduleConfig } from '@/lib/platform/module-config';
import { visibleNavItems } from '@/lib/platform/navigation';
import { getNavCounts } from '@/lib/platform/counts';
import { ModuleNav } from '@/components/chrome/module-nav';
import { ActorSwitcher } from '@/components/chrome/actor-switcher';

/**
 * The capability's chrome, resolved once and shared by every route that belongs to it.
 *
 * It is a component rather than only a layout because `/review` lives outside the module's
 * directory — requirements.md names that path, so it does not move — and it would
 * otherwise render without navigation. One screen reached two ways, looking like two
 * different products, was a large part of what made the journey feel inconsistent.
 */
export async function ModuleShell({ children }: { children: React.ReactNode }) {
  const actor = await resolveActor();
  const counts = await getNavCounts(actor);
  const config = moduleConfig();

  return (
    <div>
      <ModuleNav
        items={visibleNavItems(actor)}
        counts={counts}
        moduleName={config.moduleName}
        switcher={<ActorSwitcher actor={actor} />}
      />
      {children}
    </div>
  );
}
