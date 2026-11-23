import { isTool, runTool, TOOLS } from '../plugins/ai-agent/tools.js';
import { buildTestHead } from '../frontend/testhead.js';
import {
  NO_AI, PRESET_IDS, PRESETS, applyMaterialEvent, blendParam, chooseUvMode, clonePreset,
  createProgramActions, measureStretch, parseModelJson, sampleRuntime, setParam, setState,
  slotUvReport, timeWave, validateGlsl, validateSpec,
} from '../frontend/progmat.js';

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail !== undefined ? ' ' + JSON.stringify(detail) : ''));
  if (!cond) failed++;
}

const EXPRESSIONS = ['neutral', 'happy', 'sad', 'surprised', 'angry', 'thinking', 'talking'];
check('four presets', PRESET_IDS.join() === 'screen,hologram,water,panel');
for (const id of PRESET_IDS) {
  const spec = PRESETS[id];
  check(id + ' is a programmable spec', spec.kind === 'program' && spec.glsl && spec.params.length > 0);
  check(id + ' glsl is constrained', validateGlsl(spec.glsl).length === 0, validateGlsl(spec.glsl));
}
check('screen has expression states', EXPRESSIONS.every((name) => PRESETS.screen.states[name]));

const badJs = validateSpec({ name: 'Bad', glsl: 'eval(document.write)', params: [] });
check('javascript is rejected', !badJs.ok && badJs.errors.some((e) => /JavaScript/.test(e)));
const badMain = validateSpec({ name: 'Bad', glsl: 'void main(){ gl_FragColor = vec4(1.0); }', params: [{ name: 'glow', type: 'float', min: 0, max: 1, default: 1 }] });
check('main is rejected', !badMain.ok);
const kept = validateSpec({
  name: 'Kept',
  glsl: 'mfEmissive = vec3(uP_glow);\n',
  params: [{ name: 'glow', type: 'float', min: 0, max: 2, default: 1, label: 'Glow' }],
  images: [{ name: 'ref', data: 'data:image/png;base64,aaaa' }, { name: 'path', data: '/tmp/secret.png' }],
});
check('image data stays inside the spec', kept.ok && kept.spec.images.length === 1 && kept.spec.images[0].data.startsWith('data:image/'));
check('a file path is not stored', kept.errors.length === 0 && !JSON.stringify(kept.spec).includes('/tmp/'));

const screen = clonePreset('screen');
setParam(screen, 'smile', 1, 100, 0);
const mid = sampleRuntime(screen, 50).smile;
const end = sampleRuntime(screen, 120).smile;
check('blend is between the ends', mid > 0.2 && mid < 0.9, mid);
check('blend settles', end === 1);
setState(screen, 'sad', 0, 200);
check('sad state', sampleRuntime(screen, 200).smile === -1 && sampleRuntime(screen, 200).brow === 0.85);
const moved = timeWave({ source: 'time', wave: 'sin', speed: 1, lo: 0, hi: 1 }, 0, 0);
const later = timeWave({ source: 'time', wave: 'sin', speed: 1, lo: 0, hi: 1 }, 0, 250);
check('time wave moves', moved !== later);
screen.params.find((p) => p.name === 'glow').drive = { source: 'event', event: 'power', key: 'value' };
applyMaterialEvent(screen, 'power', { value: 1.4 }, 300);
check('event sets a parameter', sampleRuntime(screen, 300).glow === 1.4);
check('colour blend', blendParam('color', '#000000', '#ffffff', 0.5) === '#808080');

check('missing UVs use planar', chooseUvMode({ hasUv: false, stretch: 1, uv: { planar: 'auto', normalize: true, aspect: true } }).mode === 'planar');
const normalised = chooseUvMode({ hasUv: true, stretch: 1.2, uv: { planar: 'auto', normalize: true, aspect: true } });
check('a clean island can be normalised', normalised.mode === 'normalize' && normalised.aspect);
check('stretched UVs fall back to planar', chooseUvMode({ hasUv: true, stretch: 12, uv: { planar: 'auto', normalize: true } }).mode === 'planar');
check('planar can be turned off', chooseUvMode({ hasUv: true, stretch: 12, uv: { planar: 'off', normalize: true, aspect: true } }).mode === 'normalize');
check('stretch measure', measureStretch([{ wArea: 1, uvArea: 1 }, { wArea: 1, uvArea: 8 }]) === 8);
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]);
const uvs = new Float32Array([0.25, 0.25, 0.75, 0.25, 0.25, 0.75]);
const report = slotUvReport(positions, uvs, null, [0], 0);
check('slot uv bounds', report.hasUv && Math.abs(report.min[0] - 0.25) < 1e-5 && Math.abs(report.max[1] - 0.75) < 1e-5 && report.frame.size[0] > 0, report);

const head = buildTestHead();
check('head is slightly wide', head.bounds.size[0] > head.bounds.size[2] && head.bounds.size[0] > 1.4, head.bounds.size);
const slots = new Set(head.slots);
check('face panel is its own slot', slots.has(0) && slots.has(1));
let zmin = Infinity, zmax = -Infinity, nz = 0, count = 0, leftPaddle = false, rightPaddle = false, leftPod = false, rightPod = false;
for (let t = 0; t < head.slots.length; t++) {
  for (let k = 0; k < 3; k++) {
    const i = head.indices[t * 3 + k];
    const x = head.positions[i * 3], y = head.positions[i * 3 + 1], z = head.positions[i * 3 + 2];
    if (head.slots[t] === 1) {
      zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
      nz += head.normals[i * 3 + 2]; count++;
    } else {
      if (y > 0.95 && x < -0.05) leftPaddle = true;
      if (y > 0.95 && x > 0.05) rightPaddle = true;
      if (Math.abs(y) < 0.25 && x < -0.85) leftPod = true;
      if (Math.abs(y) < 0.25 && x > 0.85) rightPod = true;
    }
  }
}
check('face panel is gently curved and faces forward', zmax - zmin > 0.02 && nz / count > 0.5, { span: zmax - zmin, nz: nz / count });
check('two paddles and two ear pods', leftPaddle && rightPaddle && leftPod && rightPod);

