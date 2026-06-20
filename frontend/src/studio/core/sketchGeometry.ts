import * as THREE from 'three';
import type { CogProfile, CornerMod, DimensionAnchor, EdgeKind, LineEntity, SketchEntity, SketchFeature, Vec2 } from '../types';
import { evalExpression, tryEval, type Params } from './expressions';

export const dist2d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

const MATCH_TOL = 0.05; // tolerance for matching corner mods to vertices

function norm(v: Vec2): Vec2 {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

/** Display/tessellation segment count for a circle of radius r. */
export function circleSegs(r: number): number {
  return Math.min(256, Math.max(64, Math.ceil(r * 4)));
}

export function circlePoly(center: Vec2, r: number, segs = 96): Vec2[] {
  const pts: Vec2[] = [];
  for (let k = 0; k < segs; k++) {
    const t = (k / segs) * Math.PI * 2;
    pts.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  return pts;
}

/** Ellipse perimeter polygon. Falls back to a circle when rx === ry and rotation === 0.
 *  Rotation uses the same CW-positive convention as `rectCorners` so the
 *  static-rotate UI's positive-angle input rotates ovals the same way it
 *  rotates rectangles. */
export function ellipsePoly(center: Vec2, rx: number, ry: number, segs = 96, rotation = 0): Vec2[] {
  if (rx === ry && !rotation) return circlePoly(center, rx, segs);
  const a = (rotation * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const pts: Vec2[] = [];
  for (let k = 0; k < segs; k++) {
    const t = (k / segs) * Math.PI * 2;
    const lx = rx * Math.cos(t);
    const ly = ry * Math.sin(t);
    pts.push({ x: center.x + lx * c + ly * s, y: center.y - lx * s + ly * c });
  }
  return pts;
}

/** Resolve a circle entity's effective rx/ry. Defaults ry to rx when omitted. */
export function circleRadii(e: { radius: string; radiusY?: string }, params: Params): { rx: number; ry: number } {
  const rx = evalExpression(e.radius, params);
  const ry = e.radiusY ? evalExpression(e.radiusY, params) : rx;
  return { rx, ry };
}

/** Resolve a cog entity's evaluated outer / inner radii. Returns null if either
 *  expression fails to evaluate (caller skips rendering). */
export function cogRadii(
  e: { outerRadius: string; innerRadius: string },
  params: Params,
): { outer: number; inner: number } | null {
  const outer = tryEval(e.outerRadius, params);
  const inner = tryEval(e.innerRadius, params);
  if (outer === null || inner === null) return null;
  return { outer, inner };
}

/** Cog perimeter polygon. Vertices emitted in math-CCW order so the
 *  trace-cycles step treats the enclosed area as positive. `rotation` is in
 *  degrees, screen-CW positive (matches the rest of the sketch UI). The
 *  `profile` chooses the tooth shape — see CogProfile.
 *
 *  • `square`    — 4 verts/tooth: rectangular tooth, equal-width tooth & gap
 *  • `pointy`    — 2 verts/tooth: a star polygon, tip on outerR, valley on innerR
 *  • `trapezoid` — 4 verts/tooth: tooth tip narrower than its root (gear-like)
 */
export function cogPoly(
  center: Vec2,
  outerR: number,
  innerR: number,
  teeth: number,
  rotation = 0,
  profile: CogProfile = 'square',
): Vec2[] {
  if (teeth < 1) return circlePoly(center, outerR);
  const pts: Vec2[] = [];
  const step = (2 * Math.PI) / teeth;
  // CW-positive screen rotation → CCW-negative math rotation.
  const baseRot = -(rotation * Math.PI) / 180;

  if (profile === 'pointy') {
    // Star polygon: alternate outer tip and inner trough, one each per tooth.
    for (let i = 0; i < teeth; i++) {
      const tip = i * step + baseRot;
      const trough = tip + step / 2;
      pts.push({
        x: center.x + outerR * Math.cos(tip),
        y: center.y + outerR * Math.sin(tip),
      });
      pts.push({
        x: center.x + innerR * Math.cos(trough),
        y: center.y + innerR * Math.sin(trough),
      });
    }
    return pts;
  }

  // square / trapezoid — both emit 4 verts/tooth (two at outerR, two at innerR).
  // The trapezoid's outer edges sit closer together than the inner edges, so
  // the tooth gets narrower at the tip.
  const halfTop  = profile === 'trapezoid' ? step / 6 : step / 4;
  const halfBase = step / 4;
  for (let i = 0; i < teeth; i++) {
    const ang = i * step + baseRot;
    pts.push({ x: center.x + outerR * Math.cos(ang - halfTop),  y: center.y + outerR * Math.sin(ang - halfTop)  });
    pts.push({ x: center.x + outerR * Math.cos(ang + halfTop),  y: center.y + outerR * Math.sin(ang + halfTop)  });
    pts.push({ x: center.x + innerR * Math.cos(ang + halfBase), y: center.y + innerR * Math.sin(ang + halfBase) });
    const next = (i + 1) * step + baseRot;
    pts.push({ x: center.x + innerR * Math.cos(next - halfBase), y: center.y + innerR * Math.sin(next - halfBase) });
  }
  return pts;
}

/** Resolve a dimension anchor to its current sketch-space position, or null if
 *  the referenced entity has been deleted / replaced with a kind that can't host
 *  the requested anchor (caller falls back to the dim's stored absolute point). */
export function resolveDimAnchor(
  anchor: DimensionAnchor,
  sketch: SketchFeature,
  params: Params,
): Vec2 | null {
  const ent = sketch.entities.find((e) => e.id === anchor.entityId);
  if (!ent) return null;
  if (anchor.kind === 'endpoint') {
    if (ent.kind !== 'line') return null;
    return anchor.which === 'p2' ? { ...ent.p2 } : { ...ent.p1 };
  }
  if (anchor.kind === 'midpoint') {
    if (ent.kind !== 'line') return null;
    return { x: (ent.p1.x + ent.p2.x) / 2, y: (ent.p1.y + ent.p2.y) / 2 };
  }
  if (anchor.kind === 'center') {
    if (ent.kind !== 'circle' && ent.kind !== 'cog') return null;
    return { ...ent.center };
  }
  if (anchor.kind === 'corner' || anchor.kind === 'edgemid') {
    if (ent.kind !== 'rect') return null;
    const w = tryEval(ent.width, params);
    const h = tryEval(ent.height, params);
    if (!w || !h || w <= 0 || h <= 0) return null;
    const corners = rectCorners(ent.corner, w, h, ent.rotation);
    const i = (anchor.index ?? 0) % 4;
    if (anchor.kind === 'corner') return { ...corners[i] };
    // edgemid: midpoint between corners[i] and corners[i+1]
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  return null;
}

/** Find the nearest snap-worthy entity feature point to `p`. Used by the
 *  Dimension tool so the picked anchor follows its host entity when the entity
 *  moves. Returns null if no feature within `tol` matches. */
export function findDimAnchorAt(
  p: Vec2,
  sketch: SketchFeature,
  params: Params,
  tol: number,
): { anchor: DimensionAnchor; pos: Vec2 } | null {
  // Use an array we sort at the end. Mutating a `let best | null` from inside
  // the closure trips up TS's control-flow narrowing and is more fragile.
  const found: { anchor: DimensionAnchor; pos: Vec2; d: number }[] = [];
  const tryCandidate = (pos: Vec2, anchor: DimensionAnchor) => {
    const d = dist2d(p, pos);
    if (d < tol) found.push({ anchor, pos: { ...pos }, d });
  };

  for (const e of sketch.entities) {
    if (e.kind === 'line') {
      tryCandidate(e.p1, { kind: 'endpoint', entityId: e.id, which: 'p1' });
      tryCandidate(e.p2, { kind: 'endpoint', entityId: e.id, which: 'p2' });
      tryCandidate(
        { x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 },
        { kind: 'midpoint', entityId: e.id },
      );
    } else if (e.kind === 'circle' || e.kind === 'cog') {
      tryCandidate(e.center, { kind: 'center', entityId: e.id });
    } else if (e.kind === 'rect') {
      const w = tryEval(e.width, params);
      const h = tryEval(e.height, params);
      if (!w || !h || w <= 0 || h <= 0) continue;
      const cs = rectCorners(e.corner, w, h, e.rotation);
      for (let i = 0; i < 4; i++) {
        tryCandidate(cs[i], { kind: 'corner', entityId: e.id, index: i });
        const next = cs[(i + 1) % 4];
        tryCandidate(
          { x: (cs[i].x + next.x) / 2, y: (cs[i].y + next.y) / 2 },
          { kind: 'edgemid', entityId: e.id, index: i },
        );
      }
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => a.d - b.d);
  return { anchor: found[0].anchor, pos: found[0].pos };
}

export function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Evaluated rect corners (corner anchor, extends +x/+y). */
export function rectCorners(corner: Vec2, w: number, h: number, rotation = 0): Vec2[] {
  const raw: Vec2[] = [
    { x: corner.x,     y: corner.y },
    { x: corner.x + w, y: corner.y },
    { x: corner.x + w, y: corner.y + h },
    { x: corner.x,     y: corner.y + h },
  ];
  if (!rotation) return raw;
  const a = (rotation * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return raw.map((p) => {
    const dx = p.x - corner.x, dy = p.y - corner.y;
    return { x: corner.x + dx * c + dy * s, y: corner.y - dx * s + dy * c };
  });
}

/* ================= Corner fillet / chamfer math ================= */

interface CornerCut {
  pA: Vec2;
  pB: Vec2;
  /** polyline replacing the corner: chamfer = [pA,pB], fillet = arc points */
  pts: Vec2[];
  setback: number;
}

/** Compute the cut for a corner at `at`, with unit dirs u/w pointing toward each neighbour. */
function cornerCut(at: Vec2, u: Vec2, w: Vec2, size: number, kind: EdgeKind): CornerCut | null {
  const dot = Math.max(-1, Math.min(1, u.x * w.x + u.y * w.y));
  const theta = Math.acos(dot);
  if (theta < 0.01 || theta > Math.PI - 0.01) return null;
  const setback = kind === 'chamfer' ? size : size / Math.tan(theta / 2);
  const pA: Vec2 = { x: at.x + u.x * setback, y: at.y + u.y * setback };
  const pB: Vec2 = { x: at.x + w.x * setback, y: at.y + w.y * setback };
  if (kind === 'chamfer') return { pA, pB, pts: [pA, pB], setback };
  const bis = norm({ x: u.x + w.x, y: u.y + w.y });
  const centerDist = size / Math.sin(theta / 2);
  const c: Vec2 = { x: at.x + bis.x * centerDist, y: at.y + bis.y * centerDist };
  const angA = Math.atan2(pA.y - c.y, pA.x - c.x);
  const angB = Math.atan2(pB.y - c.y, pB.x - c.x);
  let delta = angB - angA;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const steps = 12;
  const pts: Vec2[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = angA + (delta * k) / steps;
    pts.push({ x: c.x + size * Math.cos(t), y: c.y + size * Math.sin(t) });
  }
  return { pA, pB, pts, setback };
}

/** Replace matched corners of a polygon with arcs (fillet) or straight cuts (chamfer). */
export function applyCornerMods(loop: Vec2[], corners: CornerMod[], params: Params, tol = MATCH_TOL): Vec2[] {
  if (!corners.length) return loop;
  const out: Vec2[] = [];
  const n = loop.length;
  for (let idx = 0; idx < n; idx++) {
    const v = loop[idx];
    const a = loop[(idx - 1 + n) % n];
    const b = loop[(idx + 1) % n];
    const mod = corners.find((c) => dist2d(c.at, v) < tol);
    if (!mod) {
      out.push(v);
      continue;
    }
    let size: number;
    try {
      size = evalExpression(mod.size, params);
    } catch {
      out.push(v);
      continue;
    }
    if (size <= 0) {
      out.push(v);
      continue;
    }
    const u = norm({ x: a.x - v.x, y: a.y - v.y });
    const w = norm({ x: b.x - v.x, y: b.y - v.y });
    const cut = cornerCut(v, u, w, size, mod.kind);
    if (!cut || cut.setback >= dist2d(a, v) * 0.95 || cut.setback >= dist2d(b, v) * 0.95) {
      out.push(v);
      continue;
    }
    out.push(...cut.pts);
  }
  return out;
}

/* ---------- visuals: trim entity lines at corner mods ---------- */

export interface CornerVisuals {
  /** lineId -> replacement endpoints (where trimmed by a corner mod) */
  trims: Map<string, { p1?: Vec2; p2?: Vec2 }>;
  /** arc / chamfer polylines to draw in place of the corners */
  decorations: Vec2[][];
}

export function cornerModVisuals(sketch: SketchFeature, params: Params): CornerVisuals {
  const trims = new Map<string, { p1?: Vec2; p2?: Vec2 }>();
  const decorations: Vec2[][] = [];
  const lines = sketch.entities.filter((e) => e.kind === 'line' && !e.construction) as LineEntity[];

  for (const mod of sketch.corners) {
    let size: number | null = null;
    try {
      size = evalExpression(mod.size, params);
    } catch {
      continue;
    }
    if (!size || size <= 0) continue;

    const touching: { line: LineEntity; end: 'p1' | 'p2' }[] = [];
    for (const l of lines) {
      if (dist2d(l.p1, mod.at) < MATCH_TOL) touching.push({ line: l, end: 'p1' });
      else if (dist2d(l.p2, mod.at) < MATCH_TOL) touching.push({ line: l, end: 'p2' });
    }
    if (touching.length < 2) continue; // rect corners are handled by the rect outline itself
    const [A, B] = touching;
    const otherA = A.end === 'p1' ? A.line.p2 : A.line.p1;
    const otherB = B.end === 'p1' ? B.line.p2 : B.line.p1;
    const u = norm({ x: otherA.x - mod.at.x, y: otherA.y - mod.at.y });
    const w = norm({ x: otherB.x - mod.at.x, y: otherB.y - mod.at.y });
    const cut = cornerCut(mod.at, u, w, size, mod.kind);
    if (!cut) continue;
    if (cut.setback >= dist2d(otherA, mod.at) * 0.95 || cut.setback >= dist2d(otherB, mod.at) * 0.95) continue;

    const tA = trims.get(A.line.id) ?? {};
    tA[A.end] = cut.pA;
    trims.set(A.line.id, tA);
    const tB = trims.get(B.line.id) ?? {};
    tB[B.end] = cut.pB;
    trims.set(B.line.id, tB);
    decorations.push(cut.pts);
  }
  return { trims, decorations };
}

/* ================= Planar arrangement: distinct faces ================= */

interface Seg {
  a: Vec2;
  b: Vec2;
}

const QUANT = 1e-4;
const vkey = (p: Vec2) => `${Math.round(p.x / QUANT)}:${Math.round(p.y / QUANT)}`;

/** Split all segments at their mutual intersections (including collinear overlaps). */
function splitSegments(segs: Seg[]): Seg[] {
  const splits: number[][] = segs.map(() => []);
  const EPS_T = 1e-6;

  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i];
      const B = segs[j];
      const rx = A.b.x - A.a.x;
      const ry = A.b.y - A.a.y;
      const sx = B.b.x - B.a.x;
      const sy = B.b.y - B.a.y;
      const denom = rx * sy - ry * sx;
      const qpx = B.a.x - A.a.x;
      const qpy = B.a.y - A.a.y;
      const lenScale = Math.hypot(rx, ry) * Math.hypot(sx, sy) || 1;

      if (Math.abs(denom) > 1e-9 * lenScale) {
        const t = (qpx * sy - qpy * sx) / denom;
        const u = (qpx * ry - qpy * rx) / denom;
        if (t > -EPS_T && t < 1 + EPS_T && u > -EPS_T && u < 1 + EPS_T) {
          if (t > EPS_T && t < 1 - EPS_T) splits[i].push(t);
          if (u > EPS_T && u < 1 - EPS_T) splits[j].push(u);
        }
      } else if (Math.abs(qpx * ry - qpy * rx) < 1e-9 * lenScale) {
        // collinear: split each at the other's endpoints
        const lenA2 = rx * rx + ry * ry || 1;
        const lenB2 = sx * sx + sy * sy || 1;
        for (const p of [B.a, B.b]) {
          const t = ((p.x - A.a.x) * rx + (p.y - A.a.y) * ry) / lenA2;
          if (t > EPS_T && t < 1 - EPS_T) splits[i].push(t);
        }
        for (const p of [A.a, A.b]) {
          const u = ((p.x - B.a.x) * sx + (p.y - B.a.y) * sy) / lenB2;
          if (u > EPS_T && u < 1 - EPS_T) splits[j].push(u);
        }
      }
    }
  }

  const out: Seg[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const ts = [0, ...splits[i].sort((a, b) => a - b), 1];
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k];
      const t1 = ts[k + 1];
      if (t1 - t0 < 1e-9) continue;
      out.push({
        a: { x: s.a.x + (s.b.x - s.a.x) * t0, y: s.a.y + (s.b.y - s.a.y) * t0 },
        b: { x: s.a.x + (s.b.x - s.a.x) * t1, y: s.a.y + (s.b.y - s.a.y) * t1 },
      });
    }
  }
  return out;
}

interface Cycle {
  pts: Vec2[];
  area: number; // signed
}

/** Extract all boundary cycles of the planar subdivision (positive = face interiors). */
function traceCycles(segs: Seg[]): Cycle[] {
  // unique vertices
  const verts: Vec2[] = [];
  const vidx = new Map<string, number>();
  const getV = (p: Vec2): number => {
    const k = vkey(p);
    let i = vidx.get(k);
    if (i === undefined) {
      i = verts.length;
      verts.push(p);
      vidx.set(k, i);
    }
    return i;
  };

  // unique undirected edges
  const edgeKeys = new Set<string>();
  const edges: [number, number][] = [];
  for (const s of segs) {
    const i = getV(s.a);
    const j = getV(s.b);
    if (i === j) continue;
    const k = i < j ? `${i}_${j}` : `${j}_${i}`;
    if (edgeKeys.has(k)) continue;
    edgeKeys.add(k);
    edges.push([i, j]);
  }

  // half-edges
  const heFrom: number[] = [];
  const heTo: number[] = [];
  const heTwin: number[] = [];
  for (const [i, j] of edges) {
    const a = heFrom.length;
    heFrom.push(i, j);
    heTo.push(j, i);
    heTwin.push(a + 1, a);
  }

  const outgoing = new Map<number, number[]>();
  for (let h = 0; h < heFrom.length; h++) {
    const arr = outgoing.get(heFrom[h]);
    if (arr) arr.push(h);
    else outgoing.set(heFrom[h], [h]);
  }
  const angleOf = (h: number) =>
    Math.atan2(verts[heTo[h]].y - verts[heFrom[h]].y, verts[heTo[h]].x - verts[heFrom[h]].x);
  for (const arr of outgoing.values()) arr.sort((a, b) => angleOf(a) - angleOf(b));

  const nextHe = (h: number): number => {
    const list = outgoing.get(heTo[h])!;
    const tw = heTwin[h];
    const k = list.indexOf(tw);
    return list[(k + 1) % list.length]; // CCW-next from the twin → interiors trace counter-clockwise
  };

  const visited = new Array<boolean>(heFrom.length).fill(false);
  const cycles: Cycle[] = [];
  for (let h0 = 0; h0 < heFrom.length; h0++) {
    if (visited[h0]) continue;
    const pts: Vec2[] = [];
    let h = h0;
    let guard = 0;
    while (!visited[h] && guard++ < heFrom.length + 1) {
      visited[h] = true;
      pts.push(verts[heFrom[h]]);
      h = nextHe(h);
    }
    if (pts.length < 3) continue;
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
    }
    area /= 2;
    if (Math.abs(area) > 1e-6) cycles.push({ pts, area });
  }
  return cycles;
}

