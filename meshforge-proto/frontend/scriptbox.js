// Sandboxed gameplay scripts. Original MIT code.
//
// A script is plain JavaScript with lifecycle functions. It never receives the page,
// the DOM, or a network API. The browser runs it inside a Worker. Tests and the
// fallback path run the same wrapper in a restricted function. See the limits note
// at the bottom of this file and in docs/script-editor-guide.md.

export const SCRIPT_LIMITS = {
  maxChars: 100000,
  runtime: 'worker-or-restricted-function',
  noDom: true,
  noNetwork: true,
  noPageEval: true,
};

export const HOOKS = ['onStart', 'onUpdate', 'onOverlap', 'onHit', 'onInteract', 'onEvent', 'onSpeak', 'onHear'];

const WRAP_PRE = `"use strict";
const window = undefined, document = undefined, fetch = undefined, XMLHttpRequest = undefined;
const WebSocket = undefined, importScripts = undefined, Function = undefined;
const globalThis = undefined, self = undefined, global = undefined, process = undefined, require = undefined;
const module = undefined, exports = undefined, indexedDB = undefined, localStorage = undefined;
const sessionStorage = undefined, navigator = undefined, postMessage = undefined, Worker = undefined;
const Deno = undefined, caches = undefined;
`;

const WRAP_POST = `
return {
  onStart: typeof onStart === "function" ? onStart : null,
  onUpdate: typeof onUpdate === "function" ? onUpdate : null,
  onOverlap: typeof onOverlap === "function" ? onOverlap : null,
  onHit: typeof onHit === "function" ? onHit : null,
  onInteract: typeof onInteract === "function" ? onInteract : null,
  onEvent: typeof onEvent === "function" ? onEvent : null,
  onSpeak: typeof onSpeak === "function" ? onSpeak : null,
  onHear: typeof onHear === "function" ? onHear : null
};
`;

