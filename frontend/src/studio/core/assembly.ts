/**
 * assembly.ts — pure mechanical-assembly math for Assembly mode.
 *
 * Responsibilities (all pure, unit-testable; THREE only used for matrix
 * composition helpers at the bottom):
 *   • resolved-range intersection — a driven joint's usable range is its own
 *     range intersected with each partner's range mapped through the link
 *     ratio + phase.
 *   • propagation — driving one joint propagates values across links (clamped
 *     at every node). Acyclic only; a visited set guards against stray loops.
 *   • cycle detection — closed link loops are reported, never solved.
 *   • joint delta transforms — rotation about an axis / translation along a
 *     vector, composed around the joint origin.
 *
 * Conventions: a joint value is in joint units — degrees for revolute (about
 * `axis`, right-hand rule), length for prismatic (along `axis`). The home pose
 * is the zero; geometry is baked to world space so a body's home matrix is the
 * identity and the joint delta is applied directly to the rendered mesh.
 */
import * as THREE from 'three';
import type { Doc, Joint, Link, PinSlotJoint, Vec3 } from '../types';

/** A closed numeric range; `null` on a side means unbounded there. */
export interface Range {
  min: number | null;
  max: number | null;
}

const UNBOUNDED: Range = { min: null, max: null };

/** Intersect two ranges (null = unbounded). */
export function intersectRange(a: Range, b: Range): Range {
  const min =
    a.min === null ? b.min : b.min === null ? a.min : Math.max(a.min, b.min);
  const max =
    a.max === null ? b.max : b.max === null ? a.max : Math.min(a.max, b.max);
  return { min, max };
}

/** True when a range is empty (over-constrained). */
export function isEmptyRange(r: Range): boolean {
  return r.min !== null && r.max !== null && r.min > r.max;
}

/** Clamp a value into a range (unbounded sides pass through). */
export function clampToRange(v: number, r: Range): number {
  let out = v;
  if (r.min !== null && out < r.min) out = r.min;
  if (r.max !== null && out > r.max) out = r.max;
  return out;
}

/** A joint's own declared range (free → unbounded). `evalNum` resolves the
 *  limit expressions (so they can reference parameters). */
export function ownRange(
  joint: Joint,
  evalNum: (expr: string) => number | null,
): Range {
  if (joint.limits.mode !== 'limited') return { ...UNBOUNDED };
  const min = joint.limits.min != null ? evalNum(joint.limits.min) : null;
  const max = joint.limits.max != null ? evalNum(joint.limits.max) : null;
  return { min: min ?? null, max: max ?? null };
}

/** Map a partner joint's range into this joint's coordinate through a link.
 *  `forward` true  → this joint is the driver: driven = r*this + phase, so
 *                    this = (partnerRange - phase) / r.
 *  `forward` false → this joint is the driven: this = r*partner + phase. */
function mapRange(partner: Range, r: number, phase: number, forward: boolean): Range {
  if (forward) {
    if (r === 0) return { ...UNBOUNDED }; // driver unconstrained by a 0-ratio driven
    const a = partner.min === null ? null : (partner.min - phase) / r;
    const b = partner.max === null ? null : (partner.max - phase) / r;
    return r > 0 ? { min: a, max: b } : { min: b, max: a };
  } else {
    const a = partner.min === null ? null : r * partner.min + phase;
    const b = partner.max === null ? null : r * partner.max + phase;
    return r > 0 ? { min: a, max: b } : { min: b, max: a };
  }
}

/** Resolved range for a joint: own range ∩ each incident link's partner range
 *  mapped through the ratio. One-hop (partner's *own* range) — sufficient for
 *  v1 acyclic chains. */
