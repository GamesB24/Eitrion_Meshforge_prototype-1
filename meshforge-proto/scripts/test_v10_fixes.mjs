import { Worker } from 'node:worker_threads';
import { isTool } from '../plugins/ai-agent/tools.js';
import { createMemoryForge } from '../frontend/levelplan.js';
import { createPlayWorld } from '../frontend/playworld.js';
import { actorRefHasTag, cameraFarForSpan, isOverlapTarget, landscapeSendScale, plainActorRef } from '../frontend/playrules.js';
import { workerBootstrap } from '../frontend/scriptbox.js';

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail !== undefined ? ' ' + JSON.stringify(detail) : ''));
  if (!cond) failed++;
}

check('camera far stays at least 2000 m', cameraFarForSpan(40) === 2000 && cameraFarForSpan(480) === 2000);
check('a larger scene pushes the far plane out', cameraFarForSpan(800) === 3200);
check('landscape send keeps world size', landscapeSendScale(480, {}) === 1);
check('landscape size option scales from the mesh edge', Math.abs(landscapeSendScale(480, { size: 240 }) - 0.5) < 1e-9);
check('landscape scale option is used as given', landscapeSendScale(20, { scale: 2 }) === 2);

check('the level actor is not an overlap target', isOverlapTarget({ type: 'level', name: 'Scene', isScene: true }) === false);
check('terrain and water are not overlap targets', isOverlapTarget({ name: 'Terrain' }) === false && isOverlapTarget({ name: 'Water', source: 'landscape' }) === false);
check('a door is an overlap target', isOverlapTarget({ name: 'Door', type: 'static' }) === true);

const ref = plainActorRef({ id: 'door', name: 'Door', type: 'static', tags: ['player'], position: [1, 2, 3] });
check('actor refs posted to a worker are plain data', JSON.stringify(ref).includes('"player"') && !Object.values(ref).some((value) => typeof value === 'function'));
check('tag checks use the array', actorRefHasTag(ref, 'player') && !actorRefHasTag(ref, 'red'));

const world = createPlayWorld();
world.addActor({
  id: 'level', name: 'Scene', type: 'level', kind: 'level', position: [0, 0, 0],
  collision: { enabled: true, preset: 'BlockAll', type: 'box', size: [400, 20, 400] },
  script: 'function onOverlap(){ api.log("level-touch"); }',
});
world.addActor({
  id: 'door', name: 'Door', type: 'static', position: [0, 0, 0],
  collision: { enabled: true, preset: 'OverlapAll', type: 'box', size: [1, 1, 1] },
  script: 'function onOverlap(other){ api.log("door " + other.type); }',
});
world.play();
world.tick(0.1, { axes: { x: 0, z: 0 } });
check('a huge level box does not emit overlap', !world.logs().some((line) => line.includes('level-touch') || line.includes('door level')));
world.stop();

const forge = createMemoryForge();
await forge.newProject({ name: 'Range' });
await forge.setLandscapeSize({ width: 480, depth: 480, height: 8 });
const full = await forge.sendLandscapeToScene();
check('memory landscape stays 480 m', full.ok && full.scale === 1 && full.size === 480, full);
const sized = createMemoryForge();
await sized.setLandscapeSize({ width: 480 });
const half = await sized.sendLandscapeToScene({ size: 240 });
check('memory landscape honours size', half.ok && Math.abs(half.scale - 0.5) < 1e-9, half);

const missingScript = forge.setScript('does-not-exist', 'function onStart(){}');
const missingCol = forge.setCollision('does-not-exist', { preset: 'BlockAll' });
check('unknown script id is an error', !missingScript.ok && /no actor/i.test(missingScript.error));
check('unknown collision id is an error', !missingCol.ok && /no actor/i.test(missingCol.error));

const spawn = forge.addSpawn({ name: 'Red start', position: [4, 0, 4], team: 'red' });
const listed = forge.listActors().find((actor) => actor.id === spawn.id);
check('spawn team is listed', spawn.team === 'red' && listed?.team === 'red' && listed.tags.includes('team:red'));

const level = forge.placePrimitive({ kind: 'cube', name: 'Level', actorType: 'level' });
const wrote = forge.setScript(level.id, 'function onStart(){ api.log("keep"); }\n');
check('level script is stored on the actor id', wrote.ok);
const files = forge.projectFiles();
const savedScripts = JSON.parse(files['scripts.json']);
check('script owner id is the saved actor id', savedScripts.scripts.some((script) => script.ownerId === level.id && script.source.includes('keep')));
const loaded = createMemoryForge();
loaded.loadProject(files);
const again = loaded.getScript(level.id);
const againSpawn = loaded.listActors().find((actor) => actor.name === 'Red start');
check('reload keeps the level script and the team', again.ok && again.source.includes('keep') && againSpawn?.team === 'red');

check('open, clip, and ground tools are whitelisted', ['openProject', 'setCameraClip', 'getGroundHeight'].every(isTool));

const heard = await new Promise((resolve, reject) => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = (data) => parentPort.postMessage(data);
    globalThis.self = globalThis;
    parentPort.on('message', (data) => self.onmessage({ data }));
    ${workerBootstrap()}
  `, { eval: true });
  const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker timed out')); }, 4000);
  worker.on('message', (msg) => {
    if (msg.op === 'result' && msg.token === 'call') { clearTimeout(timer); worker.terminate(); resolve(msg); }
  });
  worker.on('error', (err) => { clearTimeout(timer); reject(err); });
  worker.postMessage({ op: 'load', id: 'door', token: 'load', code: 'function onOverlap(other){ api.log(String(other.hasTag && other.hasTag("player"))); }' });
  setTimeout(() => worker.postMessage({
    op: 'call', id: 'door', token: 'call', hook: 'onOverlap',
    args: [{ id: 'player', name: 'Player', type: 'character', tags: ['player'], position: [0, 0, 0] }],
    state: { id: 'door', name: 'Door', type: 'static', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, actors: [] },
  }), 40);
});
check('the worker adds hasTag after a plain post', heard.logs && heard.logs.includes('true'), heard.logs);

if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('fix tests ok');