export interface FaceRegion {
  outer: Vec2[];
  holes: Vec2[][];
  /** A point guaranteed to lie inside the face. */
  rep: Vec2;
  shape: THREE.Shape;
}

function repPoint(outer: Vec2[], holes: Vec2[][]): Vec2 {
  try {
    const c = outer.map((p) => new THREE.Vector2(p.x, p.y));
    const hs = holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y)));
    const all = [...c, ...hs.flat()];
    const tris = THREE.ShapeUtils.triangulateShape(c, hs);
    let best: number[] | null = null;
    let bestArea = 0;
    for (const t of tris) {
      const [a, b, d] = [all[t[0]], all[t[1]], all[t[2]]];
      const area = Math.abs((b.x - a.x) * (d.y - a.y) - (d.x - a.x) * (b.y - a.y)) / 2;
      if (area > bestArea) {
        bestArea = area;
        best = t;
      }
    }
    if (best) {
      const [a, b, d] = [all[best[0]], all[best[1]], all[best[2]]];
      return { x: (a.x + b.x + d.x) / 3, y: (a.y + b.y + d.y) / 3 };
    }
  } catch {
    /* fall through */
  }
  const cx = outer.reduce((s, p) => s + p.x, 0) / outer.length;
  const cy = outer.reduce((s, p) => s + p.y, 0) / outer.length;
  return { x: cx, y: cy };
}

