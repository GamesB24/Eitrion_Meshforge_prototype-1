// Script editor window. Original MIT code. No third-party editor.
import { diffLines, highlightScript, listTemplates } from './scriptbox.js';

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function createScriptEditor(ctx) {
  const root = document.createElement('div');
  root.id = 'scriptEditor';
  root.hidden = true;
  root.innerHTML = `
    <div class="se-head" id="seHead"><b>Script</b><span class="grow"></span>
      <button type="button" id="seDock" title="Dock or float">Dock</button>
      <button type="button" id="seClose">Close</button></div>
    <div class="se-tabs" id="seTabs"></div>
    <div class="se-bar">
      <select id="seTemplate" title="Template"></select>
      <button type="button" id="seValidate">Validate</button>
      <button type="button" id="seSave">Save</button>
      <span id="seLang" class="hint0"></span>
    </div>
    <div class="se-code"><pre id="seHl" class="se-hl"></pre><textarea id="seTa" class="se-ta" spellcheck="false" wrap="off"></textarea></div>
    <label class="hint0" id="seParamLabel" hidden>Parameters (JSON)</label>
    <textarea id="seParams" class="se-params" hidden spellcheck="false"></textarea>
    <div class="se-ask">
      <input id="seBrief" class="txt" placeholder="Ask AI what to change. The key stays in the Agent session.">
      <button type="button" id="seAsk">Ask AI</button>
    </div>
    <div id="seDiff" class="se-diff" hidden></div>
    <div class="se-diffbar" id="seDiffBar" hidden>
      <button type="button" id="seAccept">Accept</button>
      <button type="button" id="seReject">Reject</button>
    </div>
    <div id="seConsole" class="se-console"></div>
    <div class="se-resize" id="seResize" title="Drag to resize"></div>`;
  document.body.appendChild(root);

  const tabs = [];
  let active = null;
  let pending = null;
  const undo = [];
  let applying = false;

  const $ = (id) => root.querySelector(id);
  const template = $('#seTemplate');
  template.innerHTML = '<option value="">Template…</option>' + listTemplates().map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join('');

  function paint() {
    const code = $('#seTa').value;
    const parts = highlightScript(code);
    $('#seHl').innerHTML = parts.map((p) => `<span class="tok-${p.kind}">${esc(p.text)}</span>`).join('') + '\n';
  }
  function consoleLine(text, kind) {
    const row = document.createElement('div');
    row.className = kind || '';
    row.textContent = text;
    const box = $('#seConsole');
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }
  function clearConsole() { $('#seConsole').replaceChildren(); }

  function drawTabs() {
    const host = $('#seTabs');
    host.replaceChildren();
    for (const tab of tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = tab === active ? 'on' : '';
      b.textContent = tab.title;
      b.onclick = () => show(tab);
      host.appendChild(b);
    }
  }
  function show(tab) {
    if (active && active !== tab) active.source = $('#seTa').value;
    active = tab;
    applying = true;
    $('#seTa').value = tab.source || '';
    applying = false;
    $('#seLang').textContent = tab.language === 'glsl' ? 'GLSL shader and parameters' : 'Gameplay script';
    $('#seParamLabel').hidden = tab.language !== 'glsl';
    $('#seParams').hidden = tab.language !== 'glsl';
    $('#seParams').value = tab.paramsText || '';
    template.hidden = tab.language === 'glsl';
    paint();
    drawTabs();
    pending = null;
    $('#seDiff').hidden = true;
    $('#seDiffBar').hidden = true;
  }

  function open(tab) {
    const id = tab.id || tab.title;
    let row = tabs.find((t) => t.id === id);
    if (!row) {
      row = { id, title: tab.title || 'Script', language: tab.language || 'javascript', source: tab.source || '', paramsText: tab.paramsText || '', owner: tab.owner || null, kind: tab.kind || 'actor' };
      tabs.push(row);
    } else if (tab.source != null && tab.refresh) row.source = tab.source;
    root.hidden = false;
    show(row);
    return row;
  }

  function currentSource() {
    if (!active) return '';
    active.source = $('#seTa').value;
    if (active.language === 'glsl') active.paramsText = $('#seParams').value;
    return active.source;
  }

  function pushUndo() {
    if (!active) return;
    undo.push({ id: active.id, source: active.source, paramsText: active.paramsText });
    if (undo.length > 40) undo.shift();
  }

  async function save() {
    if (!active) return { ok: false };
    pushUndo();
    currentSource();
    const result = await ctx.save(active);
    consoleLine(result.ok ? 'Saved ' + active.title : (result.error || 'Could not save'), result.ok ? '' : 'bad');
    ctx.autosave?.();
    return result;
  }

  function validate() {
    if (!active) return;
    currentSource();
    clearConsole();
    const result = ctx.validate(active);
    if (result.ok) consoleLine('No errors.');
    else for (const err of result.errors || []) consoleLine('Line ' + err.line + ': ' + err.message, 'bad');
    return result;
  }

  function showDiff(before, after) {
    const rows = diffLines(before, after);
    const host = $('#seDiff');
    host.replaceChildren();
    host.hidden = false;
    $('#seDiffBar').hidden = false;
    for (const row of rows) {
      if (row.type === 'same') continue;
      const line = document.createElement('div');
      line.className = row.type === 'add' ? 'add' : 'remove';
      line.textContent = (row.type === 'add' ? '+ ' : '- ') + row.text;
      host.appendChild(line);
    }
    if (!host.childNodes.length) {
      const line = document.createElement('div');
      line.textContent = 'No changes.';
      host.appendChild(line);
    }
  }

  $('#seTa').addEventListener('input', () => { if (!applying) { paint(); ctx.touch?.(active); } });
  $('#seTa').addEventListener('scroll', () => { $('#seHl').scrollTop = $('#seTa').scrollTop; $('#seHl').scrollLeft = $('#seTa').scrollLeft; });
  $('#seClose').onclick = () => { root.hidden = true; };
  $('#seDock').onclick = () => {
    root.classList.toggle('docked');
    $('#seDock').textContent = root.classList.contains('docked') ? 'Float' : 'Dock';
  };
  $('#seValidate').onclick = () => validate();
  $('#seSave').onclick = () => save();
  template.onchange = () => {
    const id = template.value;
    template.value = '';
    if (!id || !active || active.language === 'glsl') return;
    const source = ctx.template(id);
    if (!source) return;
    pushUndo();
    active.source = source;
    $('#seTa').value = source;
    paint();
    consoleLine('Inserted the ' + id + ' template. Save to keep it.');
  };
  $('#seAsk').onclick = async () => {
    if (!active) return;
    currentSource();
    clearConsole();
    consoleLine('Asking the connected provider…');
    const result = await ctx.ask({ brief: $('#seBrief').value, source: active.source, language: active.language, title: active.title });
    if (!result?.ok) { consoleLine(result?.error || 'No reply', 'bad'); return; }
    const proposed = ctx.propose(active.source, result.source, active.language);
    if (!proposed.ok) {
      for (const err of proposed.errors) consoleLine('Line ' + err.line + ': ' + err.message, 'bad');
      consoleLine('The reply was rejected. The script was not changed.', 'bad');
      return;
    }
    pending = proposed.next;
    showDiff(active.source, pending);
    consoleLine('Review the diff, then accept or reject.');
  };
  $('#seAccept').onclick = () => {
    if (!active || pending == null) return;
    pushUndo();
    const before = active.source;
    active.source = pending;
    $('#seTa').value = pending;
    paint();
    pending = null;
    $('#seDiff').hidden = true;
    $('#seDiffBar').hidden = true;
    ctx.onAccept?.(active, before);
    consoleLine('Accepted. Save to write it into the project.');
  };
  $('#seReject').onclick = () => {
    pending = null;
    $('#seDiff').hidden = true;
    $('#seDiffBar').hidden = true;
    consoleLine('Rejected.');
  };
  root.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); validate(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && e.target !== $('#seTa')) {
      const step = undo.pop();
      if (step) {
        const tab = tabs.find((t) => t.id === step.id);
        if (tab) { tab.source = step.source; tab.paramsText = step.paramsText; show(tab); }
      }
    }
  });

  const head = $('#seHead');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || root.classList.contains('docked')) return;
    const box = root.getBoundingClientRect();
    const dx = e.clientX - box.left, dy = e.clientY - box.top;
    const move = (ev) => {
      root.style.left = Math.max(8, ev.clientX - dx) + 'px';
      root.style.top = Math.max(8, ev.clientY - dy) + 'px';
      root.style.right = 'auto';
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  const handle = $('#seResize');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const box = root.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, w = box.width, h = box.height;
    const move = (ev) => {
      root.style.width = Math.max(360, w + ev.clientX - sx) + 'px';
      root.style.height = Math.max(280, h + ev.clientY - sy) + 'px';
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

  function log(text) { consoleLine(text); }

  return { open, log, hide: () => { root.hidden = true; }, show: () => { root.hidden = false; }, get root() { return root; }, tabs: () => tabs.map((t) => t.id) };
}
