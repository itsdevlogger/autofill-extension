// Fetches and parses the Google Sheet.
// Expected columns: Field Type | Field Name Type | Field Name | Field Value
// (the older Field Type | Field Name | Field Value layout still works).

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

function normalizeNameType(raw) {
  return /^\s*reg(ular)?\s*ex(p)?\s*$/i.test(String(raw || '')) ? 'regex' : 'text';
}

// "/^first.?name$/i" -> { pattern: "^first.?name$", flags: "i" }.
// Without slashes the whole cell is the pattern and matching ignores case.
// The g and y flags are dropped: they make RegExp.test() stateful.
function parseRegex(raw) {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(raw);
  const pattern = m ? m[1] : raw;
  const flags = (m ? m[2] : 'i').replace(/[gy]/g, '');
  new RegExp(pattern, flags); // Throws on invalid patterns or flags.
  return { pattern, flags };
}

// Converts CSV rows into { rows, problems }.
// Text rows:  { type, nameType: 'text',  names: [...], value }
// RegEx rows: { type, nameType: 'regex', pattern, flags, value }
// problems lists rows that were skipped, e.g. invalid regular expressions.
function rowsFromCsv(csvRows) {
  const rows = [];
  const problems = [];
  if (!csvRows.length) return { rows, problems };

  // Find columns by header name; fall back to A/B/C/D (or A/B/C for the old 3-column layout).
  const header = csvRows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const col = (name) => header.indexOf(name);
  const hasHeader = ['field type', 'field name type', 'field name', 'field value'].some((h) => col(h) !== -1);
  const fourColumns = hasHeader ? col('field name type') !== -1 : csvRows[0].length >= 4;
  const pick = (name, fallback4, fallback3) =>
    col(name) !== -1 ? col(name) : fourColumns ? fallback4 : fallback3;
  const typeCol = pick('field type', 0, 0);
  const nameTypeCol = fourColumns ? pick('field name type', 1, -1) : -1;
  const nameCol = pick('field name', 2, 1);
  const valueCol = pick('field value', 3, 2);

  csvRows.forEach((r, i) => {
    if (hasHeader && i === 0) return;
    const sheetRow = i + 1;
    const rawName = String(r[nameCol] || '').trim();
    if (!rawName) return;

    const type = normalizeType(r[typeCol]);
    const rawValue = r[valueCol] ?? '';
    let value = rawValue;
    if (type === 'bool') value = parseBool(rawValue);
    else if (type === 'number') value = String(rawValue).trim();

    const nameType = nameTypeCol === -1 ? 'text' : normalizeNameType(r[nameTypeCol]);
    if (nameType === 'regex') {
      try {
        rows.push({ type, nameType, ...parseRegex(rawName), value, sheetRow });
      } catch (err) {
        problems.push(`Row ${sheetRow}: invalid RegEx ${rawName} (${err.message})`);
      }
      return;
    }

    const names = rawName
      .split('|')
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length) rows.push({ type, nameType, names, value, sheetRow });
  });
  return { rows, problems };
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

  const { rows, problems } = rowsFromCsv(parseCsv(text));
  if (!rows.length) throw new Error('The sheet has no usable rows with a Field Name.');
  return { rows, problems };
}

if (typeof module !== 'undefined') {
  module.exports = { DEFAULT_SHEET_URL, toCsvUrl, parseCsv, rowsFromCsv, parseBool, parseRegex };
}
