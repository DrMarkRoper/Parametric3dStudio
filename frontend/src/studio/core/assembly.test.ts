import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  intersectRange,
  isEmptyRange,
  clampToRange,
  resolvedRange,
  detectCycles,
  propagate,
  jointDeltaMatrix,
  teethRatio,
  linkKind,
  solveSlotAngle,
  solveBodyTransforms,
  type Range,
} from './assembly';
import type { Doc, Joint, Link, PinSlotJoint } from '../types';

const num = (n: number | null) => n;
const noEval = (e: string) => {
  const v = parseFloat(e);
  return isFinite(v) ? v : null;
};

const revolute = (id: string, featureId: string, limits?: { min: string; max: string }): Joint => ({
  id,
  name: id,
  featureId,
  type: 'revolute',
  origin: [0, 0, 0],
  axis: [0, 1, 0],
  limits: limits ? { mode: 'limited', ...limits } : { mode: 'free' },
});

const link = (id: string, driver: string, driven: string, ratio: string, phase = '0'): Link => ({
  id,
  name: id,
  driverJointId: driver,
  drivenJointId: driven,
  kind: 'rot-rot',
  ratio,
  ratioSource: 'manual',
  phase,
});

describe('range algebra', () => {
  it('intersects bounded + unbounded', () => {
    expect(intersectRange({ min: -90, max: 45 }, { min: null, max: 30 })).toEqual({ min: -90, max: 30 });
    expect(intersectRange({ min: null, max: null }, { min: -10, max: 10 })).toEqual({ min: -10, max: 10 });
  });
  it('detects empty ranges', () => {
    expect(isEmptyRange({ min: 10, max: 5 })).toBe(true);
    expect(isEmptyRange({ min: 5, max: 10 })).toBe(false);
    expect(isEmptyRange({ min: null, max: 10 })).toBe(false);
  });
  it('clamps to bounds', () => {
    const r: Range = { min: -90, max: 45 };
    expect(clampToRange(100, r)).toBe(45);
    expect(clampToRange(-100, r)).toBe(-90);
    expect(clampToRange(10, r)).toBe(10);
  });
});

describe('resolved range = intersection through ratio', () => {
  // Driver ±90, driven ±10, ratio 1/4 → driver effectively clamped to ±40
  it('clamps the driver to what the driven can reach', () => {
    const joints = [revolute('A', 'fa', { min: '-90', max: '90' }), revolute('B', 'fb', { min: '-10', max: '10' })];
    const links = [link('L', 'A', 'B', '0.25')];
    const r = resolvedRange('A', joints, links, noEval);
    expect(r.min).toBeCloseTo(-40);
    expect(r.max).toBeCloseTo(40);
  });
  it('maps the driver range onto the driven', () => {
    const joints = [revolute('A', 'fa', { min: '-20', max: '20' }), revolute('B', 'fb')];
    const links = [link('L', 'A', 'B', '0.25')];
    const r = resolvedRange('B', joints, links, noEval);
    expect(r.min).toBeCloseTo(-5);
    expect(r.max).toBeCloseTo(5);
  });
  it('negative ratio swaps the mapped ends', () => {
    const joints = [revolute('A', 'fa', { min: '-20', max: '20' }), revolute('B', 'fb')];
    const links = [link('L', 'A', 'B', '-0.5')];
    const r = resolvedRange('B', joints, links, noEval);
    expect(r.min).toBeCloseTo(-10);
    expect(r.max).toBeCloseTo(10);
  });
});

