// Actor and blueprint records. Original MIT code.
// A blueprint is an asset. Placing it makes an actor that inherits from it.
// A field listed in overrides belongs to that actor and is not replaced when the blueprint changes.

import { normaliseComponent, publicComponents } from './components.js';

export const ACTOR_TYPES = ['static', 'character', 'npc', 'level'];

export const ACTOR_LABELS = {
  static: 'Static',
  character: 'Character',
  npc: 'NPC/AI',
  level: 'Level',
};

export function isActorType(value) {
  return ACTOR_TYPES.includes(value);
}

export function blankActor(type = 'static') {
  return {
    type: isActorType(type) ? type : 'static',
    blueprintId: null,
    scriptId: null,
    scriptOverride: false,
    spawn: false,
    tags: [],
    overrides: [],
    team: null,
  };
}

export function normaliseActor(raw, fallback = 'static') {
  const base = blankActor(fallback);
  if (!raw || typeof raw !== 'object') return base;
  if (isActorType(raw.type)) base.type = raw.type;
  if (raw.blueprintId) base.blueprintId = String(raw.blueprintId);
  if (raw.scriptId) base.scriptId = String(raw.scriptId);
  base.scriptOverride = !!raw.scriptOverride;
  base.spawn = !!raw.spawn;
  base.tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)).slice(0, 16) : [];
  base.overrides = Array.isArray(raw.overrides) ? raw.overrides.map((k) => String(k)) : [];
  base.componentsOverride = !!raw.componentsOverride;
  const tagged = base.tags.find((t) => t.startsWith('team:'));
  base.team = raw.team ? String(raw.team) : (tagged ? tagged.slice(5) : null);
  if (base.team && !base.tags.includes('team:' + base.team)) base.tags.push('team:' + base.team);
  return base;
}

export function blankBlueprint(input = {}) {
  const type = isActorType(input.actorType) ? input.actorType : 'static';
  return {
    id: input.id ? String(input.id) : '',
    name: String(input.name || 'Blueprint'),
    kind: 'blueprint',
    actorType: type,
    primitive: input.primitive || 'cube',
    meshAssetId: input.meshAssetId || null,
    script: typeof input.script === 'string' ? input.script : '',
    collision: input.collision ? JSON.parse(JSON.stringify(input.collision)) : null,
    tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t)) : [],
    components: publicComponents(input.components),
  };
}

export function instanceFromBlueprint(blueprint, overrides = {}) {
  const bp = blankBlueprint(blueprint);
  const actor = blankActor(bp.actorType);
  actor.blueprintId = bp.id || null;
  actor.tags = bp.tags.slice();
  const over = [];
  if (isActorType(overrides.actorType) && overrides.actorType !== bp.actorType) {
    actor.type = overrides.actorType;
    over.push('type');
  }
  if (typeof overrides.script === 'string') {
    actor.scriptOverride = true;
    over.push('script');
  }
  if (overrides.collision) over.push('collision');
  if (overrides.spawn != null) {
    actor.spawn = !!overrides.spawn;
    if (actor.spawn !== false) over.push('spawn');
  }
  if (Array.isArray(overrides.tags)) {
    actor.tags = overrides.tags.map((t) => String(t));
    over.push('tags');
  }
  const ownComponents = Array.isArray(overrides.components);
  if (ownComponents) {
    actor.componentsOverride = true;
    over.push('components');
  }
  actor.overrides = over;
  const components = publicComponents(ownComponents ? overrides.components : bp.components).map((c) => normaliseComponent({ ...c, id: c.id })).filter(Boolean);
  return {
    actor,
    script: actor.scriptOverride ? overrides.script : bp.script,
    collision: overrides.collision ? JSON.parse(JSON.stringify(overrides.collision)) : (bp.collision ? JSON.parse(JSON.stringify(bp.collision)) : null),
    primitive: bp.primitive,
    meshAssetId: bp.meshAssetId,
    name: overrides.name || bp.name,
    components,
  };
}

export function publicActor(actor) {
  const row = normaliseActor(actor);
  return {
    type: row.type,
    label: ACTOR_LABELS[row.type],
    blueprintId: row.blueprintId,
    scriptId: row.scriptId,
    scriptOverride: row.scriptOverride,
    spawn: row.spawn,
    tags: row.tags.slice(),
    overrides: row.overrides.slice(),
    team: row.team,
    componentsOverride: row.componentsOverride,
  };
}
