export type Vec2 = { x: number; y: number };

export type PlaneId = 'XY' | 'XZ' | 'YZ';
export type SnapMode = 'none' | 'grid' | 'edge';
export type EdgeKind = 'fillet' | 'chamfer';
export type BoolOp = 'new' | 'cut' | 'fuse';

export interface Parameter {
  id: string;
  name: string;
  expression: string;
}

/* ---------- Sketch entities ---------- */

export interface LineEntity {
  id: string;
  kind: 'line';
  p1: Vec2;
  p2: Vec2;
  construction: boolean;
  /** Optional driving length expression. Applied when set/edited (moves p2 along p1->p2). */
  length?: string;
}

export interface CircleEntity {
  id: string;
  kind: 'circle';
  center: Vec2;
  /** X-radius expression. When `radiusY` is omitted, the entity is a true circle (radiusY = radius). */
  radius: string; // expression
  /** Optional Y-radius expression — turns the entity into an axis-aligned ellipse. */
  radiusY?: string;
  /** Accumulated rotation in degrees (screen-CW positive). Ignored when the
   *  entity is a true circle (rx === ry) but lets ovals spin around `center`. */
  rotation?: number;
  construction: boolean;
}

export interface RectEntity {
  id: string;
  kind: 'rect';
  corner: Vec2; // anchor corner; rect extends +x/+y by width/height
  width: string; // expression
  height: string; // expression
  construction: boolean;
  /** Rotation in degrees (CCW), applied around `corner`. Default 0. */
  rotation?: number;
}

export interface ImageEntity {
  id: string;
  kind: 'image';
  corner: Vec2;           // bottom-left in sketch space
  width: string;          // expression (sketch units)
  height: string;         // expression
  src: string;            // data URL (base64)
  fileName: string;
  naturalWidth: number;   // original image width in pixels
  naturalHeight: number;  // original image height in pixels
  fit: 'scale' | 'crop';
  maintainAspect: boolean; // only applies in 'scale' mode
  opacity: number;         // 0..1
  /**
   * Crop mode only: the full image's width in sketch units.
   * Controls zoom level independently of the rect size.
   * Stored so changing the rect never silently changes the image zoom.
   * Display as % = cropScale / naturalWidth * 100  (100% = 1px per sketch unit).
   */
  cropScale?: number;
  /** Crop mode only: which part of the image to anchor / where to place when image < rect. */
  cropAnchor?: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Rotation in degrees (CCW), applied around `corner`. Default 0. */
  rotation?: number;
}

/**
 * Anchor reference for a dimension pick. When set, the rendered position is
 * looked up live off the referenced entity (so the dim follows the entity as
 * it moves). When omitted, the absolute `p1` / `p2` on the dimension itself
 * is used.
 *
 *   • endpoint  → a line's p1 (which='p1') or p2 (which='p2')
 *   • midpoint  → midpoint of a line
 *   • center    → centre of a circle / ellipse
 *   • corner    → one of a rectangle's four corners (index 0–3, CCW from BL)
 *   • edgemid   → midpoint of a rectangle edge (index 0–3, BL→BR, BR→TR, …)
 */
export type DimensionAnchorKind = 'endpoint' | 'midpoint' | 'center' | 'corner' | 'edgemid';
export interface DimensionAnchor {
  kind: DimensionAnchorKind;
  entityId: string;
  which?: 'p1' | 'p2';
  index?: number;
}

/** Linear dimension annotation. Renders perpendicular extension lines from
 *  `p1` and `p2`, a parallel dimension line offset by `offset` along the
 *  perpendicular, and a distance label centred on the dim line. Decorative —
 *  excluded from region detection, hit testing and extrude profile building.
 *
 *  When `p1Anchor` / `p2Anchor` are set, the renderer resolves them to live
 *  positions on the referenced entities, so moving the underlying line / rect
 *  / circle updates the dimension automatically. The stored `p1` / `p2` are
 *  the fallback positions used when an anchor can't be resolved (e.g. its
 *  entity was deleted). */
