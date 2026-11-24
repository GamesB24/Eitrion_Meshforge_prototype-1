// Play mode, actors, collision editing, and the script editor host.
// Original MIT code. The Worker runs gameplay scripts. The page only applies the command list.
import { createAssetEditor } from './asset_editor.js';
import { normaliseActor, blankBlueprint, instanceFromBlueprint, isActorType, publicActor, ACTOR_LABELS } from './actors.js';
import { setBrowserExtras, onAssetActivate, onAssetCommand } from './content.js';
import {
  createCollisionDebug, ensureAll, ensureCollision, moveActor, publicCollision, setCollision,
} from './collision.js';
import { validateGlsl } from './progmat.js';
import { createScriptEditor } from './scripteditor.js';
import {
  createSession, diffLines, proposeScriptEdit, templateSource, validateScript, workerBootstrap, SANDBOX_LIMITS_TEXT,
} from './scriptbox.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function installGameplay(ctx) {
  const THREE = ctx.THREE;
  const library = { scripts: [], blueprints: [] };
  let scriptSeq = 1;
  const keys = new Set();
  let playing = false;
  let snap = [];
  const born = new Set();
  const sessions = new Map();
  let worker = null;
  let useWorker = false;
  const waiters = new Map();
  let tokenN = 1;
  let frame = null;
  const heard = [];
  const overlapWas = new Set();
  let interactLatch = false;
  let saveTimer = 0;

  const collisionView = createCollisionDebug(ctx.scene);
  const assetEditor = createAssetEditor({
    status: ctx.status,
    onAssetSaved: (asset) => {
      if (asset._meshAsset) asset._meshAsset.collision = JSON.parse(JSON.stringify(asset.payload.collision || {}));
      ctx.status('Collision saved');
    },
  });
  const editorUi = createScriptEditor({
    validate(tab) {
      if (tab.language === 'glsl') {
        const errors = validateGlsl(tab.source).map((message, i) => ({ line: i + 1, message }));
        let paramsOk = true;
        try { JSON.parse(tab.paramsText || '[]'); } catch (err) { paramsOk = false; errors.push({ line: 1, message: 'Parameters are not valid JSON. ' + err.message }); }
        return { ok: errors.length === 0 && paramsOk, errors };
      }
      const errors = validateScript(tab.source);
      return { ok: errors.length === 0, errors };
    },
    template: templateSource,
    propose(current, next, language) {
      if (language === 'glsl') {
        const errors = validateGlsl(next).map((message) => ({ line: 1, message }));
        return { ok: errors.length === 0, errors, next, diff: diffLines(current, next) };
      }
      return proposeScriptEdit(current, next);
    },
    async save(tab) { return saveTab(tab); },
    async ask(body) { return askProvider(body); },
    autosave() { scheduleSave(); },
    touch() { scheduleSave(); },
    onAccept(tab) { ctx.pushHistory?.({ label: 'Accept script edit', undo() {}, redo() {} }); void tab; },
  });

  const details = document.createElement('details');
  details.id = 'actorDetails';
  details.open = true;
  details.innerHTML = `<summary>Actor</summary><div id="actorBody"></div>`;
  document.querySelector('.props')?.prepend(details);

  const bar = document.querySelector('.vheader');
  if (bar && !document.getElementById('playBtn')) {
    const play = document.createElement('button');
    play.id = 'playBtn'; play.className = 'ib'; play.type = 'button'; play.textContent = 'Play';
    const stop = document.createElement('button');
    stop.id = 'stopBtn'; stop.className = 'ib'; stop.type = 'button'; stop.textContent = 'Stop';
    const col = document.createElement('label');
    col.className = 'ib';
    col.innerHTML = '<input id="colDbg" type="checkbox"> Collision';
    bar.append(play, stop, col);
    play.onclick = () => runPlay();
    stop.onclick = () => stopPlay();
    col.querySelector('input').onchange = (e) => collisionView.set(e.target.checked, ctx.getModel());
  }

  function idOf(obj) { return obj?.userData?.sceneId || obj?.uuid || ''; }
  function guessType(obj) {
    if (obj?.userData?.isScene) return 'level';
    const name = String(obj?.name || '').toLowerCase();
    if (name.includes('npc') || name.includes('companion')) return 'npc';
    if (name.includes('player') || name.includes('character')) return 'character';
    return 'static';
  }
  function actorOf(obj, type) {
    if (!obj) return normaliseActor(type || 'static');
    obj.userData.actor = normaliseActor(obj.userData.actor, type || guessType(obj));
    if (type && isActorType(type)) obj.userData.actor.type = type;
    return obj.userData.actor;
  }
  function resolve(id) {
    if (!id) return ctx.editor.sel || ctx.getModel();
    if (id === 'level' || id === ctx.getModel()?.uuid) return ctx.getModel();
    return ctx.findSceneNode(id) || ctx.getModel();
  }
  function eachNode(fn) {
    const root = ctx.getModel();
    const nodes = [];
    if (root?.userData?.isScene) nodes.push(root);
    for (const o of ctx.sceneObjects()) nodes.push(o);
    return nodes.filter((o) => o).map((o) => fn(o));
  }
  function scriptSource(obj) {
    const actor = actorOf(obj);
    if (actor.scriptId) {
      const rec = library.scripts.find((s) => s.id === actor.scriptId);
      if (rec && !actor.scriptOverride) return rec.source;
    }
    return obj.userData.scriptSource || '';
  }
  function materialParamsOf(obj) {
    const slots = obj?.userData?.mf?.slots || [];
    const out = {};
    for (const slot of slots) {
      const def = ctx.mats?.byId?.(slot);
      if (def?.kind === 'program') for (const p of def.params || []) out[p.name] = p.base ?? p.default;
    }
    return out;
  }
  function readInput() {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    const down = (k) => !typing && keys.has(k);
    const x = (down('d') || down('arrowright') ? 1 : 0) - (down('a') || down('arrowleft') ? 1 : 0);
    const z = (down('s') || down('arrowdown') ? 1 : 0) - (down('w') || down('arrowup') ? 1 : 0);
    const len = Math.hypot(x, z);
    return {
      axes: len ? { x: x / len, z: z / len } : { x: 0, z: 0 },
      jump: down(' '),
      interact: interactLatch,
      keys: { w: down('w'), a: down('a'), s: down('s'), d: down('d') },
    };
  }
  function stateOf(obj) {
    const actor = actorOf(obj);
    const others = eachNode((o) => o).filter((o) => o !== obj).map((o) => ({
      id: idOf(o), name: o.name, type: actorOf(o).type, spawn: !!actorOf(o).spawn, tags: actorOf(o).tags.slice(),
      position: [o.position.x, o.position.y, o.position.z],
    }));
    return {
      id: idOf(obj), name: obj.name || 'Actor', type: actor.type, tags: actor.tags.slice(),
      transform: {
        position: [obj.position.x, obj.position.y, obj.position.z],
        rotation: [obj.rotation.x * R2D, obj.rotation.y * R2D, obj.rotation.z * R2D],
        scale: [obj.scale.x, obj.scale.y, obj.scale.z],
      },
      actors: others,
      components: [
        { type: obj.isMesh ? 'mesh' : 'group', name: obj.name || '' },
        obj.userData.collision ? { type: 'collision', preset: obj.userData.collision.preset } : null,
        scriptSource(obj) ? { type: 'script', name: obj.name || '' } : null,
      ].filter(Boolean),
      materialParams: materialParamsOf(obj),
      input: readInput(),
    };
  }
  function applyCommands(obj, commands) {
    for (const cmd of commands || []) {
      if (cmd.op === 'log') editorUi.log((obj.name || 'Script') + ': ' + cmd.message);
      if (cmd.op === 'error') editorUi.log((obj.name || 'Script') + ' ' + cmd.hook + ': ' + cmd.message);
      if (cmd.op === 'setPosition' && cmd.position) obj.position.set(+cmd.position[0] || 0, +cmd.position[1] || 0, +cmd.position[2] || 0);
      if (cmd.op === 'setRotation' && cmd.rotation) obj.rotation.set((+cmd.rotation[0] || 0) * D2R, (+cmd.rotation[1] || 0) * D2R, (+cmd.rotation[2] || 0) * D2R);
      if (cmd.op === 'setScale' && cmd.scale) obj.scale.set(+cmd.scale[0] || 1, +cmd.scale[1] || 1, +cmd.scale[2] || 1);
      if (cmd.op === 'setMaterialParam') ctx.programActions?.setMaterialParam?.(idOf(obj), cmd.name, cmd.value, { blendMs: 0 });
      if (cmd.op === 'setMaterialState') ctx.programActions?.setMaterialState?.(idOf(obj), cmd.name, { blendMs: 80 });
      if (cmd.op === 'emit') heard.push({ event: true, name: cmd.name, data: cmd.data });
      if (cmd.op === 'say') { editorUi.log((obj.name || 'Actor') + ' says: ' + cmd.text); heard.push({ who: obj.name || 'actor', text: cmd.text }); }
      if (cmd.op === 'destroy') {
        obj.visible = false;
        obj.userData.playDead = true;
      }
      if (cmd.op === 'spawn' && cmd.blueprintId) spawnActor({ blueprint: cmd.blueprintId, position: obj.position.toArray(), duringPlay: true });
    }
  }

  function bootWorker() {
    if (worker) return useWorker;
    try {
      const url = URL.createObjectURL(new Blob([workerBootstrap()], { type: 'application/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (ev) => {
        const msg = ev.data || {};
        const waiter = waiters.get(msg.token);
        if (waiter) { waiters.delete(msg.token); waiter(msg); }
      };
      useWorker = true;
    } catch (err) {
      useWorker = false;
      editorUi.log('Worker did not start (' + (err.message || err) + '). Using the restricted runtime on this thread.');
    }
    return useWorker;
  }
  function post(msg) {
    const token = 't' + (tokenN++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiters.delete(token); resolve({ commands: [], logs: ['timed out'] }); }, 800);
      waiters.set(token, (data) => { clearTimeout(timer); resolve(data); });
      worker.postMessage({ ...msg, token });
    });
  }
  async function callHook(obj, hook, args, dt) {
    const id = idOf(obj);
    const source = scriptSource(obj);
    if (!source || obj.userData.playDead) return;
    const state = stateOf(obj);
    if (useWorker) {
      if (!sessions.has(id)) {
        const loaded = await post({ op: 'load', id, code: source });
        if (loaded.op === 'error') { editorUi.log(obj.name + ': ' + loaded.message); return; }
        sessions.set(id, { worker: true });
      }
      const result = await post({ op: 'call', id, hook, args, state, dt: dt || 0 });
      for (const line of result.logs || []) editorUi.log(obj.name + ': ' + line);
      applyCommands(obj, result.commands);
      return;
    }
    let session = sessions.get(id);
    if (!session) {
      session = createSession(source);
      if (!session.ok) { editorUi.log(obj.name + ': ' + session.errors.map((e) => e.message).join('; ')); return; }
      sessions.set(id, session);
    }
    session.load(state);
    if (dt) session.tickTimers(dt);
    applyCommands(obj, session.call(hook, args));
  }

  function takeSnap() {
    snap = [];
    ctx.getModel()?.traverse((o) => {
      if (!o.position) return;
      snap.push({ obj: o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(), visible: o.visible });
    });
  }
  function restoreSnap() {
    for (const row of snap) {
      if (!row.obj.parent && row.obj !== ctx.getModel()) continue;
      row.obj.position.copy(row.p);
      row.obj.quaternion.copy(row.q);
      row.obj.scale.copy(row.s);
      row.obj.visible = row.visible;
      row.obj.userData.playDead = false;
    }
    for (const obj of born) {
      obj.parent?.remove(obj);
    }
    born.clear();
    snap = [];
  }

  async function runPlay() {
    if (playing) return { ok: true, playing: true };
    ensureAll(ctx.getModel());
    takeSnap();
    sessions.clear();
    overlapWas.clear();
    bootWorker();
    playing = true;
    const playBtn = document.getElementById('playBtn');
    if (playBtn) playBtn.classList.add('on');
    ctx.status(useWorker ? 'Playing. Scripts are in a Worker. Escape stops.' : 'Playing. Scripts are in the restricted runtime. Escape stops.');
    for (const obj of eachNode((o) => o)) {
      if (scriptSource(obj)) await callHook(obj, 'onStart', []);
    }
    const spawn = eachNode((o) => o).find((o) => actorOf(o).spawn && actorOf(o).type !== 'character');
    const player = eachNode((o) => o).find((o) => actorOf(o).type === 'character');
    if (spawn && player) player.position.set(spawn.position.x, player.position.y, spawn.position.z);
    return { ok: true, playing: true, runtime: useWorker ? 'worker' : 'restricted' };
  }
  async function stopPlay() {
    if (!playing && !snap.length) return { ok: true, playing: false };
    playing = false;
    if (worker) for (const id of sessions.keys()) worker.postMessage({ op: 'stop', id });
    sessions.clear();
    restoreSnap();
    const playBtn = document.getElementById('playBtn');
    if (playBtn) playBtn.classList.remove('on');
    ctx.status('Stopped. Transforms are back where Play started.');
    ctx.updateInfo?.();
    return { ok: true, playing: false };
  }

  function meshesOf(root) {
    const out = [];
    root?.traverse((o) => { if (o.isMesh && !o.userData.isOverlay && !o.userData.isCollisionDebug) out.push(o); });
    return out;
  }
  function moveCharacters(dt) {
    const input = readInput();
    const meshes = meshesOf(ctx.getModel());
    for (const obj of eachNode((o) => o)) {
      if (actorOf(obj).type !== 'character' || obj.userData.playDead) continue;
      const speed = 4;
      const delta = new THREE.Vector3(input.axes.x * speed * dt, 0, input.axes.z * speed * dt);
      const feet = obj.position.clone();
      const moved = moveActor(obj, feet, delta, meshes);
      obj.position.copy(moved.position);
      if (input.jump && obj.position.y <= 0.05) obj.position.y = 1.1;
      else if (!input.jump && obj.position.y > 0 && actorOf(obj).type === 'character') obj.position.y = Math.max(0, obj.position.y - 5 * dt);
    }
  }
  function worldBox(obj) {
    const box = new THREE.Box3();
    if (obj.isMesh || obj.isGroup) box.setFromObject(obj);
    else box.setFromCenterAndSize(obj.position, new THREE.Vector3(1, 1, 1));
    return box;
  }
  function hits(a, b) {
    return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y && a.min.z <= b.max.z && a.max.z >= b.min.z;
  }
  async function overlaps() {
    const nodes = eachNode((o) => o).filter((o) => !o.userData.playDead && o.visible !== false);
    const now = new Set();
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const ca = a.userData.collision, cb = b.userData.collision;
        if (ca?.preset === 'NoCollision' || cb?.preset === 'NoCollision') continue;
        if (!ca && !cb) continue;
        if (!hits(worldBox(a), worldBox(b))) continue;
        const key = idOf(a) < idOf(b) ? idOf(a) + '|' + idOf(b) : idOf(b) + '|' + idOf(a);
        now.add(key);
        if (!overlapWas.has(key)) {
          await callHook(a, 'onOverlap', [brief(b)]);
          await callHook(b, 'onOverlap', [brief(a)]);
        }
        if (ca?.preset === 'BlockAll' && cb?.preset === 'BlockAll') {
          await callHook(a, 'onHit', [brief(b)]);
          await callHook(b, 'onHit', [brief(a)]);
        }
      }
    }
    overlapWas.clear();
    for (const key of now) overlapWas.add(key);
    if (interactLatch) {
      const who = nodes.find((o) => actorOf(o).type === 'character');
      if (who) for (const other of nodes) if (other !== who && hits(worldBox(who), worldBox(other))) await callHook(other, 'onInteract', [brief(who)]);
      interactLatch = false;
    }
  }
  function brief(obj) {
    const tags = actorOf(obj).tags.slice();
    return { id: idOf(obj), name: obj.name, type: actorOf(obj).type, tags, hasTag: (t) => tags.includes(t), position: [obj.position.x, obj.position.y, obj.position.z] };
  }

  async function step(dt) {
    if (!playing) return;
    moveCharacters(dt);
    for (const obj of eachNode((o) => o)) if (scriptSource(obj)) await callHook(obj, 'onUpdate', [dt], dt);
    const queued = heard.splice(0, heard.length);
    for (const item of queued) {
      for (const obj of eachNode((o) => o)) {
        if (item.event) await callHook(obj, 'onEvent', [item.name, item.data]);
        else await callHook(obj, 'onHear', [item.who, item.text]);
      }
    }
    await overlaps();
    if (collisionView.visible()) collisionView.rebuild(ctx.getModel());
  }
  function tick(dt) {
    if (!playing || frame) return;
    frame = step(dt || 0).finally(() => { frame = null; });
  }

  function placePrimitive(spec = {}) {
    const kind = String(spec.kind || 'cube');
    const mat = new THREE.MeshStandardMaterial({ color: kind === 'spawn' ? 0xe0c36a : 0xc8c8c8, roughness: 0.6 });
    let node;
    if (kind === 'building') {
      node = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(1, 0.75, 1), mat);
      body.position.y = 0.375;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(0.78, 0.42, 4), new THREE.MeshStandardMaterial({ color: 0x8d4b32, roughness: 0.8 }));
      roof.position.y = 0.96;
      roof.rotation.y = Math.PI / 4;
      node.add(body, roof);
    } else if (kind === 'sphere') {
      const geo = new THREE.SphereGeometry(0.5, 20, 14);
      geo.translate(0, 0.5, 0);
      node = new THREE.Mesh(geo, mat);
    } else if (kind === 'capsule') {
      const geo = new THREE.CapsuleGeometry(0.32, 0.7, 4, 8);
      geo.translate(0, 0.67, 0);
      node = new THREE.Mesh(geo, mat);
    } else if (kind === 'plane') {
      node = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
    } else if (kind === 'spawn') {
      const geo = new THREE.OctahedronGeometry(0.28);
      geo.translate(0, 0.45, 0);
      node = new THREE.Mesh(geo, mat);
    } else if (kind === 'sky' || kind === 'water') {
      return ctx.addSkyWater?.(kind) || { ok: false, error: 'Use addPrimitive for sky and water' };
    } else {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      geo.translate(0, 0.5, 0);
      node = new THREE.Mesh(geo, mat);
    }
    node.name = spec.name || (kind.charAt(0).toUpperCase() + kind.slice(1));
    const p = spec.position || [0, 0, 0];
    node.position.set(+p[0] || 0, +p[1] || 0, +p[2] || 0);
    if (spec.rotation) node.rotation.set((+spec.rotation[0] || 0) * D2R, (+spec.rotation[1] || 0) * D2R, (+spec.rotation[2] || 0) * D2R);
    if (Array.isArray(spec.scale)) node.scale.set(+spec.scale[0] || 1, +spec.scale[1] || 1, +spec.scale[2] || 1);
    else if (spec.scale != null) node.scale.setScalar(+spec.scale || 1);
    const type = spec.actorType || (kind === 'capsule' ? 'character' : 'static');
    actorOf(node, type);
    if (Array.isArray(spec.tags)) node.userData.actor.tags = spec.tags.map(String);
    if (spec.collision) node.traverse((o) => { if (o.isMesh) setCollision(o, spec.collision); });
    else node.traverse((o) => { if (o.isMesh) ensureCollision(o); });
    const carrier = node.isMesh ? node : node.children?.find((c) => c.isMesh);
    if (carrier?.userData?.collision) node.userData.collision = carrier.userData.collision;
    if (spec.duringPlay) born.add(node);
    ctx.addUndoable(ctx.ensureScene(true), node, { id: kind, label: node.name, source: 'primitive' }, 'Place ' + node.name);
    ctx.applyShading?.();
    ctx.updateInfo?.();
    return { ok: true, id: idOf(node), name: node.name, type: node.userData.actor.type };
  }

  function setActorType(id, type) {
    const obj = resolve(id);
    if (!obj) return { ok: false, error: 'No actor' };
    if (!isActorType(type)) return { ok: false, error: 'Actor type must be static, character, npc, or level' };
    const before = actorOf(obj).type;
    const mesh = obj.isMesh ? obj : obj.children?.find((c) => c.isMesh);
    const beforeCol = mesh ? publicCollision(mesh.userData.collision) : null;
    const applyType = (next, col) => {
      actorOf(obj).type = next;
      if (mesh && col) setCollision(mesh, col);
      if (mesh && (next === 'character' || next === 'npc') && col == null) setCollision(mesh, { preset: 'Pawn', type: 'capsule' });
      refreshDetails();
    };
    applyType(type, null);
    const afterCol = mesh ? publicCollision(mesh.userData.collision) : null;
    ctx.pushHistory?.({
      label: 'Actor type',
      undo: () => applyType(before, beforeCol),
      redo: () => applyType(type, afterCol),
    });
    return { ok: true, id: idOf(obj), type };
  }
  function setCollisionOn(id, patch) {
    const obj = resolve(id);
    if (!obj) return { ok: false, error: 'No actor' };
    const meshes = [];
    obj.traverse?.((o) => { if (o.isMesh) meshes.push(o); });
    if (!meshes.length && obj.isMesh) meshes.push(obj);
    const before = meshes.map((m) => publicCollision(m.userData.collision));
    const apply = (list) => list.forEach((col, i) => { if (meshes[i] && col) setCollision(meshes[i], col); });
    meshes.forEach((m) => setCollision(m, patch || {}));
    const after = meshes.map((m) => publicCollision(m.userData.collision));
    ctx.pushHistory?.({ label: 'Collision', undo: () => apply(before), redo: () => apply(after) });
    if (collisionView.visible()) collisionView.rebuild(ctx.getModel());
    return { ok: true, id: idOf(obj), collision: after[0] };
  }
  function setScript(id, source) {
    const obj = resolve(id);
    if (!obj) return { ok: false, error: 'No actor' };
    const errors = validateScript(source ?? '');
    if (String(source || '').trim() && errors.length) return { ok: false, error: errors[0].message, errors };
    const actor = actorOf(obj);
    const before = { source: obj.userData.scriptSource || '', scriptId: actor.scriptId };
    const recId = 'script_' + (scriptSeq++);
    const apply = (pack) => {
      obj.userData.scriptSource = pack.source;
      actor.scriptId = pack.scriptId;
      actor.scriptOverride = !!pack.source;
      const i = library.scripts.findIndex((s) => s.ownerId === idOf(obj));
      if (!pack.source) { if (i >= 0) library.scripts.splice(i, 1); return; }
      const rec = { id: pack.scriptId || recId, name: (obj.name || 'Actor') + ' script', ownerId: idOf(obj), kind: actor.type, language: 'javascript', source: pack.source };
      if (i >= 0) library.scripts[i] = rec; else library.scripts.push(rec);
    };
    apply({ source: String(source ?? ''), scriptId: recId });
    ctx.pushHistory?.({ label: 'Set script', undo: () => apply(before), redo: () => apply({ source: String(source ?? ''), scriptId: recId }) });
    scheduleSave();
    return { ok: true, id: idOf(obj), scriptId: recId };
  }
  function attachScript(id, scriptId) {
    const rec = library.scripts.find((s) => s.id === scriptId);
    if (!rec) return { ok: false, error: 'No script' };
    return setScript(id, rec.source);
  }
  function detachScript(id) { return setScript(id, ''); }
  function addSpawn(spec = {}) {
    const made = placePrimitive({ kind: 'spawn', name: spec.name || 'Spawn', position: spec.position || [0, 0, 0], actorType: 'static', tags: ['spawn'], collision: { enabled: false, preset: 'NoCollision', type: 'none', size: [0.3, 0.3, 0.3] } });
    const obj = resolve(made.id);
    if (obj) actorOf(obj).spawn = true;
    return { ok: true, id: made.id, name: made.name, spawn: true };
  }
  function createBlueprint(spec = {}) {
    const bp = blankBlueprint({ ...spec, id: spec.id || ('bp_' + (scriptSeq++)) });
    if (bp.script && validateScript(bp.script).length) return { ok: false, error: validateScript(bp.script)[0].message, errors: validateScript(bp.script) };
    library.blueprints.push(bp);
    ctx.pushHistory?.({ label: 'Create blueprint', undo: () => { const i = library.blueprints.findIndex((b) => b.id === bp.id); if (i >= 0) library.blueprints.splice(i, 1); refreshBrowser(); }, redo: () => { library.blueprints.push(bp); refreshBrowser(); } });
    refreshBrowser();
    return { ok: true, id: bp.id, name: bp.name, actorType: bp.actorType };
  }
  function spawnActor(spec = {}) {
    const bp = library.blueprints.find((b) => b.id === spec.blueprint || b.name === spec.blueprint);
    if (!bp) return { ok: false, error: 'No blueprint' };
    const inst = instanceFromBlueprint(bp, spec);
    const made = placePrimitive({
      kind: inst.primitive || 'cube', name: spec.name || inst.name, position: spec.position, scale: spec.scale,
      actorType: inst.actor.type, collision: inst.collision || undefined, tags: inst.actor.tags, duringPlay: spec.duringPlay,
    });
    const obj = resolve(made.id);
    if (obj) {
      obj.userData.actor = inst.actor;
      obj.userData.actor.blueprintId = bp.id;
      if (inst.script) obj.userData.scriptSource = inst.script;
    }
    return { ok: true, id: made.id, name: made.name, type: inst.actor.type, blueprintId: bp.id };
  }
  function listActors() {
    return eachNode((obj) => {
      const actor = actorOf(obj);
      const mesh = obj.isMesh ? obj : obj.children?.find((c) => c.isMesh);
      return {
        id: idOf(obj), name: obj.name || 'Actor', label: obj.name || 'Actor', type: actor.type, typeLabel: ACTOR_LABELS[actor.type],
        spawn: !!actor.spawn, tags: actor.tags.slice(), blueprintId: actor.blueprintId, scriptId: actor.scriptId,
        position: [obj.position.x, obj.position.y, obj.position.z],
        rotation: [obj.rotation.x * R2D, obj.rotation.y * R2D, obj.rotation.z * R2D],
        scale: [obj.scale.x, obj.scale.y, obj.scale.z],
        collision: publicCollision(mesh?.userData?.collision || obj.userData.collision),
        script: scriptSource(obj),
        actor: publicActor(actor),
      };
    });
  }
  function listScriptables() {
    const rows = listActors().map((a) => ({ id: a.id, name: a.name, kind: a.type, scriptId: a.scriptId, language: 'javascript' }));
    for (const bp of library.blueprints) rows.push({ id: bp.id, name: bp.name, kind: 'blueprint', language: 'javascript' });
    for (const mat of ctx.mats?.lib || []) if (mat.kind === 'program') rows.push({ id: mat.id, name: mat.name, kind: 'material', language: 'glsl' });
    return rows;
  }
  function getScript(id) {
    const mat = ctx.mats?.byId?.(id);
    if (mat?.kind === 'program') return { ok: true, id, source: mat.glsl || '', language: 'glsl', params: mat.params || [] };
    const rec = library.scripts.find((s) => s.id === id);
    if (rec) return { ok: true, id: rec.id, source: rec.source, language: rec.language || 'javascript' };
    const obj = resolve(id);
    if (obj && (obj.userData?.sceneId || obj.userData?.isScene)) return { ok: true, id: idOf(obj), source: scriptSource(obj), language: 'javascript' };
    return { ok: false, error: 'No script' };
  }
  function setLandscapeSize(spec = {}) {
    const P = ctx.land?.state?.params;
    if (!P) return { ok: false, error: 'Landscape is not ready' };
    const before = JSON.parse(JSON.stringify(P));
    const width = Number(spec.width ?? spec.size ?? P.size);
    const depth = Number(spec.depth ?? width);
    const height = spec.height == null ? null : Number(spec.height);
    const apply = (pack) => {
      P.size = pack.size;
      P.base = pack.base;
      P.noiseAmp = pack.noiseAmp;
      ctx.land.rebuild();
    };
    const next = { size: width, base: { ...P.base }, noiseAmp: P.noiseAmp };
    if (height != null) {
      const k = height / 8;
      next.base = { sand: 0.25 * k, grass: 0.8 * k, water: -1.2 * k, mountain: 4.5 * k };
      next.noiseAmp = 0.5 * k;
    }
    apply(next);
    ctx.pushHistory?.({ label: 'Landscape size', undo: () => apply({ size: before.size, base: before.base, noiseAmp: before.noiseAmp }), redo: () => apply(next) });
    return { ok: true, size: width, width, depth, height: height ?? null, square: true, depthUsed: width, note: 'The landscape map is square. Depth uses the same edge as width.' };
  }
  async function saveProject(path) {
    const file = String(path || '');
    if (!file.toLowerCase().endsWith('.mfproj')) return { ok: false, error: 'Project path must end with .mfproj' };
    try {
      const blob = await ctx.buildProject();
      const res = await fetch('/api/projects/save?path=' + encodeURIComponent(file), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.detail || 'Save failed' };
      ctx.status('Saved ' + body.path);
      return { ok: true, path: body.path };
    } catch (err) {
      return { ok: false, error: err.message || 'Save failed' };
    }
  }
  function newProject(opts = {}) {
    const root = ctx.ensureScene(false);
    root.name = opts.name || 'Scene';
    actorOf(root, 'level');
    library.scripts = library.scripts.filter((s) => s.kind === 'material');
    library.blueprints = [];
    refreshBrowser();
    ctx.status('New project');
    return { ok: true, name: root.name };
  }

  function refreshBrowser() {
    setBrowserExtras(library.blueprints.map((bp) => ({
      id: bp.id, name: bp.name, category: 'blueprint', kind: 'blueprint', blueprintId: bp.id,
      title: ACTOR_LABELS[bp.actorType] + ' blueprint. Drag into the view to place an actor.',
    })), 'blueprints');
  }
  function openScript(obj) {
    if (!obj) return;
    const actor = actorOf(obj);
    editorUi.open({ id: 'actor:' + idOf(obj), title: (obj.name || 'Actor') + ' script', language: 'javascript', source: scriptSource(obj), owner: { id: idOf(obj) }, kind: actor.type, refresh: true });
  }
  function openShader(materialId) {
    const def = ctx.mats?.byId?.(materialId);
    if (!def) return;
    editorUi.open({
      id: 'mat:' + materialId, title: def.name + ' shader', language: 'glsl', kind: 'material', refresh: true,
      source: def.glsl || '', paramsText: JSON.stringify(def.params || [], null, 2), owner: { materialId },
    });
  }
  async function saveTab(tab) {
    if (tab.language === 'glsl' && tab.owner?.materialId) {
      let params;
      try { params = JSON.parse(tab.paramsText || '[]'); }
      catch (err) { return { ok: false, error: err.message }; }
      const result = ctx.programActions?.editProgrammableMaterial?.(tab.owner.materialId, { glsl: tab.source, params }) || { ok: false, error: 'Material editor is not ready' };
      return result;
    }
    if (tab.owner?.id) return setScript(tab.owner.id, tab.source);
    if (tab.owner?.blueprintId) {
      const bp = library.blueprints.find((b) => b.id === tab.owner.blueprintId);
      if (!bp) return { ok: false, error: 'No blueprint' };
      const errors = validateScript(tab.source);
      if (errors.length) return { ok: false, error: errors[0].message, errors };
      bp.script = tab.source;
      return { ok: true };
    }
    return { ok: false, error: 'Nothing to save' };
  }
  async function askProvider(body) {
    const session = window.MeshForge?.agentSession;
    if (!session?.connected?.()) return { ok: false, error: 'No AI provider is connected. You can still edit the script by hand. The key is never written into the project.' };
    try {
      const res = await fetch('/api/plugins/ai-agent/script', {
        method: 'POST',
        headers: { ...(session.headers?.() || {}), 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: session.provider(), model: session.model(), base: session.base(), brief: body.brief, source: body.source, language: body.language }),
      });
      const data = await res.json();
      if (!data.ok || !data.script) return { ok: false, error: data.message || 'The provider did not return a script.' };
      return { ok: true, source: data.script };
    } catch {
      return { ok: false, error: 'Network error' };
    }
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { ctx.autosave?.('script'); }, 4000);
  }
  let detailKey = '';
  function refreshDetails() {
    const obj = ctx.editor.sel || ctx.getModel();
    const body = details.querySelector('#actorBody');
    if (!obj || !body) { details.hidden = true; detailKey = ''; return; }
    if (document.activeElement?.closest?.('#actorDetails')) return;
    const actor = actorOf(obj);
    const key = idOf(obj) + '|' + actor.type + '|' + (actor.spawn ? 1 : 0) + '|' + (obj.userData.collision?.preset || '');
    if (key === detailKey) return;
    detailKey = key;
    details.hidden = false;
    const mesh = obj.isMesh ? obj : null;
    const col = publicCollision(mesh?.userData?.collision || obj.userData.collision);
    body.innerHTML = `
      <div class="row"><span>Name</span><b>${esc(obj.name || 'Scene')}</b></div>
      <div class="row"><span>Type</span><select id="actorType">${['static', 'character', 'npc', 'level'].map((t) => `<option value="${t}" ${actor.type === t ? 'selected' : ''}>${ACTOR_LABELS[t]}</option>`).join('')}</select></div>
      <label class="chk"><input id="actorSpawn" type="checkbox" ${actor.spawn ? 'checked' : ''}> Spawn point</label>
      <div class="hint0">Blueprint: ${esc(actor.blueprintId || 'none')}${actor.scriptOverride ? ' · script override' : ''}</div>
      <div class="hint0">Collision: ${col ? esc(col.preset + ' / ' + col.type) : 'none'}</div>
      <div class="row"><button type="button" class="btn" id="actorScript">Edit Script</button><button type="button" class="btn" id="actorCol">Edit Collision</button></div>`;
    body.querySelector('#actorType').onchange = (e) => setActorType(idOf(obj), e.target.value);
    body.querySelector('#actorSpawn').onchange = (e) => { actor.spawn = e.target.checked; };
    body.querySelector('#actorScript').onclick = () => openScript(obj);
    body.querySelector('#actorCol').onclick = () => openCollision(obj);
  }
  function openCollision(obj) {
    const mesh = obj?.isMesh ? obj : obj?.children?.find((c) => c.isMesh);
    if (!mesh) { ctx.status('That actor has no mesh to fit collision to'); return; }
    ensureCollision(mesh);
    assetEditor.open({ mesh, title: (obj.name || 'Actor') + ' collision' });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  onAssetActivate((asset) => {
    if (asset?.materialId) { openShader(asset.materialId); return; }
    if (asset?.kind === 'blueprint') {
      const bp = library.blueprints.find((b) => b.id === asset.blueprintId);
      if (bp) editorUi.open({ id: 'bp:' + bp.id, title: bp.name + ' script', language: 'javascript', source: bp.script || templateSource(bp.actorType === 'npc' ? 'patrol' : 'rotate'), owner: { blueprintId: bp.id }, kind: 'blueprint', refresh: true });
      return;
    }
    if (asset?.parts) openCollisionAsset(asset);
  });
  function openCollisionAsset(asset) {
    const mesh = asset.parts?.[0] ? new THREE.Mesh(asset.parts[0].geometry, asset.parts[0].material) : null;
    const wrap = { payload: { collision: asset.collision ? JSON.parse(JSON.stringify(asset.collision)) : null }, _meshAsset: asset };
    assetEditor.open({ mesh, asset: wrap, title: asset.name + ' collision' });
  }
  const menu = document.createElement('div');
  menu.className = 'objmenu'; menu.hidden = true;
  document.body.appendChild(menu);
  onAssetCommand((asset, e) => {
    const items = [['Edit Script', () => {
      if (asset.materialId) openShader(asset.materialId);
      else if (asset.kind === 'blueprint') onAssetActivate && editorUi.open({ id: 'bp:' + asset.id, title: asset.name, language: 'javascript', source: library.blueprints.find((b) => b.id === asset.id)?.script || '', owner: { blueprintId: asset.id }, refresh: true });
      else ctx.status('Place the mesh, then use Edit Script on the actor. The asset collision opens with a double-click.');
    }]];
    if (asset.parts) items.push(['Edit Collision', () => openCollisionAsset(asset)]);
    if (asset.materialId) items.push(['Open material window', () => window.__mfOpenProgram?.(asset.materialId)]);
    menu.replaceChildren();
    for (const [label, fn] of items) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.onclick = () => { menu.hidden = true; fn(); };
      menu.appendChild(b);
    }
    menu.hidden = false;
    menu.style.left = Math.min(e.clientX, innerWidth - 180) + 'px';
    menu.style.top = Math.min(e.clientY, innerHeight - 80) + 'px';
  });
  addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });

  addEventListener('keydown', (e) => {
    if (playing && e.key === 'Escape' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName || '')) { e.preventDefault(); stopPlay(); return; }
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName || '')) return;
    keys.add(e.key.toLowerCase());
    if (playing && e.key.toLowerCase() === 'e' && !e.repeat) interactLatch = true;
  });
  addEventListener('keyup', (e) => { keys.delete(e.key.toLowerCase()); if (e.key === ' ') keys.delete(' '); });

  window.__mfOpenScript = (obj) => openScript(obj);
  window.__mfOpenCollision = (obj) => openCollision(obj);
  window.__mfRefreshActors = refreshDetails;

  function exportLibrary() {
    return { version: 1, scripts: library.scripts, blueprints: library.blueprints, limits: SANDBOX_LIMITS_TEXT };
  }
  function loadLibrary(pack) {
    if (!pack) return;
    library.scripts = Array.isArray(pack.scripts) ? pack.scripts : [];
    library.blueprints = Array.isArray(pack.blueprints) ? pack.blueprints : [];
    refreshBrowser();
  }
  function applyActorRecord(obj, rec) {
    if (!obj || !rec) return;
    if (rec.actor) obj.userData.actor = normaliseActor(rec.actor);
    if (typeof rec.script === 'string' && rec.script) obj.userData.scriptSource = rec.script;
    if (rec.collision && obj.isMesh) setCollision(obj, rec.collision);
    if (rec.collision && obj.isGroup) obj.traverse((o) => { if (o.isMesh) setCollision(o, rec.collision); });
  }

  const api = {
    newProject, setLandscapeSize,
    generateLandscape: (opts) => ctx.generateLandscape?.(opts) || { ok: false, error: 'Landscape is not ready' },
    sendLandscapeToScene: () => ctx.sendLandscape?.() || { ok: false, error: 'Landscape is not ready' },
    placePrimitive, setActorType, setCollision: setCollisionOn, setScript, getScript, attachScript, detachScript,
    addSpawn, createBlueprint, spawnActor, listActors, listScriptables,
    validateScript: (source) => { const errors = validateScript(source); return { ok: errors.length === 0, errors }; },
    scriptTemplate: templateSource, runPlay, stopPlay, saveProject,
    exportScriptLibrary: exportLibrary, loadScriptLibrary: loadLibrary, applyActorRecord,
    agentVoice: { hear(who, text) { heard.push({ who: who || 'agent', text: String(text || '') }); editorUi.log('Heard ' + (who || 'agent') + ': ' + text); } },
    limits: SANDBOX_LIMITS_TEXT,
  };
  return { api, tick, refreshDetails, openScript, editorUi };
}

export { SANDBOX_LIMITS_TEXT };