/**
 * Compute all distinct enclosed faces of the sketch (planar arrangement of all
 * non-construction curves, intersections included), with corner mods applied.
 */
export function computeRegions(sketch: SketchFeature, params: Params): FaceRegion[] {
  const segs: Seg[] = [];
  for (const e of sketch.entities) {
    if (e.kind === 'image') continue; // images are reference overlays, not geometry
    if (e.construction) continue;
    if (e.kind === 'line') {
      if (dist2d(e.p1, e.p2) > 1e-9) segs.push({ a: e.p1, b: e.p2 });
    } else if (e.kind === 'rect') {
      const w = evalExpression(e.width, params);
      const h = evalExpression(e.height, params);
      if (w > 0 && h > 0) {
        const c = rectCorners(e.corner, w, h, e.rotation);
        for (let i = 0; i < 4; i++) segs.push({ a: c[i], b: c[(i + 1) % 4] });
      }
    } else if (e.kind === 'circle') {
      const { rx, ry } = circleRadii(e, params);
      if (rx > 0 && ry > 0) {
        const segCount = circleSegs(Math.max(rx, ry));
        const poly = ellipsePoly(e.center, rx, ry, segCount, e.rotation ?? 0);
        for (let i = 0; i < poly.length; i++) segs.push({ a: poly[i], b: poly[(i + 1) % poly.length] });
      }
    } else if (e.kind === 'arc') {
      const r = tryEval(e.radius, params);
      const sa = tryEval(e.startAngle, params);
      const ea = tryEval(e.endAngle, params);
      if (r && r > 0 && sa !== null && ea !== null) {
        const poly = arcPoly(e.center, r, sa, ea);
        for (let i = 0; i < poly.length - 1; i++) segs.push({ a: poly[i], b: poly[i + 1] });
      }
    } else if (e.kind === 'cog') {
      const rs = cogRadii(e, params);
      if (rs && rs.outer > 0 && rs.inner > 0 && e.teeth >= 1) {
        const poly = cogPoly(e.center, rs.outer, rs.inner, e.teeth, e.rotation ?? 0, e.profile);
        for (let i = 0; i < poly.length; i++) segs.push({ a: poly[i], b: poly[(i + 1) % poly.length] });
      }
    }
  }
  if (!segs.length) return [];

  const cycles = traceCycles(splitSegments(segs));
  const positives = cycles.filter((c) => c.area > 0);
  const negatives = cycles.filter((c) => c.area < 0);

  // assign hole cycles (negative) to the smallest positive cycle containing them
  const holesOf = new Map<number, Vec2[][]>();
  for (const neg of negatives) {
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < positives.length; i++) {
      const pos = positives[i];
      // a hole is always strictly smaller than its containing face (strict: excludes the
      // face bounded by this same curve, whose |area| is identical)
      if (pos.area > -neg.area * (1 + 1e-9) && pos.area < bestArea && pointInPoly(neg.pts[0], pos.pts)) {
        best = i;
        bestArea = pos.area;
      }
    }
    if (best >= 0) {
      const arr = holesOf.get(best);
      if (arr) arr.push(neg.pts);
      else holesOf.set(best, [neg.pts]);
    }
  }

  return positives.map((pos, i) => {
    const outer = applyCornerMods(pos.pts, sketch.corners, params);
    const holes = (holesOf.get(i) ?? []).map((h) => applyCornerMods(h, sketch.corners, params));
    const shape = new THREE.Shape(outer.map((p) => new THREE.Vector2(p.x, p.y)));
    shape.holes = holes.map((h) => new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
    return { outer, holes, rep: repPoint(outer, holes), shape };
  });
}

