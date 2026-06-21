import { create } from 'zustand';
import * as THREE from 'three';
import { emptyDoc, uid, type Doc, type Feature, type FeatureCategory, type Joint, type Link, type Parameter, type PinSlotJoint, type SketchFeature, type SnapMode, type Vec2 } from '../types';
import { cycleWarnings, propagate, solveBodyTransforms } from '../core/assembly';
import { resolveParameters, tryEval } from '../core/expressions';

export type Tool =
  | 'select'
  | 'line'
  | 'rect'
  | 'circle'
  | 'arc'
  | 'cog'
  | 'fillet'
  | 'chamfer'
  | 'image'
  | 'measure'
  | 'dimension'
  | 'offset';

/** Transient state for the Measure tool — two picked points in sketch space. */
export interface MeasureState {
  p1: Vec2 | null;
  p2: Vec2 | null;
}

/** Transient state for the Dimension tool while the user is placing a dim entity. */
export interface DimensionDraft {
  p1: Vec2 | null;
  p2: Vec2 | null;
}

/** Project file metadata (name / description / dates), stored alongside the Doc but outside undo/redo. */
export interface ProjectMeta {
  name: string | null;
  description: string;
  createdAt: string | null;  // ISO timestamp; null until first save
  modifiedAt: string | null; // ISO timestamp; null until first save
}

export const emptyProjectMeta = (): ProjectMeta => ({
  name: null,
  description: '',
  createdAt: null,
  modifiedAt: null,
});

export interface DynamicOp {
  kind: 'move' | 'rotate';
  sketchId: string;
  entityIds: string[];
  startDoc: Doc;
  /** move: grab point; rotate: rotation origin. null = awaiting first canvas click. */
  grabPt: Vec2 | null;
  /** rotate only: atan2 angle (°) at first mouse move after origin set. null until mouse moves. */
  firstAngle: number | null;
}
export type Mode = 'model' | 'sketch' | 'assembly';

/** Transient Assembly-mode state. Joint/link *definitions* live in the Doc
 *  (serialised, undoable); these *values* and selections are transient and
 *  reset to zero whenever the mode is entered or left, so posing a mechanism
 *  never mutates the model. */
export interface AssemblyState {
  /** Current drive value per joint id (degrees or length). Zeroed on enter/exit. */
  jointValues: Record<string, number>;
  selectedJointId: string | null;
  selectedLinkId: string | null;
  selectedPinSlotId: string | null;
  /** Cycle / over-constraint warnings recomputed on link changes. */
  warnings: string[];
}

export interface PendingImage {
  src: string;
  fileName: string;
  naturalWidth: number;
  naturalHeight: number;
}

/** Geometry of imported meshes, keyed by feature id (kept outside React state). */
export const importCache = new Map<string, THREE.BufferGeometry>();

export interface DimPrompt {
  x: number;
  y: number;
  label: string;
  initial: string;
  onCommit: (text: string) => void;
  onCancel?: () => void;
}

interface State {
  doc: Doc;
  past: Doc[];
  future: Doc[];

  mode: Mode;
  activeSketchId: string | null;
  tool: Tool;
  construction: boolean;
  /** Whether construction entities are rendered in the viewport. Persisted per
   *  store instance — independent of the per-entity `construction` flag. */
  showConstruction: boolean;
  selectedFeatureId: string | null;
  selectedEntityId: string | null;   // null when 0 or >1 entities selected
  selectedEntityIds: string[];        // ground truth for multi-select
  gizmoMode: 'translate' | 'rotate' | null;
  dimPrompt: DimPrompt | null;
  /** Active "pick faces to extrude" session. `editId` is set when re-selecting
   *  the profile of an existing extrude (otherwise Accept creates a new one). */
  facePick: { sketchId: string; pts: { x: number; y: number }[]; editId?: string } | null;
  /** Active "merge two objects" session. */
  mergePick: { firstId: string; secondId: string | null } | null;
  /** Waiting for the user to click a 3D face to create a sketch on it. */
  faceSketchMode: boolean;
  /** Image data waiting to be placed in the sketch (set by toolbar file-picker). */
  pendingImage: PendingImage | null;
  /** Active dynamic move or rotate operation. Cleared on confirm/cancel. */
  dynamicOp: DynamicOp | null;

