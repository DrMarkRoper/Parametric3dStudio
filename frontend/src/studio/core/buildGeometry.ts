import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import type {
  Doc,
  ExtrudeFeature,
  ImportFeature,
  PlaneId,
  PrimitiveFeature,
  SketchFeature,
} from '../types';
import { evalExpression, resolveParameters, type Params } from './expressions';
import { computeRegions, defaultRegions, regionContains, type FaceRegion } from './sketchGeometry';
import type { Vec2 } from '../types';

/* ---------- Sketch planes ---------- */

export function planeBasis(plane: PlaneId, offset: number): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (plane === 'XZ') m.makeRotationX(-Math.PI / 2);
  else if (plane === 'YZ') m.makeRotationY(Math.PI / 2);
  const n = planeNormal(plane);
  m.setPosition(n.multiplyScalar(offset));
  return m;
}

/**
 * Returns the world-space matrix for a sketch's drawing plane.
 * Handles both standard planes (XY/XZ/YZ with an offset expression) and
 * arbitrary face-derived planes stored in sketch.customPlane.
 */
export function sketchMatrix(sketch: SketchFeature, params: Params): THREE.Matrix4 {
  if (sketch.customPlane && sketch.customPlane.length === 16) {
    return new THREE.Matrix4().fromArray(sketch.customPlane);
  }
  let offset = 0;
  try {
    offset = evalExpression(sketch.offset || '0', params);
  } catch {
    /* leave offset = 0 on parse errors */
  }
  return planeBasis(sketch.plane, offset);
}

export function planeNormal(plane: PlaneId): THREE.Vector3 {
  if (plane === 'XY') return new THREE.Vector3(0, 0, 1);
  if (plane === 'XZ') return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(1, 0, 0);
}

export const PLANE_LABELS: Record<PlaneId, string> = {
  XZ: 'Top (XZ)',
  XY: 'Front (XY)',
  YZ: 'Right (YZ)',
};

/* ---------- CSG ---------- */

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal'];
evaluator.useGroups = false;

function prepGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = g.index ? g.toNonIndexed() : g.clone();
  for (const name of Object.keys(c.attributes)) {
    if (name !== 'position' && name !== 'normal') c.deleteAttribute(name);
  }
  if (!c.attributes.normal) c.computeVertexNormals();
  return c;
}

function csg(a: THREE.BufferGeometry, b: THREE.BufferGeometry, op: typeof SUBTRACTION): THREE.BufferGeometry {
  const ba = new Brush(prepGeometry(a));
  const bb = new Brush(prepGeometry(b));
  ba.updateMatrixWorld();
  bb.updateMatrixWorld();
  const res = evaluator.evaluate(ba, bb, op);
  res.geometry.computeVertexNormals();
  return res.geometry;
}

/* ---------- Feature geometry ---------- */

/**
 * Pick the set of regions to extrude given the user's saved selection points.
 * Auto-heals when sketch entities have been moved, resized, or deleted:
 *   1. Try exact containment for each saved regionPt.
 *   2. For unmatched regionPts, snap to the nearest unused region by `rep` distance
 *      (so a small entity move still extrudes the "same" profile).
 *   3. If still nothing matches, fall back to defaultRegions ("extrude all").
 */
function chooseRegions(regions: FaceRegion[], regionPts?: Vec2[]): FaceRegion[] {
  if (!regionPts || !regionPts.length) return defaultRegions(regions);
  const chosen = new Set<FaceRegion>();
  const matched = regionPts.map(() => false);
  for (let i = 0; i < regionPts.length; i++) {
    const p = regionPts[i];
    const r = regions.find((reg) => regionContains(reg, p));
    if (r) { chosen.add(r); matched[i] = true; }
  }
  for (let i = 0; i < regionPts.length; i++) {
    if (matched[i]) continue;
    const p = regionPts[i];
    let best: FaceRegion | null = null;
    let bestD = Infinity;
    for (const r of regions) {
      if (chosen.has(r)) continue;
      const d = (r.rep.x - p.x) ** 2 + (r.rep.y - p.y) ** 2;
      if (d < bestD) { bestD = d; best = r; }
    }
    if (best) chosen.add(best);
  }
  if (!chosen.size) return defaultRegions(regions);
  return Array.from(chosen);
}

