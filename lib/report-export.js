import { toCsv } from '@/lib/csv.js';

export const reportLabel = (key) => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (s) => s.toUpperCase());
const xml = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** Values stay numeric in Excel; null means unavailable, never a made-up zero. */
export function reportWorkbook(title, sections, metadata = []) {
  const used = new Set();
  const sheets = sections.map((section, index) => {
    let name = String(section.title || `Report ${index + 1}`).replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31);
    if (used.has(name)) name = `${name.slice(0, 26)} ${index + 1}`;
    used.add(name);
    const cell = (value, style = '', merge = 0) => `<Cell${style ? ` ss:StyleID="${style}"` : ''}${merge ? ` ss:MergeAcross="${merge}"` : ''}><Data ss:Type="${typeof value === 'number' && Number.isFinite(value) ? 'Number' : 'String'}">${xml(value)}</Data></Cell>`;
    const columns = section.columns;
    const row = (record, i) => `<Row ss:AutoFitHeight="1">${columns.map((c) => cell(record[c.key], Object.values(record).includes('TOTAL') ? 'Total' : c.type === 'currency' ? (i % 2 ? 'MoneyAlt' : 'Money') : (i % 2 ? 'Alt' : 'Body'))).join('')}</Row>`;
    return `<Worksheet ss:Name="${xml(name)}"><Table>${columns.map((c, i) => `<Column ss:Width="${c.type === 'currency' ? 110 : i === 0 ? 200 : 145}"/>`).join('')}<Row ss:Height="32">${cell(title, 'Title', Math.max(1, columns.length - 1))}</Row><Row ss:Height="24">${cell(section.title, 'Subtitle', Math.max(1, columns.length - 1))}</Row>${metadata.map(([label, value]) => `<Row>${cell(label, 'Meta')}${cell(value, 'Meta')}</Row>`).join('')}<Row/><Row ss:Height="28">${columns.map((c) => cell(c.label, 'Header')).join('')}</Row>${section.rows.map(row).join('')}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>${metadata.length + 4}</SplitHorizontal><TopRowBottomPane>${metadata.length + 4}</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions></Worksheet>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel"><Styles><Style ss:ID="Default"><Alignment ss:Vertical="Top" ss:WrapText="1"/><Font ss:FontName="Calibri" ss:Size="11"/></Style><Style ss:ID="Title"><Font ss:Size="18" ss:Bold="1" ss:Color="#0F172A"/></Style><Style ss:ID="Subtitle"><Font ss:Size="13" ss:Bold="1" ss:Color="#334155"/></Style><Style ss:ID="Meta"><Font ss:Color="#64748B"/></Style><Style ss:ID="Header"><Interior ss:Color="#0F172A" ss:Pattern="Solid"/><Font ss:Bold="1" ss:Color="#FFFFFF"/></Style><Style ss:ID="Body"/><Style ss:ID="Alt"><Interior ss:Color="#F1F5F9" ss:Pattern="Solid"/></Style><Style ss:ID="Money" ss:Parent="Body"><NumberFormat ss:Format="#,##0.00;[Red](#,##0.00)"/></Style><Style ss:ID="MoneyAlt" ss:Parent="Alt"><NumberFormat ss:Format="#,##0.00;[Red](#,##0.00)"/></Style><Style ss:ID="Total"><Font ss:Bold="1"/><Interior ss:Color="#E2E8F0" ss:Pattern="Solid"/><NumberFormat ss:Format="#,##0.00;[Red](#,##0.00)"/></Style></Styles>${sheets.join('')}</Workbook>`;
}

export function reportCsv(title, sections, metadata = []) {
  const rows = [[title], ...metadata, []];
  for (const section of sections) {
    rows.push([section.title], section.columns.map((c) => c.label));
    for (const record of section.rows) rows.push(section.columns.map((c) => record[c.key] ?? ''));
    rows.push([]);
  }
  const keys = Array.from({ length: rows.reduce((width, row) => Math.max(width, row.length), 1) }, (_, i) => String(i));
  // Section headings provide the actual labels. Avoid generic Column 1 headers.
  return toCsv(keys, rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])))).split('\r\n').slice(1).join('\r\n').replace(/^/, '\uFEFF');
}

