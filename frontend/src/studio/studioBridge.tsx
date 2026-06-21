/**
 * studioBridge — glue between the ported Parametric-3D engine (Zustand store)
 * and the MDI shell. Provides:
 *   • useRegen()        – memoised geometry regeneration shared by all panels
 *   • studio commands   – the imperative operations the old Toolbar performed,
 *                         re-expressed as plain functions driven by the store
 *   • file-input bridge – hidden <input> elements + triggers, since the MDI
 *                         toolbar is JSON/action driven and cannot host inputs
 *
 * NOTE: none of the files under studio/ (other than this bridge) are modified
 * from the original project — this layer wraps them.
 */
import { useRef } from 'react';
import * as THREE from 'three';
import { regenerate } from './core/buildGeometry';
import { importCache, nextName, useStore, type PendingImage, type ProjectMeta } from './state/store';
import { linkKind, teethRatio } from './core/assembly';
import * as dialogService from '../utils/dialogService';
import { actionRegistry } from '../utils/actionRegistry';
import {
  BODY_COLORS,
  PRIMITIVE_DEFAULTS,
  uid,
  type BooleanFeature,
  type Doc,
  type ExtrudeFeature,
  type ImportFeature,
  type Joint,
  type JointType,
  type Link,
  type MergeOp,
  type PinSlotJoint,
  type PlaneId,
  type PrimitiveFeature,
  type PrimitiveShape,
  type SketchFeature,
  type Vec3,
} from './types';
import { exportSTL, loadProject, saveProject } from './io/exporters';
import { IMPORT_EXTENSIONS, importModelFile } from './io/importers';

type RegenResult = ReturnType<typeof regenerate>;

// ── Shared regeneration ────────────────────────────────────────────────────
// regenerate() is moderately expensive, so we memoise on the doc identity at
// module scope. All three panels (features / canvas / info) call useRegen and
// re-render together when the doc changes, so the first caller computes and the
// rest hit the cache.

let _doc: Doc | null = null;
let _regen: RegenResult | null = null;
let _rev = 0;

export function useRegen(): { regen: RegenResult; rev: number } {
  const doc = useStore((s) => s.doc);
  if (doc !== _doc) {
    _doc = doc;
    _rev += 1;
    _regen = regenerate(doc, importCache);
  }
  return { regen: _regen as RegenResult, rev: _rev };
}

// ── Body-colour rotation (matches old Toolbar) ─────────────────────────────
let colorIdx = 0;
const nextColor = () => BODY_COLORS[colorIdx++ % BODY_COLORS.length];

// ── Commands (formerly Toolbar button handlers) ────────────────────────────

/** Reset all transient UI state and return to the default 3D model view. */
function resetToModelMode() {
  const s = useStore.getState();
  if (s.mode === 'sketch') s.exitSketch();
  s.cancelMergePick();
  s.cancelFaceSketchMode();
  s.cancelFacePick();
  s.setGizmoMode(null);
  s.setPendingImage(null);
  s.setDynamicOp(null);
  s.select(null);
}

/** Slugify a project name into a safe file name. */
function projectFileName(name: string | null | undefined): string {
  const safe = (name ?? '').trim().replace(/[^a-z0-9_\- ]+/gi, '').replace(/\s+/g, '_');
  return `${safe || 'project'}.cad.json`;
}

/**
 * Open the Save Project dialog (name + description). Calls `onSave` with the
 * collected meta on confirm. `prefill` becomes the initial form state.
 * Returns immediately; the dialog drives the rest of the flow.
 */
function openSaveProjectDialog(
  isSaveAs: boolean,
  prefill: ProjectMeta,
  onSave: (next: { name: string; description: string }) => void,
) {
  actionRegistry.invoke('studio:_openSaveModal', {
    title: isSaveAs ? 'Save Project As' : 'Save Project',
    props: {
      name: prefill.name ?? '',
      description: prefill.description ?? '',
      createdAt: prefill.createdAt ?? null,
      onSave,
    },
  });
}