export function regionContains(r: FaceRegion, p: Vec2): boolean {
  if (!pointInPoly(p, r.outer)) return false;
  return !r.holes.some((h) => pointInPoly(p, h));
}

/**
 * Default face set for "extrude all": faces at even containment depth
 * (reproduces hole semantics for nested shapes and union for overlapping ones).
 */
export function defaultRegions(regions: FaceRegion[]): FaceRegion[] {
  return regions.filter((r) => {
    let depth = 0;
    for (const o of regions) {
      if (o !== r && pointInPoly(r.rep, o.outer)) depth++;
    }
    return depth % 2 === 0;
  });
}

/* ================= Corner mod identification ================= */

export const MOD_COLORS = ['#ffaa33', '#4fd1ff', '#ff6ec7', '#9dff57', '#b07ce8', '#ff8c5a', '#5fe0c0', '#ffd24f'];

/** Stable display color for a corner mod (by its index in the sketch). */
export function modColor(sketch: SketchFeature, modId: string): string {
  const i = sketch.corners.findIndex((c) => c.id === modId);
  return MOD_COLORS[(i < 0 ? 0 : i) % MOD_COLORS.length];
}

/** Corner mods attached to any vertex of the given entity (a corner between two lines belongs to both). */
export function modsForEntity(sketch: SketchFeature, entId: string, params: Params): CornerMod[] {
  const ent = sketch.entities.find((e) => e.id === entId);
  if (!ent) return [];
  const verts = entityVertices(ent, params);
  if (!verts.length) return [];
  return sketch.corners.filter((c) => verts.some((v) => dist2d(v, c.at) < MATCH_TOL));
}

