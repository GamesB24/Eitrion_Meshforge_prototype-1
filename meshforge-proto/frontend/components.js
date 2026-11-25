// Actor components. Original MIT code.
// A component is data on an actor or a blueprint. Behaviours move during Play.
// The AI brain may only return a whitelisted command. It cannot run script text.

export const COMPONENT_TYPES = ['mesh', 'collision', 'material', 'behaviour', 'brain', 'voice'];
export const BEHAVIOUR_KINDS = ['wander', 'patrol', 'follow', 'face', 'idle'];

// Commands a brain may apply to its own actor. MeshForge.actions names that
// edit the whole level, or any payload that carries source code, are refused.
export const BRAIN_OPS = [
  'move', 'face', 'say', 'idle', 'setMaterialState', 'setMaterialParam', 'emit',
  'transform_object', 'setCollision', 'listActors',
];

const REFUSED_KEYS = ['code', 'source', 'script', 'eval', 'javascript', 'glsl'];

let seq = 1;
export function nextComponentId() { return 'cmp_' + (seq++); }

function num(v, d = 0) { return Number.isFinite(+v) ? +v : d; }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function text(v, max) { return String(v ?? '').slice(0, max); }

function pointsOf(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of list.slice(0, 16)) {
    if (!Array.isArray(row) || row.length < 2) continue;
    out.push([num(row[0]), num(row[1])]);
  }
  return out;
}

export function normaliseComponent(raw) {
  if (!raw || typeof raw !== 'object' || !COMPONENT_TYPES.includes(raw.type)) return null;
  if (raw.type === 'behaviour' && raw.kind && !BEHAVIOUR_KINDS.includes(raw.kind)) return null;
  const id = raw.id ? String(raw.id) : nextComponentId();
  const base = { id, type: raw.type, enabled: raw.type === 'voice' ? raw.enabled === true : raw.enabled !== false };
  if (raw.type === 'mesh') {
    base.primitive = text(raw.primitive || 'cube', 24) || 'cube';
    base.meshAssetId = raw.meshAssetId ? text(raw.meshAssetId, 80) : null;
    base.visible = raw.visible !== false;
  } else if (raw.type === 'collision') {
    base.preset = text(raw.preset || 'BlockAll', 24) || 'BlockAll';
    base.shape = text(raw.shape || raw.collisionType || 'box', 24) || 'box';
    base.size = Array.isArray(raw.size) ? raw.size.slice(0, 3).map((n) => num(n, 0.5)) : [0.5, 0.5, 0.5];
    base.enabled = raw.enabled !== false && base.preset !== 'NoCollision';
  } else if (raw.type === 'material') {
    base.materialId = text(raw.materialId || '', 80);
    base.state = text(raw.state || '', 48);
    base.slot = raw.slot == null || raw.slot === '' ? null : num(raw.slot, 0);
  } else if (raw.type === 'behaviour') {
    base.kind = BEHAVIOUR_KINDS.includes(raw.kind) ? raw.kind : 'idle';
    base.speed = Math.max(0, num(raw.speed, base.kind === 'face' ? 240 : 1.5));
    base.radius = Math.max(0, num(raw.radius, 4));
    base.pause = Math.max(0, num(raw.pause, 0));
    base.points = pointsOf(raw.points);
    base.target = text(raw.target || '', 80);
    base.stop = Math.max(0, num(raw.stop, 1.2));
    base.turn = Math.max(0, num(raw.turn, base.speed));
  } else if (raw.type === 'brain') {
    base.goal = text(raw.goal || '', 400);
    base.interval = Math.max(0, num(raw.interval, 1.5));
  } else if (raw.type === 'voice') {
    base.hear = raw.hear !== false;
    base.speak = raw.speak !== false;
    base.lang = text(raw.lang || 'en-US', 24) || 'en-US';
  }
  return base;
}

export function publicComponent(comp) {
  const clean = normaliseComponent(comp);
  return clean ? clone(clean) : null;
}

export function publicComponents(list) {
  return (list || []).map(publicComponent).filter(Boolean);
}

