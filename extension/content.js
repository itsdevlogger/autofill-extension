// Injected into every frame of the page when you click "Fill".
// Exposes globalThis.__sheetAutofill.fill(rows, { overwrite }).
(() => {
  if (globalThis.__sheetAutofill) return;

  const SKIP_INPUT_TYPES = new Set([
    'hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'search', 'color', 'range',
  ]);
  const CONTROL_SELECTOR = 'input, textarea, select';
  const MAX_LABEL_LENGTH = 300;

  // "First Name", "first_name", "first-name" all become "firstname".
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  // "First Name *" becomes "first name".
  const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // ---------- Building the lookup from sheet rows ----------

  function buildIndex(rows) {
    const exact = new Map(); // normalized alias -> { row, order } (first row wins)
    const regexes = []; // { re, row, order } tested against raw attributes and labels
    const phrases = []; // { phrase, row } for matching inside label text
    rows.forEach((row, order) => {
      if (row.nameType === 'regex') {
        try {
          regexes.push({ re: new RegExp(row.pattern, row.flags), row, order });
        } catch (err) {
          console.warn('Sheet Autofill: skipping invalid RegEx', row.pattern, err);
        }
        return;
      }
      for (const name of row.names) {
        const key = norm(name);
        if (key && !exact.has(key)) exact.set(key, { row, order });
        const phrase = words(name);
        if (phrase.length >= 3) phrases.push({ phrase, row });
      }
    });
    // Longer phrases first so "confirm email" beats "email".
    phrases.sort((a, b) => b.phrase.length - a.phrase.length);
    return { exact, regexes, phrases };
  }

  // The earliest sheet row whose Text name equals one of the strings or whose RegEx matches one.
  function firstRowMatching(index, strings) {
    let best = null;
    for (const s of strings) {
      const hit = index.exact.get(norm(s));
      if (hit && (!best || hit.order < best.order)) best = hit;
      for (const r of index.regexes) {
        if (best && r.order >= best.order) break;
        if (r.re.test(s)) best = r;
      }
    }
    return best ? best.row : null;
  }

  // ---------- Reading what a field is called ----------

  function textOf(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Machine-ish identifiers: name, id, autocomplete, common data attributes.
  function attributeKeys(el) {
    const keys = [];
    const add = (v) => v && keys.push(v);
    const name = el.getAttribute('name');
    const id = el.id;
    add(name);
    add(id);
    const ac = (el.getAttribute('autocomplete') || '').trim().split(/\s+/).pop();
    if (ac && ac !== 'on' && ac !== 'off') add(ac);
    add(el.getAttribute('data-automation-id'));
    add(el.getAttribute('data-testid'));
    add(el.getAttribute('data-qa'));
    add(el.getAttribute('data-field'));
    // job_application[first_name] -> first_name ; applicant.firstName -> firstName
    for (const v of [name, id]) {
      if (!v) continue;
      const parts = v.split(/[[\].:]+/).filter(Boolean);
      if (parts.length > 1) add(parts[parts.length - 1]);
    }
    return keys;
  }

  // Human-readable labels: <label>, aria-label(ledby), placeholder, title, nearby text.
  function labelTexts(el, scopeControls) {
    const texts = [];
    const add = (t) => {
      t = String(t || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= MAX_LABEL_LENGTH) texts.push(t);
    };

    add(el.getAttribute('aria-label'));
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = el.getRootNode();
      add(labelledBy.split(/\s+/).map((id) => textOf(root.getElementById?.(id))).join(' '));
    }
    const isGroup = scopeControls.length > 1;
    // A radio's own <label> is the option ("Yes"), not the question.
    if (el.labels && !isGroup) for (const l of el.labels) add(textOf(l));
    add(el.getAttribute('placeholder'));
    add(el.getAttribute('title'));

    // Text of the nearest ancestor that wraps only this control (or this whole radio group).
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const controls = [...node.querySelectorAll(CONTROL_SELECTOR)].filter(isCandidate);
      if (controls.some((c) => !scopeControls.includes(c))) break;
      if (controls.length < scopeControls.length) continue;
      if (node.tagName === 'FIELDSET') {
        add(textOf(node.querySelector('legend')));
      }
      const t = textOf(node);
      if (t) {
        add(t);
        break;
      }
    }
    return texts;
  }

  function matchRow(index, el, scopeControls) {
    // 1. Attributes (most reliable): Text name equals one, or a RegEx matches one.
    const byAttr = firstRowMatching(index, attributeKeys(el));
    if (byAttr) return byAttr;
    // 2. Label text: Text name equals it ("First Name *" -> "firstname"), or a RegEx matches it.
    const labels = labelTexts(el, scopeControls);
    const byLabel = firstRowMatching(index, labels);
    if (byLabel) return byLabel;
    // 3. A Text name appears as whole words inside a label ("What is your first name?").
    for (const label of labels) {
      const hay = ` ${words(label)} `;
      let best = null;
      for (const p of index.phrases) {
        if (best && p.phrase.length < best.phrase.length) break;
        const at = hay.lastIndexOf(` ${p.phrase} `);
        // On a tie, prefer the phrase that appears later ("Company website" -> website).
        if (at !== -1 && (!best || at > best.at)) best = { ...p, at };
      }
      if (best) return best.row;
    }
    return null;
  }

  // ---------- Finding fields (including open shadow DOMs) ----------

  function collectControls(root, out = []) {
    for (const el of root.querySelectorAll(CONTROL_SELECTOR)) out.push(el);
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) collectControls(host.shadowRoot, out);
    }
    return out;
  }

  function isCandidate(el) {
    if (el.disabled || el.readOnly) return false;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (SKIP_INPUT_TYPES.has(type)) return false;
      // Styled checkboxes/radios are often visually hidden; keep them.
      if (type === 'checkbox' || type === 'radio') return true;
    }
    return el.getClientRects().length > 0;
  }

  // ---------- Writing values so frameworks (React, Vue, Angular) notice ----------

  function fire(el, ...types) {
    for (const type of types) el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus({ preventScroll: true });
    setter.call(el, value);
    fire(el, 'input', 'change');
    el.blur();
  }

  function setChecked(el, checked) {
    if (el.checked !== checked) el.click();
    if (el.checked !== checked) {
      el.checked = checked;
      fire(el, 'input', 'change');
    }
  }

  function highlight(el) {
    const prev = el.style.outline;
    el.style.outline = '2px solid #1a7f37';
    setTimeout(() => (el.style.outline = prev), 1500);
  }

  function optionLabel(opt) {
    return opt instanceof HTMLOptionElement
      ? `${opt.textContent} ${opt.value}`
      : `${labelTexts(opt, [opt]).join(' ')} ${opt.value}`;
  }

  // Picks the option (select <option> or radio input) that best fits the row's value.
  function pickOption(options, row) {
    const labels = options.map((o) => ({ o, text: words(optionLabel(o)), value: norm(o.value) }));
    if (row.type === 'bool') {
      const want = row.value ? /^(yes|true|y|1)\b/ : /^(no|false|n|0)\b/;
      return (labels.find((l) => want.test(l.text) || want.test(l.value)) || {}).o || null;
    }
    const v = norm(row.value);
    if (!v) return null;
    const exact = labels.find((l) => norm(l.text) === v || l.value === v);
    if (exact) return exact.o;
    const partial = labels.find((l) => {
      const t = norm(l.text);
      return t && (t.includes(v) || v.includes(t)) && t.length >= 2;
    });
    return partial ? partial.o : null;
  }

  function isPlaceholderOption(opt) {
    return !opt || opt.value === '' || /^\W*(select|choose|please|--)/i.test(opt.textContent.trim());
  }

  function fillSelect(el, row, overwrite) {
    if (!overwrite && !isPlaceholderOption(el.options[el.selectedIndex])) return false;
    const opt = pickOption([...el.options].filter((o) => !o.disabled), row);
    if (!opt) return false;
    setNativeValue(el, opt.value);
    return true;
  }

  function fillRadioGroup(radios, row, overwrite) {
    if (!overwrite && radios.some((r) => r.checked)) return false;
    const pick = pickOption(radios, row);
    if (!pick) return false;
    setChecked(pick, true);
    return true;
  }

  function fillInput(el, row, overwrite) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') {
      if (row.type !== 'bool') return false;
      setChecked(el, row.value);
      return true;
    }
    if (!overwrite && el.value !== '') return false;
    let value = row.type === 'bool' ? (row.value ? 'Yes' : 'No') : String(row.value);
    if (type === 'number' && Number.isNaN(Number(value))) return false;
    if (type === 'email' && !value.includes('@')) return false;
    if (el.maxLength > 0 && value.length > el.maxLength) value = value.slice(0, el.maxLength);
    if (el.value === value) return false;
    setNativeValue(el, value);
    // Inputs like type="date" silently reject values in the wrong format.
    return el.value === value;
  }

  // ---------- Main entry ----------

  function fill(rows, { overwrite = false } = {}) {
    const index = buildIndex(rows);
    const controls = collectControls(document).filter(isCandidate);
    const handledRadioGroups = new Set();
    let filled = 0;
    let skipped = 0;

    for (const el of controls) {
      try {
        if (el.type === 'radio') {
          const groupKey = el.name || el;
          if (handledRadioGroups.has(groupKey)) continue;
          handledRadioGroups.add(groupKey);
          const group = el.name
            ? controls.filter((c) => c.type === 'radio' && c.name === el.name && c.form === el.form)
            : [el];
          const row = matchRow(index, el, group);
          if (!row) continue;
          if (fillRadioGroup(group, row, overwrite)) {
            filled++;
            group.forEach(highlight);
          } else skipped++;
          continue;
        }

        const row = matchRow(index, el, [el]);
        if (!row) continue;
        const ok = el.tagName === 'SELECT' ? fillSelect(el, row, overwrite) : fillInput(el, row, overwrite);
        if (ok) {
          filled++;
          highlight(el);
        } else skipped++;
      } catch (err) {
        console.warn('Sheet Autofill: could not fill', el, err);
        skipped++;
      }
    }
    return { filled, skipped };
  }

  globalThis.__sheetAutofill = { fill };
})();