describe('propagation', () => {
  it('drives a 3-joint chain through its ratios', () => {
    const joints = [revolute('A', 'fa'), revolute('B', 'fb'), revolute('C', 'fc')];
    const links = [link('L1', 'A', 'B', '0.25'), link('L2', 'B', 'C', '2')];
    const out = propagate('A', 20, joints, links, noEval);
    expect(out['A']).toBeCloseTo(20);
    expect(out['B']).toBeCloseTo(5); // 0.25 * 20
    expect(out['C']).toBeCloseTo(10); // 2 * 5
  });
  it('inverts the ratio when dragging the driven end', () => {
    const joints = [revolute('A', 'fa'), revolute('B', 'fb')];
    const links = [link('L', 'A', 'B', '0.25')];
    const out = propagate('B', 5, joints, links, noEval);
    expect(out['B']).toBeCloseTo(5);
    expect(out['A']).toBeCloseTo(20); // (5 - 0) / 0.25
  });
  it('clamps propagated values at each driven limit', () => {
    const joints = [revolute('A', 'fa'), revolute('B', 'fb', { min: '-3', max: '3' })];
    const links = [link('L', 'A', 'B', '0.25')];
    const out = propagate('A', 40, joints, links, noEval);
    // B would be 10 but is capped at 3
    expect(out['B']).toBeCloseTo(3);
  });
  it('applies the phase offset', () => {
    const joints = [revolute('A', 'fa'), revolute('B', 'fb')];
    const links = [link('L', 'A', 'B', '1', '90')];
    const out = propagate('A', 10, joints, links, noEval);
    expect(out['B']).toBeCloseTo(100);
  });
});

describe('cycle detection', () => {
  it('reports a closed loop and does not propagate through it', () => {
    const joints = [revolute('A', 'fa'), revolute('B', 'fb')];
    const links = [link('L1', 'A', 'B', '1'), link('L2', 'B', 'A', '1')];
    const cycles = detectCycles(joints, links);
    expect(cycles.length).toBeGreaterThan(0);
    const out = propagate('A', 10, joints, links, noEval);
    // seed set, loop partner not propagated
    expect(out['A']).toBeCloseTo(10);
    expect(out['B']).toBeUndefined();
  });
  it('is acyclic for a simple chain', () => {
    const joints = [revolute('A', 'fa'), revolute('B', 'fb')];
    expect(detectCycles(joints, [link('L', 'A', 'B', '1')]).length).toBe(0);
  });
});

describe('transforms & helpers', () => {
  it('revolute matrix rotates a point about the origin axis', () => {
    const j: Joint = { id: 'J', name: 'J', featureId: 'f', type: 'revolute', origin: [0, 0, 0], axis: [0, 1, 0], limits: { mode: 'free' } };
    const m = jointDeltaMatrix(j, 90);
    const p = new THREE.Vector3(1, 0, 0).applyMatrix4(m);
    expect(p.x).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(-1); // +90° about +Y sends +X to −Z (right-hand rule)
  });
  it('revolute matrix respects a non-origin pivot', () => {
    const j: Joint = { id: 'J', name: 'J', featureId: 'f', type: 'revolute', origin: [5, 0, 0], axis: [0, 1, 0], limits: { mode: 'free' } };
    const p = new THREE.Vector3(5, 0, 0).applyMatrix4(jointDeltaMatrix(j, 90));
    expect(p.x).toBeCloseTo(5);
    expect(p.z).toBeCloseTo(0); // the pivot point itself is invariant
  });
  it('prismatic matrix translates along the axis', () => {
    const j: Joint = { id: 'J', name: 'J', featureId: 'f', type: 'prismatic', origin: [0, 0, 0], axis: [0, 0, 1], limits: { mode: 'free' } };
    const p = new THREE.Vector3(0, 0, 0).applyMatrix4(jointDeltaMatrix(j, 7));
    expect(p.z).toBeCloseTo(7);
  });
  it('derives gear ratio (negative for external mesh)', () => {
    expect(teethRatio(20, 10)).toBeCloseTo(-2);
    expect(teethRatio(undefined, 10)).toBeNull();
  });
  it('classifies link kinds', () => {
    const rev: Joint = { id: 'r', name: 'r', featureId: 'f', type: 'revolute', origin: [0, 0, 0], axis: [0, 1, 0], limits: { mode: 'free' } };
    const pri: Joint = { id: 'p', name: 'p', featureId: 'g', type: 'prismatic', origin: [0, 0, 0], axis: [1, 0, 0], limits: { mode: 'free' } };
    expect(linkKind(rev, rev)).toBe('rot-rot');
    expect(linkKind(rev, pri)).toBe('rot-lin');
    expect(linkKind(pri, pri)).toBe('lin-lin');
  });
});