export function prepareComponent(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'A component needs a type' };
  if (!COMPONENT_TYPES.includes(raw.type)) return { ok: false, error: 'Unknown component type. Use mesh, collision, material, behaviour, brain, or voice.' };
  if (raw.type === 'behaviour' && raw.kind && !BEHAVIOUR_KINDS.includes(raw.kind)) {
    return { ok: false, error: 'Unknown behaviour. Use wander, patrol, follow, face, or idle.' };
  }
  const component = normaliseComponent(raw);
  if (!component) return { ok: false, error: 'Could not read that component' };
  return { ok: true, component };
}

export function addComponentTo(list, raw) {
  const prepared = prepareComponent(raw);
  if (!prepared.ok) return prepared;
  const next = publicComponents(list);
  if (prepared.component.type !== 'behaviour' && next.some((c) => c.type === prepared.component.type)) {
    return { ok: false, error: 'This actor already has a ' + prepared.component.type + ' component' };
  }
  next.push(prepared.component);
  return { ok: true, components: next, component: publicComponent(prepared.component) };
}

export function removeComponentFrom(list, id) {
  const next = publicComponents(list);
  const index = next.findIndex((c) => c.id === id);
  if (index < 0) return { ok: false, error: 'No component' };
  const [component] = next.splice(index, 1);
  return { ok: true, components: next, component };
}

export function patchComponent(list, id, patch) {
  const next = publicComponents(list);
  const index = next.findIndex((c) => c.id === id);
  if (index < 0) return { ok: false, error: 'No component' };
  if (patch && patch.type && patch.type !== next[index].type) return { ok: false, error: 'A component cannot change type' };
  const merged = { ...next[index], ...(patch || {}), id: next[index].id, type: next[index].type };
  const prepared = prepareComponent(merged);
  if (!prepared.ok) return prepared;
  next[index] = prepared.component;
  return { ok: true, components: next, component: publicComponent(prepared.component) };
}

export function collisionFromComponent(comp) {
  const row = normaliseComponent(comp) || {};
  return {
    enabled: row.enabled !== false && row.preset !== 'NoCollision',
    preset: row.preset || 'BlockAll',
    type: row.shape || 'box',
    size: (row.size || [0.5, 0.5, 0.5]).slice(),
  };
}

export function componentFromCollision(col, id) {
  return normaliseComponent({
    id,
    type: 'collision',
    enabled: col?.enabled !== false,
    preset: col?.preset || 'BlockAll',
    shape: col?.type || 'box',
    size: col?.size || [0.5, 0.5, 0.5],
  });
}

export function resetComponentRuntime(list) {
  for (const comp of list || []) {
    if (!comp || typeof comp !== 'object') continue;
    for (const key of Object.keys(comp)) if (key.startsWith('_')) delete comp[key];
  }
}

export function componentSummary(comp) {
  const row = publicComponent(comp);
  if (!row) return '';
  if (row.type === 'mesh') return row.primitive + (row.visible ? '' : ' hidden');
  if (row.type === 'collision') return row.preset + ' / ' + row.shape;
  if (row.type === 'material') return (row.materialId || 'material') + (row.state ? ' · ' + row.state : '');
  if (row.type === 'behaviour') return row.kind;
  if (row.type === 'brain') return row.goal ? row.goal.slice(0, 42) : 'connected agent';
  if (row.type === 'voice') return row.enabled ? 'on' : 'off';
  return row.type;
}

function hash(textValue) {
  let h = 2166136261;
  const s = String(textValue || '');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function nextSeed(comp) {
  const seed = (Math.imul(comp._seed || hash(comp.id), 1664525) + 1013904223) >>> 0;
  comp._seed = seed;
  return seed / 4294967296;
}

function flat(position, goal) {
  return Math.hypot((goal.x ?? 0) - position[0], (goal.z ?? 0) - position[2]);
}

function yawDegrees(from, to) {
  const dx = (to.x ?? to[0] ?? 0) - from[0];
  const dz = (to.z ?? to[2] ?? to[1] ?? 0) - from[2];
  return Math.atan2(dx, dz) * 180 / Math.PI;
}

function turnToward(current, want, maxStep) {
  let delta = ((want - current + 540) % 360) - 180;
  if (Math.abs(delta) > maxStep) delta = Math.sign(delta) * maxStep;
  return current + delta;
}

function findTarget(spec, self, others) {
  const want = String(spec || '').trim();
  const list = others || [];
  if (!want || want === 'player' || want === 'character') {
    return list.find((a) => a.id !== self.id && (a.type === 'character' || (a.tags || []).includes('player'))) || null;
  }
  return list.find((a) => a.id !== self.id && (a.id === want || a.name === want)) || null;
}

function moveToward(actor, goal, distance) {
  const dx = goal.x - actor.position[0];
  const dz = goal.z - actor.position[2];
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6 || distance <= 0) return;
  const step = Math.min(distance, dist);
  actor.position[0] += dx / dist * step;
  actor.position[2] += dz / dist * step;
  actor.rotation[1] = yawDegrees(actor.position, { x: actor.position[0] + dx, z: actor.position[2] + dz });
}

