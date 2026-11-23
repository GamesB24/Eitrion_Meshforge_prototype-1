// Popup and details for a programmable material. Original MIT code.
import { NO_AI, PRESET_IDS, PRESETS, clonePreset, setParam, shaderKey, validateSpec } from './progmat.js';
import { compileProgram, createPreview } from './progdraw.js';

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the image'));
    reader.readAsDataURL(file);
  });
}
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not read the image'));
    image.src = url;
  });
}
async function storeImage(file) {
  const data = await readFile(file);
  const image = await loadImage(data);
  const max = 512;
  const scale = Math.min(1, max / Math.max(image.width, image.height, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return { id: 'img_' + Math.random().toString(36).slice(2, 8), name: file.name || 'reference', data: canvas.toDataURL('image/jpeg', 0.85) };
}

export function mountProgramUi(ctx) {
  const pop = document.createElement('div');
  pop.id = 'pmPop';
  pop.className = 'pm-pop';
  pop.hidden = true;
  pop.innerHTML = `
    <div class="pm-head" id="pmHead"><b id="pmTitle">Programmable material</b><span class="grow"></span><button type="button" id="pmClose">Close</button></div>
    <div class="pm-body">
      <div class="pm-form">
        <label>Name <input id="pmName" class="txt"></label>
        <label>Brief <textarea id="pmBrief" class="txt" rows="3" placeholder="Describe any material: screen, hologram, water, lava, cloth, metal, toon…"></textarea></label>
        <div class="pm-images" id="pmImages"></div>
        <div class="row"><button type="button" class="btn" id="pmAddImg">Add reference image</button><input id="pmFile" type="file" accept="image/*" hidden></div>
        <p class="hint0">Images are stored inside this asset. They are not written outside the project.</p>
        <div id="pmAi" class="hint0"></div>
        <div class="row"><button type="button" class="primary" id="pmBuild">Build with AI</button><button type="button" class="btn" id="pmRegen">Regenerate</button></div>
        <label>History <select id="pmHist" class="txt"></select></label>
        <label>Preset <select id="pmPreset" class="txt"><option value="">Current</option>${PRESET_IDS.map((id) => `<option value="${id}">${esc(PRESETS[id].name)}</option>`).join('')}</select></label>
        <label>GLSL snippet <textarea id="pmGlsl" class="txt pm-glsl" rows="8" spellcheck="false"></textarea></label>
        <pre id="pmErr" class="pm-err"></pre>
        <div id="pmParams"></div>
        <div class="row"><button type="button" class="btn" id="pmAddParam">Add parameter</button></div>
        <div class="row"><span>UV</span>
          <label class="chk"><input id="pmNorm" type="checkbox"> Normalise slot to 0..1</label>
          <select id="pmPlanar" class="txt"><option value="auto">Planar if UVs are missing or stretched</option><option value="on">Always planar</option><option value="off">Keep mesh UVs</option></select>
          <label class="chk"><input id="pmAspect" type="checkbox"> Aspect correct</label>
        </div>
        <div class="row"><button type="button" class="primary" id="pmApply">Apply</button><button type="button" class="btn" id="pmAssign">Assign to selection</button></div>
        <p class="hint0">Apply saves the brief, images, snippet, and parameters onto the asset. Build only fills this window.</p>
      </div>
      <div class="pm-side"><canvas id="pmView"></canvas><div class="row"><button type="button" class="btn" id="pmSphere">Sphere</button><button type="button" class="btn" id="pmSelView">Selected</button></div><p id="pmViewNote" class="hint0">Preview</p></div>
    </div>`;
  document.body.appendChild(pop);
  const details = document.createElement('details');
  details.id = 'pmDetails';
  details.open = true;
  details.hidden = true;
  details.innerHTML = '<summary>Programmable material</summary><div id="pmDetailBody"></div>';
  document.querySelector('.props')?.prepend(details);
  const $ = (id) => pop.querySelector(id);
  let draft = null;
  let openId = '';
  let preview = null;
  let shownKey = '';
  let raf = 0;

  function ensurePreview() {
    if (preview) return preview;
    preview = createPreview($('#pmView'));
    const loop = () => { raf = requestAnimationFrame(loop); if (!pop.hidden) preview.render(); };
    loop();
    return preview;
  }
  function readDraft() {
    if (!draft) return null;
    draft.name = $('#pmName').value;
    draft.brief = $('#pmBrief').value;
    draft.glsl = $('#pmGlsl').value;
    draft.uv = { normalize: $('#pmNorm').checked, planar: $('#pmPlanar').value, aspect: $('#pmAspect').checked };
    draft.pbr = { ...(draft.pbr || {}), color: draft.pbr?.color || draft.color || '#888888' };
    return draft;
  }
  function showErrors(list) {
    $('#pmErr').textContent = (list || []).join('\n');
  }
  function refreshPreview() {
    const spec = readDraft();
    if (!spec) return;
    const checked = validateSpec(spec);
    const gpu = checked.ok ? compileProgram(checked.spec) : { ok: false, errors: checked.errors };
    showErrors(gpu.ok ? [] : gpu.errors);
    const view = ensurePreview();
    const key = shaderKey(spec);
    view.setSpec(spec, key !== shownKey);
    shownKey = key;
    $('#pmViewNote').textContent = gpu.ok ? 'Live preview' : 'The shader did not compile. The preview is showing an error colour.';
  }
  function drawParams() {
    const host = $('#pmParams');
    host.innerHTML = (draft?.params || []).map((param, index) => {
      const label = esc(param.label || param.name);
      let control = '';
      if (param.type === 'bool') control = `<input data-i="${index}" data-k="value" type="checkbox" ${param.base ? 'checked' : ''}>`;
      else if (param.type === 'color') control = `<input data-i="${index}" data-k="value" type="color" value="${esc(param.base || param.default || '#ffffff')}">`;
      else if (param.type === 'vec2' || param.type === 'vec3') {
        const n = param.type === 'vec2' ? 2 : 3;
        const value = param.base || param.default || [];
        control = Array.from({ length: n }, (_, k) => `<input data-i="${index}" data-k="vec" data-c="${k}" class="txt num" type="number" step="0.01" value="${value[k] ?? 0}">`).join('');
      } else if (param.type === 'texture') control = `<input data-i="${index}" data-k="tex" type="file" accept="image/*">`;
      else control = `<input data-i="${index}" data-k="value" type="range" min="${param.min}" max="${param.max}" step="${param.type === 'int' ? 1 : 0.01}" value="${param.base ?? param.default ?? 0}"><b>${param.base ?? param.default ?? 0}</b>`;
      const drive = param.drive?.source || 'off';
      return `<div class="pm-param"><b>${label}</b> <small>${esc(param.name)} · ${esc(param.type)}</small><div class="row">${control}</div>
        <div class="row"><select data-i="${index}" data-k="drive" class="txt"><option value="off" ${drive === 'off' ? 'selected' : ''}>Manual</option><option value="time" ${drive === 'time' ? 'selected' : ''}>Drive with time</option><option value="event" ${drive === 'event' ? 'selected' : ''}>Gameplay event</option></select>
        <input data-i="${index}" data-k="event" class="txt" placeholder="event name" value="${esc(param.drive?.event || '')}" ${drive === 'event' ? '' : 'hidden'}>
        <button type="button" data-i="${index}" data-k="del">Remove</button></div></div>`;
    }).join('') || '<p class="hint0">No parameters yet. Add one, or let Build with AI declare them.</p>';
    host.querySelectorAll('input, select').forEach((el) => {
      const event = el.type === 'range' || el.type === 'color' || el.type === 'checkbox' ? 'input' : 'change';
      el.addEventListener(event, () => onParamInput(el));
    });
    host.querySelectorAll('button[data-k="del"]').forEach((btn) => btn.onclick = () => {
      draft.params.splice(+btn.dataset.i, 1);
      drawParams();
      refreshPreview();
    });
  }
  function onParamInput(el) {
    const param = draft.params[+el.dataset.i];
    if (!param) return;
    if (el.dataset.k === 'drive') {
      if (el.value === 'time') param.drive = { source: 'time', wave: 'sin', speed: 1, amp: 0.25 };
      else if (el.value === 'event') param.drive = { source: 'event', event: 'gameplay', key: 'value' };
      else delete param.drive;
      drawParams();
      return;
    }
    if (el.dataset.k === 'event') {
      param.drive = { source: 'event', event: el.value.trim() || 'gameplay', key: 'value' };
      return;
    }
    if (el.dataset.k === 'tex') {
      const file = el.files?.[0];
      if (!file) return;
      storeImage(file).then((img) => { param.texture = img.data; refreshPreview(); });
      return;
    }
    if (el.dataset.k === 'vec') {
      const value = (param.base || param.default || []).slice();
      value[+el.dataset.c] = +el.value;
      param.base = value;
      param.default = value;
    } else if (param.type === 'bool') {
      param.base = el.checked;
      param.default = el.checked;
    } else if (param.type === 'color') {
      param.base = el.value;
      param.default = el.value;
    } else {
      param.base = param.type === 'int' ? Math.round(+el.value) : +el.value;
      const label = el.parentElement?.querySelector('b');
      if (label) label.textContent = String(param.base);
    }
    setParam(draft, param.name, param.base, 0, performance.now());
  }
  function drawImages() {
    const host = $('#pmImages');
    host.innerHTML = '';
    for (const img of draft?.images || []) {
      const fig = document.createElement('figure');
      const pic = document.createElement('img');
      pic.src = img.data;
      pic.alt = img.name || 'reference';
      const cap = document.createElement('button');
      cap.type = 'button';
      cap.textContent = 'Remove';
      cap.onclick = () => { draft.images = draft.images.filter((item) => item !== img); drawImages(); };
      fig.append(pic, cap);
      host.appendChild(fig);
    }
  }
  function drawHistory() {
    const sel = $('#pmHist');
    const items = draft?.history || [];
    sel.innerHTML = '<option value="">Current draft</option>' + items.map((item, i) => `<option value="${i}">${esc(item.brief || 'Earlier version').slice(0, 64)}</option>`).join('');
  }
  function fill(spec) {
    draft = spec;
    $('#pmName').value = spec.name || '';
    $('#pmBrief').value = spec.brief || '';
    $('#pmGlsl').value = spec.glsl || '';
    $('#pmNorm').checked = !!spec.uv?.normalize;
    $('#pmPlanar').value = spec.uv?.planar || 'auto';
    $('#pmAspect').checked = spec.uv?.aspect !== false;
    drawParams();
    drawImages();
    drawHistory();
    shownKey = '';
    refreshPreview();
    aiNote();
  }
  function aiNote() {
    const session = ctx.session?.();
    $('#pmAi').textContent = session?.connected?.() ? 'AI Agent is connected. Build uses that provider and its session key. The key is not saved with the asset.' : NO_AI;
  }
  function open(id) {
    const found = ctx.byId(id);
    if (!found || found.kind !== 'program') return;
    openId = id;
    pop.hidden = false;
    $('#pmTitle').textContent = found.name;
    fill(JSON.parse(JSON.stringify(found)));
  }
  async function build(regenerate) {
    readDraft();
    const session = ctx.session?.();
    if (!session?.connected?.()) { $('#pmAi').textContent = NO_AI; return; }
    $('#pmAi').textContent = 'Asking the connected provider…';
    const result = await ctx.buildDraft?.({ brief: draft.brief, images: draft.images, previous: regenerate ? { glsl: draft.glsl, params: draft.params } : null });
    if (!result?.ok) {
      $('#pmAi').textContent = result?.error || 'The AI did not return a usable material.';
      showErrors(result?.errors || []);
      return;
    }
    const next = result.spec;
    next.images = draft.images;
    next.history = draft.history || [];
    next.brief = draft.brief || next.brief;
    fill(next);
    $('#pmAi').textContent = 'Built a draft. Apply saves it onto the asset.';
  }

  $('#pmClose').onclick = () => { pop.hidden = true; };
  $('#pmBuild').onclick = () => build(false);
  $('#pmRegen').onclick = () => build(true);
  $('#pmApply').onclick = () => {
    readDraft();
    const checked = validateSpec(draft);
    if (!checked.ok) { showErrors(checked.errors); return; }
    const gpu = compileProgram(checked.spec);
    if (!gpu.ok) showErrors(gpu.errors);
    ctx.apply(openId, checked.spec);
    $('#pmTitle').textContent = checked.spec.name;
  };
  $('#pmAssign').onclick = () => ctx.assign(openId);
  $('#pmAddImg').onclick = () => $('#pmFile').click();
  $('#pmFile').onchange = async () => {
    const file = $('#pmFile').files?.[0];
    $('#pmFile').value = '';
    if (!file) return;
    try { draft.images = [...(draft.images || []), await storeImage(file)].slice(-4); drawImages(); }
    catch (err) { $('#pmAi').textContent = err.message; }
  };
  $('#pmAddParam').onclick = () => {
    const name = 'param' + ((draft.params?.length || 0) + 1);
    draft.params = [...(draft.params || []), { name, type: 'float', label: name, min: 0, max: 1, default: 0.5, base: 0.5 }];
    drawParams();
  };
  $('#pmPreset').onchange = () => {
    const id = $('#pmPreset').value;
    if (!id) return;
    const next = clonePreset(id);
    next.images = draft.images || [];
    next.history = draft.history || [];
    next.brief = draft.brief || next.brief;
    fill(next);
    $('#pmPreset').value = '';
  };
  $('#pmHist').onchange = () => {
    const item = draft.history?.[+$('#pmHist').value];
    if (!item) return;
    if (item.glsl) draft.glsl = item.glsl;
    if (item.params) draft.params = JSON.parse(JSON.stringify(item.params));
    if (item.pbr) draft.pbr = JSON.parse(JSON.stringify(item.pbr));
    if (item.states) draft.states = JSON.parse(JSON.stringify(item.states));
    if (item.brief) draft.brief = item.brief;
    fill(draft);
  };
  ['pmGlsl', 'pmBrief', 'pmName'].forEach((id) => $('#' + id).addEventListener('input', () => { if (id === 'pmGlsl') refreshPreview(); }));
  ['pmNorm', 'pmPlanar', 'pmAspect'].forEach((id) => $('#' + id).addEventListener('change', refreshPreview));
  pop.addEventListener('dragover', (e) => e.preventDefault());
  pop.addEventListener('drop', async (e) => {
    const file = [...(e.dataTransfer?.files || [])].find((item) => item.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    draft.images = [...(draft.images || []), await storeImage(file)].slice(-4);
    drawImages();
  });
  const head = $('#pmHead');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const box = pop.getBoundingClientRect();
    const dx = e.clientX - box.left, dy = e.clientY - box.top;
    const move = (ev) => { pop.style.left = (ev.clientX - dx) + 'px'; pop.style.top = (ev.clientY - dy) + 'px'; pop.style.right = 'auto'; };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

  let detailKey = '';
  function syncDetails() {
    const hit = ctx.selectedProgram?.();
    if (!hit) { details.hidden = true; detailKey = ''; return; }
    details.hidden = false;
    const key = hit.id + '|' + shaderKey(hit.def) + '|' + (hit.slot ?? '');
    if (key === detailKey && document.activeElement?.closest?.('#pmDetails')) return;
    detailKey = key;
    const values = ctx.paramValues(hit.def);
    const body = details.querySelector('#pmDetailBody');
    const states = Object.keys(hit.def.states || {});
    body.innerHTML = `<div class="row"><b>${esc(hit.def.name)}</b><button type="button" class="btn" id="pmOpen">Open</button></div>
      <p class="pm-err">${esc(hit.error || '')}</p>
      ${values.map((param) => `<div class="row"><span>${esc(param.label)}</span>${detailControl(param)}</div>`).join('')}
      <div class="row"><span>State</span><select id="pmState" class="txt">${states.map((name) => `<option ${name === hit.state ? 'selected' : ''}>${esc(name)}</option>`).join('') || '<option value="">none</option>'}</select><button type="button" class="btn" id="pmStateGo">Set</button></div>
      <div class="row"><input id="pmStateName" class="txt" placeholder="state name"><button type="button" class="btn" id="pmStateSave">Save state</button></div>
      <label class="chk"><input id="pmSlotNorm" type="checkbox" ${hit.uv?.normalize ? 'checked' : ''}> Normalise this slot's UVs to 0..1</label>
      <div class="row"><span>Planar</span><select id="pmSlotPlanar" class="txt"><option value="auto">Auto</option><option value="on">On</option><option value="off">Off</option></select></div>
      <label class="chk"><input id="pmSlotAspect" type="checkbox" ${hit.uv?.aspect !== false ? 'checked' : ''}> Aspect correct</label>
      <p class="hint0">${hit.uvNote || 'uTime is available inside the shader. Parameter changes here are live and are not undo steps.'}</p>`;
    const planar = body.querySelector('#pmSlotPlanar');
    if (planar) planar.value = hit.uv?.planar || 'auto';
    body.querySelector('#pmOpen').onclick = () => open(hit.id);
    body.querySelectorAll('[data-name]').forEach((el) => {
      const fire = async () => {
        let value = controlValue(el);
        if (el.type === 'file') {
          if (!value) return;
          value = (await storeImage(value)).data;
        } else if (el.dataset.c != null) {
          const param = hit.def.params.find((item) => item.name === el.dataset.name);
          value = (param?.base || param?.default || []).slice();
          value[+el.dataset.c] = +el.value;
        }
        ctx.setLiveParam(hit.id, el.dataset.name, value);
      };
      el.addEventListener(el.type === 'range' || el.type === 'color' || el.type === 'checkbox' ? 'input' : 'change', fire);
    });
    body.querySelector('#pmStateGo').onclick = () => { const name = body.querySelector('#pmState').value; if (name) ctx.setLiveState(hit.id, name); };
    body.querySelector('#pmStateSave').onclick = () => { const name = body.querySelector('#pmStateName').value.trim(); if (name) ctx.saveLiveState(hit.id, name); };
    const uvChange = () => ctx.setSlotUv?.(hit.mesh, hit.slot, { normalize: body.querySelector('#pmSlotNorm').checked, planar: planar.value, aspect: body.querySelector('#pmSlotAspect').checked });
    body.querySelector('#pmSlotNorm').onchange = uvChange;
    planar.onchange = uvChange;
    body.querySelector('#pmSlotAspect').onchange = uvChange;
  }
  function detailControl(param) {
    if (param.type === 'bool') return `<input data-name="${esc(param.name)}" type="checkbox" ${param.value ? 'checked' : ''}>`;
    if (param.type === 'color') return `<input data-name="${esc(param.name)}" type="color" value="${esc(param.value || '#ffffff')}">`;
    if (param.type === 'texture') return `<input data-name="${esc(param.name)}" type="file" accept="image/*">`;
    if (param.type === 'vec2' || param.type === 'vec3') {
      const value = param.value || [];
      return value.map((part, index) => `<input data-name="${esc(param.name)}" data-c="${index}" class="txt num" type="number" step="0.01" value="${part}">`).join('');
    }
    return `<input data-name="${esc(param.name)}" type="range" min="${param.min ?? 0}" max="${param.max ?? 1}" step="${param.type === 'int' ? 1 : 0.01}" value="${param.value ?? 0}">`;
  }
  function controlValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'file') return el.files?.[0] || null;
    return el.type === 'range' ? +el.value : el.value;
  }

  return {
    open, syncDetails, aiNote,
    createBlank() { const made = ctx.createBlank(); if (made) open(made.id); },
    note() { return NO_AI; },
    dispose() { cancelAnimationFrame(raf); preview?.dispose(); },
  };
}