  /** Transient Measure-tool picks. Active only while tool === 'measure'. */
  measureState: MeasureState;
  /** Transient Dimension-tool picks while placing a new dimension entity. */
  dimensionDraft: DimensionDraft;

  /** Project file metadata (name, description, dates). Outside undo history. */
  projectMeta: ProjectMeta;
  /** Whether the doc has unsaved changes since the last save / load / new. */
  dirty: boolean;

  /** Transient Assembly-mode drive values + selection + warnings. */
  assembly: AssemblyState;

  /** Viewport projection. Orthographic makes parallel sketch planes line up
   *  (no perspective parallax); perspective is the default 3D view. */
  orthographic: boolean;
  toggleProjection: () => void;

  setDoc: (doc: Doc, undoable?: boolean) => void;
  undo: () => void;
  redo: () => void;
  newProject: () => void;
  /** Push a pre-edit snapshot onto the undo stack (used after transient live edits like dragging). */
  endTransient: (prev: Doc) => void;
  /** Replace the project metadata (e.g. after Save / Save As / Open). */
  setProjectMeta: (meta: ProjectMeta) => void;
  /** Mark the document as having no unsaved changes (call after save). */
  markClean: () => void;

  addFeature: (f: Feature, select?: boolean) => void;
  updateFeature: (id: string, fn: (f: Feature) => Feature, undoable?: boolean) => void;
  deleteFeature: (id: string) => void;

  // ── Features-panel category tree (presentation only) ──────────────────────
  addCategory: (name: string) => void;
  updateCategory: (id: string, fn: (c: FeatureCategory) => FeatureCategory) => void;
  removeCategory: (id: string) => void;
  /** Move a feature or category to a target position: into `intoCategoryId`
   *  (or root when null), before `beforeId` (or at the end when null). */
  moveTreeItem: (dragId: string, intoCategoryId: string | null, beforeId: string | null) => void;

  setParameters: (parameters: Parameter[]) => void;
  setGrid: (gridSize: number) => void;
  setSnap: (snap: SnapMode) => void;

  enterSketch: (id: string) => void;
  exitSketch: () => void;
  setTool: (tool: Tool) => void;
  setConstruction: (v: boolean) => void;
  setShowConstruction: (v: boolean) => void;
  select: (featureId: string | null, entityId?: string | null) => void;
  selectEntities: (featureId: string | null, ids: string[]) => void;
  setGizmoMode: (v: 'translate' | 'rotate' | null) => void;
  setDimPrompt: (p: DimPrompt | null) => void;
  startFacePick: (sketchId: string, editId?: string, pts?: { x: number; y: number }[]) => void;
  setFacePickPts: (pts: { x: number; y: number }[]) => void;
  cancelFacePick: () => void;
  startMergePick: (firstId: string) => void;
  setMergeSecond: (id: string | null) => void;
  cancelMergePick: () => void;
  startFaceSketchMode: () => void;
  cancelFaceSketchMode: () => void;
  setPendingImage: (img: PendingImage | null) => void;
  setDynamicOp: (op: DynamicOp | null) => void;
  setMeasure: (m: MeasureState) => void;
  setDimensionDraft: (d: DimensionDraft) => void;

