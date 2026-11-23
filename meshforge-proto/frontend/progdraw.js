// WebGL side of a programmable material. Original MIT code.
import * as THREE from 'three';
import { applyGroups, setSlots } from './mfdata.js';
import { lightDir } from './chibili.js';
import {
  FALLBACK_GLSL, buildShaderSources, chooseUvMode, compileSources, sampleRuntime, shaderKey, slotUvReport,
} from './progmat.js';

const WHITE = new Uint8Array([255, 255, 255, 255]);

function blankTexture() {
  const tex = new THREE.DataTexture(WHITE, 1, 1);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let compileGL = null;
export function compileProgram(spec) {
  try {
    if (!compileGL) {
      const canvas = document.createElement('canvas');
      compileGL = canvas.getContext('webgl', { failIfMajorPerformanceCaveat: false });
    }
    return compileSources(compileGL, spec);
  } catch (err) {
    return { ok: false, errors: [String(err.message || err)] };
  }
}

function sourcesFor(spec) {
  const compiled = compileProgram(spec);
  if (compiled.ok) return { sources: compiled.sources, error: '' };
  const fallback = buildShaderSources({ ...spec, glsl: FALLBACK_GLSL, params: [] });
  return { sources: fallback, error: compiled.errors.join('\n') };
}

export function makeProgramMaterial(spec) {
  const built = sourcesFor(spec);
  const uniforms = baseUniforms(spec);
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: built.sources.vertex,
    fragmentShader: built.sources.fragment,
    side: THREE.DoubleSide,
    transparent: (spec.pbr?.opacity ?? 1) < 0.999 || /mfAlpha\s*=/.test(spec.glsl || ''),
  });
  material.depthWrite = !material.transparent;
  material.userData.mfProgram = true;
  material.userData.glslKey = shaderKey(spec);
  material.userData.compileError = built.error;
  material.userData.texCache = new Map();
  material.userData.blankTex = blankTexture();
  return material;
}

function colorUniform(hex) { return { value: new THREE.Color(hex || '#ffffff') }; }

function baseUniforms(spec) {
  const pbr = spec.pbr || {};
  const ch = spec.chibili || {};
  const bag = {
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uBaseColor: colorUniform(pbr.color),
    uRoughness: { value: pbr.roughness ?? 0.5 },
    uMetalness: { value: pbr.metalness ?? 0 },
    uEmissiveColor: colorUniform(pbr.emissive),
    uEmissiveIntensity: { value: pbr.emissiveIntensity ?? 0 },
    uOpacity: { value: pbr.opacity ?? 1 },
    uShade: colorUniform(ch.shade || '#333333'),
    uBands: { value: ch.bands || 3 },
    uSoft: { value: ch.soft ?? 0.04 },
    uRim: { value: ch.rim ?? 0.2 },
    uLight: { value: lightDir() },
    uUvMode: { value: 0 },
    uUvAspect: { value: 0 },
    uUvMin: { value: new THREE.Vector2(0, 0) },
    uUvMax: { value: new THREE.Vector2(1, 1) },
    uPlanarT: { value: new THREE.Vector3(1, 0, 0) },
    uPlanarB: { value: new THREE.Vector3(0, 1, 0) },
    uPlanarOrigin: { value: new THREE.Vector3() },
    uPlanarSize: { value: new THREE.Vector2(1, 1) },
  };
  for (const param of spec.params || []) {
    const key = 'uP_' + param.name;
    if (param.type === 'color') bag[key] = colorUniform(param.default);
    else if (param.type === 'vec3') bag[key] = { value: new THREE.Vector3() };
    else if (param.type === 'vec2') bag[key] = { value: new THREE.Vector2() };
    else if (param.type === 'texture') {
      bag[key] = { value: null };
      bag[key + 'On'] = { value: 0 };
    } else bag[key] = { value: param.default ?? 0 };
  }
  return bag;
}

function textureFor(material, dataUrl) {
  if (!dataUrl) return material.userData.blankTex;
  const cache = material.userData.texCache;
  if (cache.has(dataUrl)) return cache.get(dataUrl);
  const image = new Image();
  const tex = new THREE.Texture(image);
  tex.colorSpace = THREE.SRGBColorSpace;
  image.onload = () => { tex.needsUpdate = true; };
  image.src = dataUrl;
  cache.set(dataUrl, tex);
  return tex;
}

