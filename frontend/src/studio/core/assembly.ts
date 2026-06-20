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
import type { Joint, Link } from '../types';

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