  // ── Assembly mode ──────────────────────────────────────────────────────
  /** Enter Assembly mode: freeze the model, zero all joint values. */
  enterAssembly: () => void;
  /** Leave Assembly mode: drop drive values so every body snaps home. */
  exitAssembly: () => void;
  addJoint: (j: Joint, select?: boolean) => void;
  updateJoint: (id: string, fn: (j: Joint) => Joint) => void;
  removeJoint: (id: string) => void;
  addLink: (l: Link, select?: boolean) => void;
  updateLink: (id: string, fn: (l: Link) => Link) => void;
  removeLink: (id: string) => void;
  addPinSlot: (ps: PinSlotJoint, select?: boolean) => void;
  updatePinSlot: (id: string, fn: (ps: PinSlotJoint) => PinSlotJoint) => void;
  removePinSlot: (id: string) => void;
  selectJoint: (id: string | null) => void;
  selectLink: (id: string | null) => void;
  selectPinSlot: (id: string | null) => void;
  /** Drive a joint to `value`, clamped and propagated across links. */
  setJointValue: (jointId: string, value: number) => void;
}

/** Build a number-evaluator over a doc's parameters (for joint limit / ratio
 *  expressions). */
function makeEvalNum(doc: Doc): (expr: string) => number | null {
  const { values } = resolveParameters(doc.parameters);
  return (expr: string) => tryEval(expr, values);
}