/* ================= Entity editing helpers ================= */

/** Evaluated vertices of an entity (used to carry corner mods along when moving). */
export function entityVertices(e: SketchEntity, params: Params): Vec2[] {
  if (e.kind === 'line') return [e.p1, e.p2];
  if (e.kind === 'circle' || e.kind === 'image' || e.kind === 'cog') return [];
  if (e.kind === 'dimension') return [e.p1, e.p2];
  if (e.kind === 'arc') {
    const r = tryEval(e.radius, params);
    const sa = tryEval(e.startAngle, params);
    const ea = tryEval(e.endAngle, params);
    if (!r || sa === null || ea === null) return [];
    const rad = (a: number) => (a * Math.PI) / 180;
    return [
      { x: e.center.x + r * Math.cos(rad(sa)), y: e.center.y + r * Math.sin(rad(sa)) },
      { x: e.center.x + r * Math.cos(rad(ea)), y: e.center.y + r * Math.sin(rad(ea)) },
    ];
  }
  const w = tryEval(e.width, params);
  const h = tryEval(e.height, params);
  return w && h && w > 0 && h > 0 ? rectCorners(e.corner, w, h, e.rotation) : [];
}

/** Compute arc polyline points from startAngle to endAngle, taking the shorter
 *  of the two possible arcs (≤ 180°). Used by render + region detection. */
export function arcPoly(
  center: Vec2,
  r: number,
  startDeg: number,
  endDeg: number,
  segs?: number,
): Vec2[] {
  let diff = endDeg - startDeg;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  const n = segs ?? Math.max(12, Math.ceil((Math.abs(diff) / 180) * Math.PI * r / 2) + 4);
  const s = (startDeg * Math.PI) / 180;
  const d = (diff * Math.PI) / 180;
  const pts: Vec2[] = [];
  for (let k = 0; k <= n; k++) {
    const t = s + d * (k / n);
    pts.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  return pts;
}

/** Translate an entity (and corner mods attached to its vertices) by d. */
export function translateEntityInSketch(sk: SketchFeature, entId: string, d: Vec2, params: Params): SketchFeature {
  const ent = sk.entities.find((e) => e.id === entId);
  if (!ent) return sk;
  const verts = entityVertices(ent, params);
  const corners = sk.corners.map((c) =>
    verts.some((v) => dist2d(v, c.at) < MATCH_TOL) ? { ...c, at: { x: c.at.x + d.x, y: c.at.y + d.y } } : c
  );
  const entities = sk.entities.map((e): SketchEntity => {
    if (e.id !== entId) return e;
    if (e.kind === 'line' || e.kind === 'dimension')
      return { ...e, p1: { x: e.p1.x + d.x, y: e.p1.y + d.y }, p2: { x: e.p2.x + d.x, y: e.p2.y + d.y } };
    if (e.kind === 'circle' || e.kind === 'arc' || e.kind === 'cog')
      return { ...e, center: { x: e.center.x + d.x, y: e.center.y + d.y } };
    return { ...e, corner: { x: e.corner.x + d.x, y: e.corner.y + d.y } };
  });
  return { ...sk, entities, corners };
}

/* ================= Helpers for the interactive sketcher ================= */

/** All entity endpoints + rect corners + circle centers (used for grid extent + base snap). */
export function snapPoints(sketch: SketchFeature, params: Params): Vec2[] {
  const pts: Vec2[] = [];
  for (const e of sketch.entities) {
    if (e.kind === 'image') continue; // images don't provide snap targets
    if (e.kind === 'line') {
      pts.push(e.p1, e.p2);
    } else if (e.kind === 'circle') {
      pts.push(e.center);
    } else if (e.kind === 'arc') {
      // Centre + two arc endpoints
      const r = tryEval(e.radius, params);
      const sa = tryEval(e.startAngle, params);
      const ea = tryEval(e.endAngle, params);
      if (r && sa !== null && ea !== null) {
        const rad = (a: number) => (a * Math.PI) / 180;
        pts.push(e.center);
        pts.push({ x: e.center.x + r * Math.cos(rad(sa)), y: e.center.y + r * Math.sin(rad(sa)) });
        pts.push({ x: e.center.x + r * Math.cos(rad(ea)), y: e.center.y + r * Math.sin(rad(ea)) });
      }
    } else if (e.kind === 'rect') {
      const w = tryEval(e.width, params);
      const h = tryEval(e.height, params);
      if (w && h) pts.push(...rectCorners(e.corner, w, h, e.rotation));
    } else if (e.kind === 'cog') {
      pts.push(e.center);
    }
  }
  return pts;
}

/* ---- Intersection helpers (used by edgeSnapPoints) ---- */

/** Intersection of two finite segments [p1,p2] and [p3,p4]; null if parallel or outside bounds. */
function segSegIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
  const dx1 = p2.x - p1.x, dy1 = p2.y - p1.y;
  const dx2 = p4.x - p3.x, dy2 = p4.y - p3.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((p3.x - p1.x) * dy2 - (p3.y - p1.y) * dx2) / denom;
  const u = ((p3.x - p1.x) * dy1 - (p3.y - p1.y) * dx1) / denom;
  const EPS = 1e-9;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { x: p1.x + t * dx1, y: p1.y + t * dy1 };
}

/** Intersections of a finite segment [p1,p2] with a circle; returns 0–2 points. */
function segCircleIntersect(p1: Vec2, p2: Vec2, center: Vec2, r: number): Vec2[] {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const fx = p1.x - center.x, fy = p1.y - center.y;
  const a = dx * dx + dy * dy;
  if (a < 1e-20) return [];
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const sq = Math.sqrt(Math.max(0, disc));
  const EPS = 1e-9;
  const results: Vec2[] = [];
  for (const sign of [-1, 1]) {
    const t = (-b + sign * sq) / (2 * a);
    if (t >= -EPS && t <= 1 + EPS) {
      results.push({ x: p1.x + t * dx, y: p1.y + t * dy });
    }
  }
  return results;
}

/**
 * Edge-snap targets: everything in snapPoints PLUS
 *   • midpoints of lines and rect sides
 *   • circle quadrant points (E / N / W / S)
 *   • line-line intersections (within both segment bounds)
 *   • line-circle intersections (segment within bounds, on circumference)
 */
