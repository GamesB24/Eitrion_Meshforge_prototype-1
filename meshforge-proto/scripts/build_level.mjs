import { pathToFileURL } from 'node:url';

// Build a small yard through window.MeshForge only.
// Copy this file and change the positions when you build a shooter level:
// more BlockAll cubes for cover, extra spawn points, and NPC scripts.
//
// Headless, against a running MeshForge:
//   node scripts/build_level.mjs http://127.0.0.1:8000/?noautosave=1 /tmp/demo-yard.mfproj
//
// The function itself does not touch the page. Tests pass a memory editor with the same method names.

export async function buildDemoLevel(mf, opts = {}) {
  const api = mf || globalThis.MeshForge;
  if (!api?.newProject || !api.placePrimitive || !api.saveProject) {
    throw new Error('MeshForge level API is not ready');
  }
  const path = opts.path || 'demo-yard.mfproj';
  await api.newProject({ name: 'Demo yard' });
  const landscape = await api.setLandscapeSize({ width: 64, depth: 64, height: 6 });
  await api.generateLandscape({ seed: opts.seed ?? 11 });
  await api.sendLandscapeToScene();

  const hut = await api.placePrimitive({
    kind: 'building', name: 'Hut', position: [8, 0, 6], scale: [4, 2.4, 3],
    actorType: 'static', collision: { preset: 'BlockAll', type: 'box', enabled: true },
  });
  const wall = await api.placePrimitive({
    kind: 'cube', name: 'Cover wall', position: [-6, 0, 4], scale: [6, 2, 0.4],
    actorType: 'static', collision: { preset: 'BlockAll', type: 'box', enabled: true },
  });
  const door = await api.placePrimitive({
    kind: 'cube', name: 'Door', position: [8, 0, 8.2], scale: [1.4, 2.2, 0.3],
    actorType: 'static', collision: { preset: 'OverlapAll', type: 'box', enabled: true },
  });
  await api.setScript(door.id, api.scriptTemplate('door'));
  const pickup = await api.placePrimitive({
    kind: 'sphere', name: 'Pickup', position: [3, 0, 4], scale: [0.35, 0.35, 0.35],
    actorType: 'static', collision: { preset: 'OverlapAll', type: 'sphere', enabled: true },
  });
  await api.setScript(pickup.id, api.scriptTemplate('pickup'));
  const npc = await api.placePrimitive({
    kind: 'capsule', name: 'Companion', position: [1, 0, 2], scale: [1, 1, 1],
    actorType: 'npc', collision: { preset: 'Pawn', type: 'capsule', enabled: true },
  });
  await api.setScript(npc.id, api.scriptTemplate('companion'));
  const player = await api.placePrimitive({
    kind: 'capsule', name: 'Player', position: [0, 0, 10], scale: [1, 1, 1],
    actorType: 'character', collision: { preset: 'Pawn', type: 'capsule', enabled: true },
  });
  const spawn = await api.addSpawn({ name: 'Start', position: [0, 0, 12] });
  const actors = await api.listActors();
  const saved = await api.saveProject(path);
  return {
    ok: !!saved?.ok,
    landscape,
    actors,
    saved,
    ids: { hut: hut.id, wall: wall.id, door: door.id, pickup: pickup.id, npc: npc.id, player: player.id, spawn: spawn.id },
  };
}

async function driveBrowser(url, savePath) {
  const { createRequire } = await import('node:module');
  let puppeteer;
  try { puppeteer = createRequire('/tmp/mf-test/package.json')('puppeteer-core'); }
  catch { puppeteer = null; }
  if (!puppeteer) throw new Error('puppeteer-core is not installed. Open MeshForge and run the calls from the page, or install puppeteer-core.');
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.MeshForge && window.MeshForge.newProject && window.MeshForge.placePrimitive, { timeout: 30000 });
    const result = await page.evaluate(buildDemoLevel, null, { path: savePath });
    console.log(JSON.stringify({ ok: result.ok, path: result.saved?.path, actors: result.actors?.length, ids: result.ids }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  const savePath = process.argv[3] || 'demo-yard.mfproj';
  if (!url) {
    console.log('Usage: node scripts/build_level.mjs http://127.0.0.1:8000/?noautosave=1 [save-path.mfproj]');
    console.log('Start MeshForge first (run_windows.bat). The script only calls window.MeshForge.');
    process.exit(1);
  }
  driveBrowser(url, savePath).catch((err) => { console.error(err.message || err); process.exit(1); });
}