const FORBIDDEN = [
  { re: /\beval\s*\(/, message: 'eval is not allowed.' },
  { re: /\bFunction\s*\(/, message: 'Function is not allowed.' },
  { re: /\bconstructor\b/, message: 'constructor is not allowed.' },
  { re: /\b__proto__\b/, message: '__proto__ is not allowed.' },
  { re: /\bglobalThis\b/, message: 'globalThis is not allowed.' },
  { re: /\bdocument\b/, message: 'document is not allowed.' },
  { re: /\bwindow\b/, message: 'window is not allowed.' },
  { re: /\bfetch\s*\(/, message: 'fetch is not allowed. Scripts have no network access.' },
  { re: /\bXMLHttpRequest\b/, message: 'XMLHttpRequest is not allowed.' },
  { re: /\bWebSocket\b/, message: 'WebSocket is not allowed.' },
  { re: /\bimportScripts\b/, message: 'importScripts is not allowed.' },
  { re: /\brequire\s*\(/, message: 'require is not allowed.' },
  { re: /\bprocess\b/, message: 'process is not allowed.' },
  { re: /\bimport\s*\(/, message: 'import() is not allowed.' },
  { re: /(^|[\s;}])import\s+/, message: 'import is not allowed.' },
  { re: /\bpostMessage\b/, message: 'postMessage is not allowed.' },
  { re: /\bindexedDB\b/, message: 'indexedDB is not allowed.' },
  { re: /\blocalStorage\b/, message: 'localStorage is not allowed.' },
  { re: /\bsessionStorage\b/, message: 'sessionStorage is not allowed.' },
];

export const TEMPLATES = {
  rotate: {
    label: 'Rotate',
    type: 'static',
    source: `function onUpdate(dt) {
  api.rotate(0, 40 * dt, 0);
}
`,
  },
  patrol: {
    label: 'Patrol NPC',
    type: 'npc',
    source: `let point = 0;
const points = [[0, 0], [4, 0], [4, 4], [0, 4]];

function onUpdate(dt) {
  const here = points[point];
  const left = api.moveToward(here[0], here[1], 1.6 * dt);
  if (left < 0.15) point = (point + 1) % points.length;
}
`,
  },
  door: {
    label: 'Door trigger',
    type: 'static',
    source: `let open = false;

function onOverlap(other) {
  if (open || other.type !== 'character') return;
  open = true;
  api.move(0, 2.2, 0);
  api.emit('door', { id: api.id, name: api.name });
  api.log('The door opens');
}
`,
  },
  pickup: {
    label: 'Pickup',
    type: 'static',
    source: `function onOverlap(other) {
  if (other.type !== 'character' && !other.hasTag('player')) return;
  api.emit('pickup', { id: api.id, name: api.name });
  api.log('Picked up ' + api.name);
  api.destroy();
}
`,
  },
  companion: {
    label: 'Companion idle and emotions',
    type: 'npc',
    source: `let mood = 'idle';

function onStart() {
  api.log('Companion is here');
}

function onUpdate(dt) {
  const player = api.findActors({ type: 'character' })[0];
  if (!player) return;
  api.moveToward(player.position[0] - 1.2, player.position[2], 2 * dt);
  if (mood === 'happy') api.setMaterialState('happy');
  if (mood === 'sad') api.setMaterialState('sad');
}

function onHear(who, text) {
  const said = String(text || '').toLowerCase();
  if (said.indexOf('hello') >= 0) {
    mood = 'happy';
    api.say('Hello.');
    api.setMaterialState('happy');
  } else if (said.indexOf('sad') >= 0) {
    mood = 'sad';
    api.say('I will stay close.');
    api.setMaterialState('sad');
  }
}

function onInteract() {
  api.say(mood === 'sad' ? 'I am still with you.' : 'Ready when you are.');
}
`,
  },
  level: {
    label: 'Level script',
    type: 'level',
    source: `function onStart() {
  api.log('Level started');
}

function onEvent(name, data) {
  api.log(name + ' ' + JSON.stringify(data || {}));
}
`,
  },
};

export function templateSource(id) {
  return TEMPLATES[id]?.source || '';
}

export function listTemplates() {
  return Object.entries(TEMPLATES).map(([id, row]) => ({ id, label: row.label, type: row.type }));
}

function stripForScan(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\n])*"/g, '""')
    .replace(/`(?:\\.|[^`])*`/g, '``');
}

function lineOfIndex(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

export function validateScript(code) {
  const errors = [];
  const text = String(code ?? '');
  if (text.length > SCRIPT_LIMITS.maxChars) {
    errors.push({ line: 1, message: 'Script is over ' + SCRIPT_LIMITS.maxChars + ' characters.' });
    return errors;
  }
  const stripped = stripForScan(text);
  for (const rule of FORBIDDEN) {
    const match = rule.re.exec(stripped);
    if (match) errors.push({ line: lineOfIndex(stripped, match.index), message: rule.message });
  }
  if (errors.length) return errors;
  try {
    // Syntax only. The constructed function is not called.
    new Function(WRAP_PRE + '\n' + text + '\n' + WRAP_POST);
  } catch (err) {
    errors.push({ line: syntaxLine(err, WRAP_PRE), message: err.message || 'Syntax error' });
  }
  return errors;
}

function syntaxLine(err, prelude) {
  const pre = prelude.split('\n').length;
  const stack = String(err.stack || '');
  const match = /<anonymous>:(\d+)/.exec(stack) || /:(\d+):\d+/.exec(stack);
  if (!match) return 1;
  const reported = +match[1];
  return Math.max(1, reported - pre);
}

export function apiFactory(state, commands, logs, timers) {
  const num = (v, d = 0) => Number.isFinite(+v) ? +v : d;
  const pos = () => (state.transform.position = state.transform.position || [0, 0, 0]);
  function push(cmd) { commands.push(cmd); return cmd; }
  return {
    get id() { return state.id; },
    get name() { return state.name; },
    get type() { return state.type; },
    get tags() { return (state.tags || []).slice(); },
    log(message) {
      const text = String(message ?? '');
      logs.push(text);
      push({ op: 'log', message: text });
    },
    transform() {
      return {
        position: pos().slice(),
        rotation: (state.transform.rotation || [0, 0, 0]).slice(),
        scale: (state.transform.scale || [1, 1, 1]).slice(),
      };
    },
    setPosition(x, y, z) {
      pos()[0] = num(x); pos()[1] = num(y); pos()[2] = num(z);
      push({ op: 'setPosition', position: pos().slice() });
    },
    setRotation(x, y, z) {
      state.transform.rotation = [num(x), num(y), num(z)];
      push({ op: 'setRotation', rotation: state.transform.rotation.slice() });
    },
    setScale(x, y, z) {
      state.transform.scale = [num(x, 1), num(y, 1), num(z, 1)];
      push({ op: 'setScale', scale: state.transform.scale.slice() });
    },
    rotate(x, y, z) {
      const r = state.transform.rotation = state.transform.rotation || [0, 0, 0];
      r[0] += num(x); r[1] += num(y); r[2] += num(z);
      push({ op: 'setRotation', rotation: r.slice() });
    },
    move(x, y, z) {
      const p = pos();
      p[0] += num(x); p[1] += num(y); p[2] += num(z);
      push({ op: 'setPosition', position: p.slice() });
    },
    moveToward(x, z, step) {
      const p = pos();
      const dx = num(x) - p[0];
      const dz = num(z) - p[2];
      const dist = Math.hypot(dx, dz);
      const m = Math.min(Math.max(num(step), 0), dist);
      if (dist > 1e-6) { p[0] += dx / dist * m; p[2] += dz / dist * m; }
      push({ op: 'setPosition', position: p.slice() });
      return dist - m;
    },
    components() { return (state.components || []).map((c) => ({ ...c })); },
    materialParams() { return { ...(state.materialParams || {}) }; },
    setMaterialParam(name, value) { push({ op: 'setMaterialParam', name: String(name), value }); },
    setMaterialState(name) { push({ op: 'setMaterialState', name: String(name) }); },
    spawn(blueprintId, opts) { push({ op: 'spawn', blueprintId: String(blueprintId || ''), opts: opts || {} }); },
    destroy(id) { push({ op: 'destroy', id: id ? String(id) : state.id }); },
    findActors(query) {
      const q = query || {};
      function view(a) {
        const tags = (a.tags || []).slice();
        return {
          id: a.id, name: a.name, type: a.type, spawn: !!a.spawn, tags,
          position: (a.position || a.transform?.position || [0, 0, 0]).slice(),
          hasTag(tag) { return tags.includes(tag); },
        };
      }
      return (state.actors || []).filter((a) => {
        if (q.type && a.type !== q.type) return false;
        if (q.name && a.name !== q.name) return false;
        if (q.tag && !(a.tags || []).includes(q.tag)) return false;
        if (q.spawn && !a.spawn) return false;
        return true;
      }).map(view);
    },
    emit(name, data) { push({ op: 'emit', name: String(name), data: data ?? null }); },
    input() { return JSON.parse(JSON.stringify(state.input || { axes: { x: 0, z: 0 }, jump: false, interact: false, keys: {} })); },
    say(text) { push({ op: 'say', text: String(text ?? '') }); },
    after(seconds, fn) {
      if (typeof fn !== 'function' || !(+seconds >= 0)) return;
      timers.push({ left: +seconds, fn });
    },
  };
}

export function highlightScript(code) {
  const src = String(code ?? '');
  const parts = [];
  const re = /\/\*[\s\S]*?\*\/|\/\/.*$|'(?:\\.|[^'\n])*'|"(?:\\.|[^"\n])*"|`(?:\\.|[^`])*`|\b(?:function|return|if|else|let|const|var|for|while|new|true|false|null)\b|\b\d+(?:\.\d+)?\b/gm;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) parts.push({ kind: 'text', text: src.slice(last, m.index) });
    const token = m[0];
    let kind = 'text';
    if (token.startsWith('/*') || token.startsWith('//')) kind = 'com';
    else if (token.startsWith("'") || token.startsWith('"') || token.startsWith('`')) kind = 'str';
    else if (/^\d/.test(token)) kind = 'num';
    else kind = 'key';
    parts.push({ kind, text: token });
    last = m.index + token.length;
  }
  if (last < src.length) parts.push({ kind: 'text', text: src.slice(last) });
  return parts;
}

export function diffLines(before, after) {
  const A = String(before ?? '').split('\n');
  const B = String(after ?? '').split('\n');
  const n = Math.max(A.length, B.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    if (A[i] === B[i]) rows.push({ type: 'same', line: i + 1, text: A[i] ?? '' });
    else {
      if (A[i] !== undefined) rows.push({ type: 'remove', line: i + 1, text: A[i] });
      if (B[i] !== undefined) rows.push({ type: 'add', line: i + 1, text: B[i] });
    }
  }
  return rows;
}

export function proposeScriptEdit(current, next) {
  const errors = validateScript(next);
  return { ok: errors.length === 0, errors, diff: diffLines(current, next), next: String(next ?? '') };
}

function blankState(seed) {
  const s = seed || {};
  return {
    id: s.id || 'actor',
    name: s.name || 'Actor',
    type: s.type || 'static',
    tags: s.tags || [],
    transform: {
      position: (s.position || s.transform?.position || [0, 0, 0]).slice(),
      rotation: (s.rotation || s.transform?.rotation || [0, 0, 0]).slice(),
      scale: (s.scale || s.transform?.scale || [1, 1, 1]).slice(),
    },
    actors: s.actors || [],
    components: s.components || [],
    materialParams: s.materialParams || {},
    input: s.input || { axes: { x: 0, z: 0 }, jump: false, interact: false, keys: {} },
  };
}

export function createSession(code) {
  const errors = validateScript(code);
  if (errors.length) return { ok: false, errors, logs: [], commands: [] };
  let factory;
  try { factory = new Function('api', WRAP_PRE + '\n' + String(code) + '\n' + WRAP_POST); }
  catch (err) { return { ok: false, errors: [{ line: syntaxLine(err, WRAP_PRE), message: err.message }], logs: [], commands: [] }; }
  const timers = [];
  const logs = [];
  const commands = [];
  const state = blankState();
  const api = apiFactory(state, commands, logs, timers);
  let hooks = null;
  let ready = false;
  function sync(next) {
    commands.length = 0;
    const t = next?.transform || {};
    state.id = next?.id || state.id;
    state.name = next?.name || state.name;
    state.type = next?.type || state.type;
    state.tags = next?.tags || [];
    const p = t.position || [0, 0, 0];
    const r = t.rotation || [0, 0, 0];
    const s = t.scale || [1, 1, 1];
    state.transform.position.splice(0, 3, p[0], p[1], p[2]);
    state.transform.rotation.splice(0, 3, r[0], r[1], r[2]);
    state.transform.scale.splice(0, 3, s[0], s[1], s[2]);
    state.actors = next?.actors || [];
    state.input = next?.input || state.input;
    state.materialParams = next?.materialParams || {};
    state.components = next?.components || [];
  }
  function call(name, args) {
    const fn = hooks && hooks[name];
    if (typeof fn !== 'function') return commands.slice();
    try { fn.apply(undefined, args || []); }
    catch (err) { logs.push('Error in ' + name + ': ' + (err.message || err)); commands.push({ op: 'error', hook: name, message: String(err.message || err) }); }
    return commands.slice();
  }
  return {
    ok: true,
    errors: [],
    logs,
    get commands() { return commands.slice(); },
    get state() { return state; },
    load(next) {
      sync(next || {});
      if (ready) return { ok: true };
      try { hooks = factory(api) || {}; ready = true; }
      catch (err) {
        logs.push(String(err.message || err));
        return { ok: false, message: String(err.message || err) };
      }
      return { ok: true };
    },
    call,
    tickTimers(dt) {
      for (const timer of timers) timer.left -= dt;
      const due = timers.filter((t) => t.left <= 0);
      for (const timer of due) {
        const i = timers.indexOf(timer);
        if (i >= 0) timers.splice(i, 1);
        try { timer.fn(); }
        catch (err) { logs.push('Timer error: ' + (err.message || err)); }
      }
    },
  };
}

export function workerBootstrap() {
  return `
var deny = function () { throw new Error('blocked'); };
try { self.fetch = deny; } catch (e) {}
try { self.XMLHttpRequest = deny; } catch (e) {}
try { self.WebSocket = deny; } catch (e) {}
try { self.importScripts = deny; } catch (e) {}
try { self.indexedDB = undefined; } catch (e2) {}
try { self.caches = undefined; } catch (e3) {}
var sessions = {};
var apiFactory = ${apiFactory.toString()};
function compile(code) {
  return new Function('api', ${JSON.stringify(WRAP_PRE + '\n')} + code + ${JSON.stringify('\n' + WRAP_POST)});
}
self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (msg.op === 'probe') {
    var fetchBlocked = false;
    try { self.fetch('http://127.0.0.1/blocked'); } catch (err) { fetchBlocked = true; }
    postMessage({ op: 'probe', fetchBlocked: fetchBlocked, hasDocument: typeof document !== 'undefined', hasWindow: typeof window !== 'undefined' });
    return;
  }
  function copyState(box, src) {
    src = src || {};
    if (!box.state) {
      box.state = { id: '', name: '', type: 'static', tags: [], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, actors: [], components: [], materialParams: {}, input: {} };
    }
    var s = box.state;
    var t = src.transform || {};
    s.id = src.id || s.id; s.name = src.name || s.name; s.type = src.type || s.type; s.tags = src.tags || [];
    var p = t.position || [0, 0, 0], r = t.rotation || [0, 0, 0], sc = t.scale || [1, 1, 1];
    s.transform.position.splice(0, 3, p[0], p[1], p[2]);
    s.transform.rotation.splice(0, 3, r[0], r[1], r[2]);
    s.transform.scale.splice(0, 3, sc[0], sc[1], sc[2]);
    s.actors = src.actors || [];
    s.components = src.components || [];
    s.materialParams = src.materialParams || {};
    s.input = src.input || {};
  }
  if (msg.op === 'load') {
    try {
      var factory = compile(String(msg.code || ''));
      var box0 = { factory: factory, hooks: null, timers: [], logs: [], commands: [], state: null, api: null };
      copyState(box0, {});
      box0.api = apiFactory(box0.state, box0.commands, box0.logs, box0.timers);
      sessions[msg.id] = box0;
      postMessage({ op: 'loaded', id: msg.id, token: msg.token });
    } catch (err) {
      postMessage({ op: 'error', id: msg.id, token: msg.token, message: String(err.message || err) });
    }
    return;
  }
  if (msg.op === 'call') {
    var box = sessions[msg.id];
    if (!box) { postMessage({ op: 'result', id: msg.id, token: msg.token, commands: [], logs: ['missing script'] }); return; }
    box.commands = [];
    copyState(box, msg.state);
    if (!box.hooks) {
      try { box.hooks = box.factory(box.api) || {}; }
      catch (err2) { postMessage({ op: 'result', id: msg.id, token: msg.token, commands: [], logs: [String(err2.message || err2)] }); return; }
    }
    var fn = box.hooks[msg.hook];
    if (typeof fn === 'function') {
      try { fn.apply(undefined, msg.args || []); }
      catch (err3) { box.logs.push(String(err3.message || err3)); }
    }
    if (msg.dt) {
      for (var i = box.timers.length - 1; i >= 0; i--) {
        box.timers[i].left -= msg.dt;
        if (box.timers[i].left <= 0) {
          var t = box.timers.splice(i, 1)[0];
          try { t.fn(); } catch (err4) { box.logs.push(String(err4.message || err4)); }
        }
      }
    }
    var outLogs = box.logs.slice();
    box.logs.length = 0;
    postMessage({ op: 'result', id: msg.id, token: msg.token, commands: box.commands, logs: outLogs });
  }
  if (msg.op === 'stop') delete sessions[msg.id];
};
`;
}

export const SANDBOX_LIMITS_TEXT = [
  'Scripts run in a Worker when the browser can start one. The Worker is not the page: it is not given the document, the editor objects, or a way to call the network.',
  'Before the script is compiled, fetch, XMLHttpRequest, WebSocket, and importScripts on that Worker are replaced with functions that throw.',
  'The script body is wrapped so the names window, document, fetch, eval, Function, globalThis, process, require, and the storage APIs are local undefined bindings.',
  'A check rejects eval, Function, constructor, import, fetch, and the other names above before the script is kept.',
  'This is a gameplay sandbox, not a security product. The check covers the obvious escapes. A script written to break out of a Worker might still find a novel path. Do not run hostile scripts from the internet.',
  'If the Worker cannot start, MeshForge uses the same wrapper on the page thread. A script that never returns can freeze the tab in that fallback. The page DOM is still not passed in.',
  'There is no access to the file system, to keys, or to another site. Logs stay in the script console.',
].join(' ');
