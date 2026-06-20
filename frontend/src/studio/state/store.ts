import { create } from 'zustand';
import * as THREE from 'three';
import { emptyDoc, uid, type Doc, type Feature, type Parameter, type SketchFeature, type SnapMode, type Vec2 } from '../types';

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
export type Mode = 'model' | 'sketch';

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
  /** Active "pick faces to extrude" session. */
  facePick: { sketchId: string; pts: { x: number; y: number }[] } | null;
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
  startFacePick: (sketchId: string) => void;
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

  deleteFeature(id) {
    const d = get().doc;
    const dead = collectDead(d, id);
    get().setDoc({ ...d, features: d.features.filter((f) => !dead.has(f.id)) });
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

  startFacePick(sketchId) {
    set({ facePick: { sketchId, pts: [] }, dimPrompt: null, selectedEntityId: null });
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
}));

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
