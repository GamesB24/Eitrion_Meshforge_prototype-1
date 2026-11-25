// Programmable materials: a constrained spec, a GLSL snippet inside a fixed template,
// declared parameters, named states, and UV choices. Original MIT code.
// The snippet is GLSL only. It is never evaluated as JavaScript.

export const NO_AI = 'No AI provider is connected. Open the Agent tab and connect a provider. You can still edit the GLSL and the parameters by hand.';
export const PARAM_TYPES = ['float', 'int', 'bool', 'color', 'vec2', 'vec3', 'texture'];
export const STRETCH_LIMIT = 6;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,20}$/;
const RESERVED = new Set(['time', 'uv', 'resolution', 'albedo', 'roughness', 'metalness', 'emissive', 'alpha', 'light', 'main']);
const MAX_GLSL = 6000;
const MAX_PARAMS = 24;
const MAX_IMAGES = 4;
const MAX_IMAGE = 1800000;

const RT = new WeakMap();

export function runtime(def) {
  let row = RT.get(def);
  if (!row) {
    row = { values: {}, blends: {}, state: '' };
    RT.set(def, row);
  }
  return row;
}

function num(v, fallback = 0) {
  const n = +v;
  return Number.isFinite(n) ? n : fallback;
}
function clamp(v, lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return v;
  return Math.min(hi, Math.max(lo, v));
}
function hexByte(n) {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}
export function normalizeColor(value) {
  if (Array.isArray(value) && value.length >= 3) {
    const scale = value[0] > 1 || value[1] > 1 || value[2] > 1 ? 1 : 255;
    return '#' + hexByte(value[0] * (scale === 1 ? 255 : 1)) + hexByte(value[1] * (scale === 1 ? 255 : 1)) + hexByte(value[2] * (scale === 1 ? 255 : 1));
  }
  const text = String(value || '').trim();
  const m = text.match(/^#?([0-9a-f]{6})$/i);
  return m ? '#' + m[1].toLowerCase() : '#ffffff';
}
function hexRgb(hex) {
  const h = normalizeColor(hex).slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function blendColor(a, b, t) {
  const A = hexRgb(a), B = hexRgb(b);
  return '#' + [0, 1, 2].map((i) => hexByte(A[i] + (B[i] - A[i]) * t)).join('');
}

export function coerceParam(param, value) {
  const type = param.type;
  if (type === 'bool') return value === true || value === 1 || value === '1' || value === 'true';
  if (type === 'color') return normalizeColor(value);
  if (type === 'vec2' || type === 'vec3') {
    const n = type === 'vec2' ? 2 : 3;
    const src = Array.isArray(value) ? value : [];
    return Array.from({ length: n }, (_, i) => num(src[i], 0));
  }
  if (type === 'texture') return typeof value === 'string' && value.startsWith('data:image/') && value.length <= MAX_IMAGE ? value : '';
  const lo = num(param.min, type === 'int' ? 0 : 0);
  const hi = num(param.max, type === 'int' ? 10 : 1);
  const next = clamp(num(value, 0), Math.min(lo, hi), Math.max(lo, hi));
  return type === 'int' ? Math.round(next) : next;
}

export function blendParam(type, a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  if (k >= 1) return b;
  if (k <= 0) return a;
  if (type === 'bool' || type === 'texture') return k < 1 ? a : b;
  if (type === 'color') return blendColor(a, b, k);
  if (type === 'vec2' || type === 'vec3') return a.map((v, i) => v + ((b[i] ?? 0) - v) * k);
  if (type === 'int') return Math.round(a + (b - a) * k);
  return a + (b - a) * k;
}

export function timeWave(drive, base, nowMs) {
  const speed = num(drive?.speed, 1);
  const phase = (nowMs / 1000) * speed + num(drive?.phase, 0);
  let w = 0;
  if (drive?.wave === 'saw') w = phase - Math.floor(phase);
  else if (drive?.wave === 'triangle') {
    const f = phase - Math.floor(phase);
    w = f < 0.5 ? f * 2 : (1 - f) * 2;
  } else w = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
  const amp = num(drive?.amp, 0.5);
  const lo = drive?.lo != null ? num(drive.lo) : base - amp;
  const hi = drive?.hi != null ? num(drive.hi) : base + amp;
  return lo + (hi - lo) * w;
}

function baseOf(param) {
  return param.base !== undefined ? param.base : param.default;
}

export function sampleRuntime(def, nowMs) {
  const rt = runtime(def);
  const out = {};
  for (const param of def.params || []) {
    let value = rt.values[param.name];
    if (value === undefined) value = baseOf(param);
    const blend = rt.blends[param.name];
    if (blend) {
      const t = blend.dur <= 0 ? 1 : Math.min(1, (nowMs - blend.start) / blend.dur);
      value = blendParam(param.type, blend.from, blend.to, t);
      if (t >= 1) {
        delete rt.blends[param.name];
        rt.values[param.name] = blend.to;
        value = blend.to;
      } else rt.values[param.name] = value;
    } else if (param.drive?.source === 'time' && (param.type === 'float' || param.type === 'int')) {
      value = timeWave(param.drive, num(baseOf(param), 0), nowMs);
      if (param.type === 'int') value = Math.round(value);
      rt.values[param.name] = value;
    }
    out[param.name] = value;
  }
  return out;
}

export function setParam(def, name, value, blendMs = 0, nowMs = 0) {
  const param = (def.params || []).find((p) => p.name === name);
  if (!param) return { ok: false, error: 'No parameter ' + name };
  const rt = runtime(def);
  const current = rt.values[name] !== undefined ? rt.values[name] : baseOf(param);
  const next = coerceParam(param, value);
  if (param.type !== 'texture') param.base = next;
  else param.texture = next;
  if (blendMs > 0 && param.type !== 'texture') rt.blends[name] = { from: current, to: next, start: nowMs, dur: blendMs };
  else {
    rt.values[name] = next;
    delete rt.blends[name];
  }
  return { ok: true, name, value: next };
}

export function setState(def, name, blendMs = 0, nowMs = 0) {
  const snap = def.states && def.states[name];
  if (!snap) return { ok: false, error: 'No state ' + name };
  const applied = [];
  for (const [key, value] of Object.entries(snap)) {
    const result = setParam(def, key, value, blendMs, nowMs);
    if (result.ok) applied.push(key);
  }
  runtime(def).state = name;
  return { ok: true, state: name, applied };
}

export function saveState(def, name) {
  const clean = String(name || '').trim().slice(0, 32);
  if (!clean) return { ok: false, error: 'Name the state' };
  const rt = runtime(def);
  const snap = {};
  for (const param of def.params || []) {
    if (param.type === 'texture') continue;
    snap[param.name] = rt.values[param.name] !== undefined ? rt.values[param.name] : baseOf(param);
  }
  def.states = { ...(def.states || {}), [clean]: snap };
  return { ok: true, state: clean, params: snap };
}

export function applyMaterialEvent(def, eventName, data, nowMs = 0) {
  let hits = 0;
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : { value: data };
  for (const param of def.params || []) {
    if (param.drive?.source !== 'event' || param.drive.event !== eventName) continue;
    const key = param.drive.key || 'value';
    if (payload[key] === undefined && payload.value === undefined) continue;
    setParam(def, param.name, payload[key] !== undefined ? payload[key] : payload.value, num(payload.blendMs, 0), nowMs);
    hits++;
  }
  for (const hook of def.hooks || []) {
    if (hook?.event === eventName && hook.state && def.states?.[hook.state]) {
      setState(def, hook.state, num(payload.blendMs, hook.blendMs || 0), nowMs);
      hits++;
    }
  }
  return hits;
}

function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    if (source[i] === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

export function validateGlsl(source) {
  const errors = [];
  const text = String(source || '');
  if (!text.trim()) errors.push('The GLSL snippet is empty.');
  if (text.length > MAX_GLSL) errors.push('The GLSL snippet is too long.');
  if (text.includes('\0')) errors.push('The snippet contains a null character.');
  const code = stripComments(text);
  const banned = [
    [/void\s+main\s*\(/, 'Do not declare main. The template already has one.'],
    [/#\s*version\b/, 'Do not set a GLSL version. The template picks it.'],
    [/#\s*include\b/, 'Includes are not allowed.'],
    [/#\s*extension\b/, 'Extensions are not allowed.'],
    [/\b(eval|Function|document|window)\b/, 'JavaScript is not allowed in the snippet.'],
    [/=>/, 'JavaScript is not allowed in the snippet.'],
    [/<\s*script/i, 'JavaScript is not allowed in the snippet.'],
    [/\b(uniform|attribute|varying)\b/, 'Declare parameters in the parameter list. The template writes the uniforms.'],
    [/\bgl_FragColor\b/, 'Write mfAlbedo, mfRough, mfMetal, mfEmissive, and mfAlpha. The template writes the fragment colour.'],
  ];
  for (const [re, message] of banned) if (re.test(code)) errors.push(message);
  let depth = 0;
  for (const ch of code) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) errors.push('The snippet has unbalanced braces.');
  return errors;
}

function cleanDrive(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.source === 'time') {
    const wave = raw.wave === 'saw' || raw.wave === 'triangle' ? raw.wave : 'sin';
    return { source: 'time', wave, speed: num(raw.speed, 1), amp: raw.amp != null ? num(raw.amp) : undefined, lo: raw.lo != null ? num(raw.lo) : undefined, hi: raw.hi != null ? num(raw.hi) : undefined, phase: num(raw.phase, 0) };
  }
  if (raw.source === 'event') {
    const event = String(raw.event || '').trim().slice(0, 32);
    if (!event || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(event)) return null;
    return { source: 'event', event, key: String(raw.key || 'value').slice(0, 24) };
  }
  return null;
}

function cleanParam(raw, errors, seen) {
  const name = String(raw?.name || '').trim();
  if (!NAME_RE.test(name) || RESERVED.has(name)) {
    errors.push('Parameter name is not allowed: ' + (name || '(blank)'));
    return null;
  }
  if (seen.has(name)) {
    errors.push('Repeated parameter: ' + name);
    return null;
  }
  seen.add(name);
  const type = PARAM_TYPES.includes(raw.type) ? raw.type : null;
  if (!type) {
    errors.push('Unknown parameter type for ' + name);
    return null;
  }
  const param = { name, type, label: String(raw.label || name).slice(0, 40) };
  if (type === 'float' || type === 'int') {
    param.min = num(raw.min, 0);
    param.max = num(raw.max, type === 'int' ? 10 : 1);
    if (param.min > param.max) [param.min, param.max] = [param.max, param.min];
    param.default = coerceParam(param, raw.default !== undefined ? raw.default : param.min);
  } else if (type === 'bool') param.default = coerceParam(param, raw.default);
  else if (type === 'color') param.default = coerceParam(param, raw.default || '#ffffff');
  else if (type === 'vec2') param.default = coerceParam(param, raw.default || [0, 0]);
  else if (type === 'vec3') param.default = coerceParam(param, raw.default || [0, 0, 0]);
  else param.default = '';
  if (raw.base !== undefined && type !== 'texture') param.base = coerceParam(param, raw.base);
  else if (type !== 'texture') param.base = param.default;
  if (type === 'texture' && typeof raw.texture === 'string') param.texture = coerceParam(param, raw.texture);
  const drive = cleanDrive(raw.drive);
  if (drive) param.drive = drive;
  return param;
}

function cleanImages(list, errors) {
  const out = [];
  for (const img of list || []) {
    const data = typeof img === 'string' ? img : img?.data;
    if (typeof data !== 'string' || !data.startsWith('data:image/')) continue;
    if (data.length > MAX_IMAGE) {
      errors.push('A reference image is too large. Use a picture under about 512 px.');
      continue;
    }
    out.push({ id: String(img.id || ('img_' + out.length)).slice(0, 24), name: String(img.name || 'reference').slice(0, 64), data });
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

function cleanPbr(raw) {
  const src = raw || {};
  return {
    color: normalizeColor(src.color || '#888888'),
    roughness: clamp(num(src.roughness, 0.5), 0, 1),
    metalness: clamp(num(src.metalness, 0), 0, 1),
    emissive: normalizeColor(src.emissive || '#000000'),
    emissiveIntensity: clamp(num(src.emissiveIntensity, 0), 0, 8),
    opacity: clamp(num(src.opacity, 1), 0, 1),
  };
}
function cleanChibili(raw) {
  const src = raw || {};
  return {
    bands: clamp(Math.round(num(src.bands, 3)), 1, 5),
    shade: normalizeColor(src.shade || '#3a3348'),
    rim: clamp(num(src.rim, 0.2), 0, 1),
    soft: clamp(num(src.soft, 0.04), 0, 0.5),
  };
}
function cleanUv(raw) {
  const src = raw || {};
  const planar = src.planar === 'on' || src.planar === 'off' || src.planar === 'auto' ? src.planar : (src.planar === true ? 'on' : 'auto');
  return { normalize: !!src.normalize, planar, aspect: src.aspect !== false };
}

export function validateSpec(raw, extra = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['The material spec has to be an object.'] };
  const params = [];
  const seen = new Set();
  for (const item of raw.params || []) {
    if (params.length >= MAX_PARAMS) { errors.push('Too many parameters.'); break; }
    const param = cleanParam(item, errors, seen);
    if (param) params.push(param);
  }
  const glslErrors = validateGlsl(raw.glsl);
  errors.push(...glslErrors);
  const states = {};
  for (const [name, snap] of Object.entries(raw.states || {})) {
    const key = String(name || '').trim().slice(0, 32);
    if (!key || !snap || typeof snap !== 'object') continue;
    const next = {};
    for (const param of params) {
      if (snap[param.name] !== undefined && param.type !== 'texture') next[param.name] = coerceParam(param, snap[param.name]);
    }
    states[key] = next;
  }
  const hooks = [];
  for (const hook of raw.hooks || []) {
    const event = String(hook?.event || '').trim().slice(0, 32);
    const state = String(hook?.state || '').trim().slice(0, 32);
    if (!event || !state || !states[state]) continue;
    hooks.push({ event, state, blendMs: Math.max(0, num(hook.blendMs, 0)) });
  }
  const images = cleanImages(extra.images || raw.images, errors);
  const history = [];
  for (const item of raw.history || []) {
    if (!item || typeof item !== 'object') continue;
    history.push({ at: num(item.at, 0), brief: String(item.brief || '').slice(0, 2000), glsl: String(item.glsl || '').slice(0, MAX_GLSL), params: item.params, pbr: item.pbr, states: item.states });
    if (history.length >= 8) break;
  }
  if (errors.length) return { ok: false, errors };
  const pbr = cleanPbr(raw.pbr);
  const spec = {
    name: String(raw.name || 'Programmable').slice(0, 48),
    kind: 'program',
    color: pbr.color,
    brief: String(extra.brief !== undefined ? extra.brief : (raw.brief || '')).slice(0, 4000),
    images,
    pbr,
    chibili: cleanChibili(raw.chibili),
    params,
    states,
    hooks,
    uv: cleanUv(raw.uv),
    glsl: String(raw.glsl),
    history,
  };
  return { ok: true, spec, errors: [] };
}

export function mergeSpec(current, patch) {
  const base = current || {};
  return {
    ...base,
    ...patch,
    pbr: { ...(base.pbr || {}), ...(patch?.pbr || {}) },
    chibili: { ...(base.chibili || {}), ...(patch?.chibili || {}) },
    uv: { ...(base.uv || {}), ...(patch?.uv || {}) },
    params: patch?.params || base.params,
    states: patch?.states || base.states,
    hooks: patch?.hooks || base.hooks,
    images: patch?.images || base.images,
    glsl: patch?.glsl !== undefined ? patch.glsl : base.glsl,
    brief: patch?.brief !== undefined ? patch.brief : base.brief,
    name: patch?.name || base.name,
    kind: 'program',
  };
}

export function shaderKey(spec) {
  const sig = (spec?.params || []).map((p) => p.name + ':' + p.type).join(',');
  return sig + '|' + (spec?.glsl || '');
}

const HELPERS = `
float mfHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float mfNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = mfHash(i);
  float b = mfHash(i + vec2(1.0, 0.0));
  float c = mfHash(i + vec2(0.0, 1.0));
  float d = mfHash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

function uniformLine(param) {
  const name = 'uP_' + param.name;
  if (param.type === 'color' || param.type === 'vec3') return 'uniform vec3 ' + name + ';';
  if (param.type === 'vec2') return 'uniform vec2 ' + name + ';';
  if (param.type === 'texture') return 'uniform sampler2D ' + name + ';\nuniform float ' + name + 'On;';
  return 'uniform float ' + name + ';';
}

function fragmentSource(spec, standalone) {
  const head = standalone ? `precision mediump float;
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
` : '';
  const uniforms = (spec.params || []).map(uniformLine).join('\n');
  return `${head}uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uBaseColor;
uniform float uRoughness;
uniform float uMetalness;
uniform vec3 uEmissiveColor;
uniform float uEmissiveIntensity;
uniform float uOpacity;
uniform vec3 uShade;
uniform float uBands;
uniform float uSoft;
uniform float uRim;
uniform vec3 uLight;
uniform float uUvMode;
uniform float uUvAspect;
uniform vec2 uUvMin;
uniform vec2 uUvMax;
uniform vec3 uPlanarT;
uniform vec3 uPlanarB;
uniform vec3 uPlanarOrigin;
uniform vec2 uPlanarSize;
${uniforms}
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
varying vec3 vObj;
${HELPERS}
vec2 mfUv() {
  vec2 span = max(uUvMax - uUvMin, vec2(0.0001));
  vec2 normed = (vUv - uUvMin) / span;
  vec2 planar = vec2(dot(vObj - uPlanarOrigin, uPlanarT), dot(vObj - uPlanarOrigin, uPlanarB));
  planar = planar / max(uPlanarSize, vec2(0.0001)) + vec2(0.5);
  vec2 uv = vUv;
  if (uUvMode > 1.5) uv = planar;
  else if (uUvMode > 0.5) uv = normed;
  if (uUvAspect > 0.5) {
    vec2 src = uUvMode > 1.5 ? uPlanarSize : span;
    float a = src.x / max(src.y, 0.0001);
    uv -= vec2(0.5);
    if (a > 1.0) uv.y /= a;
    else uv.x *= a;
    uv += vec2(0.5);
  }
  return uv;
}
float mfBand(float t, float bands, float soft) {
  float q = t * max(bands, 1.0);
  float fl = floor(q);
  float fr = q - fl;
  float lv = fl + smoothstep(1.0 - max(soft, 0.0005), 1.0, fr);
  return clamp(lv / max(bands - 1.0, 1.0), 0.0, 1.0);
}
void main() {
  vec3 mfAlbedo = uBaseColor;
  float mfRough = uRoughness;
  float mfMetal = uMetalness;
  vec3 mfEmissive = uEmissiveColor * uEmissiveIntensity;
  float mfAlpha = uOpacity;
  vec2 mfUV = mfUv();
  ${spec.glsl || ''}
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = normalize(uLight);
  float ndl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  float bands = max(uBands, 1.0);
  float lv = bands < 1.5 ? ndl : mfBand(ndl, bands, uSoft);
  vec3 lit = mfAlbedo * mix(uShade, vec3(1.0), lv);
  vec3 H = normalize(L + V);
  float shin = mix(8.0, 96.0, 1.0 - clamp(mfRough, 0.0, 1.0));
  float spec = pow(max(dot(N, H), 0.0), shin);
  float metal = clamp(mfMetal, 0.0, 1.0);
  vec3 col = mix(lit, mfAlbedo * (lv + spec), metal);
  col += mfAlbedo * spec * (1.0 - metal) * 0.25;
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.0);
  col += vec3(rim * uRim);
  col += mfEmissive;
  gl_FragColor = vec4(col, clamp(mfAlpha, 0.0, 1.0));
}
`;
}

const VERT_RUNTIME = `uniform float uTime;
varying vec3 vN; varying vec3 vW; varying vec2 vUv; varying vec3 vObj;
#include <common>
#include <skinning_pars_vertex>
#include <morphtarget_pars_vertex>
void main() {
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vW = wp.xyz;
  vN = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
  vUv = uv;
  vObj = transformed;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const VERT_STANDALONE = `precision mediump float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
varying vec3 vN; varying vec3 vW; varying vec2 vUv; varying vec3 vObj;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  vUv = uv;
  vObj = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export function buildShaderSources(spec) {
  return {
    key: shaderKey(spec),
    vertex: VERT_RUNTIME,
    fragment: fragmentSource(spec, false),
    vertexStandalone: VERT_STANDALONE,
    fragmentStandalone: fragmentSource(spec, true),
  };
}

export const FALLBACK_GLSL = 'mfAlbedo = vec3(1.0, 0.15, 0.55); mfEmissive = mfAlbedo;';

export function compileSources(gl, spec) {
  const errors = validateGlsl(spec.glsl);
  if (errors.length) return { ok: false, errors };
  if (!gl) return { ok: false, errors: ['No WebGL context is available to compile this shader.'] };
  const src = buildShaderSources(spec);
  function one(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    const log = gl.getShaderInfoLog(shader) || '';
    gl.deleteShader(shader);
    return ok ? '' : log;
  }
  const vert = one(gl.VERTEX_SHADER, src.vertexStandalone);
  const frag = one(gl.FRAGMENT_SHADER, src.fragmentStandalone);
  const logs = [vert, frag].filter(Boolean);
  return { ok: logs.length === 0, errors: logs, sources: src };
}

export function chooseUvMode({ hasUv, stretch, uv }) {
  const opts = cleanUv(uv);
  const missing = !hasUv;
  const stretched = !!hasUv && !(stretch < STRETCH_LIMIT);
  let mode = 'mesh';
  if (opts.planar === 'on' || (opts.planar === 'auto' && (missing || stretched))) mode = 'planar';
  else if (opts.normalize) mode = 'normalize';
  return { mode, aspect: opts.aspect && mode !== 'mesh', missing, stretched, uv: opts };
}

export function measureStretch(tris) {
  const ratios = [];
  for (const tri of tris || []) {
    if (!tri || !(tri.wArea > 1e-10)) continue;
    ratios.push((tri.uvArea || 0) / tri.wArea);
  }
  if (!ratios.length) return Infinity;
  let min = Infinity;
  let max = 0;
  for (const ratio of ratios) {
    if (ratio > 1e-12) min = Math.min(min, ratio);
    max = Math.max(max, ratio);
  }
  if (!Number.isFinite(min) || min <= 0) return Infinity;
  return max / min;
}

export function triArea(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], (b[2] || 0) - (a[2] || 0)];
  const ac = [c[0] - a[0], c[1] - a[1], (c[2] || 0) - (a[2] || 0)];
  const cross = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  return 0.5 * Math.hypot(cross[0], cross[1], cross[2]);
}

function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

export function planarFrame(points, normalHint) {
  let n = normalHint ? normalize3(normalHint) : [0, 0, 1];
  if (!points.length) {
    return { origin: [0, 0, 0], tangent: [1, 0, 0], bitangent: [0, 1, 0], size: [1, 1] };
  }
  const origin = points.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]).map((v) => v / points.length);
  if (!normalHint) {
    const acc = [0, 0, 0];
    for (let i = 1; i < points.length - 1; i += 3) {
      const ab = [points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]];
      const ac = [points[i + 1][0] - points[i - 1][0], points[i + 1][1] - points[i - 1][1], points[i + 1][2] - points[i - 1][2]];
      const c = cross3(ab, ac);
      acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
    }
    if (Math.hypot(acc[0], acc[1], acc[2]) > 1e-8) n = normalize3(acc);
  }
  const up = Math.abs(n[1]) > 0.85 ? [1, 0, 0] : [0, 1, 0];
  const tangent = normalize3(cross3(up, n));
  const bitangent = normalize3(cross3(n, tangent));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    const d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    const x = dot3(d, tangent), y = dot3(d, bitangent);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const size = [Math.max(maxX - minX, 1e-4), Math.max(maxY - minY, 1e-4)];
  return { origin, tangent, bitangent, normal: n, size };
}

export function slotUvReport(positions, uvs, index, slots, slot) {
  const tris = [];
  const points = [];
  const normals = [0, 0, 0];
  let hasUv = !!uvs;
  const triCount = slots.length;
  for (let t = 0; t < triCount; t++) {
    if (slots[t] !== slot) continue;
    const ia = index ? index[t * 3] : t * 3;
    const ib = index ? index[t * 3 + 1] : t * 3 + 1;
    const ic = index ? index[t * 3 + 2] : t * 3 + 2;
    const a = [positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]];
    const b = [positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]];
    const c = [positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]];
    points.push(a, b, c);
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = cross3(ab, ac);
    normals[0] += cr[0]; normals[1] += cr[1]; normals[2] += cr[2];
    if (uvs) {
      const ua = [uvs[ia * 2], uvs[ia * 2 + 1]];
      const ub = [uvs[ib * 2], uvs[ib * 2 + 1]];
      const uc = [uvs[ic * 2], uvs[ic * 2 + 1]];
      tris.push({ wArea: triArea(a, b, c), uvArea: triArea(ua, ub, uc) });
    }
  }
  if (!points.length) return null;
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  if (uvs) {
    for (let t = 0; t < triCount; t++) {
      if (slots[t] !== slot) continue;
      for (let k = 0; k < 3; k++) {
        const vi = index ? index[t * 3 + k] : t * 3 + k;
        const u = uvs[vi * 2], v = uvs[vi * 2 + 1];
        if (!Number.isFinite(u) || !Number.isFinite(v)) hasUv = false;
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        minV = Math.min(minV, v); maxV = Math.max(maxV, v);
      }
    }
  } else hasUv = false;
  if (hasUv && !(maxU - minU > 1e-6) && !(maxV - minV > 1e-6)) hasUv = false;
  const frame = planarFrame(points, Math.hypot(...normals) > 1e-8 ? normals : null);
  return {
    hasUv,
    stretch: hasUv ? measureStretch(tris) : Infinity,
    min: hasUv ? [minU, minV] : [0, 0],
    max: hasUv ? [maxU, maxV] : [1, 1],
    frame,
    count: points.length / 3,
  };
}

export function currentParamList(def, nowMs = 0) {
  const values = sampleRuntime(def, nowMs);
  return (def.params || []).map((param) => ({
    name: param.name,
    type: param.type,
    label: param.label,
    min: param.min,
    max: param.max,
    default: param.default,
    value: values[param.name],
    drive: param.drive || null,
  }));
}

function materialHit(def, mesh, slot) {
  return { ok: true, def, mesh: mesh || null, slot: slot == null ? null : slot, id: def.id, name: def.name };
}

export function resolveProgramTarget(target, slot, ctx) {
  const byId = ctx.byId || (() => null);
  const wanted = target == null || target === '' ? null : String(target);
  if (wanted) {
    const direct = byId(wanted) || (ctx.byName ? ctx.byName(wanted) : null);
    if (direct?.kind === 'program') return materialHit(direct, ctx.findMesh?.(wanted) || null, slot ?? null);
  }
  const mesh = (wanted && ctx.findMesh?.(wanted)) || (!wanted ? ctx.selected?.() : null);
  if (!mesh) {
    if (!wanted) {
      const active = ctx.active?.();
      if (active?.kind === 'program') return materialHit(active, null, null);
    }
    return { ok: false, error: wanted ? 'No programmable material or object matches ' + wanted : 'No programmable material is selected' };
  }
  const slots = mesh.userData?.mf?.slots || [];
  let index = Number.isInteger(slot) ? slot : (Number.isInteger(+slot) && slot !== '' && slot != null ? +slot : null);
  if (index == null) index = mesh.userData?.mf?.active || 0;
  if (byId(slots[index])?.kind !== 'program') index = slots.findIndex((id) => byId(id)?.kind === 'program');
  const def = byId(slots[index]);
  if (!def || def.kind !== 'program') return { ok: false, error: 'That object has no programmable material' };
  return materialHit(def, mesh, index);
}

function snapshot(def) {
  return JSON.parse(JSON.stringify(def));
}

export function createProgramActions(deps) {
  const mats = deps.mats;
  const now = () => (deps.now ? deps.now() : 0);
  const look = () => ({
    byId: (id) => mats.byId(id),
    byName: (name) => deps.byName?.(name) || mats.lib.find((m) => m.name === name) || null,
    findMesh: deps.findMesh,
    selected: deps.selected,
    active: deps.active,
  });
  function history(label, undo, redo) {
    deps.pushHistory?.({ label, undo, redo });
  }
  function commit(id, spec, label) {
    const prev = mats.byId(id);
    if (!prev) return { ok: false, error: 'No programmable material' };
    const before = snapshot(prev);
    const past = Array.isArray(before.history) ? before.history.slice(-7) : [];
    past.push({ at: Date.now(), brief: before.brief || '', glsl: before.glsl, params: before.params, pbr: before.pbr, states: before.states });
    spec.history = past;
    spec.id = id;
    mats.replace(id, spec);
    const after = snapshot(mats.byId(id));
    history(label, () => mats.replace(id, before), () => mats.replace(id, after));
    return { ok: true, id, name: spec.name };
  }
  return {
    createProgrammableMaterial(opts = {}) {
      const seeded = opts.preset ? clonePreset(opts.preset) : blankSpec(opts.name || 'Programmable');
      if (!seeded) return { ok: false, error: 'Unknown preset' };
      if (opts.name) seeded.name = String(opts.name).slice(0, 48);
      if (opts.brief) seeded.brief = String(opts.brief).slice(0, 4000);
      const made = mats.create(seeded);
      const copy = snapshot(made);
      history('Create programmable material ' + made.name, () => mats.remove(made.id), () => { if (!mats.byId(made.id)) mats.create(copy); });
      return { ok: true, id: made.id, name: made.name, preset: opts.preset || '' };
    },
    editProgrammableMaterial(id, patch = {}) {
      const prev = mats.byId(id);
      if (!prev || prev.kind !== 'program') return { ok: false, error: 'No programmable material' };
      const validated = validateSpec(mergeSpec(prev, patch), { brief: patch.brief, images: patch.images });
      if (!validated.ok) return { ok: false, error: validated.errors[0], errors: validated.errors };
      validated.spec.name = patch.name || prev.name;
      return commit(id, validated.spec, 'Edit programmable material');
    },
    async buildProgrammableMaterial(opts = {}) {
      let spec = opts.spec || null;
      if (!spec) {
        const session = deps.session?.();
        if (!session?.connected?.()) return { ok: false, error: NO_AI };
        const body = { provider: session.provider?.() || '', base: session.base?.() || '', model: session.model?.() || '', brief: opts.brief || '', images: opts.images || [], previous: opts.previous || null };
        let data;
        try {
          if (deps.post) data = await deps.post(body);
          else if (deps.bus?.emit) {
            const replies = await Promise.all(deps.bus.emit('ai:material', body).map((reply) => Promise.resolve(reply)));
            data = replies.find((reply) => reply && typeof reply === 'object') || null;
          } else return { ok: false, error: 'No material builder is connected. Materials ask the event bus, not a server address.' };
        } catch { return { ok: false, error: 'Network error' }; }
        if (!data) return { ok: false, error: 'No material builder is connected. Materials ask the event bus, not a server address.' };
        if (!data?.ok || !data.spec) return { ok: false, error: data?.message || data?.error || 'The AI did not return a material', errors: data?.errors || [] };
        const validated = validateSpec(data.spec, { brief: opts.brief, images: opts.images });
        if (!validated.ok) return { ok: false, error: validated.errors[0], errors: validated.errors };
        spec = validated.spec;
      } else {
        const validated = validateSpec(spec, { brief: opts.brief, images: opts.images });
        if (!validated.ok) return { ok: false, error: validated.errors[0], errors: validated.errors };
        spec = validated.spec;
      }
      if (opts.name) spec.name = String(opts.name).slice(0, 48);
      if (opts.brief && !spec.brief) spec.brief = String(opts.brief).slice(0, 4000);
      let id = opts.id;
      if (!id || !mats.byId(id)) {
        const made = mats.create(spec);
        const copy = snapshot(made);
        history('Build programmable material ' + made.name, () => mats.remove(made.id), () => { if (!mats.byId(made.id)) mats.create(copy); });
        return { ok: true, id: made.id, name: made.name };
      }
      return commit(id, spec, 'Build programmable material');
    },
    listMaterialParams(target, slot) {
      const hit = resolveProgramTarget(target, slot, look());
      if (!hit.ok) return hit;
      return { ok: true, id: hit.id, name: hit.name, slot: hit.slot, object: hit.mesh?.name || '', state: runtime(hit.def).state || '', params: currentParamList(hit.def, now()) };
    },
    setMaterialParam(target, name, value, opts = {}) {
      const hit = resolveProgramTarget(target, opts.slot, look());
      if (!hit.ok) return hit;
      const result = setParam(hit.def, name, value, num(opts.blendMs, 0), now());
      if (!result.ok) return result;
      return { ok: true, id: hit.id, name, value: result.value };
    },
    listMaterialStates(target, slot) {
      const hit = resolveProgramTarget(target, slot, look());
      if (!hit.ok) return hit;
      return { ok: true, id: hit.id, name: hit.name, state: runtime(hit.def).state || '', states: Object.keys(hit.def.states || {}) };
    },
    setMaterialState(target, name, opts = {}) {
      const hit = resolveProgramTarget(target, opts.slot, look());
      if (!hit.ok) return hit;
      const result = setState(hit.def, name, num(opts.blendMs, 0), now());
      if (!result.ok) return result;
      return { ok: true, id: hit.id, state: name };
    },
    saveMaterialState(target, name, opts = {}) {
      const hit = resolveProgramTarget(target, opts.slot, look());
      if (!hit.ok) return hit;
      const before = snapshot(hit.def.states || {});
      const saved = saveState(hit.def, name);
      if (!saved.ok) return saved;
      const after = snapshot(hit.def.states || {});
      const id = hit.id;
      history('Save material state ' + saved.state, () => { const d = mats.byId(id); if (d) d.states = JSON.parse(JSON.stringify(before)); }, () => { const d = mats.byId(id); if (d) d.states = JSON.parse(JSON.stringify(after)); });
      return { ok: true, id, state: saved.state };
    },
  };
}

export function blankSpec(name = 'Programmable') {
  return {
    name,
    kind: 'program',
    color: '#242838',
    brief: '',
    images: [],
    pbr: { color: '#242838', roughness: 0.45, metalness: 0.05, emissive: '#7fd0ff', emissiveIntensity: 0.4, opacity: 1 },
    chibili: { bands: 3, shade: '#2a3148', rim: 0.25, soft: 0.04 },
    params: [
      { name: 'glow', type: 'float', min: 0, max: 2, default: 0.6, base: 0.6, label: 'Glow' },
    ],
    states: {},
    hooks: [],
    uv: { normalize: true, planar: 'auto', aspect: true },
    glsl: 'mfEmissive += vec3(0.35, 0.75, 1.0) * uP_glow * (0.65 + 0.35 * sin(uTime * 2.0));\n',
    history: [],
  };
}

function spec(entry) {
  const validated = validateSpec(entry);
  if (!validated.ok) throw new Error(validated.errors.join(' '));
  return validated.spec;
}

const SCREEN_STATES = {
  neutral: { smile: 0, mouthOpen: 0.02, blink: 0, brow: 0, eyeOpen: 1, lookX: 0, lookY: 0, glow: 1, talk: 0 },
  happy: { smile: 1, mouthOpen: 0.18, blink: 0, brow: -0.35, eyeOpen: 0.9, lookX: 0, lookY: 0.15, glow: 1.15, talk: 0 },
  sad: { smile: -1, mouthOpen: 0.04, blink: 0.2, brow: 0.85, eyeOpen: 0.7, lookX: 0, lookY: -0.35, glow: 0.65, talk: 0 },
  surprised: { smile: 0.1, mouthOpen: 1, blink: 0, brow: -0.8, eyeOpen: 1.25, lookX: 0, lookY: 0.2, glow: 1.3, talk: 0 },
  angry: { smile: -0.55, mouthOpen: 0.22, blink: 0.12, brow: 1, eyeOpen: 0.62, lookX: 0, lookY: 0, glow: 1.2, talk: 0 },
  thinking: { smile: 0.15, mouthOpen: 0.02, blink: 0.05, brow: 0.45, eyeOpen: 0.8, lookX: 0.85, lookY: 0.4, glow: 0.85, talk: 0 },
  talking: { smile: 0.35, mouthOpen: 0.2, blink: 0, brow: 0, eyeOpen: 1, lookX: 0, lookY: 0, glow: 1, talk: 1 },
};

const SCREEN_GLSL = `
float pulse = fract(uTime * 0.33);
float autoBlink = smoothstep(0.0, 0.05, pulse) * smoothstep(0.14, 0.07, pulse) * step(0.72, fract(sin(floor(uTime * 0.33) * 13.7) * 43758.5));
float shut = clamp(uP_blink + autoBlink, 0.0, 1.0);
float eyeH = max(0.012, mix(0.11, 0.01, shut) * uP_eyeOpen);
vec2 look = vec2(uP_lookX, uP_lookY) * 0.045;
vec2 el = mfUV - vec2(0.35, 0.62) - look;
vec2 er = mfUV - vec2(0.65, 0.62) - look;
float leftEye = smoothstep(0.018, 0.0, length(vec2(el.x / 0.09, el.y / eyeH)));
float rightEye = smoothstep(0.018, 0.0, length(vec2(er.x / 0.09, er.y / eyeH)));
float eyes = max(leftEye, rightEye);
float browLine = el.y - 0.16 - uP_brow * 0.05;
float brow = smoothstep(0.012, 0.0, abs(browLine)) * smoothstep(0.12, 0.03, abs(el.x));
float open = clamp(uP_mouthOpen + uP_talk * (0.22 + 0.22 * sin(uTime * 9.0)), 0.0, 1.0);
vec2 m = mfUV - vec2(0.5, 0.34);
float curve = m.y - uP_smile * (0.08 - m.x * m.x * 1.4);
float mouth = smoothstep(0.018 + open * 0.07, 0.0, abs(curve)) * smoothstep(0.18, 0.1, abs(m.x));
float ink = clamp(eyes + mouth + brow, 0.0, 1.0);
mfAlbedo = vec3(0.015, 0.03, 0.045);
mfRough = 0.32;
mfMetal = 0.04;
mfEmissive = vec3(0.45, 0.9, 1.0) * ink * uP_glow;
mfAlpha = 1.0;
`;

const HOLO_GLSL = `
float scan = 0.55 + 0.45 * sin(mfUV.y * 90.0 - uTime * uP_speed);
float flick = 0.82 + 0.18 * sin(uTime * 18.0);
float fres = pow(1.0 - max(dot(normalize(vN), normalize(cameraPosition - vW)), 0.0), 1.6);
vec3 tint = uP_tint * scan * flick;
mfAlbedo = tint * 0.15;
mfRough = 0.15;
mfMetal = 0.0;
mfEmissive = tint * (0.45 + fres * uP_edge);
mfAlpha = clamp(uP_opacity * (0.35 + fres), 0.05, 1.0);
`;

const WATER_GLSL = `
vec2 flow = mfUV * uP_scale + vec2(uTime * uP_flow, uTime * 0.15);
float n = mfNoise(flow);
float n2 = mfNoise(mfUV * uP_scale * 2.1 - vec2(uTime * 0.2, uTime * uP_flow));
float wave = n * 0.65 + n2 * 0.35;
vec3 deep = vec3(0.02, 0.12, 0.22);
vec3 shallow = vec3(0.18, 0.62, 0.68);
mfAlbedo = mix(deep, shallow, wave);
mfRough = mix(0.04, 0.32, wave);
mfMetal = 0.02;
float fres = pow(1.0 - max(dot(normalize(vN), normalize(cameraPosition - vW)), 0.0), 3.0);
float foam = smoothstep(0.72, 0.9, n2) * uP_foam;
mfAlbedo = mix(mfAlbedo, vec3(0.85, 0.95, 1.0), clamp(fres * 0.45 + foam, 0.0, 1.0));
mfEmissive = vec3(0.04, 0.18, 0.22) * wave * 0.6;
mfAlpha = uP_opacity;
`;

const PANEL_GLSL = `
float columns = max(uP_columns, 1.0);
float bars = smoothstep(0.45, 0.55, fract(mfUV.x * columns));
float scroll = 0.35 + 0.65 * fract(mfUV.y - uTime * uP_speed);
float pulse = 0.45 + 0.55 * sin(uTime * uP_pulse + mfUV.x * 8.0);
vec3 glow = uP_color * pulse * mix(0.2, 1.0, bars) * scroll * uP_intensity;
mfAlbedo = glow * 0.12;
mfRough = 0.38;
mfMetal = 0.12;
mfEmissive = glow;
mfAlpha = 1.0;
`;

function floatParam(name, label, min, max, value) {
  return { name, type: 'float', label, min, max, default: value, base: value };
}

export const PRESETS = {
  screen: spec({
    name: 'Screen Face',
    brief: 'Emissive screen with procedural eyes, a mouth, blinking, and expression states.',
    pbr: { color: '#071018', roughness: 0.35, metalness: 0.04, emissive: '#73e6ff', emissiveIntensity: 1, opacity: 1 },
    chibili: { bands: 2, shade: '#0c1420', rim: 0.15, soft: 0.03 },
    uv: { normalize: true, planar: 'auto', aspect: true },
    params: [
      floatParam('smile', 'Smile', -1, 1, 0),
      floatParam('mouthOpen', 'Mouth open', 0, 1, 0.02),
      floatParam('blink', 'Blink', 0, 1, 0),
      floatParam('brow', 'Brow', -1, 1, 0),
      floatParam('eyeOpen', 'Eye open', 0.2, 1.6, 1),
      floatParam('lookX', 'Look X', -1, 1, 0),
      floatParam('lookY', 'Look Y', -1, 1, 0),
      floatParam('glow', 'Glow', 0, 2, 1),
      floatParam('talk', 'Talk', 0, 1, 0),
    ],
    states: SCREEN_STATES,
    glsl: SCREEN_GLSL,
  }),
  hologram: spec({
    name: 'Hologram',
    brief: 'Transparent scanline hologram with a fresnel edge and a flicker.',
    pbr: { color: '#12323a', roughness: 0.2, metalness: 0, emissive: '#49f3e0', emissiveIntensity: 1.2, opacity: 0.7 },
    chibili: { bands: 2, shade: '#062026', rim: 0.4, soft: 0.02 },
    uv: { normalize: true, planar: 'auto', aspect: true },
    params: [
      { name: 'tint', type: 'color', label: 'Tint', default: '#49f3e0' },
      floatParam('opacity', 'Opacity', 0.15, 1, 0.75),
      floatParam('edge', 'Edge', 0, 2, 1),
      floatParam('speed', 'Speed', 0, 4, 1.4),
    ],
    states: { steady: { opacity: 0.75, edge: 1, speed: 1.4 }, alert: { opacity: 0.9, edge: 1.6, speed: 2.6 } },
    glsl: HOLO_GLSL,
  }),
  water: spec({
    name: 'Flowing Water',
    brief: 'Animated flowing water with foam, depth colour, and a fresnel edge.',
    pbr: { color: '#0d4f63', roughness: 0.12, metalness: 0.02, emissive: '#083040', emissiveIntensity: 0.3, opacity: 0.92 },
    chibili: { bands: 3, shade: '#083048', rim: 0.35, soft: 0.05 },
    uv: { normalize: false, planar: 'auto', aspect: true },
    params: [
      floatParam('flow', 'Flow', 0, 1.5, 0.35),
      floatParam('scale', 'Scale', 0.4, 8, 2.4),
      floatParam('foam', 'Foam', 0, 1, 0.45),
      floatParam('opacity', 'Opacity', 0.3, 1, 0.92),
    ],
    states: { calm: { flow: 0.12, foam: 0.15, opacity: 0.88 }, storm: { flow: 0.9, foam: 0.85, opacity: 0.8 } },
    glsl: WATER_GLSL,
  }),
  panel: spec({
    name: 'Animated Emissive Panel',
    brief: 'Emissive panel with scrolling bars and a pulse.',
    pbr: { color: '#101018', roughness: 0.4, metalness: 0.1, emissive: '#ffb15a', emissiveIntensity: 1.3, opacity: 1 },
    chibili: { bands: 2, shade: '#201408', rim: 0.2, soft: 0.03 },
    uv: { normalize: true, planar: 'auto', aspect: true },
    params: [
      { name: 'color', type: 'color', label: 'Colour', default: '#ffb15a' },
      floatParam('intensity', 'Intensity', 0, 3, 1.2),
      floatParam('speed', 'Speed', 0, 2, 0.35),
      floatParam('pulse', 'Pulse', 0, 8, 2.2),
      floatParam('columns', 'Columns', 1, 16, 6),
    ],
    states: { idle: { intensity: 0.5, speed: 0.1 }, alert: { intensity: 2.2, speed: 0.8 } },
    glsl: PANEL_GLSL,
  }),
};

export const PRESET_IDS = Object.keys(PRESETS);

export function clonePreset(id) {
  const found = PRESETS[id];
  if (!found) return null;
  return JSON.parse(JSON.stringify(found));
}

export function presetIdFor(def) {
  return PRESET_IDS.find((id) => PRESETS[id].name === def?.name) || '';
}

export function exportSpec(def) {
  if (!def || def.kind !== 'program') return def;
  const copy = JSON.parse(JSON.stringify(def));
  copy.images = (copy.images || []).map((img) => ({ id: img.id, name: img.name, stored: 'project' }));
  copy.history = (copy.history || []).slice(-3).map((item) => ({ at: item.at, brief: item.brief }));
  for (const param of copy.params || []) if (param.texture) param.texture = '';
  return copy;
}

export function parseModelJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); }
  catch { return null; }
}