export function edgeSnapPoints(sketch: SketchFeature, params: Params): Vec2[] {
  const pts: Vec2[] = [...snapPoints(sketch, params)];

  type Seg = { p1: Vec2; p2: Vec2 };
  type Circ = { center: Vec2; r: number };
  const segs: Seg[] = [];
  const circs: Circ[] = [];

  for (const e of sketch.entities) {
    if (e.kind === 'line') {
      // midpoint
      pts.push({ x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 });
      segs.push({ p1: e.p1, p2: e.p2 });
    } else if (e.kind === 'circle') {
      const r = tryEval(e.radius, params);
      if (r && r > 0) {
        // quadrant points: E, N, W, S
        pts.push(
          { x: e.center.x + r, y: e.center.y },
          { x: e.center.x,     y: e.center.y + r },
          { x: e.center.x - r, y: e.center.y },
          { x: e.center.x,     y: e.center.y - r },
        );
        circs.push({ center: e.center, r });
      }
    } else if (e.kind === 'rect') {
      const w = tryEval(e.width, params);
      const h = tryEval(e.height, params);
      if (w && h && w > 0 && h > 0) {
        const c = rectCorners(e.corner, w, h, e.rotation);
        // corners + side midpoints
        pts.push(...c);
        for (let i = 0; i < 4; i++) {
          const a = c[i], b = c[(i + 1) % 4];
          pts.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
          segs.push({ p1: a, p2: b });
        }
      }
    } else if (e.kind === 'cog') {
      const rs = cogRadii(e, params);
      if (rs && rs.outer > 0) {
        // Outer-radius quadrant snaps so the user can hang dims off the cog like a circle.
        pts.push(
          { x: e.center.x + rs.outer, y: e.center.y },
          { x: e.center.x,            y: e.center.y + rs.outer },
          { x: e.center.x - rs.outer, y: e.center.y },
          { x: e.center.x,            y: e.center.y - rs.outer },
        );
      }
    }
  }

  // line-line intersections
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = segSegIntersect(segs[i].p1, segs[i].p2, segs[j].p1, segs[j].p2);
      if (p) pts.push(p);
    }
  }

  // line-circle intersections
  for (const seg of segs) {
    for (const circ of circs) {
      for (const p of segCircleIntersect(seg.p1, seg.p2, circ.center, circ.r)) {
        pts.push(p);
      }
    }
  }

  return pts;
}

/** Junction vertices eligible for fillet/chamfer (shared line endpoints + rect corners). */
export function cornerCandidates(sketch: SketchFeature, params: Params): Vec2[] {
  const counts = new Map<string, { p: Vec2; n: number }>();
  for (const e of sketch.entities) {
    if (e.kind !== 'line' || e.construction) continue;
    for (const p of [e.p1, e.p2]) {
      const k = vkey(p);
      const cur = counts.get(k);
      if (cur) cur.n++;
      else counts.set(k, { p, n: 1 });
    }
  }
  const out: Vec2[] = [];
  for (const { p, n } of counts.values()) if (n >= 2) out.push(p);
  for (const e of sketch.entities) {
    if (e.kind === 'rect' && !e.construction) {
      const w = tryEval(e.width, params);
      const h = tryEval(e.height, params);
      if (w && h) out.push(...rectCorners(e.corner, w, h, e.rotation));
    }
  }
  return out;
}

function pointSegDist(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 === 0) return dist2d(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist2d(p, { x: a.x + abx * t, y: a.y + aby * t });
}

/** Find entity nearest to point p (within tol), for selection. */
export function pickEntity(sketch: SketchFeature, params: Params, p: Vec2, tol: number): string | null {
  let bestId: string | null = null;
  let bestD = tol;
  for (const e of sketch.entities) {
    if (e.kind === 'image') continue; // handled as interior fallback below
    let d = Infinity;
    if (e.kind === 'line') {
      d = pointSegDist(p, e.p1, e.p2);
    } else if (e.kind === 'circle') {
      const { rx, ry } = circleRadii(e, params);
      if (rx > 0 && ry > 0) {
        // Inverse-rotate the test point into the ellipse-local frame so the
        // hit test works for both axis-aligned circles and rotated ovals.
        const rotRad = ((e.rotation ?? 0) * Math.PI) / 180;
        const cr = Math.cos(rotRad), sr = Math.sin(rotRad);
        const dx = p.x - e.center.x;
        const dy = p.y - e.center.y;
        const lx = dx * cr - dy * sr;
        const ly = dx * sr + dy * cr;
        if (rx === ry) {
          d = Math.abs(Math.hypot(lx, ly) - rx);
        } else {
          // Approximate perimeter distance using the normalised radius.
          const norm = Math.hypot(lx / rx, ly / ry);
          d = Math.abs(norm - 1) * Math.min(rx, ry);
        }
      }
    } else if (e.kind === 'rect') {
      const w = tryEval(e.width, params);
      const h = tryEval(e.height, params);
      if (w && h) {
        const c = rectCorners(e.corner, w, h, e.rotation);
        d = Math.min(
          pointSegDist(p, c[0], c[1]),
          pointSegDist(p, c[1], c[2]),
          pointSegDist(p, c[2], c[3]),
          pointSegDist(p, c[3], c[0])
        );
      }
    } else if (e.kind === 'cog') {
      const rs = cogRadii(e, params);
      if (rs && rs.outer > 0 && rs.inner > 0 && e.teeth >= 1) {
        // Distance from cursor to the *actual* cog perimeter polyline. Using
        // just the outer-radius circle misses every tooth flank and every
        // valley, so a click on a tooth side does nothing — hence the polygon
        // sweep here.
        const poly = cogPoly(e.center, rs.outer, rs.inner, e.teeth, e.rotation ?? 0, e.profile);
        let dmin = Infinity;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i];
          const b = poly[(i + 1) % poly.length];
          const ds = pointSegDist(p, a, b);
          if (ds < dmin) dmin = ds;
        }
        d = dmin;
      }
    } else if (e.kind === 'arc') {
      const r = tryEval(e.radius, params);
      const sa = tryEval(e.startAngle, params);
      const ea = tryEval(e.endAngle, params);
      if (r && r > 0 && sa !== null && ea !== null) {
        // Distance from arc = distance from circle if the cursor's angle lies
        // within the arc's range; otherwise use the nearer endpoint.
        const dx = p.x - e.center.x;
        const dy = p.y - e.center.y;
        const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        let diff = ea - sa;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        // Normalise ang relative to sa into the same half-revolution as diff.
        let rel = ang - sa;
        while (rel > 180) rel -= 360;
        while (rel < -180) rel += 360;
        const inRange = diff >= 0 ? rel >= 0 && rel <= diff : rel <= 0 && rel >= diff;
        if (inRange) {
          d = Math.abs(Math.hypot(dx, dy) - r);
        } else {
          const rad = (a: number) => (a * Math.PI) / 180;
          const epA = { x: e.center.x + r * Math.cos(rad(sa)), y: e.center.y + r * Math.sin(rad(sa)) };
          const epB = { x: e.center.x + r * Math.cos(rad(ea)), y: e.center.y + r * Math.sin(rad(ea)) };
          d = Math.min(dist2d(p, epA), dist2d(p, epB));
        }
      }
    }
    if (d < bestD) {
      bestD = d;
      bestId = e.id;
    }
  }
  // Image fallback: only select if nothing else was found (interior click)
  if (!bestId) {
    for (const e of sketch.entities) {
      if (e.kind !== 'image') continue;
      const w = tryEval(e.width, params);
      const h = tryEval(e.height, params);
      if (!w || !h || w <= 0 || h <= 0) continue;
      if (
        p.x >= e.corner.x - tol && p.x <= e.corner.x + w + tol &&
        p.y >= e.corner.y - tol && p.y <= e.corner.y + h + tol
      ) {
        bestId = e.id;
        break;
      }
    }
  }
  return bestId;
}

