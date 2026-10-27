// Fetches and parses the Google Sheet.
// Expected columns: Field Type | Field Name | Field Value

const DEFAULT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1Y-VZWm7ud-6RgqfFTUw32-139CODTokDf-rCnbWyhco/edit?usp=sharing';

const FIELD_TYPES = ['bool', 'string', 'number'];

// Turns any Google Sheets link into its CSV export URL. Keeps the tab (gid)
// if the link points at one; otherwise the first tab is exported.
function toCsvUrl(sheetUrl) {
  const idMatch = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(sheetUrl);
  if (!idMatch) return sheetUrl; // Assume it is already a direct CSV link.
  const gidMatch = /[#&?]gid=(\d+)/.exec(sheetUrl);
  let url = `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv`;
  if (gidMatch) url += `&gid=${gidMatch[1]}`;
  return url;
}

// RFC 4180 CSV parser: handles quoted fields, escaped quotes and newlines inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeType(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (t === 'boolean' || t === 'checkbox') return 'bool';
  if (t === 'text' || t === 'str') return 'string';
  if (t === 'int' || t === 'float' || t === 'integer') return 'number';
  return FIELD_TYPES.includes(t) ? t : 'string';
}

function parseBool(raw) {
  return /^(true|yes|y|1|checked|on)$/i.test(String(raw).trim());
}

// Converts CSV rows into [{ type, names: [...], value }].
function rowsFromCsv(csvRows) {
  if (!csvRows.length) return [];

  // Find columns by header name; fall back to A/B/C.
  const header = csvRows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  let typeCol = header.indexOf('field type');
  let nameCol = header.indexOf('field name');
  let valueCol = header.indexOf('field value');
  const hasHeader = typeCol !== -1 || nameCol !== -1 || valueCol !== -1;
  if (typeCol === -1) typeCol = 0;
  if (nameCol === -1) nameCol = 1;
  if (valueCol === -1) valueCol = 2;

  const out = [];
  for (const r of csvRows.slice(hasHeader ? 1 : 0)) {
    const names = String(r[nameCol] || '')
      .split('|')
      .map((n) => n.trim())
      .filter(Boolean);
    if (!names.length) continue;

    const type = normalizeType(r[typeCol]);
    const rawValue = r[valueCol] ?? '';
    let value = rawValue;
    if (type === 'bool') value = parseBool(rawValue);
    else if (type === 'number') value = String(rawValue).trim();

    out.push({ type, names, value });
  }
  return out;
}

async function fetchSheetRows(sheetUrl) {
  const url = toCsvUrl(sheetUrl || DEFAULT_SHEET_URL);
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new Error(`Sheet request failed (HTTP ${res.status}).`);

  const text = await res.text();
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html') || /^\s*<(!doctype|html)/i.test(text)) {
    throw new Error(
      'Google returned a web page instead of CSV. Share the sheet as "Anyone with the link can view", or sign in to Google in this browser.'
    );
  }

  const rows = rowsFromCsv(parseCsv(text));
  if (!rows.length) throw new Error('The sheet has no rows with a Field Name.');
  return rows;
}

if (typeof module !== 'undefined') {
  module.exports = { DEFAULT_SHEET_URL, toCsvUrl, parseCsv, rowsFromCsv, parseBool };
}