export function resolvedRange(
  jointId: string,
  joints: Joint[],
  links: Link[],
  evalNum: (expr: string) => number | null,
): Range {
  const joint = joints.find((j) => j.id === jointId);
  if (!joint) return { ...UNBOUNDED };
  let range = ownRange(joint, evalNum);
  for (const link of links) {
    const r = evalNum(link.ratio);
    if (r === null) continue;
    const phase = link.phase != null ? evalNum(link.phase) ?? 0 : 0;
    if (link.driverJointId === jointId) {
      const partner = joints.find((j) => j.id === link.drivenJointId);
      if (!partner) continue;
      range = intersectRange(range, mapRange(ownRange(partner, evalNum), r, phase, true));
    } else if (link.drivenJointId === jointId) {
      const partner = joints.find((j) => j.id === link.driverJointId);
      if (!partner) continue;
      range = intersectRange(range, mapRange(ownRange(partner, evalNum), r, phase, false));
    }
  }
  return range;
}

/** Detect closed loops in the (directed) link graph. Returns the joint-id
 *  cycles found (empty when acyclic). Treats links as directed driver→driven. */
export function detectCycles(joints: Joint[], links: Link[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const j of joints) adj.set(j.id, []);
  for (const l of links) {
    if (!adj.has(l.driverJointId)) adj.set(l.driverJointId, []);
    adj.get(l.driverJointId)!.push(l.drivenJointId);
  }
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) color.set(id, WHITE);
  const cycles: string[][] = [];
  const stack: string[] = [];

  const visit = (u: string) => {
    color.set(u, GREY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GREY) {
        const i = stack.indexOf(v);
        cycles.push(stack.slice(i).concat(v));
      } else if (color.get(v) === WHITE) {
        visit(v);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };

  for (const id of adj.keys()) if (color.get(id) === WHITE) visit(id);
  return cycles;
}

/** Build warning strings for any cycles (using joint names). */
export function cycleWarnings(joints: Joint[], links: Link[]): string[] {
  const name = (id: string) => joints.find((j) => j.id === id)?.name ?? id;
  return detectCycles(joints, links).map(
    (cyc) => `Closed loop detected: ${cyc.map(name).join(' → ')}. Linked motion is disabled for this loop.`,
  );
}

/** Joint ids that participate in any cycle (driving through them is disabled). */
export function jointsInCycles(joints: Joint[], links: Link[]): Set<string> {
  const set = new Set<string>();
  for (const cyc of detectCycles(joints, links)) for (const id of cyc) set.add(id);
  return set;
}

/**
 * Propagate a drive on `seedId` to value `value` across the link graph,
 * returning a map of joint id → value. Links are traversed undirectedly (a
 * rigid coupling is symmetric); the ratio is applied forward from driver to
 * driven and inverted the other way. Every node is clamped to its resolved
 * range. Joints in a cycle are not propagated through (only the seed is set).
 */
export function propagate(
  seedId: string,
  value: number,
  joints: Joint[],
  links: Link[],
  evalNum: (expr: string) => number | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  const blocked = jointsInCycles(joints, links);
  const seedRange = resolvedRange(seedId, joints, links, evalNum);
  out[seedId] = clampToRange(value, seedRange);

  if (blocked.has(seedId)) return out; // don't propagate through a loop

  const visit = (id: string) => {
    const v = out[id];
    for (const link of links) {
      const r = evalNum(link.ratio);
      if (r === null) continue;
      const phase = link.phase != null ? evalNum(link.phase) ?? 0 : 0;
      let other: string | null = null;
      let mapped = 0;
      if (link.driverJointId === id) {
        other = link.drivenJointId;
        mapped = r * v + phase; // forward
      } else if (link.drivenJointId === id) {
        if (r === 0) continue;
        other = link.driverJointId;
        mapped = (v - phase) / r; // inverse
      }
      if (other === null || other in out || blocked.has(other)) continue;
      out[other] = clampToRange(mapped, resolvedRange(other, joints, links, evalNum));
      visit(other);
    }
  };
  visit(seedId);
  return out;
}

/* ---------- Transform composition ---------- */

const _o = new THREE.Vector3();
const _a = new THREE.Vector3();