function buildExtrude(f: ExtrudeFeature, sketch: SketchFeature, params: Params): THREE.BufferGeometry {
  const regions = computeRegions(sketch, params);
  if (!regions.length) throw new Error(`${f.name}: sketch "${sketch.name}" has no closed profile`);
  const chosen = chooseRegions(regions, f.regionPts);
  if (!chosen.length) throw new Error(`${f.name}: selected profile regions no longer exist in the sketch`);
  const shapes = chosen.map((r) => r.shape);
  let depth = evalExpression(f.distance, params);
  if (Math.abs(depth) < 1e-6) throw new Error(`${f.name}: distance is zero`);
  const flip = depth < 0;
  depth = Math.abs(depth);

  let edgeSize = 0;
  if (f.edge) {
    edgeSize = evalExpression(f.edge.size, params);
  }
  const useBevel = edgeSize > 0 && depth > 2 * edgeSize;

  const settings: THREE.ExtrudeGeometryOptions = useBevel
    ? {
        depth: depth - 2 * edgeSize,
        curveSegments: 64,
        bevelEnabled: true,
        bevelThickness: edgeSize,
        bevelSize: edgeSize,
        bevelOffset: -edgeSize,
        bevelSegments: f.edge!.kind === 'chamfer' ? 1 : 5,
      }
    : { depth, curveSegments: 64, bevelEnabled: false };

  const g = new THREE.ExtrudeGeometry(shapes, settings);
  if (useBevel) g.translate(0, 0, edgeSize);
  if (flip) g.translate(0, 0, -depth);
  // Perpendicular start height: shift the whole solid along the plane normal so
  // it begins `offset` above the sketch plane instead of at 0.
  const offset = f.offset ? evalExpression(f.offset, params) : 0;
  if (offset) g.translate(0, 0, offset);
  g.applyMatrix4(sketchMatrix(sketch, params));
  return g;
}

function chamferedBox(w: number, h: number, d: number, c: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -d / 2);
  shape.lineTo(w / 2, -d / 2);
  shape.lineTo(w / 2, d / 2);
  shape.lineTo(-w / 2, d / 2);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: h - 2 * c,
    bevelEnabled: true,
    bevelThickness: c,
    bevelSize: c,
    bevelOffset: -c,
    bevelSegments: 1,
  });
  g.rotateX(-Math.PI / 2);
  // after rotateX(-90) the solid spans y in [-c, h-c]; recenter to [-h/2, h/2]
  g.translate(0, c - h / 2, 0);
  return g;
}

function lathedCylinder(r: number, h: number, edge?: { kind: 'fillet' | 'chamfer'; size: number }): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -h / 2)];
  const s = edge?.size ?? 0;
  if (!edge || s <= 0 || s >= r || 2 * s >= h) {
    pts.push(new THREE.Vector2(r, -h / 2), new THREE.Vector2(r, h / 2));
  } else if (edge.kind === 'chamfer') {
    pts.push(
      new THREE.Vector2(r - s, -h / 2),
      new THREE.Vector2(r, -h / 2 + s),
      new THREE.Vector2(r, h / 2 - s),
      new THREE.Vector2(r - s, h / 2)
    );
  } else {
    pts.push(new THREE.Vector2(r - s, -h / 2));
    // bottom arc: center (r-s, -h/2+s), from -90° to 0°
    for (let k = 1; k <= 6; k++) {
      const t = -Math.PI / 2 + (k / 6) * (Math.PI / 2);
      pts.push(new THREE.Vector2(r - s + s * Math.cos(t), -h / 2 + s + s * Math.sin(t)));
    }
    // top arc: center (r-s, h/2-s), from 0° to 90°
    for (let k = 0; k <= 6; k++) {
      const t = (k / 6) * (Math.PI / 2);
      pts.push(new THREE.Vector2(r - s + s * Math.cos(t), h / 2 - s + s * Math.sin(t)));
    }
  }
  pts.push(new THREE.Vector2(0, h / 2));
  const g = new THREE.LatheGeometry(pts, 64);
  g.computeVertexNormals();
  return g;
}

