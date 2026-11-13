'use client';

/**
 * Client half of the pagination contract in lib/paginate.js.
 *
 * Holds the page / page size / sort / search state for one list screen, keeps
 * it in sync with the endpoint, and hands <DataGrid server={…}> exactly the
 * shape it wants — so no page has to hand-roll query-string plumbing.
 *
 * `fetchAll` is the export path. It reruns the same query with `export=1`, so a
 * download contains every row matching the current filters rather than the page
 * that happens to be on screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiJson } from '@/lib/authed-fetch';

const EMPTY_PAGINATION = { page: 1, page_size: 50, total: 0, total_pages: 1, has_more: false };

export default function useServerList({
  url,
  key,
  filters,
  initialSort = { key: null, dir: 'desc' },
  initialPageSize = 50,
  enabled = true,
  onError,
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [sort, setSort] = useState(initialSort);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [extra, setExtra] = useState({});
  const [pagination, setPagination] = useState({ ...EMPTY_PAGINATION, page_size: initialPageSize });
  const [loading, setLoading] = useState(true);

  // Filters arrive as a fresh object each render; compare by value so a parent
  // re-render does not refetch on its own.
  const filterKey = JSON.stringify(filters || {});
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Only the latest request may paint: a slow earlier search must not overwrite it.
  const latestRequest = useRef(0);

  const buildQuery = useCallback(
    (overrides = {}) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(JSON.parse(filterKey))) {
        if (v !== '' && v !== null && v !== undefined && v !== 'all') params.set(k, String(v));
      }
      if (search) params.set('search', search);
      if (sort.key) {
        params.set('sort', sort.key);
        params.set('dir', sort.dir);
      }
      if (overrides.exportAll) {
        params.set('export', '1');
      } else {
        params.set('page', String(overrides.page ?? page));
        params.set('page_size', String(overrides.pageSize ?? pageSize));
      }
      return params.toString();
    },
    [filterKey, search, sort, page, pageSize]
  );

  const load = useCallback(async () => {
    if (!enabled) return;
    const request = ++latestRequest.current;
    setLoading(true);
    try {
      const { [key]: list, pagination: meta, ...rest } = await apiJson(`${url}?${buildQuery()}`);
      if (request !== latestRequest.current) return;
      setRows(list || []);
      setExtra(rest);
      setPagination(meta || { ...EMPTY_PAGINATION, page_size: pageSize });
      // Deleting the last row of the last page would otherwise strand the screen on an empty page.
      if (!list?.length && page > 1 && Number(meta?.total) > 0) setPage(Number(meta.total_pages) || 1);
    } catch (error) {
      if (request !== latestRequest.current) return;
      onErrorRef.current?.(error);
      setRows([]);
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }, [url, key, buildQuery, page, pageSize, enabled]);

  useEffect(() => {
    load();
  }, [load]);

  // A filter or search change invalidates the current page number.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setPage(1);
  }, [filterKey, search]);

  /** Every row matching the current filters, ignoring pagination. */
  const fetchAll = useCallback(async () => {
    const body = await apiJson(`${url}?${buildQuery({ exportAll: true })}`);
    return body[key] || [];
  }, [url, key, buildQuery]);

  const onChange = useCallback((patch) => {
    if (patch.sort !== undefined) setSort(patch.sort);
    if (patch.search !== undefined) setSearch(patch.search);
    if (patch.pageSize !== undefined) setPageSize(patch.pageSize);
    if (patch.page !== undefined) setPage(patch.page);
  }, []);

  const server = useMemo(
    () => ({ pagination, sort, search, loading, onChange, fetchAll }),
    [pagination, sort, search, loading, onChange, fetchAll]
  );

  /** Props for <PaginationControls>, for screens that are not a <DataGrid>. */
  const pager = useMemo(
    () => ({
      pagination,
      loading,
      onPageChange: (next) => onChange({ page: next }),
      onPageSizeChange: (size) => onChange({ pageSize: size, page: 1 }),
    }),
    [pagination, loading, onChange]
  );

  const updateSearch = useCallback((term) => onChange({ search: term, page: 1 }), [onChange]);

  return { rows, extra, pagination, loading, server, pager, reload: load, fetchAll, search, setSearch: updateSearch, sort };
}
