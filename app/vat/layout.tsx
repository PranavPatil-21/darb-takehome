import { ModuleShell } from '@/components/chrome/module-shell';

/** Every route under the module's base path gets the capability's chrome. */
export const dynamic = 'force-dynamic';

export default function VatModuleLayout({ children }: { children: React.ReactNode }) {
  return <ModuleShell>{children}</ModuleShell>;
}