/** The delta transform for a joint at a given value, around its origin.
 *  Revolute → rotation (value in degrees) about `axis` through `origin`.
 *  Prismatic → translation by `value` along `axis`. Identity at value 0. */
export function jointDeltaMatrix(joint: Joint, value: number): THREE.Matrix4 {
  _o.set(joint.origin[0], joint.origin[1], joint.origin[2]);
  _a.set(joint.axis[0], joint.axis[1], joint.axis[2]);
  if (_a.lengthSq() < 1e-12) _a.set(0, 1, 0);
  _a.normalize();

  if (joint.type === 'prismatic') {
    return new THREE.Matrix4().makeTranslation(_a.x * value, _a.y * value, _a.z * value);
  }
  // revolute: T(O) · R(axis, θ) · T(-O)
  const rad = (value * Math.PI) / 180;
  const rot = new THREE.Matrix4().makeRotationAxis(_a, rad);
  const toOrigin = new THREE.Matrix4().makeTranslation(-_o.x, -_o.y, -_o.z);
  const back = new THREE.Matrix4().makeTranslation(_o.x, _o.y, _o.z);
  return back.multiply(rot).multiply(toOrigin);
}

/** Combined delta matrix for a body, composing every joint that targets it at
 *  its current value (typically one). Identity when none. */
export function bodyDeltaMatrix(
  featureId: string,
  joints: Joint[],
  jointValues: Record<string, number>,
): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  for (const j of joints) {
    if (j.featureId !== featureId) continue;
    m.multiply(jointDeltaMatrix(j, jointValues[j.id] ?? 0));
  }
  return m;
}

/** Derive a gear ratio from two cog tooth counts. External mesh → negative
 *  (the cogs turn in opposite directions). Returns null when not derivable. */
export function teethRatio(driverTeeth?: number, drivenTeeth?: number): number | null {
  if (!driverTeeth || !drivenTeeth) return null;
  return -(driverTeeth / drivenTeeth);
}

/** Link kind from two joint types. */
export function linkKind(a: Joint, b: Joint): Link['kind'] {
  const rot = (j: Joint) => j.type === 'revolute';
  if (rot(a) && rot(b)) return 'rot-rot';
  if (!rot(a) && !rot(b)) return 'lin-lin';
  return 'rot-lin';
}

/* ---------- Closed-loop solving (pin-slot crank-rocker) ---------- */

type V2 = { x: number; y: number };

/** Orthonormal in-plane basis (u, v) perpendicular to a normalised axis, used to
 *  reduce the planar mechanism to 2D for solving. */
function planeBasis2D(axis: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const ref = Math.abs(axis.dot(new THREE.Vector3(0, 1, 0))) > 0.9
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 1, 0);
  const u = ref.clone().sub(axis.clone().multiplyScalar(axis.dot(ref))).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  return { u, v };
}

const rot2 = (px: number, py: number, ang: number): V2 => ({
  x: px * Math.cos(ang) - py * Math.sin(ang),
  y: px * Math.sin(ang) + py * Math.cos(ang),
});

/**
 * Solve the leg (slot-body) rotation `ang` about a fixed pivot `C2` so the slot
 * line through the leg passes through the fixed pin `Pb2`. All inputs are 2D
 * (projected onto the plane perpendicular to the joint axis):
 *   C2   – crank pin (the leg's lower pivot), world, this step
 *   P0   – the leg's lower pivot in the leg's home frame (== crank origin home)
 *   A2,B2 – slot endpoints in the leg's home frame
 *   Pb2  – the fixed pin, world
 * Returns the chosen root (nearest `seed`) plus the slide distance along the slot
 * and the slot length, or null when no real solution exists.
 */
