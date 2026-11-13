'use client';

import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';

/**
 * Search box for a server-paged list. Typing stays local and is pushed up on a
 * pause, so the search runs against every page without a request per keystroke.
 */
export default function ListSearch({ value = '', onSearch, placeholder = 'Search…', className = '' }) {
  const [draft, setDraft] = useState(value);

  useEffect(() => { setDraft(value); }, [value]);

  useEffect(() => {
    if (draft === value) return undefined;
    const timer = setTimeout(() => onSearch(draft), 300);
    return () => clearTimeout(timer);
  }, [draft, value, onSearch]);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <input
        type="search"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-500 focus:border-transparent focus:ring-2 focus:ring-blue-500 ${className}`}
      />
    </div>
  );
}
