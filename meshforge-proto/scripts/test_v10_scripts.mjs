import { Worker } from 'node:worker_threads';
import { isTool, runTool } from '../plugins/ai-agent/tools.js';
import { instanceFromBlueprint } from '../frontend/actors.js';
import { createMemoryForge } from '../frontend/levelplan.js';
import { createPlayWorld } from '../frontend/playworld.js';
import {
  createSession, listTemplates, proposeScriptEdit, templateSource, validateScript, workerBootstrap,
} from '../frontend/scriptbox.js';
import { buildDemoLevel } from './build_level.mjs';

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail !== undefined ? ' ' + JSON.stringify(detail) : ''));
  if (!cond) failed++;
}

const refused = ['fetch("http://127.0.0.1")', 'eval("1")', 'Function("return 1")', 'window.document', 'obj.constructor', 'require("fs")', 'import("x")', 'globalThis'];
for (const sample of refused) {
  const errors = validateScript('function onStart(){ ' + sample + '; }');
  check('rejects ' + sample.split('(')[0], errors.length > 0, errors);
}
check('a normal script validates', validateScript(templateSource('rotate')).length === 0);

const world = createPlayWorld();
world.addActor({
  id: 'box', name: 'Box', type: 'static', position: [2, 0, 0], rotation: [0, 0, 0],
  collision: { enabled: false, preset: 'NoCollision', type: 'none', size: [0.4, 0.4, 0.4] },
  script: templateSource('rotate'),
});
world.addActor({
  id: 'door', name: 'Door', type: 'static', position: [0, 0, 0],
  collision: { enabled: true, preset: 'OverlapAll', type: 'box', size: [0.6, 1, 0.3] },
  script: templateSource('door'),
});
world.addActor({
  id: 'player', name: 'Player', type: 'character', position: [0, 0, 0], tags: ['player'],
  collision: { enabled: true, preset: 'Pawn', type: 'capsule', size: [0.35, 0.8, 0.35] },
  script: 'function onStart(){ api.spawn("marker", { name: "Spark", position: [3, 0, 0] }); }',
});
const started = world.play();
check('play starts scripts', started.playing && started.scripts === 3);
world.tick(1, { axes: { x: 0, z: 0 }, jump: false, interact: false });
const spun = world.get('box');
check('onUpdate rotates', spun.rotation[1] > 30, spun.rotation);
const door = world.get('door');
check('overlap opens the door once', door.position[1] > 2 && world.logs().some((line) => line.includes('door')), door.position);
world.tick(1, { axes: { x: 0, z: 0 } });
check('the door does not open twice', world.get('door').position[1] === door.position[1]);
check('spawn during play is listed', world.list().some((a) => a.name === 'Spark'));
world.tick(0.5, { axes: { x: 1, z: 0 } });
check('character moves on input', world.get('player').position[0] > 0.5, world.get('player').position);
const stopped = world.stop();
check('stop restores the box', !stopped.playing && world.get('box').rotation[1] === 0 && world.get('door').position[1] === 0);
check('stop removes actors born during play', !world.list().some((a) => a.name === 'Spark'));

for (const row of listTemplates()) {
  const errors = validateScript(templateSource(row.id));
  const session = createSession(templateSource(row.id));
  session.load({ id: 't', name: row.label, type: row.type, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, actors: [{ id: 'p', name: 'Player', type: 'character', position: [1, 0, 0], tags: [] }] });
  session.call('onStart', []);
  session.call('onUpdate', [0.1]);
  check('template ' + row.id, errors.length === 0 && session.ok);
}

const proposed = proposeScriptEdit('function onUpdate(dt) {\n  api.rotate(0, 1, 0);\n}\n', 'function onUpdate(dt) {\n  api.rotate(0, 40 * dt, 0);\n}\n');
check('ask diff can be accepted', proposed.ok && proposed.diff.some((row) => row.type === 'add') && proposed.diff.some((row) => row.type === 'remove'));
const badAsk = proposeScriptEdit('function onStart() {}\n', 'function onStart(){ fetch("http://x"); }\n');
check('ask rejects a script that reaches the network', !badAsk.ok);

const inst = instanceFromBlueprint({ id: 'bp1', name: 'Guard', actorType: 'npc', primitive: 'capsule', script: templateSource('patrol') }, { script: 'function onUpdate(){ api.log("own"); }' });
check('actor inherits the blueprint and can override the script', inst.actor.type === 'npc' && inst.actor.scriptOverride && inst.script.includes('own'));