/* ---------- Helical thread primitives (Create → Custom) ----------
 *
 * `buildThreadedShaft` returns a closed solid mesh of a cylinder whose outer
 * surface carries a helical thread. The surface is generated as a parametric
 * (θ, z) grid where:
 *
 *   r(θ, z) = rMinor + threadDepth × profile(phase(θ, z)) × taper(z)
 *
 *   phase  — position within one pitch, derived from z − (θ / 2π) × pitch
 *   taper  — 0 → 1 over the first half-pitch of the body and 1 → 0 over the
 *            last half-pitch, so the thread fades cleanly into flat end discs
 *            (avoids a torn ribbon at the cap edges).
 *
 * Two profile shapes are supported:
 *   • 'v'      — sharp 60° triangle (ISO 68-1 basic profile, used for bolts /
 *                 nuts)
 *   • 'edison' — smooth sinusoidal hump (close-enough approximation to the
 *                 rounded trapezoidal profile of IEC 60061 bulb threads)
 *
 * The returned BufferGeometry is centred around y = 0 (i.e. it spans
 * y ∈ [-height/2, height/2]) with the thread axis along Y. The mesh is a
 * closed manifold (top + bottom flat discs at rMinor join the threaded side
 * surface), so it can be fed to CSG operations without seam artefacts.
 */
type ThreadProfile = 'v' | 'edison';

function profileFn(kind: ThreadProfile): (t: number) => number {
  if (kind === 'v') {
    // Triangle in [0,1] peaking at 0.5.
    return (t) => (t < 0.5 ? 2 * t : 2 * (1 - t));
  }
  // Smooth sinusoidal hump: 0 at t=0 / t=1, 1 at t=0.5.
  return (t) => 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
}