function stepBehaviour(comp, actor, others, dt) {
  if (!comp || comp.enabled === false || comp.type !== 'behaviour') return;
  const kind = comp.kind;
  if (kind === 'idle') return;
  if (kind === 'face') {
    const target = findTarget(comp.target, actor, others);
    const aim = target ? { x: target.position[0], z: target.position[2] } : null;
    if (!aim) return;
    const want = yawDegrees(actor.position, aim);
    actor.rotation[1] = turnToward(actor.rotation[1] || 0, want, (comp.turn || comp.speed || 240) * dt);
    return;
  }
  if (kind === 'wander') {
    if (!comp._home) comp._home = [actor.position[0], actor.position[2]];
    if (comp._wait > 0) { comp._wait -= dt; return; }
    if (!comp._goal || flat(actor.position, comp._goal) < 0.2) {
      const ang = nextSeed(comp) * Math.PI * 2;
      const rad = comp.radius || 0;
      comp._goal = { x: comp._home[0] + Math.cos(ang) * rad, z: comp._home[1] + Math.sin(ang) * rad };
      comp._wait = comp.pause || 0;
      if (comp._wait > 0) return;
    }
    moveToward(actor, comp._goal, (comp.speed || 0) * dt);
    return;
  }
  if (kind === 'patrol') {
    const points = comp.points || [];
    if (!points.length) return;
    if (comp._index == null) comp._index = 0;
    if (comp._wait > 0) { comp._wait -= dt; return; }
    const pt = points[comp._index % points.length];
    const goal = { x: pt[0], z: pt[1] };
    if (flat(actor.position, goal) < 0.2) {
      comp._index = (comp._index + 1) % points.length;
      comp._wait = comp.pause || 0;
      return;
    }
    moveToward(actor, goal, (comp.speed || 0) * dt);
    return;
  }
  if (kind === 'follow') {
    const target = findTarget(comp.target, actor, others);
    if (!target) return;
    const dx = target.position[0] - actor.position[0];
    const dz = target.position[2] - actor.position[2];
    const dist = Math.hypot(dx, dz);
    const stop = comp.stop ?? 1.2;
    actor.rotation[1] = yawDegrees(actor.position, { x: target.position[0], z: target.position[2] });
    if (dist <= stop) return;
    moveToward(actor, { x: target.position[0], z: target.position[2] }, Math.min((comp.speed || 0) * dt, dist - stop));
  }
}

export function stepActorBehaviours(actors, dt) {
  const step = Math.max(0, +dt || 0);
  const list = actors || [];
  for (const actor of list) {
    if (!actor || actor.dead) continue;
    for (const comp of actor.components || []) stepBehaviour(comp, actor, list, step);
  }
}

export function consumeBrainInterval(comp, dt) {
  if (!comp || comp.type !== 'brain' || comp.enabled === false) return false;
  const interval = Number.isFinite(+comp.interval) ? Math.max(0, +comp.interval) : 1.5;
  if (comp._wait == null) comp._wait = 0;
  comp._wait -= Math.max(0, +dt || 0);
  if (comp._wait > 0) return false;
  comp._wait = interval;
  return true;
}

