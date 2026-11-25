import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isTool, runTool } from '../plugins/ai-agent/tools.js';
import { createBus } from '../frontend/bus.js';
import { acceptBrainCommand } from '../frontend/components.js';
import { createMemoryForge } from '../frontend/levelplan.js';
import { createPlayWorld } from '../frontend/playworld.js';
import { createProgramActions } from '../frontend/progmat.js';

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail !== undefined ? ' ' + JSON.stringify(detail) : ''));
  if (!cond) failed++;
}

const root = fileURLToPath(new URL('..', import.meta.url));
for (const name of ['frontend/progmat.js', 'frontend/materials.js', 'frontend/components.js']) {
  const text = readFileSync(new URL('../' + name, import.meta.url), 'utf8');
  check(name + ' does not call the AI plugin URL', !text.includes('/api/plugins/'));
}

const bus = createBus();
let heard = 0;
const off = bus.on('ping', (data) => { heard += data.n; return data.n; });
const first = bus.emit('ping', { n: 2 });
off();
bus.emit('ping', { n: 5 });
check('event bus on and emit', heard === 2 && first[0] === 2);

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
let builds = 0;
const materialBus = createBus();
materialBus.on('ai:material', (body) => {
  builds++;
  check('material request has no server address', !JSON.stringify(body).includes('/api/plugins/'));
  return {
    ok: true,
    spec: {
      name: 'Glass',
      glsl: 'mfAlbedo = vec3(0.2, 0.5, 0.9); mfRough = 0.05;\n',
      params: [{ name: 'clarity', type: 'float', min: 0, max: 1, default: 0.8, label: 'Clarity' }],
      pbr: { color: '#88bbdd', roughness: 0.05, metalness: 0, emissive: '#000000', emissiveIntensity: 0, opacity: 0.7 },
    },
  };
});
const actions = createProgramActions({
  mats, bus: materialBus, pushHistory() {}, now: () => 0,
  session: () => ({ connected: () => true, provider: () => 'openai', model: () => 'mock', base: () => '' }),
});
const built = await actions.buildProgrammableMaterial({ brief: 'blue glass' });
check('material build uses the bus', built.ok && builds === 1 && mats.byId(built.id).name === 'Glass');
const lonely = createProgramActions({
  mats, pushHistory() {}, now: () => 0,
  session: () => ({ connected: () => true, provider: () => 'openai', model: () => 'm', base: () => '' }),
});
const missing = await lonely.buildProgrammableMaterial({ brief: 'blue glass' });
check('material build without a bus does not invent a URL', !missing.ok && /event bus/.test(missing.error));