/**
 * Save the current project. First save (or no name) → prompt for name/description;
 * subsequent saves update the modifiedAt date and reuse the stored name.
 */
export function saveProjectCmd() {
  const s = useStore.getState();
  const meta = s.projectMeta;
  const doSave = (next: { name: string; description: string }) => {
    const now = new Date().toISOString();
    const updated: ProjectMeta = {
      projectId: meta.projectId,
      name: next.name.trim(),
      description: next.description,
      createdAt: meta.createdAt ?? now,
      modifiedAt: now,
      defaultRootId: meta.defaultRootId,
    };
    saveProject(useStore.getState().doc, projectFileName(updated.name), updated);
    useStore.getState().setProjectMeta(updated);
    useStore.getState().markClean();
  };
  if (!meta.name) {
    openSaveProjectDialog(false, meta, doSave);
    return;
  }
  // Quick save: update modifiedAt and write to disk with the existing name.
  doSave({ name: meta.name, description: meta.description });
}

/** Always prompt with the stored details pre-filled, then save under a (possibly new) name. */
export function saveProjectAsCmd() {
  const s = useStore.getState();
  const meta = s.projectMeta;
  openSaveProjectDialog(true, meta, (next) => {
    const now = new Date().toISOString();
    const updated: ProjectMeta = {
      projectId: meta.projectId,
      name: next.name.trim(),
      description: next.description,
      createdAt: meta.createdAt ?? now,
      modifiedAt: now,
      defaultRootId: meta.defaultRootId,
    };
    saveProject(useStore.getState().doc, projectFileName(updated.name), updated);
    useStore.getState().setProjectMeta(updated);
    useStore.getState().markClean();
  });
}

/**
 * Open the Project Details editor — a tabbed dialog. The General tab edits the
 * stored `projectMeta` in place (project id, name, description; no file write),
 * the VFS Roots tab manages the VFS roots for this project's id. Name starts
 * blank for an unsaved project. General edits mark the doc dirty so the change
 * is reflected in the title bar and captured on the next save.
 */
export function projectDetailsCmd() {
  actionRegistry.invoke('studio:_openProjectDetails');
}

/**
 * Open the Application Settings dialog. Currently hosts the VFS connection
 * settings (server address + application id) with a live Test Connection probe.
 */
export function appSettingsCmd() {
  actionRegistry.invoke('studio:_openAppSettings');
}

/** Confirm Save / Discard / Cancel when there are unsaved changes; calls `proceed` if it's safe to continue. */
function confirmDiscardIfDirty(intent: 'new project' | 'open project', proceed: () => void) {
  const s = useStore.getState();
  if (!s.dirty) { proceed(); return; }
  dialogService.showConfirm({
    title: 'Unsaved Changes',
    message: `You have unsaved changes. Save before starting a ${intent}?`,
    mode: 'question',
    buttons: 'yes-no-cancel',
    onResult: (r) => {
      if (r.button === 'Yes') {
        // Save first, then continue once the user has named the file.
        const meta = useStore.getState().projectMeta;
        const doSaveAndProceed = (next: { name: string; description: string }) => {
          const now = new Date().toISOString();
          const updated: ProjectMeta = {
            projectId: meta.projectId,
            name: next.name.trim(),
            description: next.description,
            createdAt: meta.createdAt ?? now,
            modifiedAt: now,
            defaultRootId: meta.defaultRootId,
          };
          saveProject(useStore.getState().doc, projectFileName(updated.name), updated);
          useStore.getState().setProjectMeta(updated);
          useStore.getState().markClean();
          proceed();
        };
        if (!meta.name) {
          openSaveProjectDialog(false, meta, doSaveAndProceed);
        } else {
          doSaveAndProceed({ name: meta.name, description: meta.description });
        }
      } else if (r.button === 'No') {
        proceed();
      }
      // Cancel: do nothing
    },
  });
}

export function newProjectCmd() {
  confirmDiscardIfDirty('new project', () => {
    resetToModelMode();
    useStore.getState().newProject();
  });
}