export function acceptBrainCommand(command, actorId) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return { ok: false, error: 'No command' };
  for (const key of REFUSED_KEYS) {
    if (key in command) return { ok: false, error: 'Arbitrary code is not allowed' };
  }
  const op = String(command.op || command.name || '');
  if (!BRAIN_OPS.includes(op)) return { ok: false, error: 'Command is not in the actor whitelist: ' + op };
  if (command.id && String(command.id) !== String(actorId) && op !== 'listActors') {
    return { ok: false, error: 'That command is for another actor' };
  }
  const clean = { op, actorId: String(actorId) };
  if (op === 'move') { clean.x = num(command.x); clean.y = num(command.y); clean.z = num(command.z); }
  if (op === 'face') {
    clean.target = text(command.target || '', 80);
    if (command.x != null) clean.x = num(command.x);
    if (command.z != null) clean.z = num(command.z);
  }
  if (op === 'say') clean.text = text(command.text, 400);
  if (op === 'setMaterialState') clean.state = text(command.state || command.value || '', 48);
  if (op === 'setMaterialParam') { clean.param = text(command.param || command.name || '', 32); clean.value = command.value; }
  if (op === 'emit') { clean.event = text(command.event || '', 48); clean.data = command.data ?? null; }
  if (op === 'transform_object') {
    if (Array.isArray(command.position)) clean.position = command.position.slice(0, 3).map((n) => num(n));
    if (Array.isArray(command.rotation)) clean.rotation = command.rotation.slice(0, 3).map((n) => num(n));
    if (Array.isArray(command.scale)) clean.scale = command.scale.slice(0, 3).map((n) => num(n, 1));
  }
  if (op === 'setCollision') {
    clean.collision = {
      preset: command.preset ? text(command.preset, 24) : undefined,
      type: command.type && command.type !== 'brain' ? text(command.type, 24) : (command.shape ? text(command.shape, 24) : undefined),
      enabled: command.enabled,
    };
  }
  return { ok: true, command: clean };
}

export function applyBrainCommand(actor, command, others) {
  const accepted = acceptBrainCommand(command?.command || command, actor?.id);
  if (!accepted.ok) return accepted;
  const cmd = accepted.command;
  const effects = [];
  if (cmd.op === 'move') {
    actor.position[0] += cmd.x; actor.position[1] += cmd.y; actor.position[2] += cmd.z;
  } else if (cmd.op === 'face') {
    let aim = null;
    if (cmd.target) {
      const target = findTarget(cmd.target, actor, others || []);
      if (target) aim = { x: target.position[0], z: target.position[2] };
    } else if (cmd.x != null || cmd.z != null) aim = { x: num(cmd.x), z: num(cmd.z) };
    if (aim) actor.rotation[1] = yawDegrees(actor.position, aim);
  } else if (cmd.op === 'say') effects.push({ op: 'say', text: cmd.text });
  else if (cmd.op === 'setMaterialState') {
    actor.materialState = cmd.state;
    const mat = (actor.components || []).find((c) => c.type === 'material');
    if (mat) mat.state = cmd.state;
    effects.push({ op: 'material', actorId: actor.id, materialId: mat?.materialId || '', state: cmd.state, slot: mat?.slot ?? null });
  } else if (cmd.op === 'setMaterialParam') {
    actor.params = actor.params || {};
    actor.params[cmd.param] = cmd.value;
    effects.push({ op: 'param', name: cmd.param, value: cmd.value });
  } else if (cmd.op === 'emit') effects.push({ op: 'emit', name: cmd.event, data: cmd.data });
  else if (cmd.op === 'transform_object') {
    if (cmd.position) actor.position.splice(0, 3, cmd.position[0], cmd.position[1], cmd.position[2]);
    if (cmd.rotation) actor.rotation.splice(0, 3, cmd.rotation[0], cmd.rotation[1], cmd.rotation[2]);
    if (cmd.scale) actor.scale = cmd.scale.slice();
  } else if (cmd.op === 'setCollision' && cmd.collision) {
    const comp = (actor.components || []).find((c) => c.type === 'collision');
    if (comp) {
      if (cmd.collision.preset) comp.preset = cmd.collision.preset;
      if (cmd.collision.type) comp.shape = cmd.collision.type;
      if (cmd.collision.enabled != null) comp.enabled = !!cmd.collision.enabled;
    }
    effects.push({ op: 'collision', collision: collisionFromComponent(comp || { type: 'collision', ...cmd.collision, shape: cmd.collision.type }) });
  }
  return { ok: true, command: cmd, effects };
}

export function materialEventsFrom(components, actorId) {
  const out = [];
  for (const comp of components || []) {
    if (comp.type === 'material' && (comp.materialId || comp.state)) {
      out.push({ actorId, materialId: comp.materialId || '', state: comp.state || '', slot: comp.slot ?? null });
    }
  }
  return out;
}

export const LATER_NOTE = 'Animation timeline and armature fitter are not in this version.';