export function solveSlotAngle(
  C2: V2, P0: V2, A2: V2, B2: V2, Pb2: V2, seed: number,
): { ang: number; slide: number; slotLen: number } | null {
  const slotLen = Math.hypot(B2.x - A2.x, B2.y - A2.y);
  if (slotLen < 1e-9) return null;

  const slotPt = (ang: number): V2 => {
    const r = rot2(A2.x - P0.x, A2.y - P0.y, ang);
    return { x: C2.x + r.x, y: C2.y + r.y };
  };
  const resid = (ang: number): number => {
    const A = slotPt(ang);
    const d = rot2(B2.x - A2.x, B2.y - A2.y, ang);
    const len = Math.hypot(d.x, d.y) || 1;
    // signed perpendicular distance from Pb to the slot line
    return ((Pb2.x - A.x) * d.y - (Pb2.y - A.y) * d.x) / len;
  };

  // Scan the full circle for sign changes, bisect each, then pick the root
  // nearest the seed for branch continuity.
  const N = 180;
  const roots: number[] = [];
  let prevAng = -Math.PI;
  let prevR = resid(prevAng);
  for (let i = 1; i <= N; i++) {
    const ang = -Math.PI + (2 * Math.PI * i) / N;
    const r = resid(ang);
    if (prevR === 0) roots.push(prevAng);
    else if ((prevR < 0) !== (r < 0)) {
      let lo = prevAng, hi = ang, rlo = prevR;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        const rm = resid(mid);
        if ((rlo < 0) !== (rm < 0)) hi = mid;
        else { lo = mid; rlo = rm; }
      }
      roots.push((lo + hi) / 2);
    }
    prevAng = ang;
    prevR = r;
  }
  if (!roots.length) return null;

  const wrap = (x: number) => {
    let a = x;
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };
  let best = roots[0];
  let bestD = Infinity;
  for (const r of roots) {
    const dd = Math.abs(wrap(r - seed));
    if (dd < bestD) { bestD = dd; best = r; }
  }
  const A = slotPt(best);
  const d = rot2(B2.x - A2.x, B2.y - A2.y, best);
  const len = Math.hypot(d.x, d.y) || 1;
  const slide = ((Pb2.x - A.x) * d.x + (Pb2.y - A.y) * d.y) / len;
  return { ang: best, slide, slotLen };
}

const v3 = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2]);

export interface SolveResult {
  /** World delta transform per jointed/solved body featureId. */
  transforms: Map<string, THREE.Matrix4>;
  /** Solved transient values to merge back (e.g. a loop body's revolute angle, °). */
  solvedValues: Record<string, number>;
  /** False when a loop has no solution / the slide left the slot (clamp-and-stop). */
  feasible: boolean;
}

/**
 * Compute every jointed body's world delta transform for the current joint
 * values, including closed-loop bodies driven through a pin-slot.
 *
 * Simple bodies compose their revolute/prismatic joints (relative to ground, or
 * to a `baseFeatureId` body for forward chains). A body that carries a pin-slot
 * **and** a based revolute is treated as a crank-slotted-rocker loop and its pose
 * is solved (§11 of the design guide). `feasible` is false when any loop can't be
 * solved at these values — the caller clamps-and-stops.
 */