const forge = createMemoryForge();
const placed = forge.placePrimitive({ kind: 'capsule', name: 'Guide', actorType: 'npc', position: [0, 0, 0] });
const id = placed.id;
const added = forge.addComponent(id, { type: 'behaviour', kind: 'patrol', speed: 2, points: [[4, 0], [4, 4]] });
check('add behaviour', added.ok && added.component.kind === 'patrol');
const collision = forge.addComponent(id, { type: 'collision' });
check('collision component wraps the actor collision', collision.ok && collision.component.preset === 'Pawn');
const edited = forge.setComponent(id, collision.component.id, { preset: 'OverlapAll' });
check('editing collision writes the actor', edited.ok && forge.listActors().find((a) => a.id === id).collision.preset === 'OverlapAll');
const again = forge.addComponent(id, { type: 'collision', preset: 'BlockAll' });
check('a second collision component is refused', !again.ok);
const voice = forge.addComponent(id, { type: 'voice' });
check('voice is off by default', voice.ok && voice.component.enabled === false);
forge.setComponent(id, voice.component.id, { enabled: true });
const material = forge.addComponent(id, { id: 'face', type: 'material', materialId: 'screen', state: 'happy' });
check('material component stores a state', material.ok && material.component.state === 'happy');
const bp = forge.createBlueprint({ name: 'Guard', actorType: 'npc', primitive: 'capsule', components: [{ id: 'idle1', type: 'behaviour', kind: 'idle' }] });
const spawned = forge.spawnActor({ blueprint: bp.id, name: 'Posted', position: [1, 0, 1] });
check('spawn copies blueprint components', forge.listComponents(spawned.id).components.some((c) => c.kind === 'idle'));
forge.addComponent(bp.id, { type: 'mesh', primitive: 'sphere' });
check('a placed actor keeps its own copy', !forge.listComponents(spawned.id).components.some((c) => c.type === 'mesh'));
const removed = forge.removeComponent(id, added.component.id);
check('remove component', removed.ok && !forge.listComponents(id).components.some((c) => c.id === added.component.id));
forge.addComponent(id, { id: 'patrol1', type: 'behaviour', kind: 'patrol', speed: 2, points: [[4, 0], [4, 4]] });
const badKind = forge.addComponent(id, { type: 'behaviour', kind: 'script' });
check('arbitrary behaviour code is not a kind', !badKind.ok);
const saved = forge.saveProject('/tmp/components-level.mfproj');
const scene = JSON.parse(saved.files['scene.json']);
const scripts = JSON.parse(saved.files['scripts.json']);
check('project stores actor and blueprint components', scene.objects.some((o) => (o.components || []).some((c) => c.type === 'material' && c.state === 'happy')) && scripts.blueprints.some((b) => (b.components || []).some((c) => c.type === 'mesh')));
const loaded = createMemoryForge();
loaded.loadProject(saved.files);
const back = loaded.listActors().find((a) => a.name === 'Guide');
check('load restores components', back.components.some((c) => c.type === 'voice' && c.enabled === true) && back.components.some((c) => c.state === 'happy'));
check('component tools are whitelisted', ['listComponents', 'addComponent', 'removeComponent', 'setComponent'].every(isTool));
const ctx = { api: { actions: forge }, confirm: async () => true };
const listed = await runTool(ctx, 'listComponents', { id });
check('list components tool', listed.ok && listed.text.includes('material'));

const world = createPlayWorld({ bus });
const none = { enabled: false, preset: 'NoCollision', type: 'none', size: [0.2, 0.2, 0.2] };
let materialEvent = null;
bus.on('component:material', (ev) => { materialEvent = ev; });
world.addActor({ id: 'player', name: 'Player', type: 'character', position: [5, 0, 0], tags: ['player'], collision: none, script: '' });
world.addActor({
  id: 'walker', name: 'Walker', type: 'npc', position: [0, 0, 0], collision: none,
  components: [
    { id: 'w', type: 'behaviour', kind: 'wander', speed: 2, radius: 4, pause: 0 },
    { id: 'faceMat', type: 'material', materialId: 'screen', state: 'happy' },
  ],
});
world.addActor({
  id: 'guard', name: 'Guard', type: 'npc', position: [0, 0, 0], collision: none,
  components: [{ id: 'p', type: 'behaviour', kind: 'patrol', speed: 2, points: [[4, 0], [4, 4]] }],
});
world.addActor({
  id: 'friend', name: 'Friend', type: 'npc', position: [0, 0, 0], collision: none,
  components: [{ id: 'f', type: 'behaviour', kind: 'follow', speed: 2, target: 'player', stop: 1 }],
});
world.addActor({
  id: 'looker', name: 'Looker', type: 'npc', position: [0, 0, 0], rotation: [0, 0, 0], collision: none,
  components: [{ id: 'face', type: 'behaviour', kind: 'face', target: 'player', speed: 240 }],
});
world.addActor({
  id: 'still', name: 'Still', type: 'npc', position: [1, 2, 3], collision: none,
  components: [{ id: 'idle', type: 'behaviour', kind: 'idle' }],
});
world.addActor({
  id: 'mute', name: 'Mute', type: 'npc', position: [8, 0, 0], collision: none,
  script: 'function onHear(who, text){ api.log(text); }\n',
  components: [{ id: 'quiet', type: 'voice', enabled: false }],
});
world.addActor({
  id: 'speaker', name: 'Speaker', type: 'npc', position: [9, 0, 0], collision: none,
  script: 'function onHear(who, text){ api.log(text); }\nfunction onSpeak(text){ api.log("spoke " + text); }\n',
  components: [{ id: 'vox', type: 'voice', enabled: true, hear: true, speak: true }],
});
world.addActor({
  id: 'thinker', name: 'Thinker', type: 'npc', position: [0, 0, 3], collision: none,
  components: [{ id: 'brain', type: 'brain', goal: 'step forward', interval: 0 }],
});
world.play();
check('material state is emitted when play starts', materialEvent && materialEvent.state === 'happy' && world.get('walker').materialState === 'happy');
const quiet = world.hear('mute', 'mic', 'hello');
check('voice stays off', !quiet.ok && /off/i.test(quiet.error));
const heardLine = world.hear('speaker', 'mic', 'hello');
check('voice hear reaches onHear', heardLine.ok && world.logs().some((line) => line.includes('hello')));
const said = world.speak('speaker', 'ready');
check('voice speak reaches onSpeak', said.ok && world.logs().some((line) => line.includes('spoke ready')));
world.tick(1);
const moved = world.get('walker');
const guard = world.get('guard');
const friend = world.get('friend');
const looker = world.get('looker');
const still = world.get('still');
check('wander moves during play', Math.hypot(moved.position[0], moved.position[2]) > 1, moved.position);
check('patrol moves toward the first point', guard.position[0] > 1 && guard.position[0] <= 2.01, guard.position);
check('follow moves toward the character', friend.position[0] > 1, friend.position);
check('face target turns toward the character', Math.abs(looker.rotation[1] - 90) < 1, looker.rotation);
check('idle stays put', still.position[0] === 1 && still.position[1] === 2 && still.position[2] === 3, still.position);
check('brain without a provider does not move the actor', world.get('thinker').position[0] === 0 && world.get('thinker').position[2] === 3 && world.logs().some((line) => /no AI provider/i.test(line)));
let brainMode = 'move';
bus.on('ai:brain', () => (brainMode === 'move'
  ? { ok: true, command: { op: 'move', x: 2, z: 0 } }
  : { ok: true, command: { op: 'move', x: 9, source: 'fetch("http://127.0.0.1")' } }));