/* ================= Multi-entity editing helpers ================= */

/**
 * Translate multiple entities (and any corner mods whose position matches a vertex
 * of ALL entities at that junction — so shared corners only move if every entity
 * at that corner is in the selection).
 */
export function translateEntitiesInSketch(
  sk: SketchFeature,
  entIds: string[],
  d: Vec2,
  params: Params,
): SketchFeature {
  if (!entIds.length) return sk;
  const idSet = new Set(entIds);

  // Collect vertex keys for the selected entities
  const selectedVkeys = new Set<string>();
  for (const e of sk.entities) {
    if (!idSet.has(e.id)) continue;
    for (const v of entityVertices(e, params)) selectedVkeys.add(vkey(v));
  }

  // Collect vertex keys for UN-selected entities (to avoid moving shared corners)
  const otherVkeys = new Set<string>();
  for (const e of sk.entities) {
    if (idSet.has(e.id)) continue;
    for (const v of entityVertices(e, params)) otherVkeys.add(vkey(v));
  }

  // A corner mod moves only if its vertex is selected AND not shared with an unselected entity
  const corners = sk.corners.map((c) => {
    const k = vkey(c.at);
    if (selectedVkeys.has(k) && !otherVkeys.has(k)) {
      return { ...c, at: { x: c.at.x + d.x, y: c.at.y + d.y } };
    }
    return c;
  });

  const entities = sk.entities.map((e): SketchEntity => {
    if (!idSet.has(e.id)) return e;
    if (e.kind === 'line' || e.kind === 'dimension')
      return { ...e, p1: { x: e.p1.x + d.x, y: e.p1.y + d.y }, p2: { x: e.p2.x + d.x, y: e.p2.y + d.y } };
    if (e.kind === 'circle' || e.kind === 'arc' || e.kind === 'cog')
      return { ...e, center: { x: e.center.x + d.x, y: e.center.y + d.y } };
    return { ...e, corner: { x: e.corner.x + d.x, y: e.corner.y + d.y } };
  });
  return { ...sk, entities, corners };
}

/** Rotate a 2D point around an origin by angleDeg degrees (CCW positive). */
export function rotatePoint(p: Vec2, origin: Vec2, angleDeg: number): Vec2 {
  // Positive angle = clockwise (screen convention)
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a), sn = Math.sin(a);
  const dx = p.x - origin.x, dy = p.y - origin.y;
  return { x: origin.x + dx * c + dy * sn, y: origin.y - dx * sn + dy * c };
}

/**
 * Rotate selected sketch entities around `origin` by `angleDeg` degrees (CCW positive).
 * Lines/circles: all defining points are rotated.
 * Rects/images: only the corner anchor is rotated; width/height are preserved
 *   (the bounding box pivots — true rotation would require a rotation field on the type).
 * Corner mods at vertices exclusively owned by selected entities are also rotated.
 */
export function rotateEntitiesInSketch(
  sk: SketchFeature,
  entIds: string[],
  origin: Vec2,
  angleDeg: number,
  params: Params,
): SketchFeature {
  if (!entIds.length) return sk;
  const idSet = new Set(entIds);
  const rot = (p: Vec2) => rotatePoint(p, origin, angleDeg);

  const selectedVkeys = new Set<string>();
  for (const e of sk.entities) {
    if (!idSet.has(e.id)) continue;
    for (const v of entityVertices(e, params)) selectedVkeys.add(vkey(v));
  }
  const otherVkeys = new Set<string>();
  for (const e of sk.entities) {
    if (idSet.has(e.id)) continue;
    for (const v of entityVertices(e, params)) otherVkeys.add(vkey(v));
  }

  const corners = sk.corners.map((c) => {
    const k = vkey(c.at);
    if (selectedVkeys.has(k) && !otherVkeys.has(k)) return { ...c, at: rot(c.at) };
    return c;
  });

  const entities = sk.entities.map((e): SketchEntity => {
    if (!idSet.has(e.id)) return e;
    if (e.kind === 'line' || e.kind === 'dimension') return { ...e, p1: rot(e.p1), p2: rot(e.p2) };
    if (e.kind === 'circle') {
      // Accumulate rotation so ovals visibly spin even when the pivot is their
      // own centre. True circles ignore the field (their geometry is invariant
      // under rotation about the centre).
      return { ...e, center: rot(e.center), rotation: ((e.rotation ?? 0) + angleDeg) % 360 };
    }
    if (e.kind === 'arc') {
      // Rotate the centre and shift start/end angles. rotatePoint is CW
      // positive (screen convention), and arc angles are math-CCW positive,
      // so subtract angleDeg from each.
      const sa = tryEval(e.startAngle, params);
      const ea = tryEval(e.endAngle, params);
      const shift = -angleDeg;
      return {
        ...e,
        center: rot(e.center),
        startAngle: sa !== null ? String(Math.round((sa + shift) * 1000) / 1000) : e.startAngle,
        endAngle:   ea !== null ? String(Math.round((ea + shift) * 1000) / 1000) : e.endAngle,
      };
    }
    if (e.kind === 'cog') {
      // Cog rotation uses the same screen-CW convention as rect/image — accumulate
      // so spinning around the cog's own centre is visible.
      return { ...e, center: rot(e.center), rotation: ((e.rotation ?? 0) + angleDeg) % 360 };
    }
    // rect / image: rotate corner anchor AND accumulate rotation angle
    return { ...e, corner: rot(e.corner), rotation: ((e.rotation ?? 0) + angleDeg) % 360 };
  });

  return { ...sk, entities, corners };
}

