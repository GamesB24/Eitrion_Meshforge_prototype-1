// In-memory level builder. The browser editor implements the same method names
// on window.MeshForge. scripts/build_level.mjs calls only those names.
// Original MIT code.

import { blankActor, blankBlueprint, instanceFromBlueprint, isActorType, normaliseActor, publicActor } from './actors.js';
import { createPlayWorld } from './playworld.js';
import { templateSource, validateScript } from './scriptbox.js';

let seq = 1;
const nid = (p) => p + '_' + (seq++);

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

export function createMemoryForge() {
  const actors = [];
  const blueprints = [];
  const scripts = [];
  const history = [];
  let landscape = { size: 20, width: 20, depth: 20, height: 8, seed: 1, sent: false };
  let projectName = 'Untitled';
  let saved = null;
  let live = null;

  function remember(label, undo, redo) {
    history.push({ label, undo, redo });
    redo();
  }

  function actorRow(row) {
    return {
      id: row.id,
      name: row.name,
      label: row.name,
      type: row.actor.type,
      spawn: !!row.actor.spawn,
      tags: row.actor.tags.slice(),
      position: row.position.slice(),
      rotation: row.rotation.slice(),
      scale: row.scale.slice(),
      collision: clone(row.collision),
      script: row.script,
      scriptId: row.actor.scriptId,
      blueprintId: row.actor.blueprintId,
      kind: row.kind,
      actor: publicActor(row.actor),
    };
  }

  function find(id) {
    return actors.find((a) => a.id === id || a.name === id) || null;
  }

  function newProject(opts = {}) {
    const prev = { actors: clone(actors), landscape: clone(landscape), name: projectName, scripts: clone(scripts), blueprints: clone(blueprints) };
    const apply = (pack) => {
      actors.splice(0, actors.length, ...pack.actors);
      Object.assign(landscape, pack.landscape);
      projectName = pack.name;
      scripts.splice(0, scripts.length, ...pack.scripts);
      blueprints.splice(0, blueprints.length, ...pack.blueprints);
    };
    const next = { actors: [], landscape: { size: 20, width: 20, depth: 20, height: 8, seed: 1, sent: false }, name: opts.name || 'Untitled', scripts: [], blueprints: [] };
    remember('New project', () => apply(prev), () => apply(next));
    return { ok: true, name: projectName };
  }

  function setLandscapeSize(spec = {}) {
    const before = clone(landscape);
    const width = Number(spec.width ?? spec.size ?? landscape.width);
    const depth = Number(spec.depth ?? width);
    const size = width;
    const height = Number(spec.height ?? landscape.height);
    const after = { ...landscape, width, depth, size, height, square: true, depthUsed: size };
    remember('Landscape size', () => Object.assign(landscape, before), () => Object.assign(landscape, after));
    return { ok: true, ...landscape, note: 'The landscape map is square. Depth uses the same edge as width.' };
  }

  function generateLandscape(opts = {}) {
    const before = landscape.seed;
    const seed = opts.seed ?? before;
    remember('Generate landscape', () => { landscape.seed = before; }, () => { landscape.seed = seed; });
    return { ok: true, seed };
  }

  function sendLandscapeToScene() {
    if (actors.some((a) => a.kind === 'landscape')) return { ok: true, id: actors.find((a) => a.kind === 'landscape').id, note: 'already sent' };
    const row = {
      id: nid('landscape'), name: 'Landscape', kind: 'landscape', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      actor: normaliseActor({ type: 'level', tags: ['landscape'] }),
      collision: { enabled: true, preset: 'BlockAll', type: 'complex', size: [landscape.size / 2, 1, landscape.size / 2] },
      script: '',
    };
    remember('Send landscape', () => { const i = actors.findIndex((a) => a.id === row.id); if (i >= 0) actors.splice(i, 1); landscape.sent = false; }, () => { actors.push(row); landscape.sent = true; });
    return { ok: true, id: row.id };
  }

  function placePrimitive(spec = {}) {
    const kind = spec.kind || 'cube';
    const id = nid(kind);
    const actor = normaliseActor({ type: spec.actorType || (kind === 'capsule' ? 'character' : 'static'), tags: spec.tags || [] });
    const row = {
      id, name: spec.name || kind, kind, position: (spec.position || [0, 0, 0]).slice(),
      rotation: (spec.rotation || [0, 0, 0]).slice(), scale: spec.scale ? [].concat(spec.scale).slice() : [1, 1, 1],
      actor, collision: clone(spec.collision) || defaultCollision(actor.type, kind), script: spec.script || '',
    };
    if (row.scale.length === 1) row.scale = [row.scale[0], row.scale[0], row.scale[0]];
    remember('Place ' + row.name, () => { const i = actors.findIndex((a) => a.id === id); if (i >= 0) actors.splice(i, 1); }, () => actors.push(row));
    return { ok: true, id, name: row.name, type: actor.type };
  }

  function setActorType(id, type) {
    const row = find(id);
    if (!row) return { ok: false, error: 'No actor' };
    if (!isActorType(type)) return { ok: false, error: 'Unknown actor type' };
    const before = row.actor.type;
    remember('Actor type', () => { row.actor.type = before; }, () => { row.actor.type = type; if (!row.actor.overrides.includes('type')) row.actor.overrides.push('type'); });
    return { ok: true, id: row.id, type };
  }

  function setCollision(id, patch) {
    const row = find(id);
    if (!row) return { ok: false, error: 'No actor' };
    const before = clone(row.collision);
    const after = { ...before, ...clone(patch) };
    remember('Collision', () => { row.collision = before; }, () => { row.collision = after; });
    return { ok: true, id: row.id, collision: clone(after) };
  }

  function setScript(id, source) {
    const row = find(id);
    if (!row) return { ok: false, error: 'No actor' };
    const errors = validateScript(source);
    if (errors.length) return { ok: false, error: errors[0].message, errors };
    const before = row.script;
    const beforeId = row.actor.scriptId;
    const scriptId = nid('script');
    const rec = { id: scriptId, name: row.name + ' script', ownerId: row.id, kind: 'actor', language: 'javascript', source: String(source) };
    remember('Set script', () => {
      row.script = before; row.actor.scriptId = beforeId;
      const i = scripts.findIndex((s) => s.id === scriptId); if (i >= 0) scripts.splice(i, 1);
    }, () => {
      row.script = String(source); row.actor.scriptId = scriptId; row.actor.scriptOverride = true; scripts.push(rec);
    });
    return { ok: true, id: row.id, scriptId };
  }

  function attachScript(id, scriptId) {
    const row = find(id);
    const rec = scripts.find((s) => s.id === scriptId);
    if (!row || !rec) return { ok: false, error: 'No actor or script' };
    const before = { script: row.script, scriptId: row.actor.scriptId };
    remember('Attach script', () => { row.script = before.script; row.actor.scriptId = before.scriptId; }, () => { row.script = rec.source; row.actor.scriptId = rec.id; });
    return { ok: true };
  }

  function detachScript(id) {
    const row = find(id);
    if (!row) return { ok: false, error: 'No actor' };
    const before = { script: row.script, scriptId: row.actor.scriptId };
    remember('Detach script', () => { row.script = before.script; row.actor.scriptId = before.scriptId; }, () => { row.script = ''; row.actor.scriptId = null; });
    return { ok: true };
  }

  function addSpawn(spec = {}) {
    const made = placePrimitive({
      kind: 'spawn', name: spec.name || 'Spawn', position: spec.position || [0, 0, 0],
      actorType: 'static', tags: ['spawn'], collision: { enabled: false, preset: 'NoCollision', type: 'none', size: [0.3, 0.3, 0.3] },
    });
    const row = find(made.id);
    if (row) row.actor.spawn = true;
    return { ok: true, id: made.id, name: spec.name || 'Spawn', spawn: true };
  }

  function createBlueprint(spec = {}) {
    const bp = blankBlueprint({ ...spec, id: spec.id || nid('bp') });
    if (bp.script) {
      const errors = validateScript(bp.script);
      if (errors.length) return { ok: false, error: errors[0].message, errors };
    }
    remember('Create blueprint', () => { const i = blueprints.findIndex((b) => b.id === bp.id); if (i >= 0) blueprints.splice(i, 1); }, () => blueprints.push(bp));
    return { ok: true, id: bp.id, name: bp.name, actorType: bp.actorType };
  }

  function spawnActor(spec = {}) {
    const bp = blueprints.find((b) => b.id === spec.blueprint || b.name === spec.blueprint);
    if (!bp) return { ok: false, error: 'No blueprint' };
    const inst = instanceFromBlueprint(bp, spec);
    const id = nid('actor');
    const row = {
      id, name: spec.name || inst.name, kind: inst.primitive, position: (spec.position || [0, 0, 0]).slice(),
      rotation: [0, 0, 0], scale: (spec.scale || [1, 1, 1]).slice(),
      actor: inst.actor, collision: inst.collision || defaultCollision(inst.actor.type, inst.primitive), script: inst.script || '',
    };
    row.actor.blueprintId = bp.id;
    remember('Spawn actor', () => { const i = actors.findIndex((a) => a.id === id); if (i >= 0) actors.splice(i, 1); }, () => actors.push(row));
    return { ok: true, id, name: row.name, type: row.actor.type, blueprintId: bp.id };
  }

  function listActors() { return actors.map(actorRow); }

  function runPlay() {
    live = createPlayWorld();
    for (const row of actors) {
      live.addActor({
        id: row.id, name: row.name, type: row.actor.type, position: row.position.slice(),
        rotation: row.rotation.slice(), scale: row.scale.slice(), actor: row.actor,
        script: row.script, collision: row.collision, tags: row.actor.tags,
      });
    }
    return live.play();
  }
  function stopPlay() {
    const result = live ? live.stop() : { ok: true, playing: false };
    live = null;
    return result;
  }

  function listScriptables() {
    const rows = actors.map((a) => ({ id: a.id, name: a.name, kind: a.actor.type, scriptId: a.actor.scriptId, language: 'javascript' }));
    for (const bp of blueprints) rows.push({ id: bp.id, name: bp.name, kind: 'blueprint', language: 'javascript' });
    for (const s of scripts) rows.push({ id: s.id, name: s.name, kind: s.kind, language: s.language });
    return rows;
  }

  function getScript(id) {
    const rec = scripts.find((s) => s.id === id);
    if (rec) return { ok: true, id: rec.id, source: rec.source, language: rec.language };
    const row = find(id);
    if (row) return { ok: true, id: row.id, source: row.script || '', language: 'javascript' };
    const bp = blueprints.find((b) => b.id === id);
    if (bp) return { ok: true, id: bp.id, source: bp.script || '', language: 'javascript' };
    return { ok: false, error: 'No script' };
  }

  function validate(source) {
    const errors = validateScript(source);
    return { ok: errors.length === 0, errors };
  }

  function projectFiles() {
    return {
      'scene.json': JSON.stringify({
        version: 1, generator: 'MeshForge 8.0', name: projectName, units: 'm',
        landscape, objects: actors.map(actorRow),
      }, null, 2),
      'scripts.json': JSON.stringify({ version: 1, scripts, blueprints }, null, 2),
      'materials.json': '[]',
    };
  }

  function saveProject(path) {
    const file = String(path || 'demo-yard.mfproj');
    if (!file.toLowerCase().endsWith('.mfproj')) return { ok: false, error: 'Project path must end with .mfproj' };
    saved = { path: file, files: projectFiles() };
    return { ok: true, path: file, files: saved.files };
  }

  function loadProject(files) {
    const scene = JSON.parse(files['scene.json'] || '{}');
    const pack = JSON.parse(files['scripts.json'] || '{"scripts":[],"blueprints":[]}');
    actors.splice(0, actors.length);
    for (const o of scene.objects || []) {
      actors.push({
        id: o.id, name: o.name, kind: o.kind, position: o.position, rotation: o.rotation, scale: o.scale,
        actor: normaliseActor(o.actor), collision: o.collision, script: o.script || '',
      });
    }
    scripts.splice(0, scripts.length, ...(pack.scripts || []));
    blueprints.splice(0, blueprints.length, ...(pack.blueprints || []));
    if (scene.landscape) Object.assign(landscape, scene.landscape);
    projectName = scene.name || projectName;
    return { ok: true, actors: actors.length };
  }

  return {
    newProject, setLandscapeSize, generateLandscape, sendLandscapeToScene, placePrimitive,
    setActorType, setCollision, setScript, attachScript, detachScript, addSpawn,
    createBlueprint, spawnActor, listActors, listScriptables, getScript, runPlay, stopPlay,
    validateScript: validate, scriptTemplate: templateSource, saveProject, loadProject, projectFiles,
    undo() { const step = history.pop(); if (step) step.undo(); return !!step; },
    get history() { return history.map((h) => h.label); },
    get saved() { return saved; },
  };
}

function defaultCollision(type, kind) {
  if (kind === 'spawn') return { enabled: false, preset: 'NoCollision', type: 'none', size: [0.3, 0.3, 0.3] };
  if (type === 'character' || type === 'npc' || kind === 'capsule') return { enabled: true, preset: 'Pawn', type: 'capsule', size: [0.35, 0.8, 0.35] };
  if (type === 'level') return { enabled: true, preset: 'BlockAll', type: 'complex', size: [10, 1, 10] };
  return { enabled: true, preset: 'BlockAll', type: kind === 'sphere' ? 'sphere' : 'box', size: [0.5, 0.5, 0.5] };
}

export { blankActor };