export interface DimensionEntity {
  id: string;
  kind: 'dimension';
  p1: Vec2;
  p2: Vec2;
  p1Anchor?: DimensionAnchor;
  p2Anchor?: DimensionAnchor;
  /** Perpendicular offset (sketch units) from the line p1→p2 where the dim line sits. */
  offset: number;
  /** Optional override label; if omitted the rendered distance is shown. */
  label?: string;
  construction?: boolean;
}

/** Circular arc — a centre + radius + angular range. Renders as the *shorter*
 *  arc between startAngle and endAngle (the two angles are stored independently
 *  so the tool can capture either direction; on render we go the short way).
 *  Angles are in degrees, math-CCW convention. */
export interface ArcEntity {
  id: string;
  kind: 'arc';
  center: Vec2;
  radius: string;     // expression
  startAngle: string; // expression (degrees)
  endAngle: string;   // expression (degrees)
  construction: boolean;
}

/** Cog / spur gear — a centre + outer & inner radii + integer tooth count.
 *  `profile` chooses how each tooth is drawn around the outer ring:
 *    • `square`    — flat-topped block teeth (gap === tooth width at root)
 *    • `pointy`    — star-style triangular teeth pointing outwards
 *    • `trapezoid` — narrower at the tip than at the root (classic gear look)
 *  Rotation (degrees, screen-CW positive) spins the whole profile around
 *  `center`. Accepted as a closed extrude profile (like Circle). */
export type CogProfile = 'square' | 'pointy' | 'trapezoid';

export interface CogEntity {
  id: string;
  kind: 'cog';
  center: Vec2;
  outerRadius: string; // expression
  innerRadius: string; // expression — tooth root / valley radius
  teeth: number;       // positive integer
  /** Tooth shape. Missing/undefined renders as `square` to keep legacy data identical. */
  profile?: CogProfile;
  rotation?: number;   // degrees, screen-CW positive; default 0
  construction: boolean;
}

export type SketchEntity = LineEntity | CircleEntity | RectEntity | ImageEntity | DimensionEntity | ArcEntity | CogEntity;

/** Fillet/chamfer applied to a sketch corner (vertex matched by position). */
export interface CornerMod {
  id: string;
  at: Vec2;
  kind: EdgeKind;
  size: string; // expression: radius for fillet, setback for chamfer
}

/* ---------- Features ---------- */

interface FeatureBase {
  id: string;
  name: string;
  visible: boolean;
}

export interface SketchFeature extends FeatureBase {
  type: 'sketch';
  plane: PlaneId;
  offset: string; // expression, distance along plane normal
  entities: SketchEntity[];
  corners: CornerMod[];
  /**
   * Optional arbitrary-plane matrix (16 floats, THREE.Matrix4.elements order, column-major).
   * When present, overrides plane/offset entirely.
   * Column 0 = X axis, column 1 = Y axis, column 2 = face normal (extrude direction),
   * column 3 = origin (face centroid).
   * Created by "Sketch on Face".
   */
  customPlane?: number[];
}

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  sketchId: string;
  distance: string; // expression (may be negative)
  /** Optional perpendicular start height along the sketch plane normal. The
   *  extrude begins this far above the sketch plane (instead of at 0) and runs
   *  for `distance`. Expression; may be negative. Default 0 / undefined. */
  offset?: string;
  op: BoolOp;
  edge?: { kind: EdgeKind; size: string };
  color: string;
  /** 0..1, default 1 (opaque) */
  opacity?: number;
  /** Representative points inside the selected profile regions; undefined/empty = all profiles. */
  regionPts?: Vec2[];
}

export type PrimitiveShape =
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'torus'
  /** Custom thread primitives (Create → Torus → Custom). Each carries its own
   *  set of `dims` expressions describing the thread geometry — see
   *  THREAD_PRESETS below for the meanings of each field.
   *  All four share these dims keys:
   *   outerDiameter — major (crest) diameter of the thread
   *   pitch         — axial distance between two adjacent crests
   *   threadDepth   — radial depth of the thread (crest → root)
   *   height        — axial length of the threaded portion
   *  Plus shape-specific extras:
   *   bulbScrew   → bulbDiameter
   *   bulbSocket  → wallThickness
   *   screwThread → headDiameter, headHeight
   *   nutThread   → outerSize (hex flat-to-flat)
   */
  | 'bulbScrew'
  | 'bulbSocket'
  | 'screwThread'
  | 'nutThread';