world.tick(0.2);
check('brain applies a whitelisted move', world.get('thinker').position[0] === 2, world.get('thinker').position);
brainMode = 'code';
world.tick(0.2);
check('brain refuses a command that carries code', world.get('thinker').position[0] === 2 && world.logs().some((line) => /arbitrary code/i.test(line)));
const refused = acceptBrainCommand({ op: 'setScript', source: 'function onStart(){}' }, 'thinker');
check('brain refuses a script op', !refused.ok);
world.stop();
check('stop restores behaviour movement', world.get('guard').position[0] === 0 && world.get('walker').position[0] === 0 && world.get('friend').position[0] === 0);

const py = `
import os, sys, types
from pathlib import Path
root = Path(${JSON.stringify(root)})
os.environ.pop("MESHFORGE_CLOUD", None)
for name, folder in (("meshforge", root / "meshforge"), ("meshforge.runners", root / "meshforge" / "runners")):
    mod = types.ModuleType(name)
    mod.__path__ = [str(folder)]
    sys.modules[name] = mod
from meshforge.runners.cloud import CloudRunner
runner = CloudRunner()
try:
    runner.run("triposr", None, {}, lambda *a: None)
    raise SystemExit("cloud run returned a mesh without MESHFORGE_CLOUD")
except RuntimeError as exc:
    text = str(exc)
    if "placeholder" not in text.lower() or "mock" not in text:
        raise SystemExit("unclear cloud error: " + text)
print("UNSET_OK")
os.environ["MESHFORGE_CLOUD"] = "mock"
mock = CloudRunner()
status = mock.status()
if status.get("adapter") != "mock" or not status.get("ready") or not status.get("explicit_mock"):
    raise SystemExit("mock flag was not honoured: " + str(status))
print("MOCK_OK")
os.environ["MESHFORGE_CLOUD"] = "not-a-runner"
bad = CloudRunner()
try:
    bad.run("triposr", None, {}, lambda *a: None)
    raise SystemExit("unknown adapter returned a mesh")
except RuntimeError as exc:
    if "not-a-runner" not in str(exc) or "placeholder" not in str(exc).lower():
        raise SystemExit("unknown adapter error is unclear: " + str(exc))
print("UNKNOWN_OK")
`;
const cloud = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
check('cloud runner errors unless mock is explicit', cloud.status === 0 && /UNSET_OK/.test(cloud.stdout) && /MOCK_OK/.test(cloud.stdout) && /UNKNOWN_OK/.test(cloud.stdout), (cloud.stdout || '') + (cloud.stderr || ''));

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('component tests ok');