export function solveBodyTransforms(
  doc: Doc,
  jointValues: Record<string, number>,
  evalNum: (expr: string) => number | null,
): SolveResult {
  const transforms = new Map<string, THREE.Matrix4>();
  const solvedValues: Record<string, number> = {};
  let feasible = true;
  const joints = doc.joints ?? [];
  const pinSlots = doc.pinSlots ?? [];
  const slotBodyIds = new Set(pinSlots.map((ps) => ps.slotFeatureId));

  const jointsByFeature = new Map<string, Joint[]>();
  for (const j of joints) {
    const arr = jointsByFeature.get(j.featureId) ?? [];
    arr.push(j);
    jointsByFeature.set(j.featureId, arr);
  }

  // Forward-resolve a simple (non-loop) body's transform, honouring baseFeatureId
  // chains. Loop bodies are resolved separately below.
  const resolving = new Set<string>();
  const resolveSimple = (fid: string): THREE.Matrix4 => {
    const cached = transforms.get(fid);
    if (cached) return cached;
    if (resolving.has(fid)) return new THREE.Matrix4();
    resolving.add(fid);
    const m = new THREE.Matrix4();
    for (const j of jointsByFeature.get(fid) ?? []) {
      if (j.type === 'prismatic' && slotBodyIds.has(fid)) continue;
      const local = jointDeltaMatrix(j, jointValues[j.id] ?? 0);
      if (j.baseFeatureId) {
        const base = resolveSimple(j.baseFeatureId);
        m.multiply(new THREE.Matrix4().multiplyMatrices(base, local));
      } else {
        m.multiply(local);
      }
    }
    resolving.delete(fid);
    transforms.set(fid, m);
    return m;
  };
  for (const fid of jointsByFeature.keys()) {
    if (slotBodyIds.has(fid)) continue; // loop body — solved below
    resolveSimple(fid);
  }

  // Solve each pin-slot loop.
  for (const ps of pinSlots) {
    const legId = ps.slotFeatureId;
    if (!ps.pinFeatureId) { transforms.set(legId, new THREE.Matrix4()); continue; }
    const legRev = (jointsByFeature.get(legId) ?? []).find(
      (j) => j.type === 'revolute' && !!j.baseFeatureId,
    );
    if (!legRev) { transforms.set(legId, new THREE.Matrix4()); continue; }

    const axis = v3(legRev.axis);
    if (axis.lengthSq() < 1e-9) axis.set(1, 0, 0);
    axis.normalize();
    const baseT = resolveSimple(legRev.baseFeatureId as string);
    const originHome = v3(legRev.origin);
    const C3 = originHome.clone().applyMatrix4(baseT);
    const pinBaseT = transforms.get(ps.pinFeatureId) ?? new THREE.Matrix4();
    const Pb3 = v3(ps.pin).applyMatrix4(pinBaseT);
    const A3 = v3(ps.slotA);
    const B3 = v3(ps.slotB);

    const { u, v } = planeBasis2D(axis);
    const to2 = (p: THREE.Vector3): V2 => ({ x: p.dot(u), y: p.dot(v) });
    const seedDeg = jointValues[legRev.id] ?? 0;
    const sol = solveSlotAngle(
      to2(C3), to2(originHome), to2(A3), to2(B3), to2(Pb3), (seedDeg * Math.PI) / 180,
    );

    let ok = sol !== null;
    if (sol) {
      const eps = 1e-4 * (sol.slotLen || 1);
      let lo = 0, hi = sol.slotLen;
      if (ps.limits?.mode === 'limited') {
        const lmin = ps.limits.min != null ? evalNum(ps.limits.min) : null;
        const lmax = ps.limits.max != null ? evalNum(ps.limits.max) : null;
        if (lmin != null) lo = Math.max(lo, lmin);
        if (lmax != null) hi = Math.min(hi, lmax);
      }
      if (sol.slide < lo - eps || sol.slide > hi + eps) ok = false;
    }

    if (!ok || !sol) {
      feasible = false;
      // Leave the body at its last good (identity if none) — caller rejects the move.
      if (!transforms.has(legId)) transforms.set(legId, new THREE.Matrix4());
      continue;
    }

    const m = new THREE.Matrix4()
      .makeTranslation(C3.x, C3.y, C3.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(axis, sol.ang))
      .multiply(new THREE.Matrix4().makeTranslation(-originHome.x, -originHome.y, -originHome.z));
    transforms.set(legId, m);
    solvedValues[legRev.id] = (sol.ang * 180) / Math.PI;
  }

  return { transforms, solvedValues, feasible };
}

/** True when a body is the slot side of a pin-slot loop (its revolute is solved,
 *  not user-driven). */
export function isLoopSolvedJoint(doc: Doc, joint: Joint): boolean {
  if (joint.type !== 'revolute' || !joint.baseFeatureId) return false;
  return (doc.pinSlots ?? []).some((ps) => ps.slotFeatureId === joint.featureId);
}
