import test from 'node:test';
import assert from 'node:assert/strict';
import { readListParams, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../lib/paginate.js';

const pageSizeOf = (query) => readListParams(new URLSearchParams(query)).pageSize;

test('page size honours both spellings, so a caller is never silently cut to the default', () => {
  assert.equal(pageSizeOf('page_size=100'), 100);
  assert.equal(pageSizeOf('pageSize=100'), 100);
  assert.equal(pageSizeOf(''), DEFAULT_PAGE_SIZE);
  assert.equal(pageSizeOf('pageSize=99999'), MAX_PAGE_SIZE);
});

test('all=1 and export=1 both ask for the whole list', () => {
  assert.equal(readListParams(new URLSearchParams('all=1')).exportAll, true);
  assert.equal(readListParams(new URLSearchParams('export=1')).exportAll, true);
  assert.equal(readListParams(new URLSearchParams('')).exportAll, false);
});
