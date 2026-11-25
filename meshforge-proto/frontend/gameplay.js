// Play mode, actors, collision editing, and the script editor host.
// Original MIT code. The Worker runs gameplay scripts. The page only applies the command list.
import { createAssetEditor } from './asset_editor.js';
import { normaliseActor, blankBlueprint, instanceFromBlueprint, isActorType, publicActor, ACTOR_LABELS } from './actors.js';
import {
  COMPONENT_TYPES, LATER_NOTE, addComponentTo, applyBrainCommand, collisionFromComponent, componentFromCollision,
  componentSummary, consumeBrainInterval, materialEventsFrom, patchComponent, publicComponents, removeComponentFrom,
  resetComponentRuntime, stepActorBehaviours,
} from './components.js';
import { isOverlapTarget, plainActorRef } from './playrules.js';
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

  function idOf(obj) {
    if (!obj) return '';
    if (obj.userData?.isScene && !obj.userData.sceneId) obj.userData.sceneId = 'level';
    return obj.userData?.sceneId || obj.uuid || '';
  }
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
    if (id == null || id === '') return ctx.editor.sel || null;
    if (id === 'level') return ctx.getModel() || null;
    const node = ctx.findSceneNode(id);
    if (node) return node;
    const root = ctx.getModel();
    if (root && (root.userData?.sceneId === id || root.uuid === id)) return root;
    return null;
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
      components: publicComponents(obj.userData.components),
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
      if (cmd.op === 'say') {
        editorUi.log((obj.name || 'Actor') + ' says: ' + cmd.text);
        heard.push({ who: obj.name || 'actor', text: cmd.text });
        speakText(obj, cmd.text);
      }
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
    for (const obj of eachNode((o) => o)) {
      resetComponentRuntime(obj.userData.components);
      for (const ev of materialEventsFrom(obj.userData.components, idOf(obj))) {
        window.MeshForge?.bus?.emit('component:material', ev);
      }
    }
    armVoices();
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
    disarmVoices();
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
      const ground = ctx.groundHeight?.(obj.position.x, obj.position.z);
      const floorY = Number.isFinite(+ground) ? +ground : 0;
      if (input.jump && obj.position.y <= floorY + 0.05) obj.position.y = floorY + 1.1;
      else if (!input.jump && obj.position.y > floorY + 0.02) obj.position.y = Math.max(floorY, obj.position.y - 8 * dt);
      else obj.position.y = floorY;
    }
  }
  function hits(a, b) {
    return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y && a.min.z <= b.max.z && a.max.z >= b.min.z;
  }
  function overlapInfo(obj) {
    return { type: actorOf(obj).type, name: obj.name, source: obj.userData?.source || '', isScene: !!obj.userData?.isScene };
  }
  function meshBounds(mesh) {
    const box = new THREE.Box3();
    if (mesh?.isMesh) box.setFromObject(mesh);
    return box;
  }
  function actorMeshes(obj) {
    const out = [];
    if (obj.isMesh) out.push(obj);
    else obj.traverse?.((child) => { if (child.isMesh && !child.userData?.isOverlay && !child.userData?.isCollisionDebug) out.push(child); });
    return out.filter((mesh) => isOverlapTarget({ ...overlapInfo(mesh), type: actorOf(obj).type, isScene: false }));
  }
  async function overlaps() {
    const nodes = eachNode((o) => o).filter((o) => !o.userData.playDead && o.visible !== false && isOverlapTarget(overlapInfo(o)));
    const now = new Set();
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const ca = a.userData.collision, cb = b.userData.collision;
        if (ca?.preset === 'NoCollision' || cb?.preset === 'NoCollision') continue;
        const meshesA = actorMeshes(a), meshesB = actorMeshes(b);
        if (!meshesA.length || !meshesB.length) continue;
        let touching = false;
        for (const ma of meshesA) {
          const ba = meshBounds(ma);
          if (ba.isEmpty()) continue;
          for (const mb of meshesB) {
            const bb = meshBounds(mb);
            if (!bb.isEmpty() && hits(ba, bb)) touching = true;
          }
        }
        if (!touching) continue;
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
      if (who) {
        for (const other of nodes) {
          if (other === who) continue;
          const mine = actorMeshes(who), theirs = actorMeshes(other);
          let touching = false;
          for (const ma of mine) for (const mb of theirs) {
            const ba = meshBounds(ma), bb = meshBounds(mb);
            if (!ba.isEmpty() && !bb.isEmpty() && hits(ba, bb)) touching = true;
          }
          if (touching) await callHook(other, 'onInteract', [brief(who)]);
        }
      }
      interactLatch = false;
    }
  }
  function brief(obj) {
    const actor = actorOf(obj);
    return plainActorRef({ id: idOf(obj), name: obj.name, type: actor.type, tags: actor.tags, position: [obj.position.x, obj.position.y, obj.position.z] });
  }

  function stepSceneBehaviours(dt) {
    const nodes = eachNode((o) => o).filter((o) => !o.userData.playDead);
    const views = nodes.map((obj) => ({
      id: idOf(obj), name: obj.name || 'Actor', type: actorOf(obj).type, tags: actorOf(obj).tags.slice(),
      position: [obj.position.x, obj.position.y, obj.position.z],
      rotation: [obj.rotation.x * R2D, obj.rotation.y * R2D, obj.rotation.z * R2D],
      components: obj.userData.components || [],
    }));
    stepActorBehaviours(views, dt);
    for (const view of views) {
      const obj = resolve(view.id);
      if (!obj) continue;
      obj.position.set(view.position[0], view.position[1], view.position[2]);
      obj.rotation.set(view.rotation[0] * D2R, view.rotation[1] * D2R, view.rotation[2] * D2R);
    }
  }
  async function stepBrains(dt) {
    const nodes = eachNode((o) => o).filter((o) => !o.userData.playDead);
    const others = nodes.map((obj) => ({
      id: idOf(obj), name: obj.name || '', type: actorOf(obj).type, tags: actorOf(obj).tags.slice(),
      position: [obj.position.x, obj.position.y, obj.position.z],
    }));
    for (const obj of nodes) {
      for (const comp of obj.userData.components || []) {
        if (!consumeBrainInterval(comp, dt)) continue;
        const bus = window.MeshForge?.bus;
        const replies = bus?.emit('ai:brain', {
          actor: { id: idOf(obj), name: obj.name || '', type: actorOf(obj).type, position: [obj.position.x, obj.position.y, obj.position.z] },
          goal: comp.goal || '',
        }) || [];
        if (!replies.length) {
          if (!comp._noted) { comp._noted = true; editorUi.log((obj.name || 'Actor') + ': no AI provider is connected'); }
          continue;
        }
        const settled = await Promise.all(replies.map((reply) => Promise.resolve(reply)));
        if (!playing) return;
        const view = {
          id: idOf(obj), position: [obj.position.x, obj.position.y, obj.position.z],
          rotation: [obj.rotation.x * R2D, obj.rotation.y * R2D, obj.rotation.z * R2D],
          scale: [obj.scale.x, obj.scale.y, obj.scale.z],
          components: obj.userData.components || [], params: {}, materialState: '',
        };
        for (const reply of settled) {
          if (!reply || (reply.ok === false && !reply.command)) {
            editorUi.log((obj.name || 'Actor') + ' brain: ' + (reply?.error || 'no command'));
            continue;
          }
          const result = applyBrainCommand(view, reply.command || reply, others);
          if (!result.ok) { editorUi.log((obj.name || 'Actor') + ' brain: ' + result.error); continue; }
          obj.position.set(view.position[0], view.position[1], view.position[2]);
          obj.rotation.set(view.rotation[0] * D2R, view.rotation[1] * D2R, view.rotation[2] * D2R);
          obj.scale.set(view.scale[0], view.scale[1], view.scale[2]);
          for (const effect of result.effects || []) {
            if (effect.op === 'say') { editorUi.log((obj.name || 'Actor') + ' says: ' + effect.text); speakText(obj, effect.text); }
            if (effect.op === 'emit') heard.push({ event: true, name: effect.name, data: effect.data });
            if (effect.op === 'material') window.MeshForge?.bus?.emit('component:material', effect);
            if (effect.op === 'collision') setCollisionOn(idOf(obj), effect.collision);
            if (effect.op === 'param') ctx.programActions?.setMaterialParam?.(idOf(obj), effect.name, effect.value, { blendMs: 0 });
          }
        }
      }
    }
  }
  async function step(dt) {
    if (!playing) return;
    moveCharacters(dt);
    stepSceneBehaviours(dt);
    await stepBrains(dt);
    for (const obj of eachNode((o) => o)) if (scriptSource(obj)) await callHook(obj, 'onUpdate', [dt], dt);
    const queued = heard.splice(0, heard.length);
    for (const item of queued) {
      for (const obj of eachNode((o) => o)) {
        if (item.event) await callHook(obj, 'onEvent', [item.name, item.data]);
        else if (!item.actorId || item.actorId === idOf(obj)) {
          if (item.actorId) {
            const voice = (obj.userData.components || []).find((c) => c.type === 'voice');
            if (!voice?.enabled) continue;
          }
          await callHook(obj, 'onHear', [item.who, item.text]);
        }
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
    if (!obj) return { ok: false, error: id ? 'No actor matches ' + id : 'No actor' };
    const meshes = [];
    obj.traverse?.((o) => { if (o.isMesh) meshes.push(o); });
    if (!meshes.length && obj.isMesh) meshes.push(obj);
    const before = meshes.map((m) => publicCollision(m.userData.collision));
    const apply = (list) => list.forEach((col, i) => { if (meshes[i] && col) setCollision(meshes[i], col); });
    meshes.forEach((m) => setCollision(m, patch || {}));
    const after = meshes.map((m) => publicCollision(m.userData.collision));
    mirrorCollisionComponent(obj);
    ctx.pushHistory?.({
      label: 'Collision',
      undo: () => { apply(before); mirrorCollisionComponent(obj); },
      redo: () => { apply(after); mirrorCollisionComponent(obj); },
    });
    if (collisionView.visible()) collisionView.rebuild(ctx.getModel());
    return { ok: true, id: idOf(obj), collision: after[0] };
  }
  function setScript(id, source) {
    const obj = resolve(id);
    if (!obj) return { ok: false, error: id ? 'No actor matches ' + id : 'No actor' };
    const errors = validateScript(source ?? '');
    if (String(source || '').trim() && errors.length) return { ok: false, error: errors[0].message, errors };
    const actor = actorOf(obj);
    const before = { source: obj.userData.scriptSource || '', scriptId: actor.scriptId };
    const recId = 'script_' + (scriptSeq++);
    const apply = (pack) => {
      obj.userData.scriptSource = pack.source;
      actor.scriptId = pack.scriptId;
      actor.scriptOverride = !!pack.source;
      const ownerId = idOf(obj);
      const i = library.scripts.findIndex((s) => s.ownerId === ownerId);
      if (!pack.source) { if (i >= 0) library.scripts.splice(i, 1); return; }
      const rec = { id: pack.scriptId || recId, name: (obj.name || 'Actor') + ' script', ownerId, kind: actor.type, language: 'javascript', source: pack.source };
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
    const tags = ['spawn'];
    if (spec.team) tags.push('team:' + String(spec.team));
    const made = placePrimitive({ kind: 'spawn', name: spec.name || 'Spawn', position: spec.position || [0, 0, 0], actorType: 'static', tags, collision: { enabled: false, preset: 'NoCollision', type: 'none', size: [0.3, 0.3, 0.3] } });
    const obj = resolve(made.id);
    if (obj) {
      const actor = actorOf(obj);
      actor.spawn = true;
      actor.team = spec.team ? String(spec.team) : null;
      actor.tags = tags.slice();
    }
    return { ok: true, id: made.id, name: made.name, spawn: true, team: spec.team ? String(spec.team) : null, tags };
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
      obj.userData.actor.componentsOverride = true;
      obj.userData.components = publicComponents(inst.components);
      if (inst.script) obj.userData.scriptSource = inst.script;
      const mesh = obj.isMesh ? obj : obj.children?.find((c) => c.isMesh);
      const col = (obj.userData.components || []).find((c) => c.type === 'collision');
      if (mesh && col) setCollision(mesh, collisionFromComponent(col));
    }
    return { ok: true, id: made.id, name: made.name, type: inst.actor.type, blueprintId: bp.id };
  }
  function listActors() {
    return eachNode((obj) => {
      const actor = actorOf(obj);
      const mesh = obj.isMesh ? obj : obj.children?.find((c) => c.isMesh);
      return {
        id: idOf(obj), name: obj.name || 'Actor', label: obj.name || 'Actor', type: actor.type, typeLabel: ACTOR_LABELS[actor.type],
        spawn: !!actor.spawn, tags: actor.tags.slice(), team: actor.team || null, blueprintId: actor.blueprintId, scriptId: actor.scriptId,
        position: [obj.position.x, obj.position.y, obj.position.z],
        rotation: [obj.rotation.x * R2D, obj.rotation.y * R2D, obj.rotation.z * R2D],
        scale: [obj.scale.x, obj.scale.y, obj.scale.z],
        collision: publicCollision(mesh?.userData?.collision || obj.userData.collision),
        components: publicComponents(obj.userData.components),
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
    const bus = window.MeshForge?.bus;
    if (!bus) return { ok: false, error: 'No script builder is connected.' };
    try {
      const replies = await Promise.all(bus.emit('ai:script', {
        provider: session.provider(), model: session.model(), base: session.base(),
        brief: body.brief, source: body.source, language: body.language,
      }).map((reply) => Promise.resolve(reply)));
      const data = replies.find((reply) => reply && typeof reply === 'object') || null;
      if (!data?.ok || !data.script) return { ok: false, error: data?.message || data?.error || 'No script builder is connected. You can still edit the script by hand.' };
      return { ok: true, source: data.script };
    } catch {
      return { ok: false, error: 'Network error' };
    }
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { ctx.autosave?.('script'); }, 4000);
  }
  const recognizers = new Map();
  function componentList(obj) {
    if (!obj.userData.components) obj.userData.components = [];
    return obj.userData.components;
  }
  function componentTarget(id) {
    const obj = resolve(id);
    if (obj) return { kind: 'actor', id: idOf(obj), obj };
    const bp = library.blueprints.find((b) => b.id === id || b.name === id);
    if (bp) return { kind: 'blueprint', id: bp.id, blueprint: bp };
    return null;
  }
  function readList(target) {
    return publicComponents(target.kind === 'actor' ? componentList(target.obj) : target.blueprint.components);
  }
  function writeActorList(obj, list) {
    const prev = publicComponents(obj.userData.components);
    obj.userData.components = publicComponents(list);
    const actor = actorOf(obj);
    actor.componentsOverride = true;
    if (!actor.overrides.includes('components')) actor.overrides.push('components');
    const mesh = obj.isMesh ? obj : obj.children?.find((c) => c.isMesh);
    const col = obj.userData.components.find((c) => c.type === 'collision');
    const prevCol = prev.find((c) => c.type === 'collision');
    if (mesh && col && JSON.stringify(col) !== JSON.stringify(prevCol)) setCollision(mesh, collisionFromComponent(col));
    if (mesh && !col && prevCol) setCollision(mesh, { preset: 'NoCollision', type: 'none', enabled: false });
    const meshComp = obj.userData.components.find((c) => c.type === 'mesh');
    const prevMesh = prev.find((c) => c.type === 'mesh');
    if (meshComp && JSON.stringify(meshComp) !== JSON.stringify(prevMesh)) obj.visible = meshComp.visible !== false;
    const mat = obj.userData.components.find((c) => c.type === 'material');
    const prevMat = prev.find((c) => c.type === 'material');
    if (mat && JSON.stringify(mat) !== JSON.stringify(prevMat)) window.MeshForge?.bus?.emit('component:material', { actorId: idOf(obj), materialId: mat.materialId, state: mat.state, slot: mat.slot });
  }
  function mirrorCollisionComponent(obj) {
    const list = obj?.userData?.components;
    if (!Array.isArray(list)) return;
    const mesh = obj.isMesh ? obj : obj.children?.find((c) => c.isMesh);
    const col = publicCollision(mesh?.userData?.collision || obj.userData.collision);
    const comp = list.find((c) => c.type === 'collision');
    if (!col || !comp) return;
    comp.preset = col.preset;
    comp.shape = col.type;
    comp.enabled = col.enabled !== false && col.preset !== 'NoCollision';
    comp.size = (col.size || [0.5, 0.5, 0.5]).slice();
  }
  function listComponents(id) {
    const target = componentTarget(id);
    if (!target) return { ok: false, error: 'No actor or blueprint' };
    return { ok: true, id: target.id, kind: target.kind, components: readList(target) };
  }
  function commitComponents(target, before, next, label) {
    const beforeCol = target.kind === 'actor' ? publicCollision((target.obj.isMesh ? target.obj : target.obj.children?.find((c) => c.isMesh))?.userData?.collision) : null;
    const apply = (list) => {
      if (target.kind === 'blueprint') target.blueprint.components = publicComponents(list);
      else writeActorList(target.obj, list);
    };
    apply(next);
    const afterCol = target.kind === 'actor' ? publicCollision((target.obj.isMesh ? target.obj : target.obj.children?.find((c) => c.isMesh))?.userData?.collision) : null;
    ctx.pushHistory?.({
      label,
      undo: () => { apply(before); if (target.kind === 'actor' && beforeCol) setCollisionOnQuiet(target.obj, beforeCol); refreshDetails({ force: true }); },
      redo: () => { apply(next); if (target.kind === 'actor' && afterCol) setCollisionOnQuiet(target.obj, afterCol); refreshDetails({ force: true }); },
    });
    refreshDetails({ force: true });
    return readList(target);
  }
  function setCollisionOnQuiet(obj, patch) {
    const meshes = [];
    obj.traverse?.((o) => { if (o.isMesh) meshes.push(o); });
    if (!meshes.length && obj.isMesh) meshes.push(obj);
    meshes.forEach((m) => setCollision(m, patch || {}));
  }
  function addComponent(id, spec = {}) {
    const target = componentTarget(id);
    if (!target) return { ok: false, error: 'No actor or blueprint' };
    const raw = { ...spec };
    if (target.kind === 'actor' && raw.type === 'collision' && !raw.preset) {
      const mesh = target.obj.isMesh ? target.obj : target.obj.children?.find((c) => c.isMesh);
      Object.assign(raw, componentFromCollision(mesh?.userData?.collision || target.obj.userData.collision));
    }
    if (raw.type === 'mesh' && !raw.primitive) raw.primitive = target.blueprint?.primitive || 'cube';
    const before = readList(target);
    const added = addComponentTo(before, raw);
    if (!added.ok) return added;
    const components = commitComponents(target, before, added.components, 'Add component');
    return { ok: true, id: target.id, kind: target.kind, component: added.component, components };
  }
  function removeComponent(id, componentId) {
    const target = componentTarget(id);
    if (!target) return { ok: false, error: 'No actor or blueprint' };
    const before = readList(target);
    const removed = removeComponentFrom(before, componentId);
    if (!removed.ok) return removed;
    if (target.kind === 'actor' && removed.component?.type === 'collision') setCollisionOnQuiet(target.obj, { preset: 'NoCollision', type: 'none', enabled: false });
    const components = commitComponents(target, before, removed.components, 'Remove component');
    return { ok: true, id: target.id, component: removed.component, components };
  }
  function setComponent(id, componentId, patch = {}) {
    const target = componentTarget(id);
    if (!target) return { ok: false, error: 'No actor or blueprint' };
    const before = readList(target);
    const patched = patchComponent(before, componentId, patch);
    if (!patched.ok) return patched;
    const components = commitComponents(target, before, patched.components, 'Edit component');
    return { ok: true, id: target.id, component: patched.component, components };
  }
  function speakText(obj, text) {
    const voice = (obj?.userData?.components || []).find((c) => c.type === 'voice');
    if (!voice?.enabled || voice.speak === false) return;
    const said = String(text || '');
    window.MeshForge?.bus?.emit('voice:speak', { actorId: idOf(obj), text: said });
    if (typeof window.speechSynthesis?.speak === 'function') {
      try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(said.slice(0, 400))); } catch { /* this browser has no speech output */ }
    }
    if (!obj.userData.voiceBusy) {
      obj.userData.voiceBusy = true;
      void callHook(obj, 'onSpeak', [said]).finally(() => { obj.userData.voiceBusy = false; });
    }
  }
  function armVoices() {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    for (const obj of eachNode((o) => o)) {
      const voice = (obj.userData.components || []).find((c) => c.type === 'voice');
      if (!voice?.enabled || voice.hear === false) continue;
      if (!Rec) { editorUi.log('Voice input needs Chrome or Edge. Typing still works.'); continue; }
      try {
        const rec = new Rec();
        rec.lang = voice.lang || 'en-US';
        rec.continuous = true;
        rec.onresult = (ev) => {
          const said = ev.results?.[ev.results.length - 1]?.[0]?.transcript || '';
          if (!said) return;
          obj.userData.voiceTranscript = said;
          heard.push({ who: obj.name || 'actor', text: said, actorId: idOf(obj) });
          window.MeshForge?.bus?.emit('voice:hear', { actorId: idOf(obj), who: obj.name || 'actor', text: said });
        };
        rec.start();
        recognizers.set(idOf(obj), rec);
      } catch { editorUi.log((obj.name || 'Actor') + ': the microphone did not start'); }
    }
  }
  function disarmVoices() {
    for (const rec of recognizers.values()) { try { rec.stop(); } catch { /* already stopped */ } }
    recognizers.clear();
    if (typeof window.speechSynthesis?.cancel === 'function') { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }
  }
  let detailKey = '';
  function refreshDetails(opts = {}) {
    const obj = ctx.editor.sel || ctx.getModel();
    const body = details.querySelector('#actorBody');
    if (!obj || !body) { details.hidden = true; detailKey = ''; return; }
    if (!opts.force && document.activeElement?.closest?.('#actorDetails')) return;
    const actor = actorOf(obj);
    const comps = publicComponents(obj.userData.components);
    const key = idOf(obj) + '|' + actor.type + '|' + (actor.spawn ? 1 : 0) + '|' + (obj.userData.collision?.preset || '') + '|' + comps.map((c) => c.id + c.type + componentSummary(c)).join(',');
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
      <div class="row"><button type="button" class="btn" id="actorScript">Edit Script</button><button type="button" class="btn" id="actorCol">Edit Collision</button></div>
      <div id="compSec"></div>`;
    body.querySelector('#actorType').onchange = (e) => setActorType(idOf(obj), e.target.value);
    body.querySelector('#actorSpawn').onchange = (e) => { actor.spawn = e.target.checked; };
    body.querySelector('#actorScript').onclick = () => openScript(obj);
    body.querySelector('#actorCol').onclick = () => openCollision(obj);
    fillComponents(body.querySelector('#compSec'), obj);
  }
  function fillComponents(host, obj) {
    if (!host) return;
    const id = idOf(obj);
    const comps = publicComponents(componentList(obj));
    host.innerHTML = `<div class="comp-sec"><div class="row"><span>Components</span></div>`
      + (comps.map((c) => `<div class="comp-row" data-id="${esc(c.id)}"><div class="row"><b>${esc(c.type)}</b><span>${esc(componentSummary(c))}</span><button type="button" class="btn" data-rm="${esc(c.id)}">Remove</button></div>${fieldsFor(c)}</div>`).join('')
        || '<div class="hint0">No components yet.</div>')
      + `<div class="row"><select id="compAdd">${COMPONENT_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select><button type="button" class="btn" id="compAddBtn">Add</button></div>`
      + `<div class="hint0">${esc(LATER_NOTE)}</div></div>`;
    host.querySelector('#compAddBtn').onclick = () => addComponent(id, { type: host.querySelector('#compAdd').value });
    host.querySelectorAll('[data-rm]').forEach((btn) => { btn.onclick = () => removeComponent(id, btn.dataset.rm); });
    host.querySelectorAll('[data-field]').forEach((input) => {
      const apply = () => {
        const patch = {};
        const key = input.dataset.field;
        let value = input.type === 'checkbox' ? input.checked : input.value;
        if (key === 'points') value = String(value).split(';').map((pair) => pair.split(',').map((n) => +n.trim())).filter((pair) => pair.length >= 2 && pair.every((n) => Number.isFinite(n)));
        if (input.type === 'number') value = +value;
        if (key === 'visible' || key === 'enabled' || key === 'hear' || key === 'speak') value = input.checked;
        patch[key] = value;
        setComponent(id, input.dataset.comp, patch);
      };
      input.onchange = apply;
    });
  }
  function fieldsFor(c) {
    const id = esc(c.id);
    const box = (field, label, on) => `<label class="chk"><input data-comp="${id}" data-field="${field}" type="checkbox" ${on ? 'checked' : ''}> ${label}</label>`;
    const line = (field, label, value) => `<div class="row"><span>${label}</span><input data-comp="${id}" data-field="${field}" class="txt" value="${esc(value ?? '')}"></div>`;
    const num = (field, label, value) => `<div class="row"><span>${label}</span><input data-comp="${id}" data-field="${field}" type="number" step="0.1" value="${esc(value ?? 0)}"></div>`;
    if (c.type === 'mesh') return line('primitive', 'Shape', c.primitive) + line('meshAssetId', 'Asset', c.meshAssetId || '') + box('visible', 'Visible', c.visible);
    if (c.type === 'collision') return line('preset', 'Preset', c.preset) + line('shape', 'Shape', c.shape) + box('enabled', 'Enabled', c.enabled);
    if (c.type === 'material') return line('materialId', 'Material', c.materialId) + line('state', 'State', c.state);
    if (c.type === 'behaviour') return line('kind', 'Kind', c.kind) + num('speed', 'Speed', c.speed) + line('target', 'Target', c.target) + num('radius', 'Radius', c.radius) + line('points', 'Points', (c.points || []).map((p) => p.join(',')).join('; '));
    if (c.type === 'brain') return line('goal', 'Goal', c.goal) + num('interval', 'Seconds', c.interval) + box('enabled', 'Enabled', c.enabled);
    if (c.type === 'voice') return box('enabled', 'On', c.enabled) + box('hear', 'Hear', c.hear) + box('speak', 'Speak', c.speak);
    return '';
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

  function rebindScripts() {
    const root = ctx.getModel();
    if (root?.userData?.isScene && !root.userData.sceneId) root.userData.sceneId = 'level';
    for (const rec of library.scripts) {
      if (!rec?.ownerId) continue;
      let node = ctx.findSceneNode(rec.ownerId);
      if (!node && root && (root.userData?.sceneId === rec.ownerId || rec.ownerId === 'level')) node = root;
      if (!node) continue;
      node.userData.scriptSource = rec.source;
      const actor = actorOf(node);
      actor.scriptId = rec.id;
      actor.scriptOverride = true;
    }
  }
  function exportLibrary() {
    return { version: 1, scripts: library.scripts, blueprints: library.blueprints, limits: SANDBOX_LIMITS_TEXT };
  }
  function loadLibrary(pack) {
    if (!pack) return;
    library.scripts = Array.isArray(pack.scripts) ? pack.scripts : [];
    library.blueprints = Array.isArray(pack.blueprints) ? pack.blueprints.map((bp) => blankBlueprint(bp)) : [];
    refreshBrowser();
  }
  function applyActorRecord(obj, rec) {
    if (!obj || !rec) return;
    if (rec.actor) obj.userData.actor = normaliseActor(rec.actor);
    if (Array.isArray(rec.components)) obj.userData.components = publicComponents(rec.components);
    if (typeof rec.script === 'string' && rec.script) obj.userData.scriptSource = rec.script;
    if (rec.collision && obj.isMesh) setCollision(obj, rec.collision);
    if (rec.collision && obj.isGroup) obj.traverse((o) => { if (o.isMesh) setCollision(o, rec.collision); });
  }

  const api = {
    newProject, setLandscapeSize,
    generateLandscape: (opts) => ctx.generateLandscape?.(opts) || { ok: false, error: 'Landscape is not ready' },
    sendLandscapeToScene: () => ctx.sendLandscape?.() || { ok: false, error: 'Landscape is not ready' },
    placePrimitive, setActorType, setCollision: setCollisionOn, setScript, getScript, attachScript, detachScript,
    listComponents, addComponent, removeComponent, setComponent,
    addSpawn, createBlueprint, spawnActor, listActors, listScriptables,
    validateScript: (source) => { const errors = validateScript(source); return { ok: errors.length === 0, errors }; },
    scriptTemplate: templateSource, runPlay, stopPlay, saveProject,
    exportScriptLibrary: exportLibrary, loadScriptLibrary: loadLibrary, applyActorRecord, rebindScripts,
    agentVoice: { hear(who, text) { heard.push({ who: who || 'agent', text: String(text || '') }); editorUi.log('Heard ' + (who || 'agent') + ': ' + text); } },
    limits: SANDBOX_LIMITS_TEXT,
  };
  return { api, tick, refreshDetails, openScript, editorUi };
}

export { SANDBOX_LIMITS_TEXT };