describe('pin-slot loop solver', () => {
  it('solveSlotAngle is consistent at the home pose', () => {
    // Crank pivot at (0,-10); slot from (0,5)..(0,45) in leg frame; pin at (0,25).
    const sol = solveSlotAngle({ x: 0, y: -10 }, { x: 0, y: -10 }, { x: 0, y: 5 }, { x: 0, y: 45 }, { x: 0, y: 25 }, 0);
    expect(sol).not.toBeNull();
    expect(sol!.ang).toBeCloseTo(0, 3);
    expect(sol!.slide).toBeCloseTo(20, 3);
    expect(sol!.slotLen).toBeCloseTo(40, 3);
  });

  // Minimal crank-slotted-rocker: a wheel (revolute to ground) carries a crank
  // pin 10 below its centre; the leg is pinned to that crank and slotted onto a
  // fixed body pin.
  const Ow: [number, number, number] = [0, 0, 0];
  const crankHome: [number, number, number] = [0, 0, -10];
  const loopDoc = (limits?: { min: string; max: string }): Doc => ({
    parameters: [], features: [], gridSize: 5, snap: 'grid', links: [],
    joints: [
      { id: 'jw', name: 'Wheel', featureId: 'wheel', type: 'revolute', origin: Ow, axis: [1, 0, 0], limits: { mode: 'free' } },
      { id: 'jleg', name: 'Leg pin', featureId: 'leg', type: 'revolute', origin: crankHome, axis: [1, 0, 0], limits: { mode: 'free' }, baseFeatureId: 'wheel' },
    ] as Joint[],
    pinSlots: [
      {
        id: 'ps', name: 'Slot', type: 'pinslot',
        slotFeatureId: 'leg', slotA: [0, 0, 5], slotB: [0, 0, 45],
        pinFeatureId: 'body', pin: [0, 0, 25],
        limits: limits ? { mode: 'limited', ...limits } : { mode: 'free' },
      },
    ] as PinSlotJoint[],
  });

  it('leg transform is identity at the home pose (θ = 0)', () => {
    const res = solveBodyTransforms(loopDoc(), { jw: 0, jleg: 0 }, noEval);
    expect(res.feasible).toBe(true);
    const m = res.transforms.get('leg')!;
    const p = new THREE.Vector3(0, 0, 5).applyMatrix4(m); // a slot point
    expect(p.x).toBeCloseTo(0, 3);
    expect(p.y).toBeCloseTo(0, 3);
    expect(p.z).toBeCloseTo(5, 3);
  });

  it('solves the leg pose so the fixed pin stays on the slot line as the wheel turns', () => {
    const res = solveBodyTransforms(loopDoc(), { jw: 30, jleg: 0 }, noEval);
    expect(res.feasible).toBe(true);
    const m = res.transforms.get('leg')!;
    const A = new THREE.Vector3(0, 0, 5).applyMatrix4(m);
    const B = new THREE.Vector3(0, 0, 45).applyMatrix4(m);
    const pin = new THREE.Vector3(0, 0, 25); // body is ground → fixed
    // pin must be collinear with the slot segment (cross product ≈ 0)
    const dir = new THREE.Vector3().subVectors(B, A);
    const w = new THREE.Vector3().subVectors(pin, A);
    const cross = new THREE.Vector3().crossVectors(w, dir).length() / (dir.length() || 1);
    expect(cross).toBeLessThan(1e-3);
    // and the slide must stay within the slot
    const t = w.dot(dir) / dir.lengthSq();
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(1);
  });

  it('clamps-and-stops: an out-of-range slide is infeasible', () => {
    // Limit the slide to 0..5 from A, but the home slide is 20 → infeasible.
    const res = solveBodyTransforms(loopDoc({ min: '0', max: '5' }), { jw: 0, jleg: 0 }, noEval);
    expect(res.feasible).toBe(false);
  });
});

// silence unused
void num;