export const useStore = create<State>((set, get) => ({
  doc: emptyDoc(),
  past: [],
  future: [],

  mode: 'model',
  activeSketchId: null,
  tool: 'select',
  construction: false,
  showConstruction: true,
  selectedFeatureId: null,
  selectedEntityId: null,
  selectedEntityIds: [],
  gizmoMode: null,
  dimPrompt: null,
  facePick: null,
  mergePick: null,
  faceSketchMode: false,
  pendingImage: null,
  dynamicOp: null,

  measureState: { p1: null, p2: null },
  dimensionDraft: { p1: null, p2: null },

  projectMeta: emptyProjectMeta(),
  dirty: false,

  assembly: { jointValues: {}, selectedJointId: null, selectedLinkId: null, selectedPinSlotId: null, warnings: [] },

  orthographic: false,
  toggleProjection() {
    set((s) => ({ orthographic: !s.orthographic }));
  },

  setDoc(doc, undoable = true) {
    set((s) => ({
      doc,
      past: undoable ? [...s.past.slice(-49), s.doc] : s.past,
      future: undoable ? [] : s.future,
      dirty: undoable ? true : s.dirty,
    }));
  },

  undo() {
    const { past, doc, future } = get();
    if (!past.length) return;
    set({
      doc: past[past.length - 1],
      past: past.slice(0, -1),
      future: [doc, ...future].slice(0, 50),
      dirty: true,
    });
  },

  redo() {
    const { past, doc, future } = get();
    if (!future.length) return;
    set({
      doc: future[0],
      future: future.slice(1),
      past: [...past.slice(-49), doc],
      dirty: true,
    });
  },

  newProject() {
    importCache.clear();
    set({
      doc: emptyDoc(),
      past: [],
      future: [],
      mode: 'model',
      activeSketchId: null,
      selectedFeatureId: null,
      selectedEntityId: null,
      selectedEntityIds: [],
      tool: 'select',
      gizmoMode: null,
      facePick: null,
      mergePick: null,
      faceSketchMode: false,
      dimPrompt: null,
      projectMeta: emptyProjectMeta(),
      dirty: false,
      assembly: { jointValues: {}, selectedJointId: null, selectedLinkId: null, selectedPinSlotId: null, warnings: [] },
    });
  },

  setProjectMeta(meta) {
    set({ projectMeta: meta });
  },

  markClean() {
    set({ dirty: false });
  },

  addFeature(f, select = true) {
    const d = get().doc;
    get().setDoc({ ...d, features: [...d.features, f] });
    if (select) set({ selectedFeatureId: f.id, selectedEntityId: null });
  },

  updateFeature(id, fn, undoable = true) {
    const d = get().doc;
    get().setDoc({ ...d, features: d.features.map((f) => (f.id === id ? fn(f) : f)) }, undoable);
  },

  endTransient(prev) {
    set((s) => ({ past: [...s.past.slice(-49), prev], future: [] }));
  },

  addCategory(name) {
    const d = get().doc;
    const { categories, rootOrder } = featureTree(d);
    const id = `cat_${uid()}`;
    get().setDoc({
      ...d,
      categories: [...categories, { id, name, collapsed: false, children: [] }],
      rootOrder: [...rootOrder, id],
    });
  },

  updateCategory(id, fn) {
    const d = get().doc;
    get().setDoc({ ...d, categories: (d.categories ?? []).map((c) => (c.id === id ? fn(c) : c)) }, false);
  },

  removeCategory(id) {
    const d = get().doc;
    const { categories, rootOrder } = featureTree(d);
    const cat = categories.find((c) => c.id === id);
    if (!cat) return;
    const idx = rootOrder.indexOf(id);
    const newRoot = [...rootOrder];
    // replace the category in the root order with its (now ungrouped) children
    if (idx >= 0) newRoot.splice(idx, 1, ...cat.children);
    get().setDoc({ ...d, categories: categories.filter((c) => c.id !== id), rootOrder: newRoot });
  },

  moveTreeItem(dragId, intoCategoryId, beforeId) {
    const d = get().doc;
    const { categories, rootOrder } = featureTree(d);
    const isCat = categories.some((c) => c.id === dragId);
    if (isCat && intoCategoryId) return; // categories live only at root
    // remove the dragged id from wherever it is
    let root = rootOrder.filter((rid) => rid !== dragId);
    const cats = categories.map((c) => ({ ...c, children: c.children.filter((fid) => fid !== dragId) }));
    if (intoCategoryId) {
      const c = cats.find((x) => x.id === intoCategoryId);
      if (!c) return;
      const at = beforeId ? c.children.indexOf(beforeId) : -1;
      if (at >= 0) c.children.splice(at, 0, dragId);
      else c.children.push(dragId);
    } else {
      const at = beforeId ? root.indexOf(beforeId) : -1;
      if (at >= 0) root.splice(at, 0, dragId);
      else root.push(dragId);
    }
    get().setDoc({ ...d, categories: cats, rootOrder: root });
  },

  deleteFeature(id) {
    const d = get().doc;
    const dead = collectDead(d, id);
    // Drop joints on any deleted body, and links referencing those joints.
    const deadJoints = new Set(d.joints.filter((j) => dead.has(j.featureId)).map((j) => j.id));
    get().setDoc({
      ...d,
      features: d.features.filter((f) => !dead.has(f.id)),
      joints: d.joints.filter((j) => !deadJoints.has(j.id)),
      links: d.links.filter((l) => !deadJoints.has(l.driverJointId) && !deadJoints.has(l.drivenJointId)),
      // drop pin-slots whose slot or pin body was deleted
      pinSlots: (d.pinSlots ?? []).filter((ps) => !dead.has(ps.slotFeatureId) && !dead.has(ps.pinFeatureId)),
      // strip deleted features from the panel tree
      categories: (d.categories ?? []).map((c) => ({ ...c, children: c.children.filter((fid) => !dead.has(fid)) })),
      rootOrder: (d.rootOrder ?? []).filter((rid) => !dead.has(rid)),
    });
    for (const k of dead) importCache.delete(k);
    set((s) => ({
      selectedFeatureId: s.selectedFeatureId && dead.has(s.selectedFeatureId) ? null : s.selectedFeatureId,
      selectedEntityId: null,
      activeSketchId: s.activeSketchId && dead.has(s.activeSketchId) ? null : s.activeSketchId,
      mode: s.activeSketchId && dead.has(s.activeSketchId) ? 'model' : s.mode,
    }));
  },

  setParameters(parameters) {
    get().setDoc({ ...get().doc, parameters });
  },

  setGrid(gridSize) {
    if (gridSize > 0) get().setDoc({ ...get().doc, gridSize }, false);
  },

  setSnap(snap) {
    get().setDoc({ ...get().doc, snap }, false);
  },

  enterSketch(id) {
    // New (empty) sketches default to the Line tool so the user can start
    // drawing immediately; existing sketches default to Select so they don't
    // get unintended entities tacked on while inspecting / editing.
    const sketch = get().doc.features.find((f) => f.id === id && f.type === 'sketch');
    const hasEntities =
      !!sketch &&
      sketch.type === 'sketch' &&
      sketch.entities.length > 0;
    set({
      mode: 'sketch',
      activeSketchId: id,
      tool: hasEntities ? 'select' : 'line',
      selectedFeatureId: id,
      selectedEntityId: null,
      gizmoMode: null,
      dimPrompt: null,
      facePick: null,
      mergePick: null,
      faceSketchMode: false,
    });
  },

  exitSketch() {
    set({ mode: 'model', activeSketchId: null, tool: 'select', selectedEntityId: null, selectedEntityIds: [], dimPrompt: null, facePick: null });
  },

  setTool(tool) {
    set({
      tool,
      selectedEntityId: null,
      selectedEntityIds: [],
      dimPrompt: null,
      ...(tool !== 'image' ? { pendingImage: null } : {}),
      ...(tool !== 'measure' ? { measureState: { p1: null, p2: null } } : {}),
      ...(tool !== 'dimension' ? { dimensionDraft: { p1: null, p2: null } } : {}),
    });
  },

  setConstruction(construction) {
    set({ construction });
  },

  setShowConstruction(showConstruction) {
    set({ showConstruction });
  },

  select(featureId, entityId = null) {
    set({
      selectedFeatureId: featureId,
      selectedEntityId: entityId,
      selectedEntityIds: entityId ? [entityId] : [],
    });
  },

  selectEntities(featureId, ids) {
    set({
      selectedFeatureId: featureId,
      selectedEntityId: ids.length === 1 ? ids[0] : null,
      selectedEntityIds: ids,
    });
  },

  setGizmoMode(gizmoMode) {
    set({ gizmoMode });
  },

  setDimPrompt(dimPrompt) {
    set({ dimPrompt });
  },

  startFacePick(sketchId, editId, pts = []) {
    set({ facePick: { sketchId, pts, editId }, dimPrompt: null, selectedEntityId: null });
  },

  setFacePickPts(pts) {
    set((s) => (s.facePick ? { facePick: { ...s.facePick, pts } } : {}));
  },

  cancelFacePick() {
    set({ facePick: null });
  },

  startMergePick(firstId) {
    set({ mergePick: { firstId, secondId: null }, gizmoMode: null, dimPrompt: null });
  },

  setMergeSecond(secondId) {
    set((s) => (s.mergePick ? { mergePick: { ...s.mergePick, secondId } } : {}));
  },

  cancelMergePick() {
    set({ mergePick: null });
  },

  startFaceSketchMode() {
    set({ faceSketchMode: true, gizmoMode: null, dimPrompt: null, mergePick: null });
  },

  cancelFaceSketchMode() {
    set({ faceSketchMode: false });
  },

  setPendingImage(img) {
    set({ pendingImage: img });
  },
  setDynamicOp(op) {
    set({ dynamicOp: op });
  },
  setMeasure(m) {
    set({ measureState: m });
  },
  setDimensionDraft(d) {
    set({ dimensionDraft: d });
  },

  // ── Assembly mode ────────────────────────────────────────────────────────
  enterAssembly() {
    const s = get();
    if (s.mode === 'sketch') s.exitSketch();
    set({
      mode: 'assembly',
      gizmoMode: null,
      facePick: null,
      mergePick: null,
      faceSketchMode: false,
      dimPrompt: null,
      assembly: {
        jointValues: {},
        selectedJointId: s.doc.joints[0]?.id ?? null,
        selectedLinkId: null,
        selectedPinSlotId: null,
        warnings: cycleWarnings(s.doc.joints, s.doc.links),
      },
    });
  },

  exitAssembly() {
    set({
      mode: 'model',
      assembly: { jointValues: {}, selectedJointId: null, selectedLinkId: null, selectedPinSlotId: null, warnings: [] },
    });
  },

  addJoint(j, select = true) {
    const d = get().doc;
    get().setDoc({ ...d, joints: [...d.joints, j] });
    set((s) => ({
      assembly: {
        ...s.assembly,
        selectedJointId: select ? j.id : s.assembly.selectedJointId,
        selectedLinkId: null,
        warnings: cycleWarnings(get().doc.joints, get().doc.links),
      },
    }));
  },

  updateJoint(id, fn) {
    const d = get().doc;
    get().setDoc({ ...d, joints: d.joints.map((j) => (j.id === id ? fn(j) : j)) });
    set((s) => ({ assembly: { ...s.assembly, warnings: cycleWarnings(get().doc.joints, get().doc.links) } }));
  },

  removeJoint(id) {
    const d = get().doc;
    get().setDoc({
      ...d,
      joints: d.joints.filter((j) => j.id !== id),
      // drop any link that referenced the removed joint
      links: d.links.filter((l) => l.driverJointId !== id && l.drivenJointId !== id),
    });
    set((s) => {
      const { [id]: _drop, ...rest } = s.assembly.jointValues;
      return {
        assembly: {
          ...s.assembly,
          jointValues: rest,
          selectedJointId: s.assembly.selectedJointId === id ? null : s.assembly.selectedJointId,
          warnings: cycleWarnings(get().doc.joints, get().doc.links),
        },
      };
    });
  },

  addLink(l, select = true) {
    const d = get().doc;
    get().setDoc({ ...d, links: [...d.links, l] });
    set((s) => ({
      assembly: {
        ...s.assembly,
        selectedLinkId: select ? l.id : s.assembly.selectedLinkId,
        warnings: cycleWarnings(get().doc.joints, get().doc.links),
      },
    }));
  },

  updateLink(id, fn) {
    const d = get().doc;
    get().setDoc({ ...d, links: d.links.map((l) => (l.id === id ? fn(l) : l)) });
    set((s) => ({ assembly: { ...s.assembly, warnings: cycleWarnings(get().doc.joints, get().doc.links) } }));
  },

  removeLink(id) {
    const d = get().doc;
    get().setDoc({ ...d, links: d.links.filter((l) => l.id !== id) });
    set((s) => ({
      assembly: {
        ...s.assembly,
        selectedLinkId: s.assembly.selectedLinkId === id ? null : s.assembly.selectedLinkId,
        warnings: cycleWarnings(get().doc.joints, get().doc.links),
      },
    }));
  },

  addPinSlot(ps, select = true) {
    const d = get().doc;
    get().setDoc({ ...d, pinSlots: [...(d.pinSlots ?? []), ps] });
    if (select) set((s) => ({ assembly: { ...s.assembly, selectedPinSlotId: ps.id, selectedJointId: null, selectedLinkId: null } }));
  },

  updatePinSlot(id, fn) {
    const d = get().doc;
    get().setDoc({ ...d, pinSlots: (d.pinSlots ?? []).map((ps) => (ps.id === id ? fn(ps) : ps)) });
  },

  removePinSlot(id) {
    const d = get().doc;
    get().setDoc({ ...d, pinSlots: (d.pinSlots ?? []).filter((ps) => ps.id !== id) });
    set((s) => ({
      assembly: { ...s.assembly, selectedPinSlotId: s.assembly.selectedPinSlotId === id ? null : s.assembly.selectedPinSlotId },
    }));
  },

  selectJoint(id) {
    set((s) => ({ assembly: { ...s.assembly, selectedJointId: id, selectedLinkId: null, selectedPinSlotId: null } }));
  },

  selectLink(id) {
    set((s) => ({ assembly: { ...s.assembly, selectedLinkId: id, selectedJointId: null, selectedPinSlotId: null } }));
  },

  selectPinSlot(id) {
    set((s) => ({ assembly: { ...s.assembly, selectedPinSlotId: id, selectedJointId: null, selectedLinkId: null } }));
  },

  setJointValue(jointId, value) {
    const d = get().doc;
    const evalNum = makeEvalNum(d);
    const propagated = propagate(jointId, value, d.joints, d.links, evalNum);
    const candidate = { ...get().assembly.jointValues, ...propagated };
    // Closed-loop bodies (pin-slot) are solved, not ratio-driven. If solving the
    // loop at the candidate values fails (no solution / pin left the slot), this
    // drive step is infeasible — clamp-and-stop by leaving state unchanged.
    if ((d.pinSlots ?? []).length > 0) {
      const res = solveBodyTransforms(d, candidate, evalNum);
      if (!res.feasible) return;
      Object.assign(candidate, res.solvedValues);
    }
    set((s) => ({ assembly: { ...s.assembly, jointValues: candidate } }));
  },
}));