/** Internal — called by the file input's onChange handler in StudioFileInputs. */
export function openProjectCmd() {
  confirmDiscardIfDirty('open project', () => {
    fileTriggers.openProject?.();
  });
}

export function undoCmd() {
  useStore.getState().undo();
}
export function redoCmd() {
  useStore.getState().redo();
}

export function newSketch(plane: PlaneId) {
  const s = useStore.getState();
  const f: SketchFeature = {
    id: uid(),
    type: 'sketch',
    name: nextName(s.doc, 'Sketch'),
    visible: true,
    plane,
    offset: '0',
    entities: [],
    corners: [],
  };
  s.addFeature(f);
  s.enterSketch(f.id);
}

export function startFaceSketch() {
  useStore.getState().startFaceSketchMode();
}

// Friendly default names for the auto-generated `name` field. Primitives whose
// camelCase identifier doesn't read well as a UI label get an override here.
const NAME_PREFIX: Partial<Record<PrimitiveShape, string>> = {
  bulbScrew: 'Bulb',
  bulbSocket: 'Socket',
  screwThread: 'Screw',
  nutThread: 'Nut',
};

export function addPrimitive(shape: PrimitiveShape) {
  const s = useStore.getState();
  const def = PRIMITIVE_DEFAULTS[shape];
  const baseName = NAME_PREFIX[shape] ?? shape[0].toUpperCase() + shape.slice(1);
  const f: PrimitiveFeature = {
    id: uid(),
    type: 'primitive',
    name: nextName(s.doc, baseName),
    visible: true,
    shape,
    dims: { ...def.dims },
    position: ['0', def.y, '0'],
    rotation: ['0', '0', '0'],
    op: 'new',
    color: shape === 'bulbScrew' ? '#bcb8a8' : nextColor(),
    // bulbScrew renders the glass envelope in this colour, leaving `color`
    // for the metal cap + contact. Seeded as a warm bulb-white.
    ...(shape === 'bulbScrew' ? { secondaryColor: '#f4e6a8' } : {}),
  };
  s.addFeature(f);
}

function sketchForExtrude(s = useStore.getState()): string | null {
  const selected = s.doc.features.find((f) => f.id === s.selectedFeatureId);
  return s.mode === 'sketch'
    ? s.activeSketchId
    : selected?.type === 'sketch'
      ? selected.id
      : null;
}

export function startExtrude() {
  const s = useStore.getState();
  const sk = sketchForExtrude(s);
  if (!sk) return;
  if (s.mode !== 'sketch') s.enterSketch(sk);
  s.startFacePick(sk);
}

/** Re-enter face-pick for an existing extrude so its profile selection can be
 *  repaired / changed (e.g. after loading a file whose `regionPts` went stale
 *  from a move made before region-tracking existed). */
export function reselectExtrudeFaces(extrudeId: string) {
  const s = useStore.getState();
  const ex = s.doc.features.find((f) => f.id === extrudeId);
  if (!ex || ex.type !== 'extrude') return;
  if (s.mode !== 'sketch' || s.activeSketchId !== ex.sketchId) s.enterSketch(ex.sketchId);
  s.startFacePick(ex.sketchId, extrudeId, ex.regionPts ?? []);
}

/** Clear an extrude's saved profile selection so it extrudes all top-level
 *  closed profiles (`defaultRegions`, which excludes hole interiors). The
 *  quickest repair for a single-shape sketch. */
export function resetExtrudeProfiles(extrudeId: string) {
  const s = useStore.getState();
  s.updateFeature(extrudeId, (f) => (f.type === 'extrude' ? { ...f, regionPts: undefined } : f));
}