/** True when the shape is one of the threaded "Custom" primitives. */
export const THREAD_SHAPES: ReadonlySet<PrimitiveShape> = new Set<PrimitiveShape>([
  'bulbScrew',
  'bulbSocket',
  'screwThread',
  'nutThread',
]);

/** Returns `true` when the shape uses the rounded (Edison) thread profile
 *  rather than the sharp 60° V-profile used by ISO metric bolts / nuts. */
export const isEdisonThread = (s: PrimitiveShape): boolean =>
  s === 'bulbScrew' || s === 'bulbSocket';

export interface PrimitiveFeature extends FeatureBase {
  type: 'primitive';
  shape: PrimitiveShape;
  dims: Record<string, string>; // expressions
  position: [string, string, string]; // expressions
  rotation: [string, string, string]; // degrees (XYZ), expressions
  edge?: { kind: EdgeKind; size: string }; // box & cylinder only
  op: BoolOp;
  color: string;
  /** 0..1, default 1 (opaque) */
  opacity?: number;
  /** Optional second material colour. Currently only used by `bulbScrew`,
   *  where the bulb glass is rendered in this colour while `color` paints the
   *  threaded metal cap + contact. When omitted, the secondary part falls back
   *  to a warm-white default so legacy projects still render sensibly. */
  secondaryColor?: string;
  /** Optional second opacity (0..1) — paired with `secondaryColor`. Only the
   *  `bulbScrew` shape currently splits opacity per part: `opacity` drives the
   *  cap + contact body, this drives the glass envelope. Defaults to 1. */
  secondaryOpacity?: number;
}

export interface ImportFeature extends FeatureBase {
  type: 'import';
  fileName: string;
  position: [number, number, number];
  rotation: [number, number, number]; // degrees
  scale: number;
  color: string;
  /** 0..1, default 1 (opaque) */
  opacity?: number;
  /**
   * If true, this body's geometry is serialized into the project JSON when saving
   * (used for bodies created by "Detach from sketch" or "Create independent body",
   * which have no source file to re-import on load). Regular file imports leave
   * this undefined/false so save files stay small.
   */
  embedded?: boolean;
}

export type MergeOp = 'cut' | 'fuse' | 'intersect';

/** Boolean combination of two existing bodies (referenced by the feature that produced them). */
export interface BooleanFeature extends FeatureBase {
  type: 'boolean';
  op: MergeOp;
  /** body A — kept side of a cut */
  targetId: string;
  /** body B — removed side of a cut */
  toolId: string;
  color: string;
  opacity?: number;
}

export type Feature = SketchFeature | ExtrudeFeature | PrimitiveFeature | ImportFeature | BooleanFeature;

/* ---------- Assembly (mechanical joints & links) ---------- */

/** A 3D point / vector in world space (baked, like all engine geometry). */
export type Vec3 = [number, number, number];

export type JointType = 'revolute' | 'prismatic';

/** A straight slot (groove) carried by a body, used by a pin-slot joint. The
 *  endpoints are stored in the slot body's home (design) frame — since engine
 *  geometry is baked to world, that home frame is world-at-design, and the
 *  endpoints are transformed by the body's solved pose when the loop is solved. */
export interface PinSlotJoint {
  id: string;
  name: string;
  type: 'pinslot';
  /** Body carrying the slot (e.g. the leg). */
  slotFeatureId: string;
  /** Slot centre-line endpoints, in the slot body's home frame. */
  slotA: Vec3;
  slotB: Vec3;
  /** Body carrying the pin (e.g. the body / ground). Empty until configured. */
  pinFeatureId: string;
  /** Pin point in the pin body's home frame. */
  pin: Vec3;
  /** Optional slide limits along the slot (length units measured from slotA). */
  limits: JointLimits;
}

/** Allowed-motion limits for a joint. `free` = unbounded; `limited` reads min/max. */
export interface JointLimits {
  mode: 'free' | 'limited';
  /** Expression; degrees (revolute) or length units (prismatic). */
  min?: string;
  /** Expression; only read when mode === 'limited'. */
  max?: string;
}