export function syncProgramMaterial(material, spec, extra = {}) {
  if (!material?.uniforms) return;
  const u = material.uniforms;
  const pbr = spec.pbr || {};
  const ch = spec.chibili || {};
  u.uTime.value = extra.time || 0;
  if (extra.resolution) u.uResolution.value.set(extra.resolution[0], extra.resolution[1]);
  u.uBaseColor.value.set(pbr.color || '#888888');
  u.uRoughness.value = pbr.roughness ?? 0.5;
  u.uMetalness.value = pbr.metalness ?? 0;
  u.uEmissiveColor.value.set(pbr.emissive || '#000000');
  u.uEmissiveIntensity.value = pbr.emissiveIntensity ?? 0;
  u.uOpacity.value = pbr.opacity ?? 1;
  u.uShade.value.set(ch.shade || '#333333');
  u.uBands.value = ch.bands || 3;
  u.uSoft.value = ch.soft ?? 0.04;
  u.uRim.value = ch.rim ?? 0.2;
  u.uLight.value.copy(extra.light || lightDir());
  const uv = extra.uv || { mode: 'mesh', aspect: false, min: [0, 0], max: [1, 1] };
  u.uUvMode.value = uv.mode === 'planar' ? 2 : uv.mode === 'normalize' ? 1 : 0;
  u.uUvAspect.value = uv.aspect ? 1 : 0;
  u.uUvMin.value.set(uv.min?.[0] ?? 0, uv.min?.[1] ?? 0);
  u.uUvMax.value.set(uv.max?.[0] ?? 1, uv.max?.[1] ?? 1);
  if (uv.frame) {
    u.uPlanarT.value.set(...uv.frame.tangent);
    u.uPlanarB.value.set(...uv.frame.bitangent);
    u.uPlanarOrigin.value.set(...uv.frame.origin);
    u.uPlanarSize.value.set(uv.frame.size[0], uv.frame.size[1]);
  }
  const values = extra.values || sampleRuntime(spec, (extra.time || 0) * 1000);
  for (const param of spec.params || []) {
    const key = 'uP_' + param.name;
    if (!u[key]) continue;
    const value = values[param.name];
    if (param.type === 'color') u[key].value.set(value || param.default || '#ffffff');
    else if (param.type === 'vec3') u[key].value.set(value?.[0] || 0, value?.[1] || 0, value?.[2] || 0);
    else if (param.type === 'vec2') u[key].value.set(value?.[0] || 0, value?.[1] || 0);
    else if (param.type === 'texture') {
      const data = param.texture || '';
      u[key].value = textureFor(material, data);
      u[key + 'On'].value = data ? 1 : 0;
    } else if (param.type === 'bool') u[key].value = value ? 1 : 0;
    else u[key].value = +value || 0;
  }
}

export function uvForSlot(geometry, slot, uvOpts) {
  const pos = geometry.attributes?.position?.array;
  const uv = geometry.attributes?.uv?.array || null;
  const index = geometry.index?.array || null;
  const slots = geometry.userData?.mfSlotView;
  if (!pos || !slots) return { mode: 'mesh', aspect: false, min: [0, 0], max: [1, 1] };
  const report = slotUvReport(pos, uv, index, slots, slot);
  if (!report) return { mode: 'mesh', aspect: false, min: [0, 0], max: [1, 1] };
  const choice = chooseUvMode({ hasUv: report.hasUv, stretch: report.stretch, uv: uvOpts });
  return { ...choice, min: report.min, max: report.max, frame: report.frame, stretch: report.stretch };
}

export function rememberSlots(geometry, slots) {
  geometry.userData.mfSlotView = slots;
}

export function createPreview(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 20);
  camera.position.set(0.2, 0.35, 2.35);
  camera.lookAt(0, 0, 0);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.72, 40, 28), new THREE.MeshStandardMaterial({ color: 0x222222 }));
  const holder = new THREE.Group();
  holder.add(sphere);
  scene.add(holder);
  let material = null;
  let spec = null;
  let custom = null;
  const clock = new THREE.Clock();
  function resize() {
    const w = Math.max(2, canvas.clientWidth || 240);
    const h = Math.max(2, canvas.clientHeight || 180);
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }
  return {
    setSpec(next, rebuild = true) {
      spec = next;
      if (!rebuild && material) return;
      if (material) material.dispose();
      material = makeProgramMaterial(next);
      sphere.material = material;
      if (custom) custom.material = material;
    },
    setGeometry(geometry) {
      if (custom) { holder.remove(custom); custom.geometry.dispose?.(); custom = null; }
      sphere.visible = !geometry;
      if (!geometry) return;
      custom = new THREE.Mesh(geometry, material || sphere.material);
      holder.add(custom);
    },
    error() { return material?.userData?.compileError || ''; },
    render() {
      if (!spec || !material) return;
      resize();
      const t = clock.getElapsedTime();
      holder.rotation.y = t * 0.35;
      syncProgramMaterial(material, spec, {
        time: t,
        resolution: [canvas.width, canvas.height],
        uv: { mode: 'normalize', aspect: true, min: [0, 0], max: [1, 1], frame: { tangent: [1, 0, 0], bitangent: [0, 1, 0], origin: [0, 0, 0], size: [1.4, 1.4] } },
        values: sampleRuntime(spec, performance.now()),
      });
      renderer.render(scene, camera);
    },
    dispose() { material?.dispose(); renderer.dispose(); },
  };
}

export function geometryFromHead(data) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  setSlots(geometry, data.slots);
  rememberSlots(geometry, data.slots);
  applyGroups(geometry, 2);
  geometry.computeBoundingSphere();
  return geometry;
}