export function acceptExtrude() {
  const s = useStore.getState();
  const fp = s.facePick;
  if (!fp) return;
  // Re-selecting an existing extrude's profile: update it in place.
  if (fp.editId) {
    const pts = fp.pts.length ? fp.pts : undefined;
    s.cancelFacePick();
    s.exitSketch();
    s.updateFeature(fp.editId, (f) => (f.type === 'extrude' ? { ...f, regionPts: pts } : f));
    s.select(fp.editId);
    return;
  }
  const f: ExtrudeFeature = {
    id: uid(),
    type: 'extrude',
    name: nextName(s.doc, 'Extrude'),
    visible: true,
    sketchId: fp.sketchId,
    distance: '20',
    op: 'new',
    color: nextColor(),
    regionPts: fp.pts.length ? fp.pts : undefined,
  };
  s.cancelFacePick();
  s.exitSketch();
  s.addFeature(f);
}

export function cancelFacePick() {
  useStore.getState().cancelFacePick();
}

export function setTool(tool: Parameters<ReturnType<typeof useStore.getState>['setTool']>[0]) {
  useStore.getState().setTool(tool);
}

export function toggleConstruction() {
  const s = useStore.getState();
  s.setConstruction(!s.construction);
}

export function finishSketch() {
  useStore.getState().exitSketch();
}

export function toggleGizmo(mode: 'translate' | 'rotate') {
  const s = useStore.getState();
  const selected = s.doc.features.find((f) => f.id === s.selectedFeatureId);
  if (!selected || (selected.type !== 'primitive' && selected.type !== 'import')) return;
  s.setGizmoMode(s.gizmoMode === mode ? null : mode);
}

export function startMerge() {
  const s = useStore.getState();
  const selected = s.doc.features.find((f) => f.id === s.selectedFeatureId);
  if (!selected || selected.type === 'sketch') return;
  s.startMergePick(selected.id);
}

export function createMerge(op: MergeOp, swap = false) {
  const s = useStore.getState();
  const mp = s.mergePick;
  if (!mp || !mp.secondId) return;
  const A = s.doc.features.find((f) => f.id === mp.firstId);
  const B = s.doc.features.find((f) => f.id === mp.secondId);
  if (!A || !B) return;
  const f: BooleanFeature = {
    id: uid(),
    type: 'boolean',
    name: nextName(s.doc, 'Merge'),
    visible: true,
    op,
    targetId: swap ? B.id : A.id,
    toolId: swap ? A.id : B.id,
    color: 'color' in A ? (A.color as string) : nextColor(),
    opacity: 'opacity' in A ? (A as { opacity?: number }).opacity : undefined,
  };
  s.cancelMergePick();
  s.addFeature(f);
}

export function cancelMerge() {
  useStore.getState().cancelMergePick();
}
export function cancelFaceSketch() {
  useStore.getState().cancelFaceSketchMode();
}

export function exportStlCmd() {
  try {
    exportSTL(_regen?.bodies ?? []);
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
  }
}

// ── Assembly mode ──────────────────────────────────────────────────────────

