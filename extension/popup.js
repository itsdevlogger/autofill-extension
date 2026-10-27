const $ = (id) => document.getElementById(id);

function send(type) {
  return chrome.runtime.sendMessage({ type }).then((res) => {
    if (!res?.ok) throw new Error(res?.error || 'Something went wrong.');
    return res;
  });
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

function showSummary({ count, fetchedAt }) {
  if (!count) {
    $('summary').textContent = 'No data loaded yet';
    return;
  }
  const time = new Date(fetchedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  $('summary').textContent = `${count} fields · synced ${time}`;
}

async function withBusy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

$('fill').addEventListener('click', () =>
  withBusy($('fill'), async () => {
    setStatus('Filling…');
    const { filled, skipped, warning } = await send('fill');
    let msg = filled ? `Filled ${filled} field${filled === 1 ? '' : 's'}.` : 'No matching empty fields found.';
    if (skipped) msg += ` ${skipped} matched but left as is.`;
    if (warning) msg += ` (${warning})`;
    setStatus(msg, filled ? 'ok' : '');
    showSummary(await send('status'));
  })
);

$('refresh').addEventListener('click', () =>
  withBusy($('refresh'), async () => {
    setStatus('Loading sheet…');
    showSummary(await send('refresh'));
    setStatus('Sheet loaded.', 'ok');
  })
);

$('overwrite').addEventListener('change', (e) => {
  chrome.storage.sync.set({ overwrite: e.target.checked });
});

async function saveSheetUrl(url) {
  await chrome.storage.sync.set({ sheetUrl: url });
  $('sheetUrl').value = url;
  $('open').href = url;
  await withBusy($('save'), async () => {
    setStatus('Loading sheet…');
    showSummary(await send('refresh'));
    setStatus('Sheet saved and loaded.', 'ok');
  });
}

$('save').addEventListener('click', () => saveSheetUrl($('sheetUrl').value.trim() || DEFAULT_SHEET_URL));
$('reset').addEventListener('click', () => saveSheetUrl(DEFAULT_SHEET_URL));

(async () => {
  const { sheetUrl, overwrite } = await chrome.storage.sync.get({
    sheetUrl: DEFAULT_SHEET_URL,
    overwrite: false,
  });
  $('sheetUrl').value = sheetUrl;
  $('open').href = sheetUrl;
  $('overwrite').checked = overwrite;
  showSummary(await send('status').catch(() => ({})));
})();