/**
 * A single retained degree of freedom for one body, relative to its design
 * (home) pose. Revolute = rotation about `axis` through `origin`; prismatic =
 * translation along `axis` from `origin`. `axis` is stored normalised and its
 * orientation defines the positive direction (right-hand rule for revolute).
 * The current drive value is transient UI state (store.assembly.jointValues),
 * never serialised — the home pose is always the zero.
 */
export interface Joint {
  id: string;
  name: string;
  /** Feature id of the body this joint moves. */
  featureId: string;
  type: JointType;
  /** Joint origin in world space. */
  origin: Vec3;
  /** Revolute: rotation axis. Prismatic: translation direction. Normalised. */
  axis: Vec3;
  limits: JointLimits;
  /**
   * Body this joint moves relative to. Omitted/empty = ground (world) — the v1
   * default. When set, the joint origin/axis are taken in that base body's frame
   * and move with it (a joint *between two bodies*), e.g. a leg pinned to a
   * crank pin on the wheel. Used by the closed-loop solver.
   */
  baseFeatureId?: string;
}

/** The coupling type, derived from the two joints' types. */
export type LinkKind = 'rot-rot' | 'rot-lin' | 'lin-lin';

/**
 * A coupling between two joints: `driven = ratio * driver + phase`. Acyclic
 * driver→driven chains only (cycles are detected and warned, never solved).
 */
export interface Link {
  id: string;
  name: string;
  driverJointId: string;
  drivenJointId: string;
  kind: LinkKind;
  /** Expression. driven value = ratio * driver value + phase. */
  ratio: string;
  /** Where the ratio comes from. `teeth` auto-derives from cog tooth counts. */
  ratioSource: 'manual' | 'teeth';
  /** Expression; offset added to the driven value after the ratio. Default 0. */
  phase?: string;
}

/* ---------- Feature tree (panel presentation only) ---------- */

/** A collapsible group in the Features panel. Purely organisational — it does
 *  NOT change `features` order or regeneration; `children` lists the feature ids
 *  shown under it, in display order. */
export interface FeatureCategory {
  id: string;
  name: string;
  collapsed: boolean;
  children: string[];
}

/* ---------- Document ---------- */

export interface Doc {
  parameters: Parameter[];
  features: Feature[];
  gridSize: number;
  snap: SnapMode;
  /** Mechanical joints (Assembly mode). Optional for legacy files. */
  joints: Joint[];
  /** Mechanical links between joints (Assembly mode). Optional for legacy files. */
  links: Link[];
  /** Pin-slot joints (Assembly mode closed loops). Optional for legacy files. */
  pinSlots: PinSlotJoint[];
  /** Features-panel groups (presentation only). Optional for legacy files. */
  categories: FeatureCategory[];
  /** Ordered root items of the features tree — category ids and root-level
   *  feature ids. Optional; missing/extra ids are reconciled at render time. */
  rootOrder: string[];
}

export const emptyDoc = (): Doc => ({
  parameters: [],
  features: [],
  gridSize: 5,
  snap: 'grid',
  joints: [],
  links: [],
  pinSlots: [],
  categories: [],
  rootOrder: [],
});

export const uid = (): string => Math.random().toString(36).slice(2, 10);

export const PRIMITIVE_DEFAULTS: Record<PrimitiveShape, { dims: Record<string, string>; y: string }> = {
  box: { dims: { width: '40', height: '40', depth: '40' }, y: '20' },
  sphere: { dims: { radius: '25' }, y: '25' },
  cylinder: { dims: { radius: '15', height: '40' }, y: '20' },
  cone: { dims: { radius: '20', height: '40' }, y: '20' },
  torus: { dims: { radius: '25', tube: '8' }, y: '8' },
  // ── Threaded primitives (Custom submenu) ───────────────────────────────────
  // Defaults seed the standards most users want:
  //  • Bulb screw / socket → E27 (27 mm, ~3.6 mm pitch, IEC 60061)
  //  • Bolt / nut         → M8 × 1.25 (ISO metric)
  // The `y` field places the body so its bottom sits on the grid by default.
  bulbScrew: {
    dims: {
      outerDiameter: '27',
      pitch: '3.6',
      threadDepth: '1.2',
      height: '17',
      bulbDiameter: '60',
    },
    // Cap is centred around y = 0 in mesh-local space, with the contact dome
    // protruding ~outerDiameter × 0.06 below it. Lift so the contact tip sits
    // on the grid: capHeight/2 + contactBulge ≈ 17/2 + 27·0.06 ≈ 10.1.
    y: '10',
  },
  bulbSocket: {
    dims: {
      outerDiameter: '27',
      pitch: '3.6',
      threadDepth: '1.2',
      height: '20',
      wallThickness: '3',
    },
    y: '10',
  },
  screwThread: {
    dims: {
      outerDiameter: '8',
      pitch: '1.25',
      threadDepth: '0.77', // 0.614 × pitch (ISO basic profile)
      height: '30',
      headDiameter: '13',
      headHeight: '5',
    },
    // Geometry is centred at the half-height of (shaft + head). With defaults
    // (30 + 5) / 2 = 17.5 → bottom of shaft sits on the grid.
    y: '17.5',
  },
  nutThread: {
    dims: {
      outerDiameter: '8',
      pitch: '1.25',
      threadDepth: '0.77',
      height: '6',
      outerSize: '13', // hex flat-to-flat
    },
    y: '3',
  },
};