const forge = createMemoryForge();
const ctx = { api: { actions: forge, getObjects() { return forge.listActors(); } }, confirm: async () => true };
check('script tools are on the whitelist', ['listScriptables', 'getScript', 'setScript', 'validateScript', 'attachScript', 'detachScript', 'createBlueprint', 'spawnActor', 'setActorType', 'listActors', 'runPlay', 'stopPlay', 'newProject', 'setLandscapeSize', 'placePrimitive', 'setCollision', 'addSpawn', 'saveProject'].every(isTool));
check('eval is still refused', !(await runTool(ctx, 'eval', { code: '1' })).ok);
const fresh = await runTool(ctx, 'newProject', { name: 'Yard' });
check('new project tool', fresh.ok && fresh.text.includes('Yard'));
const sized = await runTool(ctx, 'setLandscapeSize', { width: 40, depth: 20, height: 5 });
check('landscape size tool reports a square map', sized.ok && sized.text.includes('40'));
const placed = await runTool(ctx, 'placePrimitive', { kind: 'cube', name: 'Crate', position: [1, 0, 2], actorType: 'static', collision: { preset: 'BlockAll', type: 'box' } });
check('place tool', placed.ok);
const id = JSON.parse(placed.text).id;
await runTool(ctx, 'setScript', { id, source: templateSource('rotate') });
const read = await runTool(ctx, 'getScript', { id });
check('get and set script tools', read.ok && read.text.includes('onUpdate'));
const bad = await runTool(ctx, 'validateScript', { source: 'eval(1)' });
check('validate tool reports an error', !bad.ok);
const bp = await runTool(ctx, 'createBlueprint', { name: 'Walker', actorType: 'npc', primitive: 'capsule', script: templateSource('patrol') });
const spawned = await runTool(ctx, 'spawnActor', { blueprint: JSON.parse(bp.text).id, position: [4, 0, 4] });
check('blueprint spawn tool', spawned.ok && JSON.parse(spawned.text).type === 'npc');
await runTool(ctx, 'setActorType', { id, type: 'npc' });
await runTool(ctx, 'addSpawn', { name: 'Entry', position: [0, 0, 8] });
const listed = await runTool(ctx, 'listActors', {});
check('list actors includes the spawn', listed.ok && listed.text.includes('Entry') && listed.text.includes('npc'));
const play = await runTool(ctx, 'runPlay', {});
const halt = await runTool(ctx, 'stopPlay', {});
check('play tools', play.ok && halt.ok);

const built = await buildDemoLevel(forge, { path: '/tmp/demo-yard.mfproj', seed: 11 });
check('demo level saved', built.ok && built.saved.path.endsWith('.mfproj'), built.saved);
const scene = JSON.parse(built.saved.files['scene.json']);
const scripts = JSON.parse(built.saved.files['scripts.json']);
check('demo level has landscape, collision, types, and a spawn', scene.landscape.size === 64 && scene.landscape.height === 6 && scene.objects.some((o) => o.type === 'character') && scene.objects.some((o) => o.spawn) && scene.objects.some((o) => o.collision?.preset === 'BlockAll') && scene.objects.some((o) => o.name === 'Companion' && o.type === 'npc'));
check('scripts are in the project', scripts.scripts.length >= 3 && scripts.scripts.some((s) => s.source.includes('onOverlap')));
const again = createMemoryForge();
again.loadProject(built.saved.files);
check('save and load keep the actors', again.listActors().length === scene.objects.length && again.listActors().some((a) => a.name === 'Player' && a.type === 'character'));

const probe = await new Promise((resolve, reject) => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = (data) => parentPort.postMessage(data);
    globalThis.self = globalThis;
    self.fetch = function () { return 'live'; };
    parentPort.on('message', (data) => self.onmessage({ data }));
    ${workerBootstrap()}
  `, { eval: true });
  const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker timed out')); }, 4000);
  worker.on('message', (msg) => {
    if (msg.op === 'probe') { clearTimeout(timer); worker.terminate(); resolve(msg); }
  });
  worker.on('error', (err) => { clearTimeout(timer); reject(err); });
  worker.postMessage({ op: 'probe' });
});
check('worker blocks fetch and has no page', probe.fetchBlocked === true && probe.hasDocument === false && probe.hasWindow === false, probe);

const ran = await new Promise((resolve, reject) => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = (data) => parentPort.postMessage(data);
    globalThis.self = globalThis;
    parentPort.on('message', (data) => self.onmessage({ data }));
    ${workerBootstrap()}
  `, { eval: true });
  const timer = setTimeout(() => { worker.terminate(); reject(new Error('script worker timed out')); }, 4000);
  worker.on('message', (msg) => {
    if (msg.op === 'result' && msg.token === 'call') { clearTimeout(timer); worker.terminate(); resolve(msg); }
  });
  worker.on('error', (err) => { clearTimeout(timer); reject(err); });
  worker.postMessage({ op: 'load', id: 'box', token: 'load', code: 'function onStart(){ api.log(typeof fetch); api.log(typeof document); }' });
  setTimeout(() => worker.postMessage({
    op: 'call', id: 'box', token: 'call', hook: 'onStart', args: [],
    state: { id: 'box', name: 'Box', type: 'static', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, actors: [] },
  }), 50);
});
check('worker script cannot see fetch or document', ran.logs && ran.logs.includes('undefined') && !ran.logs.includes('function'), ran.logs);

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('script tests ok');