/**
 * Reconcile the stored panel tree against the live features into a clean
 * presentation tree: drops ids that no longer exist, de-dupes, ensures every
 * category appears at root, and appends any ungrouped/new features at the end so
 * the panel always shows everything regardless of how features were added.
 */
export function featureTree(doc: Doc): { categories: FeatureCategory[]; rootOrder: string[] } {
  const featureIds = new Set(doc.features.map((f) => f.id));
  const cats = (doc.categories ?? []).map((c) => ({
    ...c,
    children: c.children.filter((id) => featureIds.has(id)),
  }));
  const catIds = new Set(cats.map((c) => c.id));
  const inCat = new Set<string>();
  for (const c of cats) for (const id of c.children) inCat.add(id);

  let root = (doc.rootOrder ?? []).filter(
    (id) => catIds.has(id) || (featureIds.has(id) && !inCat.has(id)),
  );
  root = root.filter((id, i) => root.indexOf(id) === i); // de-dupe
  for (const c of cats) if (!root.includes(c.id)) root.push(c.id);
  for (const f of doc.features) if (!inCat.has(f.id) && !root.includes(f.id)) root.push(f.id);
  return { categories: cats, rootOrder: root };
}

/** A feature plus everything that (transitively) depends on it. */
export function collectDead(doc: Doc, id: string): Set<string> {
  const dead = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of doc.features) {
      if (dead.has(f.id)) continue;
      if (
        (f.type === 'extrude' && dead.has(f.sketchId)) ||
        (f.type === 'boolean' && (dead.has(f.targetId) || dead.has(f.toolId)))
      ) {
        dead.add(f.id);
        changed = true;
      }
    }
  }
  return dead;
}

export function activeSketch(s: { doc: Doc; activeSketchId: string | null }): SketchFeature | null {
  if (!s.activeSketchId) return null;
  const f = s.doc.features.find((f) => f.id === s.activeSketchId);
  return f && f.type === 'sketch' ? f : null;
}

/** Delete a feature after user confirmation (lists dependent features that go with it). */
export function confirmDeleteFeature(id: string) {
  const s = useStore.getState();
  const f = s.doc.features.find((x) => x.id === id);
  if (!f) return;
  const dead = collectDead(s.doc, id);
  const dependents = s.doc.features.filter((x) => x.id !== id && dead.has(x.id));
  let msg = `Delete "${f.name}"?`;
  if (dependents.length) {
    msg += `\n\nThis will also delete: ${dependents.map((d) => `"${d.name}"`).join(', ')}.`;
  }
  if (window.confirm(msg)) s.deleteFeature(id);
}

export function nextName(doc: Doc, prefix: string): string {
  let n = 1;
  const names = new Set(doc.features.map((f) => f.name));
  while (names.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

export { uid };
