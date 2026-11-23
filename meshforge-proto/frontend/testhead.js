// Procedural MIT test head: a slightly wide rounded helmet, a curved front screen
// inside a raised rim, two top paddles, and side pods. Original MIT code.
// Slot 0 is the shell. Slot 1 is the face panel.

const RX = 0.72, RY = 0.64, RZ = 0.6;

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function createState() {
  return { positions: [], normals: [], uvs: [], indices: [], slots: [], count: 0 };
}

function addTri(state, a, b, c, slot, ua, ub, uc) {
  const n = norm(cross(sub(b, a), sub(c, a)));
  const base = state.count;
  const verts = [[a, ua], [b, ub], [c, uc]];
  for (const [p, uv] of verts) {
    state.positions.push(p[0], p[1], p[2]);
    state.normals.push(n[0], n[1], n[2]);
    state.uvs.push(uv[0], uv[1]);
  }
  state.indices.push(base, base + 1, base + 2);
  state.slots.push(slot);
  state.count += 3;
}

function deepPanel(p) {
  return p[2] > 0.2 && Math.abs(p[0]) < 0.29 && p[1] > -0.2 && p[1] < 0.3;
}
function rimBand(p) {
  return p[2] > 0.12 && Math.abs(p[0]) < 0.42 && p[1] > -0.34 && p[1] < 0.4 && !deepPanel(p);
}

function addEllipsoid(state, cx, cy, cz, rx, ry, rz, segW, segH, slot, filter) {
  const grid = [];
  for (let y = 0; y <= segH; y++) {
    const row = [];
    const v = y / segH;
    const phi = v * Math.PI;
    for (let x = 0; x <= segW; x++) {
      const u = x / segW;
      const theta = u * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(theta);
      let p = [cx + nx * rx, cy + ny * ry, cz + nz * rz];
      if (filter) p = filter(p, [nx, ny, nz]);
      row.push({ p, uv: [u, 1 - v] });
    }
    grid.push(row);
  }
  for (let y = 0; y < segH; y++) {
    for (let x = 0; x < segW; x++) {
      const a = grid[y][x], b = grid[y][x + 1], c = grid[y + 1][x], d = grid[y + 1][x + 1];
      if (slot === 0 && deepPanel(a.p) && deepPanel(b.p) && deepPanel(c.p) && deepPanel(d.p)) continue;
      addTri(state, a.p, b.p, c.p, slot, a.uv, b.uv, c.uv);
      addTri(state, b.p, d.p, c.p, slot, b.uv, d.uv, c.uv);
    }
  }
}

function addPanel(state) {
  const nx = 14, ny = 12;
  const W = 0.5, H = 0.44;
  const grid = [];
  for (let y = 0; y <= ny; y++) {
    const row = [];
    const v = y / ny;
    for (let x = 0; x <= nx; x++) {
      const u = x / nx;
      const px = (u - 0.5) * W;
      const py = (v - 0.5) * H + 0.05;
      const pz = 0.47 - px * px * 0.62 - (py - 0.05) * (py - 0.05) * 0.4;
      row.push({ p: [px, py, pz], uv: [u, v] });
    }
    grid.push(row);
  }
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const a = grid[y][x], b = grid[y][x + 1], c = grid[y + 1][x], d = grid[y + 1][x + 1];
      addTri(state, a.p, b.p, c.p, 1, a.uv, b.uv, c.uv);
      addTri(state, b.p, d.p, c.p, 1, b.uv, d.uv, c.uv);
    }
  }
}

export function buildTestHead() {
  const state = createState();
  addEllipsoid(state, 0, 0, 0, RX, RY, RZ, 28, 18, 0, (p, n) => (rimBand(p) ? [p[0] + n[0] * 0.055, p[1] + n[1] * 0.055, p[2] + n[2] * 0.055] : p));
  addEllipsoid(state, -0.24, 0.86, 0.02, 0.1, 0.18, 0.04, 10, 8, 0);
  addEllipsoid(state, 0.24, 0.86, 0.02, 0.1, 0.18, 0.04, 10, 8, 0);
  addEllipsoid(state, -0.8, 0.02, 0.05, 0.12, 0.12, 0.12, 10, 8, 0);
  addEllipsoid(state, 0.8, 0.02, 0.05, 0.12, 0.12, 0.12, 10, 8, 0);
  addPanel(state);
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < state.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], state.positions[i + k]);
      max[k] = Math.max(max[k], state.positions[i + k]);
    }
  }
  return {
    positions: Float32Array.from(state.positions),
    normals: Float32Array.from(state.normals),
    uvs: Float32Array.from(state.uvs),
    indices: Uint32Array.from(state.indices),
    slots: Uint16Array.from(state.slots),
    bounds: { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] },
    faceSlot: 1,
  };
}
