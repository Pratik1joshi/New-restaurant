'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen, FlaskConical, ArrowUpRight } from 'lucide-react';

export default function WorkspaceHeader({ eyebrow, title, description, icon: Icon, actions, children }) {
  return (
    <header className="workspace-header border-b border-gray-200 bg-white px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          {Icon && <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-teal-100 bg-teal-50 text-teal-700"><Icon className="h-6 w-6" aria-hidden="true" /></span>}
          <div className="min-w-0">
            {eyebrow && <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-teal-700">{eyebrow}</p>}
            <h1 className="text-2xl font-semibold tracking-tight text-gray-950 sm:text-3xl">{title}</h1>
            {description && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-gray-500">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 xl:max-w-xl xl:justify-end">{actions}</div>}
      </div>
      {children && <div className="mt-5">{children}</div>}
    </header>
  );
}

export function RecipeWorkspaceNav({ active }) {
  const pathname = usePathname();
  const isKitchen = pathname?.startsWith('/kitchen');
  const base = isKitchen ? '/kitchen' : pathname?.startsWith('/cashier') ? '/cashier' : '/admin';
  return (
    <nav aria-label="Recipe studio" className="flex flex-wrap items-center gap-2">
      {[
        ['recipes', '/recipes', BookOpen, 'Recipe library'],
        ['consumption', '/kitchen-use', FlaskConical, 'Testing & internal use'],
      ].map(([id, path, Icon, label]) => (
        <Link key={id} href={`${base}${path}`} aria-current={active === id ? 'page' : undefined}
          className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-3.5 text-sm font-medium ${active === id ? 'bg-gray-900 text-white' : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}>
          <Icon className="h-4 w-4" aria-hidden="true" />{label}
        </Link>
      ))}
      {!isKitchen && <Link href={`${base}/reports?tab=ingredients`} className="ml-auto inline-flex min-h-10 items-center gap-1.5 text-xs font-medium text-teal-700 hover:underline">Ingredient usage<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>}
    </nav>
  );
}