function buildThreadedShaft(opts: {
  rMinor: number;
  rMajor: number;
  pitch: number;
  height: number;
  profile: ThreadProfile;
  angularSegs?: number;
  axialSegsPerPitch?: number;
}): THREE.BufferGeometry {
  const { rMinor, rMajor, pitch, height, profile } = opts;
  const angularSegs = Math.max(24, opts.angularSegs ?? 64);
  const perPitch = Math.max(6, opts.axialSegsPerPitch ?? 12);
  const axialSegs = Math.max(12, Math.ceil((height / pitch) * perPitch));

  const prof = profileFn(profile);
  const dr = rMajor - rMinor;
  const stride = angularSegs + 1;
  const positions: number[] = [];
  const indices: number[] = [];

  // Taper window — how quickly the thread fades to flat at the ends. Roughly
  // one full pitch so the fade is visible but doesn't eat the entire body on
  // very short threads.
  const fade = Math.min(pitch, height * 0.45);
  const taperAt = (z: number): number => {
    if (z <= 0 || z >= height) return 0;
    if (fade <= 0) return 1;
    if (z < fade) return z / fade;
    if (z > height - fade) return (height - z) / fade;
    return 1;
  };

  // Side surface vertices: (i = axial index, j = angular index).
  for (let i = 0; i <= axialSegs; i++) {
    const z = (i / axialSegs) * height;
    const taper = taperAt(z);
    for (let j = 0; j <= angularSegs; j++) {
      const θ = (j / angularSegs) * 2 * Math.PI;
      // Phase folded into [0, 1) — note JS % can be negative for negative dividends.
      const raw = (z - (pitch * θ) / (2 * Math.PI)) / pitch;
      const phase = raw - Math.floor(raw);
      const r = rMinor + dr * prof(phase) * taper;
      // Centre around y = 0; thread axis is Y.
      positions.push(r * Math.cos(θ), z - height / 2, r * Math.sin(θ));
    }
  }

  // Side-surface triangles. With vertices placed at
  //   (r·cos θ, z-h/2, r·sin θ) and θ increasing CCW seen from +Y,
  // CCW winding seen from OUTSIDE the cylinder is (a, c, b) and (b, c, d):
  //   v1 = c - a ≈ +Y, v2 = b - a ≈ +Z  →  cross ≈ +X (outward at θ=0).
  // Picking the opposite winding here was the bug that made bvh-csg treat the
  // helical plug as inside-out and produce a smooth cylindrical bore.
  for (let i = 0; i < axialSegs; i++) {
    for (let j = 0; j < angularSegs; j++) {
      const a = i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  // Bottom cap centre + triangle fan (y = -height/2). Normals must face -Y.
  const botCenter = positions.length / 3;
  positions.push(0, -height / 2, 0);
  for (let j = 0; j < angularSegs; j++) {
    const a = j;
    const b = j + 1;
    indices.push(botCenter, a, b);
  }

  // Top cap centre + triangle fan (y = +height/2). Normals must face +Y.
  const topCenter = positions.length / 3;
  positions.push(0, height / 2, 0);
  const topRow = axialSegs * stride;
  for (let j = 0; j < angularSegs; j++) {
    const a = topRow + j;
    const b = topRow + j + 1;
    indices.push(topCenter, b, a);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** Merges several BufferGeometries into one without true CSG.
 *  The pieces overlap visibly (and as a non-manifold STL), but for the simple
 *  bulb/screw stacks we build below the result reads correctly. */
function mergeRaw(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  for (const p of parts) {
    const g = p.index ? p.clone() : p.clone();
    if (!g.attributes.normal) g.computeVertexNormals();
    const pos = g.attributes.position.array as ArrayLike<number>;
    const nrm = g.attributes.normal.array as ArrayLike<number>;
    for (let i = 0; i < pos.length; i++) positions.push(pos[i]);
    for (let i = 0; i < nrm.length; i++) normals.push(nrm[i]);
    if (g.index) {
      const idx = g.index.array as ArrayLike<number>;
      for (let i = 0; i < idx.length; i++) indices.push(idx[i] + offset);
    } else {
      // Non-indexed: emit sequential indices.
      const n = pos.length / 3;
      for (let i = 0; i < n; i++) indices.push(i + offset);
    }
    offset += pos.length / 3;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  out.setIndex(indices);
  return out;
}

/** Bulb-screw geometry, returned as two independent meshes so the renderer
 *  can paint them with different colours:
 *    • `cap`  — threaded Edison shell + small contact dome at the bottom
 *               (the "secondary contact" / foot pip on a real bulb).
 *    • `bulb` — glass envelope sphere sitting on top of the cap.
 *  Origin is the centre of the cap (y = 0). The cap spans
 *  [-capHeight/2, +capHeight/2]; the contact dome extends slightly below
 *  -capHeight/2; the bulb sits above +capHeight/2. */
function buildBulbScrewParts(
  outerDia: number,
  pitch: number,
  threadDepth: number,
  capHeight: number,
  bulbDia: number,
): { cap: THREE.BufferGeometry; bulb: THREE.BufferGeometry } {
  const rMajor = outerDia / 2;
  const rMinor = Math.max(0.1, rMajor - threadDepth);
  const cap = buildThreadedShaft({
    rMinor,
    rMajor,
    pitch,
    height: capHeight,
    profile: 'edison',
  });
  // Bottom contact: a small sphere whose upper hemisphere overlaps inside the
  // cap so only the rounded "pip" shows. Sized as a fraction of the outer
  // diameter so it scales naturally across E14 → E40.
  const contactR = outerDia * 0.18;
  const contact = new THREE.SphereGeometry(contactR, 24, 16);
  // Slight vertical squash makes the pip read as a dome rather than a ball.
  contact.scale(1, 0.7, 1);
  contact.translate(0, -capHeight / 2 - contactR * 0.15, 0);
  const capWithContact = mergeRaw([cap, contact]);
  // Glass bulb: a sphere tangent to the top of the cap. The small inward
  // shift (rMajor × 0.4) hides the awkward join inside the cap's top disc.
  const bulbR = Math.max(rMajor, bulbDia / 2);
  const bulb = new THREE.SphereGeometry(bulbR, 48, 32);
  bulb.translate(0, capHeight / 2 + bulbR - rMajor * 0.4, 0);
  return { cap: capWithContact, bulb };
}

/** Single-mesh fallback for op = 'cut' / 'fuse' (where we need one combined
 *  body to feed CSG against the existing scene). The split-colour rendering
 *  path uses `buildBulbScrewParts` directly. */
function buildBulbScrew(
  outerDia: number,
  pitch: number,
  threadDepth: number,
  capHeight: number,
  bulbDia: number,
): THREE.BufferGeometry {
  const { cap, bulb } = buildBulbScrewParts(outerDia, pitch, threadDepth, capHeight, bulbDia);
  return mergeRaw([cap, bulb]);
}

/** Bulb-socket: a cylindrical holder with a rounded Edison thread cut into a
 *  central bore. The outside is a smooth cylinder; the bore receives the
 *  matching bulb screw. */
function buildBulbSocket(
  outerDia: number,
  pitch: number,
  threadDepth: number,
  height: number,
  wallThickness: number,
): THREE.BufferGeometry {
  const boreR = outerDia / 2; // bore outer (where the bulb's crest sits)
  const shellR = boreR + Math.max(0.5, wallThickness);
  // The "screw plug" that we subtract: same radii as the bulb screw cap,
  // slightly taller so the cut goes clean through the socket top/bottom.
  const rMajor = boreR;
  const rMinor = Math.max(0.1, rMajor - threadDepth);
  const plug = buildThreadedShaft({
    rMinor,
    rMajor,
    pitch,
    height: height + pitch, // overshoot for clean cut
    profile: 'edison',
  });
  const shell = new THREE.CylinderGeometry(shellR, shellR, height, 64);
  return csg(shell, plug, SUBTRACTION);
}

/** Screw / bolt: a hex head sitting on top of a V-threaded shaft. The shaft
 *  hangs DOWN from the head — origin centred between the head top and shaft
 *  bottom so the body sits sensibly with the default y placement. */
function buildBoltScrew(
  outerDia: number,
  pitch: number,
  threadDepth: number,
  shaftHeight: number,
  headDia: number,
  headHeight: number,
): THREE.BufferGeometry {
  const rMajor = outerDia / 2;
  const rMinor = Math.max(0.1, rMajor - threadDepth);
  const shaft = buildThreadedShaft({
    rMinor,
    rMajor,
    pitch,
    height: shaftHeight,
    profile: 'v',
  });
  // shaft is centred at y = 0; lower it so its top sits at y = 0.
  shaft.translate(0, -shaftHeight / 2, 0);
  // Hex head sits on top of the shaft (radialSegments=6 → flat hex sides).
  // headDia is across the corners (matches the user's outerDiameter intuition).
  const headR = headDia / 2;
  const head = new THREE.CylinderGeometry(headR, headR, headHeight, 6);
  head.translate(0, headHeight / 2, 0);
  // Centre the combined body so origin is at (shaftHeight - headHeight) / 2 below the head/shaft join.
  const merged = mergeRaw([shaft, head]);
  // total span: y ∈ [-shaftHeight, headHeight]. Recentre.
  merged.translate(0, (shaftHeight - headHeight) / 2, 0);
  return merged;
}

/** Nut: a hex prism with a V-threaded bore. */
function buildBoltNut(
  outerDia: number,
  pitch: number,
  threadDepth: number,
  height: number,
  hexAcrossFlats: number,
): THREE.BufferGeometry {
  // CylinderGeometry with radialSegments=6 measures radius across CORNERS, but
  // hex nut "size" is universally quoted across FLATS. Convert: rCorners = rFlats / cos(30°).
  const rFlats = hexAcrossFlats / 2;
  const rCorners = rFlats / Math.cos(Math.PI / 6);
  const hex = new THREE.CylinderGeometry(rCorners, rCorners, height, 6);
  const rMajor = outerDia / 2;
  const rMinor = Math.max(0.1, rMajor - threadDepth);
  const plug = buildThreadedShaft({
    rMinor,
    rMajor,
    pitch,
    height: height + pitch * 2,
    profile: 'v',
  });
  return csg(hex, plug, SUBTRACTION);
}

function buildPrimitive(f: PrimitiveFeature, params: Params): THREE.BufferGeometry {
  const dim = (k: string) => evalExpression(f.dims[k] ?? '0', params);
  let g: THREE.BufferGeometry;
  const edgeSize = f.edge ? evalExpression(f.edge.size, params) : 0;

  switch (f.shape) {
    case 'box': {
      const w = dim('width');
      const h = dim('height');
      const d = dim('depth');
      if (w <= 0 || h <= 0 || d <= 0) throw new Error(`${f.name}: box dimensions must be > 0`);
      if (f.edge && edgeSize > 0 && 2 * edgeSize < Math.min(w, h, d)) {
        g =
          f.edge.kind === 'fillet'
            ? new RoundedBoxGeometry(w, h, d, 4, edgeSize)
            : chamferedBox(w, h, d, edgeSize);
      } else {
        g = new THREE.BoxGeometry(w, h, d);
      }
      break;
    }
    case 'sphere': {
      const r = dim('radius');
      if (r <= 0) throw new Error(`${f.name}: radius must be > 0`);
      g = new THREE.SphereGeometry(r, 48, 32);
      break;
    }
    case 'cylinder': {
      const r = dim('radius');
      const h = dim('height');
      if (r <= 0 || h <= 0) throw new Error(`${f.name}: cylinder dimensions must be > 0`);
      g = lathedCylinder(r, h, f.edge ? { kind: f.edge.kind, size: edgeSize } : undefined);
      break;
    }
    case 'cone': {
      const r = dim('radius');
      const h = dim('height');
      if (r <= 0 || h <= 0) throw new Error(`${f.name}: cone dimensions must be > 0`);
      g = new THREE.ConeGeometry(r, h, 48);
      break;
    }
    case 'torus': {
      const r = dim('radius');
      const tube = dim('tube');
      if (r <= 0 || tube <= 0) throw new Error(`${f.name}: torus dimensions must be > 0`);
      g = new THREE.TorusGeometry(r, tube, 24, 64);
      g.rotateX(-Math.PI / 2);
      break;
    }
    case 'bulbScrew': {
      const od = dim('outerDiameter');
      const p = dim('pitch');
      const td = dim('threadDepth');
      const h = dim('height');
      const bd = dim('bulbDiameter');
      if (od <= 0 || p <= 0 || td <= 0 || h <= 0 || bd <= 0)
        throw new Error(`${f.name}: thread parameters must be > 0`);
      if (td * 2 >= od) throw new Error(`${f.name}: threadDepth too large for outerDiameter`);
      g = buildBulbScrew(od, p, td, h, bd);
      break;
    }
    case 'bulbSocket': {
      const od = dim('outerDiameter');
      const p = dim('pitch');
      const td = dim('threadDepth');
      const h = dim('height');
      const wt = dim('wallThickness');
      if (od <= 0 || p <= 0 || td <= 0 || h <= 0 || wt <= 0)
        throw new Error(`${f.name}: socket parameters must be > 0`);
      if (td * 2 >= od) throw new Error(`${f.name}: threadDepth too large for outerDiameter`);
      g = buildBulbSocket(od, p, td, h, wt);
      break;
    }
    case 'screwThread': {
      const od = dim('outerDiameter');
      const p = dim('pitch');
      const td = dim('threadDepth');
      const sh = dim('height');
      const hd = dim('headDiameter');
      const hh = dim('headHeight');
      if (od <= 0 || p <= 0 || td <= 0 || sh <= 0 || hd <= 0 || hh <= 0)
        throw new Error(`${f.name}: screw parameters must be > 0`);
      if (td * 2 >= od) throw new Error(`${f.name}: threadDepth too large for outerDiameter`);
      g = buildBoltScrew(od, p, td, sh, hd, hh);
      break;
    }
    case 'nutThread': {
      const od = dim('outerDiameter');
      const p = dim('pitch');
      const td = dim('threadDepth');
      const h = dim('height');
      const sz = dim('outerSize');
      if (od <= 0 || p <= 0 || td <= 0 || h <= 0 || sz <= 0)
        throw new Error(`${f.name}: nut parameters must be > 0`);
      if (sz <= od) throw new Error(`${f.name}: outerSize must exceed outerDiameter`);
      if (td * 2 >= od) throw new Error(`${f.name}: threadDepth too large for outerDiameter`);
      g = buildBoltNut(od, p, td, h, sz);
      break;
    }
  }

  applyPrimitiveTransform(g, f, params);
  return g;
}

/** Apply the feature's `position` + `rotation` expressions to a built mesh,
 *  in-place. Shared between the standard buildPrimitive path and the
 *  bulb-screw split-colour path so both move/rotate identically. */
function applyPrimitiveTransform(g: THREE.BufferGeometry, f: PrimitiveFeature, params: Params) {
  // (legacy docs may have rotationY instead of rotation[])
  const rot = f.rotation ?? ['0', (f as unknown as { rotationY?: string }).rotationY ?? '0', '0'];
  const e = new THREE.Euler(
    (evalExpression(rot[0] || '0', params) * Math.PI) / 180,
    (evalExpression(rot[1] || '0', params) * Math.PI) / 180,
    (evalExpression(rot[2] || '0', params) * Math.PI) / 180,
  );
  const px = evalExpression(f.position[0], params);
  const py = evalExpression(f.position[1], params);
  const pz = evalExpression(f.position[2], params);
  const m = new THREE.Matrix4().makeRotationFromEuler(e).setPosition(px, py, pz);
  g.applyMatrix4(m);
}

/** Build a bulb screw as its two coloured parts and apply the feature's
 *  position/rotation to both. Pure — does NOT push bodies; the caller in
 *  `regenerate` decides how to record them. */
function buildBulbScrewFeatureParts(
  f: PrimitiveFeature,
  params: Params,
): { cap: THREE.BufferGeometry; bulb: THREE.BufferGeometry } {
  const dim = (k: string) => evalExpression(f.dims[k] ?? '0', params);
  const od = dim('outerDiameter');
  const p = dim('pitch');
  const td = dim('threadDepth');
  const h = dim('height');
  const bd = dim('bulbDiameter');
  if (od <= 0 || p <= 0 || td <= 0 || h <= 0 || bd <= 0)
    throw new Error(`${f.name}: thread parameters must be > 0`);
  if (td * 2 >= od) throw new Error(`${f.name}: threadDepth too large for outerDiameter`);
  const parts = buildBulbScrewParts(od, p, td, h, bd);
  applyPrimitiveTransform(parts.cap, f, params);
  applyPrimitiveTransform(parts.bulb, f, params);
  return parts;
}

/** Default glass-bulb colour when `secondaryColor` is not set on the feature. */
const DEFAULT_BULB_GLASS_COLOR = '#f4e6a8';

function buildImport(f: ImportFeature, cache: Map<string, THREE.BufferGeometry>): THREE.BufferGeometry {
  const src = cache.get(f.id);
  if (!src) throw new Error(`${f.name}: imported mesh data not available (re-import the file)`);
  const g = src.clone();
  const m = new THREE.Matrix4();
  const e = new THREE.Euler(
    (f.rotation[0] * Math.PI) / 180,
    (f.rotation[1] * Math.PI) / 180,
    (f.rotation[2] * Math.PI) / 180
  );
  m.makeRotationFromEuler(e);
  m.scale(new THREE.Vector3(f.scale, f.scale, f.scale));
  m.setPosition(f.position[0], f.position[1], f.position[2]);
  g.applyMatrix4(m);
  return g;
}

/* ---------- Regeneration ---------- */

export interface BodyOut {
  featureId: string;
  name: string;
  geometry: THREE.BufferGeometry;
  color: string;
  opacity: number;
}

export interface RegenResult {
  bodies: BodyOut[];
  errors: { featureId: string; message: string }[];
  params: Params;
  paramErrors: Record<string, string>;
}

export function regenerate(doc: Doc, importCache: Map<string, THREE.BufferGeometry>): RegenResult {
  const { values: params, errors: paramErrors } = resolveParameters(doc.parameters);
  const bodies: BodyOut[] = [];
  const errors: { featureId: string; message: string }[] = [];

  const applyOp = (f: ExtrudeFeature | PrimitiveFeature, tool: THREE.BufferGeometry, color: string, name: string) => {
    if (f.op === 'cut') {
      if (!bodies.length) throw new Error(`${name}: nothing to cut (no existing bodies)`);
      for (const b of bodies) {
        b.geometry = csg(b.geometry, tool, SUBTRACTION);
      }
    } else if (f.op === 'fuse' && bodies.length) {
      const target = bodies[bodies.length - 1];
      target.geometry = csg(target.geometry, tool, ADDITION);
    } else {
      bodies.push({ featureId: f.id, name, geometry: tool, color, opacity: f.opacity ?? 1 });
    }
  };

  for (const f of doc.features) {
    if (!f.visible) continue;
    try {
      if (f.type === 'extrude') {
        const sketch = doc.features.find((s) => s.id === f.sketchId && s.type === 'sketch') as
          | SketchFeature
          | undefined;
        if (!sketch) throw new Error(`${f.name}: source sketch missing`);
        applyOp(f, buildExtrude(f, sketch, params), f.color, f.name);
      } else if (f.type === 'primitive') {
        if (f.shape === 'bulbScrew' && f.op === 'new') {
          // Split-colour rendering: cap (+ contact pip) uses f.color, glass bulb
          // uses f.secondaryColor. Both bodies share the same featureId so
          // selecting either picks the bulb-screw feature in the tree.
          const { cap, bulb } = buildBulbScrewFeatureParts(f, params);
          bodies.push({
            featureId: f.id,
            name: `${f.name} (cap)`,
            geometry: cap,
            color: f.color,
            opacity: f.opacity ?? 1,
          });
          bodies.push({
            featureId: f.id,
            name: `${f.name} (bulb)`,
            geometry: bulb,
            color: f.secondaryColor ?? DEFAULT_BULB_GLASS_COLOR,
            // Glass has its own slider; falls back to opaque when unset.
            opacity: f.secondaryOpacity ?? 1,
          });
        } else {
          applyOp(f, buildPrimitive(f, params), f.color, f.name);
        }
      } else if (f.type === 'import') {
        bodies.push({
          featureId: f.id,
          name: f.name,
          geometry: buildImport(f, importCache),
          color: f.color,
          opacity: f.opacity ?? 1,
        });
      } else if (f.type === 'boolean') {
        const ti = bodies.findIndex((b) => b.featureId === f.targetId);
        const gi = bodies.findIndex((b) => b.featureId === f.toolId);
        if (ti < 0 || gi < 0) {
          throw new Error(`${f.name}: source bodies not available (deleted, hidden, or already merged)`);
        }
        const opMap = { cut: SUBTRACTION, fuse: ADDITION, intersect: INTERSECTION } as const;
        const geom = csg(bodies[ti].geometry, bodies[gi].geometry, opMap[f.op]);
        const empty = !geom.getAttribute('position') || geom.getAttribute('position').count === 0;
        bodies[ti] = { featureId: f.id, name: f.name, geometry: geom, color: f.color, opacity: f.opacity ?? 1 };
        bodies.splice(gi, 1);
        if (empty) throw new Error(`${f.name}: result is empty (the bodies may not overlap)`);
      }
      // sketches render separately
    } catch (e) {
      errors.push({ featureId: f.id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { bodies, errors, params, paramErrors };
}