function memoryMats() {
  const lib = [];
  return {
    lib,
    byId: (id) => lib.find((m) => m.id === id),
    create(def) {
      const row = { ...JSON.parse(JSON.stringify(def)), id: def.id || ('id' + (lib.length + 1)) };
      lib.push(row); return row;
    },
    replace(id, spec) {
      const row = lib.find((m) => m.id === id);
      for (const key of Object.keys(row)) if (key !== 'id') delete row[key];
      Object.assign(row, JSON.parse(JSON.stringify(spec)), { id });
    },
    remove(id) { const i = lib.findIndex((m) => m.id === id); if (i >= 0) lib.splice(i, 1); },
  };
}
const mats = memoryMats();
mats.create({ ...clonePreset('screen'), id: 'preset_screen' });
let history = 0;
const actions = createProgramActions({ mats, pushHistory: () => { history++; }, now: () => 0, findMesh: () => null, selected: () => null });
const created = actions.createProgrammableMaterial({ preset: 'hologram', name: 'Desk hologram' });
check('create is one undo step', created.ok && history === 1 && mats.byId(created.id).kind === 'program');
const edited = actions.editProgrammableMaterial(created.id, { glsl: 'void main(){ eval(1); }' });
check('bad edit does not undo or apply', !edited.ok && history === 1 && !mats.byId(created.id).glsl.includes('eval'));
actions.setMaterialParam('preset_screen', 'smile', 0.4, { blendMs: 0 });
actions.setMaterialState('preset_screen', 'talking', { blendMs: 0 });
check('live param and state do not push undo', history === 1 && sampleRuntime(mats.byId('preset_screen'), 0).talk === 1);
actions.saveMaterialState('preset_screen', 'custom');
check('saving a state is one undo step', history === 2 && mats.byId('preset_screen').states.custom);
const offline = await actions.buildProgrammableMaterial({ brief: 'blue glass' });
check('build without AI explains that', !offline.ok && offline.error === NO_AI && history === 2);
let posts = 0;
const online = createProgramActions({
  mats, pushHistory: () => { history++; }, now: () => 0,
  session: () => ({ connected: () => true, provider: () => 'openai', model: () => 'mock', base: () => 'http://127.0.0.1' }),
  post: async () => { posts++; return { ok: true, spec: { name: 'Glass', glsl: 'mfAlbedo = vec3(0.2, 0.5, 0.9); mfRough = 0.05;\n', params: [{ name: 'clarity', type: 'float', min: 0, max: 1, default: 0.8, label: 'Clarity' }], pbr: { color: '#88bbdd', roughness: 0.05, metalness: 0, emissive: '#000000', emissiveIntensity: 0, opacity: 0.7 } } }; },
});
const built = await online.buildProgrammableMaterial({ brief: 'blue glass', images: [{ data: 'data:image/png;base64,bbbb' }] });
check('mocked build validates and is one undo step', built.ok && posts === 1 && history === 3 && mats.byId(built.id).images[0].data.startsWith('data:image/'));
check('model json fences parse', parseModelJson('```json\n{"glsl":"mfAlpha = 1.0;"}\n```').glsl.includes('mfAlpha'));

const names = ['createProgrammableMaterial', 'editProgrammableMaterial', 'buildProgrammableMaterial', 'listMaterialParams', 'setMaterialParam', 'listMaterialStates', 'setMaterialState', 'saveMaterialState'];
check('agent tools are whitelisted', names.every((name) => isTool(name) && TOOLS.some((tool) => tool.name === name)));
const calls = [];
const api = { actions: {
  createProgrammableMaterial: (opts) => { calls.push(['create', opts.preset]); return { ok: true, name: 'Screen Face' }; },
  editProgrammableMaterial: () => ({ ok: true }),
  buildProgrammableMaterial: async () => ({ ok: false, error: NO_AI }),
  listMaterialParams: () => ({ ok: true, params: [{ name: 'smile' }] }),
  setMaterialParam: () => { calls.push('set'); return { ok: true }; },
  listMaterialStates: () => ({ ok: true, states: EXPRESSIONS }),
  setMaterialState: () => { calls.push('state'); return { ok: true }; },
  saveMaterialState: () => ({ ok: true, state: 'happy' }),
} };
const builtTool = await runTool({ api, confirm: async () => true }, 'buildProgrammableMaterial', { brief: 'a face' });
check('build tool reports a missing provider', !builtTool.ok && builtTool.summary.includes('No AI provider') && !builtTool.text.includes('sk-'));
const listed = await runTool({ api, confirm: async () => true }, 'listMaterialParams', { target: 'preset_screen' });
check('list params tool', listed.ok && listed.text.includes('smile'));
await runTool({ api, confirm: async () => true }, 'setMaterialParam', { target: 'preset_screen', name: 'smile', value: 1, blendMs: 200 });
await runTool({ api, confirm: async () => true }, 'setMaterialState', { target: 'head', name: 'happy', blendMs: 300 });
check('param and state tools call the actions', calls.includes('set') && calls.includes('state'));

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('programmable material tests ok');
