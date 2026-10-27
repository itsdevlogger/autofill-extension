importScripts('sheet.js');

// Re-use the cached sheet for this long before fetching it again on "Fill".
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

async function getSettings() {
  const { sheetUrl, overwrite } = await chrome.storage.sync.get({
    sheetUrl: DEFAULT_SHEET_URL,
    overwrite: false,
  });
  return { sheetUrl: sheetUrl || DEFAULT_SHEET_URL, overwrite };
}

async function getCache() {
  const { cache } = await chrome.storage.local.get('cache');
  return cache || null;
}

// Returns { rows, problems, fetchedAt, warning? }. Falls back to the cache if the sheet can't be reached.
async function loadRows({ force = false } = {}) {
  const { sheetUrl } = await getSettings();
  const cache = await getCache();
  const cacheValid = cache && cache.sheetUrl === sheetUrl && cache.rows?.length;

  if (!force && cacheValid && Date.now() - cache.fetchedAt < CACHE_MAX_AGE_MS) {
    return cache;
  }

  try {
    const { rows, problems } = await fetchSheetRows(sheetUrl);
    const fresh = { rows, problems, fetchedAt: Date.now(), sheetUrl };
    await chrome.storage.local.set({ cache: fresh });
    return fresh;
  } catch (err) {
    if (cacheValid) return { ...cache, warning: `Using saved copy: ${err.message}` };
    throw err;
  }
}

async function fillTab(tabId) {
  const { rows, warning } = await loadRows();
  const { overwrite } = await getSettings();
  const target = { tabId, allFrames: true };

  await chrome.scripting.executeScript({ target, files: ['content.js'] });
  const results = await chrome.scripting.executeScript({
    target,
    func: (rows, options) => globalThis.__sheetAutofill?.fill(rows, options),
    args: [rows, { overwrite }],
  });

  let filled = 0;
  let skipped = 0;
  for (const r of results) {
    if (!r.result) continue;
    filled += r.result.filled;
    skipped += r.result.skipped;
  }
  return { filled, skipped, warning };
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab.');
  return tab.id;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    switch (msg?.type) {
      case 'fill':
        return fillTab(await activeTabId());
      case 'refresh': {
        const { rows, problems = [], fetchedAt } = await loadRows({ force: true });
        return { count: rows.length, problems, fetchedAt };
      }
      case 'status': {
        const cache = await getCache();
        return {
          count: cache?.rows?.length || 0,
          problems: cache?.problems || [],
          fetchedAt: cache?.fetchedAt || null,
        };
      }
      default:
        throw new Error(`Unknown message: ${msg?.type}`);
    }
  };
  run()
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true; // Keep the channel open for the async response.
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill-page') return;
  try {
    const { filled } = await fillTab(await activeTabId());
    chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' });
    chrome.action.setBadgeText({ text: String(filled) });
  } catch (err) {
    chrome.action.setBadgeBackgroundColor({ color: '#cf222e' });
    chrome.action.setBadgeText({ text: '!' });
    console.error('Sheet Autofill:', err);
  }
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
});