/* ---- Bounding box helpers ---- */

/** Axis-aligned bounding box of a single entity. Returns null if entity can't be evaluated. */
export function entityBounds(e: SketchEntity, params: Params): { min: Vec2; max: Vec2 } | null {
  if (e.kind === 'line' || e.kind === 'dimension') {
    return {
      min: { x: Math.min(e.p1.x, e.p2.x), y: Math.min(e.p1.y, e.p2.y) },
      max: { x: Math.max(e.p1.x, e.p2.x), y: Math.max(e.p1.y, e.p2.y) },
    };
  }
  if (e.kind === 'circle') {
    const { rx, ry } = circleRadii(e, params);
    if (!rx || !ry || rx <= 0 || ry <= 0) return null;
    return {
      min: { x: e.center.x - rx, y: e.center.y - ry },
      max: { x: e.center.x + rx, y: e.center.y + ry },
    };
  }
  if (e.kind === 'cog') {
    const rs = cogRadii(e, params);
    if (!rs || rs.outer <= 0) return null;
    return {
      min: { x: e.center.x - rs.outer, y: e.center.y - rs.outer },
      max: { x: e.center.x + rs.outer, y: e.center.y + rs.outer },
    };
  }
  if (e.kind === 'arc') {
    const r = tryEval(e.radius, params);
    const sa = tryEval(e.startAngle, params);
    const ea = tryEval(e.endAngle, params);
    if (!r || r <= 0 || sa === null || ea === null) return null;
    // Use the discretised arc poly to get a tight-ish bbox.
    const pts = arcPoly(e.center, r, sa, ea);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
  }
  const w = tryEval(e.width, params);
  const h = tryEval(e.height, params);
  if (!w || !h || w <= 0 || h <= 0) return null;
  const cs = rectCorners(e.corner, w, h, (e as { rotation?: number }).rotation);
  return {
    min: { x: Math.min(...cs.map((c) => c.x)), y: Math.min(...cs.map((c) => c.y)) },
    max: { x: Math.max(...cs.map((c) => c.x)), y: Math.max(...cs.map((c) => c.y)) },
  };
}

/** Combined AABB of multiple entities. Returns null if none can be evaluated. */
export function entitiesBounds(ents: SketchEntity[], params: Params): { min: Vec2; max: Vec2 } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  for (const e of ents) {
    const b = entityBounds(e, params);
    if (!b) continue;
    minX = Math.min(minX, b.min.x);
    minY = Math.min(minY, b.min.y);
    maxX = Math.max(maxX, b.max.x);
    maxY = Math.max(maxY, b.max.y);
    any = true;
  }
  return any ? { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } : null;
}

/* ---- Box-selection test ---- */

function ptInRect(p: Vec2, mn: Vec2, mx: Vec2): boolean {
  return p.x >= mn.x && p.x <= mx.x && p.y >= mn.y && p.y <= mx.y;
}

/**
 * Test whether an entity qualifies for box selection.
 * mode 'window'   (left→right drag): entity must be FULLY inside the box.
 * mode 'crossing' (right→left drag): entity only needs to INTERSECT the box.
 */
export function entityInBox(
  e: SketchEntity,
  params: Params,
  boxMin: Vec2,
  boxMax: Vec2,
  mode: 'window' | 'crossing',
): boolean {
  // Box edges as segments for intersection tests
  const TL: Vec2 = { x: boxMin.x, y: boxMax.y };
  const TR: Vec2 = boxMax;
  const BR: Vec2 = { x: boxMax.x, y: boxMin.y };
  const BL: Vec2 = boxMin;
  const boxSides: [Vec2, Vec2][] = [[BL, BR], [BR, TR], [TR, TL], [TL, BL]];
  const intersectsBox = (p1: Vec2, p2: Vec2) =>
    boxSides.some(([a, b]) => segSegIntersect(p1, p2, a, b) !== null);

  if (e.kind === 'line') {
    const ain = ptInRect(e.p1, boxMin, boxMax);
    const bin = ptInRect(e.p2, boxMin, boxMax);
    return mode === 'window' ? ain && bin : ain || bin || intersectsBox(e.p1, e.p2);
  }

  if (e.kind === 'dimension') {
    // Dimensions aren't box-selectable in MVP — too easy to clobber when
    // sweeping across a sketch full of geometry.
    return false;
  }

  if (e.kind === 'circle') {
    const { rx, ry } = circleRadii(e, params);
    if (!rx || !ry || rx <= 0 || ry <= 0) return false;
    const { x: cx, y: cy } = e.center;
    if (mode === 'window') {
      return cx - rx >= boxMin.x && cx + rx <= boxMax.x && cy - ry >= boxMin.y && cy + ry <= boxMax.y;
    }
    // crossing: bounding-box overlap (approximate; treats ellipse as its AABB)
    return !(cx + rx < boxMin.x || cx - rx > boxMax.x || cy + ry < boxMin.y || cy - ry > boxMax.y);
  }

  if (e.kind === 'cog') {
    const rs = cogRadii(e, params);
    if (!rs || rs.outer <= 0) return false;
    const { x: cx, y: cy } = e.center;
    const r = rs.outer;
    if (mode === 'window') {
      return cx - r >= boxMin.x && cx + r <= boxMax.x && cy - r >= boxMin.y && cy + r <= boxMax.y;
    }
    return !(cx + r < boxMin.x || cx - r > boxMax.x || cy + r < boxMin.y || cy - r > boxMax.y);
  }

  if (e.kind === 'arc') {
    const r = tryEval(e.radius, params);
    const sa = tryEval(e.startAngle, params);
    const ea = tryEval(e.endAngle, params);
    if (!r || r <= 0 || sa === null || ea === null) return false;
    const poly = arcPoly(e.center, r, sa, ea, 24);
    if (mode === 'window') return poly.every((q) => ptInRect(q, boxMin, boxMax));
    if (poly.some((q) => ptInRect(q, boxMin, boxMax))) return true;
    for (let i = 0; i < poly.length - 1; i++) {
      if (intersectsBox(poly[i], poly[i + 1])) return true;
    }
    return false;
  }

  // rect / image entity
  const w = tryEval(e.width, params);
  const h = tryEval(e.height, params);
  if (!w || !h || w <= 0 || h <= 0) return false;
  const corners = rectCorners(e.corner, w, h, (e as { rotation?: number }).rotation);
  if (mode === 'window') return corners.every((c) => ptInRect(c, boxMin, boxMax));
  if (corners.some((c) => ptInRect(c, boxMin, boxMax))) return true;
  for (let i = 0; i < 4; i++) {
    if (intersectsBox(corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}
