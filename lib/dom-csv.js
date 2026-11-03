import { toCsv } from '@/lib/csv';

/**
 * Turn what a report page shows into CSV rows, in reading order: headings
 * become section rows, <table>s become their rows, <dl>s become label/value
 * pairs, and any element marked `data-csv-row` becomes one row of its
 * children's text. Controls, charts and `data-csv-skip` subtrees are ignored.
 *
 * ponytail: reads the rendered page, so a server-paged table exports only the
 * page on screen; such tables already carry their own full CSV button.
 */
const SKIP = new Set(['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA', 'SCRIPT', 'STYLE', 'svg', 'SVG', 'NAV', 'FORM']);
const text = (el) => (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();

// ponytail: "label … value" rows are spotted by the Tailwind justify-between
// class the cards use; mark odd layouts with data-csv-row instead.
function isLabelValueRow(el) {
  if (!el.classList?.contains('justify-between')) return false;
  if (el.querySelector('table, dl, h1, h2, h3, h4, [data-csv-row], .justify-between')) return false;
  const cells = [...el.children].filter((child) => !SKIP.has(child.tagName) && text(child));
  return cells.length >= 2;
}

export function elementCsvRows(root) {
  const rows = [];
  const walk = (node) => {
    for (const el of node.children) {
      if (SKIP.has(el.tagName) || el.hasAttribute('data-csv-skip') || el.getAttribute('aria-hidden') === 'true') continue;
      if (/^H[1-4]$/.test(el.tagName)) {
        if (rows.length) rows.push([]);
        rows.push([text(el)]);
      } else if (el.tagName === 'TABLE') {
        for (const tr of el.rows) rows.push([...tr.cells].map(text));
      } else if (el.tagName === 'DL') {
        let pending = null;
        for (const child of el.querySelectorAll('dt, dd')) {
          if (child.tagName === 'DT') pending = text(child);
          else { rows.push([pending ?? '', text(child)]); pending = null; }
        }
      } else if (el.hasAttribute('data-csv-row')) {
        rows.push([...el.children].map(text));
      } else if (isLabelValueRow(el)) {
        rows.push([...el.children].filter((child) => !SKIP.has(child.tagName)).map(text).filter(Boolean));
      } else {
        walk(el);
      }
    }
  };
  walk(root);
  return rows.filter((row, i) => row.some(Boolean) || (i > 0 && rows[i - 1].length));
}

export function downloadElementCsv(root, name = 'report') {
  if (!root) return;
  const rows = elementCsvRows(root);
  const width = Math.max(1, ...rows.map((row) => row.length));
  const headers = Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const body = rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i] ?? ''])));
  // The first line names the export instead of generic "Column N" headers;
  // the real headings sit inside each section. toCsv adds BOM + CRLF for Excel.
  const lines = toCsv(headers, body).split('\r\n');
  lines[0] = `﻿"${String(name).replace(/"/g, '""')}"`;
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[^\w.-]+/g, '-').toLowerCase()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