/** Sequential "Joint 1" / "Link 1" naming, scoped to joints / links. */
function nextAssemblyName(existing: { name: string }[], prefix: string): string {
  let n = 1;
  const names = new Set(existing.map((e) => e.name));
  while (names.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

/** World-space bounding box of a body (across all its BodyOut pieces). Returns
 *  the centre and the body's thinnest principal direction — a good default
 *  revolute axis for a flat disc / cog (its spin axis). */
function bodyBox(featureId: string): { center: Vec3; thinAxis: Vec3; size: Vec3 } | null {
  const bodies = _regen?.bodies ?? [];
  const pieces = bodies.filter((b) => b.featureId === featureId);
  if (!pieces.length) return null;
  const box = new THREE.Box3();
  for (const b of pieces) {
    b.geometry.computeBoundingBox();
    if (b.geometry.boundingBox) box.union(b.geometry.boundingBox);
  }
  if (box.isEmpty()) return null;
  const c = box.getCenter(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3());
  const thinAxis: Vec3 =
    sz.x <= sz.y && sz.x <= sz.z ? [1, 0, 0] : sz.y <= sz.z ? [0, 1, 0] : [0, 0, 1];
  return { center: [c.x, c.y, c.z], thinAxis, size: [sz.x, sz.y, sz.z] };
}

/** Tooth count of the cog that produced a body (extrude → sketch → cog), if any. */
export function cogTeethForFeature(doc: Doc, featureId: string): number | undefined {
  const f = doc.features.find((x) => x.id === featureId);
  if (!f || f.type !== 'extrude') return undefined;
  const sk = doc.features.find((x) => x.id === f.sketchId);
  if (!sk || sk.type !== 'sketch') return undefined;
  const cog = sk.entities.find((e) => e.kind === 'cog');
  return cog && cog.kind === 'cog' ? cog.teeth : undefined;
}

export function enterAssemblyCmd() {
  resetToModelMode();
  useStore.getState().enterAssembly();
}

export function exitAssemblyCmd() {
  useStore.getState().exitAssembly();
}

export function addJointCmd(type: JointType) {
  const s = useStore.getState();
  if (s.mode !== 'assembly') s.enterAssembly();
  const sel = useStore.getState().doc.features.find((f) => f.id === s.selectedFeatureId);
  if (!sel || sel.type === 'sketch') {
    dialogService.showAlert({
      title: 'Add Joint',
      message: 'Select a body first (click it in the viewport), then add a joint.',
      mode: 'warning',
    });
    return;
  }
  const box = bodyBox(sel.id);
  const origin: Vec3 = box?.center ?? [0, 0, 0];
  const axis: Vec3 = type === 'revolute' ? box?.thinAxis ?? [0, 1, 0] : [1, 0, 0];
  const j: Joint = {
    id: uid(),
    name: nextAssemblyName(useStore.getState().doc.joints, 'Joint'),
    featureId: sel.id,
    type,
    origin,
    axis,
    limits: { mode: 'free' },
  };
  useStore.getState().addJoint(j);
}

export function addLinkCmd() {
  const s = useStore.getState();
  const joints = s.doc.joints;
  if (joints.length < 2) {
    dialogService.showAlert({
      title: 'Add Link',
      message: 'Add at least two joints before linking them.',
      mode: 'warning',
    });
    return;
  }
  const driverId = s.assembly.selectedJointId ?? joints[0].id;
  const driver = joints.find((j) => j.id === driverId) ?? joints[0];
  const driven = joints.find((j) => j.id !== driver.id)!;
  // Auto-derive the ratio from tooth counts when both bodies are cogs.
  const ratioNum = teethRatio(cogTeethForFeature(s.doc, driver.featureId), cogTeethForFeature(s.doc, driven.featureId));
  const l: Link = {
    id: uid(),
    name: nextAssemblyName(s.doc.links, 'Link'),
    driverJointId: driver.id,
    drivenJointId: driven.id,
    kind: linkKind(driver, driven),
    ratio: ratioNum !== null ? String(+ratioNum.toFixed(4)) : '1',
    ratioSource: ratioNum !== null ? 'teeth' : 'manual',
    phase: '0',
  };
  useStore.getState().addLink(l);
}

/** Add a pin-slot joint on the selected body (the slot body). Seeds the slot
 *  endpoints along the body's longest bounding-box axis; the pin body + pin
 *  point and slide limits are configured in the editor afterwards. */
export function addPinSlotCmd() {
  const s = useStore.getState();
  if (s.mode !== 'assembly') s.enterAssembly();
  const sel = useStore.getState().doc.features.find((f) => f.id === s.selectedFeatureId);
  if (!sel || sel.type === 'sketch') {
    dialogService.showAlert({
      title: 'Pin-slot Joint',
      message: 'Select the body that carries the slot (e.g. the leg) first, then add a pin-slot.',
      mode: 'warning',
    });
    return;
  }
  const box = bodyBox(sel.id);
  let slotA: Vec3 = [0, 0, 0];
  let slotB: Vec3 = [0, 0, 0];
  if (box) {
    const { center, size } = box;
    const ax = size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2;
    const half = size[ax] * 0.35;
    slotA = [...center] as Vec3;
    slotB = [...center] as Vec3;
    slotA[ax] -= half;
    slotB[ax] += half;
  }
  const ps: PinSlotJoint = {
    id: uid(),
    name: nextAssemblyName([...s.doc.joints, ...(s.doc.pinSlots ?? [])], 'Pin-slot'),
    type: 'pinslot',
    slotFeatureId: sel.id,
    slotA,
    slotB,
    pinFeatureId: '',
    pin: [0, 0, 0],
    limits: { mode: 'free' },
  };
  useStore.getState().addPinSlot(ps);
}

/** Delete the currently selected joint, link, or pin-slot in Assembly mode. */
export function deleteAssemblyCmd() {
  const s = useStore.getState();
  if (s.assembly.selectedPinSlotId) s.removePinSlot(s.assembly.selectedPinSlotId);
  else if (s.assembly.selectedLinkId) s.removeLink(s.assembly.selectedLinkId);
  else if (s.assembly.selectedJointId) s.removeJoint(s.assembly.selectedJointId);
}

// ── Hidden file inputs ─────────────────────────────────────────────────────
// The MDI toolbar is action driven and cannot render <input type=file>, so we
// host the inputs once (in the Canvas panel) and expose click triggers.

export const fileTriggers: {
  openProject?: () => void;
  importModel?: () => void;
  pickImage?: () => void;
} = {};

export function StudioFileInputs() {
  const projRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);

  fileTriggers.openProject = () => projRef.current?.click();
  fileTriggers.importModel = () => fileRef.current?.click();
  fileTriggers.pickImage = () => imgRef.current?.click();

  const onOpenProject = async (files: FileList | null) => {
    if (!files?.[0]) return;
    const s = useStore.getState();
    try {
      importCache.clear();
      const { doc, meta } = await loadProject(files[0]);
      // Reset UI to default 3D model view before swapping the doc — guarantees
      // we never resume in sketch mode against a doc whose sketch is gone.
      resetToModelMode();
      s.setDoc(doc, false);
      s.setProjectMeta(meta);
      s.markClean();
      s.select(null);
      const missing = doc.features.filter(
        (f) => f.type === 'import' && !(f as ImportFeature).embedded && !importCache.has(f.id),
      );
      if (missing.length) {
        dialogService.showAlert({
          title: 'Open Project',
          message: `${missing.length} imported mesh file${missing.length > 1 ? 's are' : ' is'} not stored in this project — please re-import.`,
          mode: 'warning',
        });
      }
    } catch (e) {
      dialogService.showAlert({
        title: 'Open Failed',
        message: e instanceof Error ? e.message : String(e),
        mode: 'error',
      });
    }
    if (projRef.current) projRef.current.value = '';
  };

  const onImport = async (files: FileList | null) => {
    if (!files) return;
    const s = useStore.getState();
    for (const file of Array.from(files)) {
      try {
        const res = await importModelFile(file);
        const id = uid();
        importCache.set(id, res.geometry);
        const f: ImportFeature = {
          id,
          type: 'import',
          name: file.name,
          visible: true,
          fileName: file.name,
          position: [0, res.groundY, 0],
          rotation: [0, 0, 0],
          scale: 1,
          color: res.color ?? nextColor(),
        };
        s.addFeature(f);
      } catch (e) {
        alert(`Import failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const onPickImage = async (files: FileList | null) => {
    if (!files?.[0]) return;
    const s = useStore.getState();
    const file = files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      const img = new Image();
      img.onload = () => {
        const pending: PendingImage = {
          src,
          fileName: file.name,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        };
        s.setPendingImage(pending);
        s.setTool('image');
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
    if (imgRef.current) imgRef.current.value = '';
  };

  return (
    <>
      <input
        ref={projRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={(e) => onOpenProject(e.target.files)}
      />
      <input
        ref={fileRef}
        type="file"
        accept={IMPORT_EXTENSIONS.join(',')}
        multiple
        style={{ display: 'none' }}
        onChange={(e) => onImport(e.target.files)}
      />
      <input
        ref={imgRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => onPickImage(e.target.files)}
      />
    </>
  );
}