/** Quick-pick thread standards used by the Properties panel preset dropdown.
 *  Each preset fills the matching `dims` keys when applied. Bulb presets follow
 *  IEC 60061 Edison series; bolt/nut presets follow ISO 261 metric coarse. */
export interface ThreadPreset {
  id: string;
  label: string;
  /** Major (outside) diameter, mm */
  outerDiameter: number;
  /** Axial distance between crests, mm */
  pitch: number;
  /** Radial depth of the thread, mm */
  threadDepth: number;
}

export const BULB_PRESETS: ThreadPreset[] = [
  { id: 'E40', label: 'E40 (Goliath)', outerDiameter: 40, pitch: 6.0, threadDepth: 1.6 },
  { id: 'E27', label: 'E27 (Standard)', outerDiameter: 27, pitch: 3.6, threadDepth: 1.2 },
  { id: 'E26', label: 'E26 (US Medium)', outerDiameter: 26, pitch: 3.6, threadDepth: 1.2 },
  { id: 'E17', label: 'E17 (Intermediate)', outerDiameter: 17, pitch: 3.0, threadDepth: 0.9 },
  { id: 'E14', label: 'E14 (Small)', outerDiameter: 14, pitch: 2.82, threadDepth: 0.85 },
  { id: 'E12', label: 'E12 (Candelabra)', outerDiameter: 12, pitch: 2.6, threadDepth: 0.75 },
  { id: 'E10', label: 'E10 (Miniature)', outerDiameter: 10, pitch: 2.0, threadDepth: 0.6 },
];

/** ISO 261 coarse-pitch series. Thread depth = 0.614 × pitch (basic profile). */
export const BOLT_PRESETS: ThreadPreset[] = [
  { id: 'M3', label: 'M3 × 0.5', outerDiameter: 3, pitch: 0.5, threadDepth: 0.307 },
  { id: 'M4', label: 'M4 × 0.7', outerDiameter: 4, pitch: 0.7, threadDepth: 0.43 },
  { id: 'M5', label: 'M5 × 0.8', outerDiameter: 5, pitch: 0.8, threadDepth: 0.491 },
  { id: 'M6', label: 'M6 × 1.0', outerDiameter: 6, pitch: 1.0, threadDepth: 0.614 },
  { id: 'M8', label: 'M8 × 1.25', outerDiameter: 8, pitch: 1.25, threadDepth: 0.77 },
  { id: 'M10', label: 'M10 × 1.5', outerDiameter: 10, pitch: 1.5, threadDepth: 0.92 },
  { id: 'M12', label: 'M12 × 1.75', outerDiameter: 12, pitch: 1.75, threadDepth: 1.07 },
  { id: 'M16', label: 'M16 × 2.0', outerDiameter: 16, pitch: 2.0, threadDepth: 1.23 },
  { id: 'M20', label: 'M20 × 2.5', outerDiameter: 20, pitch: 2.5, threadDepth: 1.53 },
];

export const BODY_COLORS = ['#5b8def', '#5fb878', '#e6a23c', '#b07ce8', '#5ec8d8', '#e87c7c', '#8d9f6f'];
