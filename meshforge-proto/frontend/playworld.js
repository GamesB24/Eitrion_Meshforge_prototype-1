// Play simulation for actors and scripts. Original MIT code.
// Positions are plain numbers so tests can run without the viewport.
// Stop puts every transform back and removes actors that appeared during Play.

import { normaliseActor } from './actors.js';
import { createSession } from './scriptbox.js';

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function aabb(actor) {
  const p = actor.position;
  const s = actor.collision?.size || [0.5, 0.5, 0.5];
  const hx = Math.abs(s[0]) || 0.5;
  const hy = Math.abs(s[1]) || 0.5;
  const hz = Math.abs(s[2]) || 0.5;
  return { min: [p[0] - hx, p[1] - hy, p[2] - hz], max: [p[0] + hx, p[1] + hy, p[2] + hz] };
}

function overlaps(a, b) {
  return a.min[0] <= b.max[0] && a.max[0] >= b.min[0]
    && a.min[1] <= b.max[1] && a.max[1] >= b.min[1]
    && a.min[2] <= b.max[2] && a.max[2] >= b.min[2];
}

function blocking(actor) {
  const preset = actor.collision?.preset;
  return actor.collision?.enabled !== false && preset === 'BlockAll';
}

export function createPlayWorld() {
  const actors = new Map();
  const sessions = new Map();
  const logs = [];
  const events = [];
  let playing = false;
  let snapshot = null;
  const overlapsPrev = new Set();

  function list() { return [...actors.values()]; }

  function addActor(raw) {
    const actor = {
      id: String(raw.id || ('actor_' + (actors.size + 1))),
      name: String(raw.name || 'Actor'),
      position: (raw.position || [0, 0, 0]).slice(),
      rotation: (raw.rotation || [0, 0, 0]).slice(),
      scale: (raw.scale || [1, 1, 1]).slice(),
      actor: normaliseActor(raw.actor || { type: raw.type || 'static' }),
      script: typeof raw.script === 'string' ? raw.script : '',
      collision: raw.collision ? clone(raw.collision) : { enabled: true, preset: 'BlockAll', type: 'box', size: [0.5, 0.5, 0.5] },
      tags: raw.tags || raw.actor?.tags || [],
      params: {},
      materialState: '',
      spawnedDuringPlay: !!raw.spawnedDuringPlay,
      dead: false,
    };
    actor.type = actor.actor.type;
    actor.spawn = !!actor.actor.spawn;
    actors.set(actor.id, actor);
    return publicRow(actor);
  }

  function publicRow(actor) {
    return {
      id: actor.id,
      name: actor.name,
      type: actor.type,
      spawn: !!actor.spawn,
      tags: (actor.tags || []).slice(),
      position: actor.position.slice(),
      rotation: actor.rotation.slice(),
      scale: actor.scale.slice(),
      blueprintId: actor.actor.blueprintId,
      scriptId: actor.actor.scriptId,
      collision: clone(actor.collision),
      script: actor.script,
      params: { ...actor.params },
      materialState: actor.materialState,
    };
  }

  function snapshotActors() {
    return list().filter((a) => !a.spawnedDuringPlay).map((a) => ({
      id: a.id,
      position: a.position.slice(),
      rotation: a.rotation.slice(),
      scale: a.scale.slice(),
      dead: a.dead,
    }));
  }

  function viewFor(actor, input) {
    return {
      id: actor.id,
      name: actor.name,
      type: actor.type,
      tags: actor.tags,
      transform: { position: actor.position, rotation: actor.rotation, scale: actor.scale },
      actors: list().filter((a) => !a.dead && a.id !== actor.id).map((a) => ({
        id: a.id, name: a.name, type: a.type, spawn: a.spawn, tags: a.tags, position: a.position.slice(),
      })),
      components: [
        { type: 'mesh', name: actor.name },
        { type: 'collision', preset: actor.collision?.preset || 'BlockAll' },
        actor.script ? { type: 'script', name: actor.name } : null,
      ].filter(Boolean),
      materialParams: actor.params,
      input,
    };
  }

  function apply(actor, cmd) {
    if (cmd.op === 'log') logs.push(actor.name + ': ' + cmd.message);
    if (cmd.op === 'error') logs.push(actor.name + ' ' + cmd.hook + ': ' + cmd.message);
    if (cmd.op === 'setPosition' && cmd.position) actor.position = cmd.position.slice();
    if (cmd.op === 'setRotation' && cmd.rotation) actor.rotation = cmd.rotation.slice();
    if (cmd.op === 'setScale' && cmd.scale) actor.scale = cmd.scale.slice();
    if (cmd.op === 'setMaterialParam') actor.params[cmd.name] = cmd.value;
    if (cmd.op === 'setMaterialState') actor.materialState = cmd.name;
    if (cmd.op === 'emit') events.push({ name: cmd.name, data: cmd.data, from: actor.id });
    if (cmd.op === 'say') events.push({ name: 'say', data: { text: cmd.text, from: actor.id }, from: actor.id });
    if (cmd.op === 'destroy') {
      const target = actors.get(cmd.id) || actor;
      target.dead = true;
    }
    if (cmd.op === 'spawn') {
      addActor({
        id: 'spawned_' + Math.random().toString(36).slice(2, 8),
        name: cmd.opts?.name || 'Spawned',
        type: cmd.opts?.type || 'static',
        position: cmd.opts?.position || actor.position.slice(),
        script: cmd.opts?.script || '',
        collision: { enabled: true, preset: 'OverlapAll', type: 'box', size: [0.4, 0.4, 0.4] },
        spawnedDuringPlay: true,
      });
    }
  }

  function separate(a, b) {
    const A = aabb(a), B = aabb(b);
    const px = Math.min(A.max[0], B.max[0]) - Math.max(A.min[0], B.min[0]);
    const pz = Math.min(A.max[2], B.max[2]) - Math.max(A.min[2], B.min[2]);
    if (px < pz) a.position[0] += (a.position[0] < b.position[0] ? -px : px);
    else a.position[2] += (a.position[2] < b.position[2] ? -pz : pz);
  }

  function play() {
    if (playing) return { ok: true, playing: true };
    snapshot = snapshotActors();
    sessions.clear();
    overlapsPrev.clear();
    logs.length = 0;
    for (const actor of list()) {
      if (!actor.script || actor.dead) continue;
      const session = createSession(actor.script);
      if (!session.ok) {
        logs.push(actor.name + ' did not compile: ' + session.errors.map((e) => e.line + ': ' + e.message).join('; '));
        continue;
      }
      const loaded = session.load(viewFor(actor, emptyInput()));
      if (!loaded.ok) { logs.push(actor.name + ' failed: ' + loaded.message); continue; }
      sessions.set(actor.id, session);
      for (const cmd of session.call('onStart', [])) apply(actor, cmd);
    }
    playing = true;
    return { ok: true, playing: true, scripts: sessions.size };
  }

  function stop() {
    if (snapshot) {
      for (const row of snapshot) {
        const actor = actors.get(row.id);
        if (!actor) continue;
        actor.position = row.position.slice();
        actor.rotation = row.rotation.slice();
        actor.scale = row.scale.slice();
        actor.dead = row.dead;
      }
    }
    for (const actor of list()) if (actor.spawnedDuringPlay) actors.delete(actor.id);
    sessions.clear();
    overlapsPrev.clear();
    playing = false;
    snapshot = null;
    return { ok: true, playing: false };
  }

  function tick(dt, input) {
    if (!playing) return { ok: false, error: 'Not playing' };
    const step = Math.max(0, +dt || 0);
    const inp = input || emptyInput();
    for (const actor of list()) {
      if (actor.dead || actor.type !== 'character') continue;
      const speed = 4;
      actor.position[0] += (inp.axes?.x || 0) * speed * step;
      actor.position[2] += (inp.axes?.z || 0) * speed * step;
      if (inp.jump && actor.position[1] <= 0.001) actor.position[1] = 1.2;
      else if (actor.position[1] > 0) actor.position[1] = Math.max(0, actor.position[1] - 6 * step);
    }
    for (const actor of list()) {
      if (actor.dead) continue;
      const session = sessions.get(actor.id);
      if (!session) continue;
      session.load(viewFor(actor, inp));
      session.tickTimers(step);
      for (const cmd of session.call('onUpdate', [step])) apply(actor, cmd);
    }
    const live = list().filter((a) => !a.dead);
    const now = new Set();
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        if (!overlaps(aabb(a), aabb(b))) continue;
        const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
        now.add(key);
        if (!overlapsPrev.has(key)) {
          deliver(a, 'onOverlap', [otherOf(b)]);
          deliver(b, 'onOverlap', [otherOf(a)]);
        }
        if (blocking(a) && blocking(b)) {
          deliver(a, 'onHit', [otherOf(b)]);
          deliver(b, 'onHit', [otherOf(a)]);
          separate(a, b);
        } else if (blocking(a) && b.type === 'character') separate(b, a);
        else if (blocking(b) && a.type === 'character') separate(a, b);
      }
    }
    overlapsPrev.clear();
    for (const key of now) overlapsPrev.add(key);
    if (inp.interact) {
      const who = live.find((a) => a.type === 'character');
      if (who) {
        for (const other of live) {
          if (other === who) continue;
          if (overlaps(aabb(who), aabb(other))) deliver(other, 'onInteract', [otherOf(who)]);
        }
      }
    }
    for (const heard of inp.hear || []) {
      for (const actor of live) deliver(actor, 'onHear', [heard.who || 'agent', heard.text || '']);
    }
    for (const ev of inp.events || []) {
      for (const actor of live) deliver(actor, 'onEvent', [ev.name, ev.data]);
    }
    return { ok: true, playing: true, actors: list().filter((a) => !a.dead).map(publicRow) };
  }

  function otherOf(actor) {
    return { id: actor.id, name: actor.name, type: actor.type, tags: actor.tags.slice(), hasTag: (t) => actor.tags.includes(t), position: actor.position.slice() };
  }

  function deliver(actor, hook, args) {
    const session = sessions.get(actor.id);
    if (!session) return;
    session.load(viewFor(actor, emptyInput()));
    for (const cmd of session.call(hook, args)) apply(actor, cmd);
  }

  return {
    addActor,
    removeActor(id) { actors.delete(id); },
    get(id) { const a = actors.get(id); return a ? publicRow(a) : null; },
    list() { return list().filter((a) => !a.dead).map(publicRow); },
    setScript(id, source) {
      const actor = actors.get(id);
      if (!actor) return { ok: false, error: 'No actor' };
      actor.script = String(source ?? '');
      actor.actor.scriptOverride = true;
      return { ok: true, id };
    },
    play, stop, tick,
    get playing() { return playing; },
    logs: () => logs.slice(),
    events: () => events.slice(),
  };
}

function emptyInput() {
  return { axes: { x: 0, z: 0 }, jump: false, interact: false, keys: {}, hear: [], events: [] };
}