export function downloadReport(name, format, title, sections, metadata = []) {
  const body = format === 'excel' ? reportWorkbook(title, sections, metadata) : reportCsv(title, sections, metadata);
  const url = URL.createObjectURL(new Blob([body], { type: format === 'excel' ? 'application/vnd.ms-excel;charset=utf-8' : 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.${format === 'excel' ? 'xls' : 'csv'}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Export the actual dashboard response, including metrics outside visible tables. */
export function analyticsSections(data, transactions) {
  const sections = [];
  const ignored = /^(?:_|range$|previousRange$|generatedAt$|transactionPagination$|recentTransactions$|businessDay$|href$|link$|tone$|format$|key$|highlight$|rowKey$)/;
  const scalar = (value) => value == null || typeof value !== 'object';
  const flatten = (record, prefix = '', result = {}) => {
    for (const [key, value] of Object.entries(record)) {
      if (ignored.test(key)) continue;
      const path = prefix ? `${prefix} · ${reportLabel(key)}` : key;
      if (scalar(value)) result[path] = value;
      else if (Array.isArray(value)) result[path] = value.map((v) => scalar(v) ? v : Object.entries(flatten(v)).map(([k, cell]) => `${reportLabel(k)}: ${cell ?? ''}`).join(', ')).join('; ');
      else flatten(value, reportLabel(path), result);
    }
    return result;
  };
  const visit = (value, title) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (!value.length) return;
      const records = value.map((r) => scalar(r) ? { value: r } : flatten(r));
      const keys = [...new Set(records.flatMap(Object.keys))].filter((k) => !ignored.test(k) && records.some((r) => r[k] != null && scalar(r[k])));
      if (keys.length) sections.push({ title, columns: keys.map((key) => ({ key, label: reportLabel(key) })), rows: records });
    } else {
      const entries = Object.entries(value).filter(([k]) => !ignored.test(k));
      const metrics = entries.filter(([, v]) => scalar(v));
      if (metrics.length) sections.push({ title, columns: [{ key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value' }], rows: metrics.map(([k, v]) => ({ metric: reportLabel(k), value: v })) });
      entries.filter(([, v]) => !scalar(v)).forEach(([k, v]) => visit(v, title ? `${title} · ${reportLabel(k)}` : reportLabel(k)));
    }
  };
  visit(data, 'Overview');
  const transactionColumns = [
    ['created_at', 'Date'], ['bill_number', 'Bill'], ['order_number', 'Order'], ['customer_name', 'Customer'], ['cashier', 'Cashier'], ['payment', 'Payment'],
    ['subtotal', 'Subtotal'], ['discount_amount', 'Discount'], ['tax', 'Tax'], ['service_charge', 'Service charge'], ['cash_amount', 'Cash'], ['qr_amount', 'Online'], ['credit_amount', 'Credit'],
    ['food_amount', 'Food'], ['beverage_amount', 'Beverage'], ['tobacco_amount', 'Tobacco'], ['other_amount', 'Other'], ['final_total', 'Final total'],
  ].map(([key, label], i) => ({ key, label, ...(i >= 6 ? { type: 'currency' } : {}) }));
  const totals = Object.fromEntries(transactionColumns.filter((c) => c.type === 'currency').map((c) => [c.key, Math.round(transactions.reduce((sum, r) => sum + Number(r[c.key] || 0), 0) * 100) / 100]));
  sections.unshift({ title: 'Transactions', columns: transactionColumns, rows: [...transactions, { bill_number: 'TOTAL', ...totals }] });
  return sections;
}
