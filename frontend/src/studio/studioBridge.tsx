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
import { importCache, nextName, newProjectId, useStore, type PendingImage, type ProjectMeta } from './state/store';
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
import { exportSTL, loadProject, saveProject, serializeProject } from './io/exporters';
import { isVfsConfigured, listProjectRoots, writeProjectFile, VfsApiError } from '../vfs/vfsAdmin';
import { fetchFileText, fetchFileBlob } from '../vfs/vfsApi';
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
  primaryLabel = 'Save',
) {
  actionRegistry.invoke('studio:_openSaveModal', {
    title: isSaveAs ? 'Save Project As' : 'Save Project',
    primaryLabel,
    props: {
      name: prefill.name ?? '',
      description: prefill.description ?? '',
      createdAt: prefill.createdAt ?? null,
      onSave,
    },
  });
}

/**
 * Download the current project as a local `.cad.json` file. First save (or no
 * name) → prompt for name/description; subsequent saves update modifiedAt and
 * reuse the stored name. (This is the original "Save" behaviour, now exposed via
 * File ▸ Download.)
 */
export function downloadProjectCmd() {
  const s = useStore.getState();
  const meta = s.projectMeta;
  const doSave = (next: { name: string; description: string }) => {
    const now = new Date().toISOString();
    const updated: ProjectMeta = {
      ...meta,
      name: next.name.trim(),
      description: next.description,
      createdAt: meta.createdAt ?? now,
      modifiedAt: now,
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

/**
 * Save the current project. If it already has a known VFS location (opened or
 * previously Saved-As), write back over that file. Otherwise — a new project
 * with no location yet — fall through to the Save As flow.
 */
export function saveProjectCmd() {
  const meta = useStore.getState().projectMeta;

  // New project (no known VFS file location yet) → run the Save As flow.
  if (!meta.defaultFilePath || !meta.defaultRootId || !meta.defaultRootConfig) {
    saveProjectAsCmd();
    return;
  }

  if (!isVfsConfigured()) {
    dialogService.showAlert({
      title: 'Save Project',
      message: 'Configure a VFS server (File ▸ Application Settings) before saving.',
      mode: 'warning',
    });
    return;
  }

  const now = new Date().toISOString();
  const updated: ProjectMeta = {
    ...meta,
    createdAt: meta.createdAt ?? now,
    modifiedAt: now,
  };
  const content = serializeProject(useStore.getState().doc, updated);

  // Write back over the existing file at its known root + path.
  writeProjectFile(meta.defaultRootConfig, meta.defaultRootId, meta.defaultFilePath, content, { overwrite: true })
    .then(() => {
      useStore.getState().setProjectMeta(updated);
      useStore.getState().markClean();
    })
    .catch((e) => {
      dialogService.showAlert({
        title: 'Save failed',
        message: e instanceof VfsApiError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e),
        mode: 'error',
      });
    });
}

/**
 * Save As — two steps:
 *   1. Collect name + description ('Next' button).
 *   2. A VFS save browser (filename box + root/folder picker, 'Save' button).
 * On Save: mint a NEW project id and write the JSON to the chosen
 * root ▸ folder ▸ filename.json, then adopt that as the current project.
 */
export function saveProjectAsCmd() {
  if (!isVfsConfigured()) {
    dialogService.showAlert({
      title: 'Save Project As',
      message: 'Configure a VFS server (File ▸ Application Settings) before saving to the server.',
      mode: 'warning',
    });
    return;
  }
  const meta = useStore.getState().projectMeta;
  // If the project already has a VFS location, pre-fill the browser with its
  // current folder + filename; otherwise default the filename to the name.
  const fp = meta.defaultFilePath;
  const slash = fp ? fp.lastIndexOf('/') : -1;
  const curFolder = fp && slash >= 0 ? fp.slice(0, slash) : '';
  const curFileName = fp ? (slash >= 0 ? fp.slice(slash + 1) : fp).replace(/\.json$/i, '') : '';
  // Step 1 — name + description, with a 'Next' button.
  openSaveProjectDialog(true, meta, (next) => {
    // Step 2 — VFS save browser, prefilled from the current location if any.
    actionRegistry.invoke('studio:_openVfsSaveAs', {
      props: {
        defaultFileName: curFileName || next.name.trim(),
        defaultFolder: curFolder,
        // Browse the default root's config (typically the application 'config').
        configKey: meta.defaultRootConfig ?? 'config',
        defaultRootId: meta.defaultRootId,
        onSave: async (sel: {
          rootId: string; rootName: string; configKey: string; folderPath: string; fileName: string; overwrite: boolean;
        }) => {
          const now = new Date().toISOString();
          const cleanName = sel.fileName.replace(/\.json$/i, '').trim() || 'project';
          const fileName = `${cleanName}.json`;
          const filePath = sel.folderPath ? `${sel.folderPath}/${fileName}` : fileName;
          const updated: ProjectMeta = {
            projectId: newProjectId(),          // Save As creates a new project identity
            name: next.name.trim() || cleanName,
            description: next.description,
            createdAt: now,
            modifiedAt: now,
            defaultRootId: sel.rootId,
            defaultRootConfig: sel.configKey,
            defaultFilePath: filePath,
            defaultRootName: sel.rootName,
          };
          const content = serializeProject(useStore.getState().doc, updated);
          await writeProjectFile(sel.configKey, sel.rootId, filePath, content, { overwrite: sel.overwrite });
          useStore.getState().setProjectMeta(updated);
          useStore.getState().markClean();
        },
      },
    });
  }, 'Next');
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
            ...meta,
            name: next.name.trim(),
            description: next.description,
            createdAt: meta.createdAt ?? now,
            modifiedAt: now,
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
    seedApplicationDefaultRoot();
  });
}

/**
 * Best-effort: if the VFS server is reachable and the application 'config' topic
 * has at least one root, set the (just-created) project's default folder to the
 * first such root. Silent on any failure — server down, no config, no roots →
 * the project simply starts with no default until the user picks one.
 */
async function seedApplicationDefaultRoot() {
  if (!isVfsConfigured()) return;
  try {
    const roots = await listProjectRoots('config');
    if (!roots.length) return;
    const cur = useStore.getState().projectMeta;
    if (cur.defaultRootId) return; // user already chose one
    useStore.getState().setProjectMeta({
      ...cur,
      defaultRootId: roots[0].id,
      defaultRootConfig: 'config',
    });
  } catch {
    /* server unavailable / no config — leave the default unset */
  }
}

/**
 * Load a project from a File (a local pick or bytes fetched from the VFS) and
 * swap it into the store. Throws on parse/load errors so callers can surface
 * them in their own UI.
 */
export async function applyProjectFile(file: File): Promise<void> {
  const s = useStore.getState();
  importCache.clear();
  const { doc, meta } = await loadProject(file);
  // Reset UI to default 3D model view before swapping the doc — guarantees we
  // never resume in sketch mode against a doc whose sketch is gone.
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
}

/**
 * Import a project via the local system file dialog (the original "Open"
 * behaviour, now exposed via File ▸ Import).
 */
export function importProjectCmd() {
  confirmDiscardIfDirty('open project', () => {
    fileTriggers.openProject?.();
  });
}

/**
 * Open a project from the VFS server: browse the current project's roots,
 * pick a .json file, and load it. Requires a configured VFS connection.
 */
export function openProjectCmd() {
  if (!isVfsConfigured()) {
    dialogService.showAlert({
      title: 'Open Project',
      message: 'Configure a VFS server (File ▸ Application Settings) before opening from the server.',
      mode: 'warning',
    });
    return;
  }
  confirmDiscardIfDirty('open project', () => {
    // Browse the application's default config ('config') — its roots are
    // available regardless of the current project's id (which may be unsaved).
    actionRegistry.invoke('studio:_openVfsBrowser', {
      props: {
        configKey: 'config',
        onPick: async (sel: { rootId: string; rootName: string; filePath: string; name: string; configKey: string }) => {
          const text = await fetchFileText(sel.rootId, sel.filePath, sel.configKey);
          const file = new File([text], sel.name, { type: 'application/json' });
          await applyProjectFile(file);
          // Remember where it was opened from so the location shows in Project
          // Details and a later Save round-trips to the same file.
          const cur = useStore.getState().projectMeta;
          useStore.getState().setProjectMeta({
            ...cur,
            defaultRootId: sel.rootId,
            defaultRootConfig: sel.configKey,
            defaultRootName: sel.rootName,
            defaultFilePath: sel.filePath,
          });
        },
      },
    });
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

// ── Model import / image insert (shared by local + VFS pickers) ────────────

/** Import one model File (STL/OBJ/glTF/GLB/STEP) and add it as a feature. */
export async function importModelFromFile(file: File): Promise<void> {
  const s = useStore.getState();
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
    dialogService.showAlert({
      title: 'Import failed',
      message: e instanceof Error ? e.message : String(e),
      mode: 'error',
    });
  }
}

/** Load one image File as the pending sketch image and switch to the Image tool. */
export function insertImageFromFile(file: File): Promise<void> {
  return new Promise((resolve) => {
    const s = useStore.getState();
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      const img = new Image();
      img.onload = () => {
        s.setPendingImage({ src, fileName: file.name, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
        s.setTool('image');
        resolve();
      };
      img.onerror = () => resolve();
      img.src = src;
    };
    reader.onerror = () => resolve();
    reader.readAsDataURL(file);
  });
}

/** Image file extensions offered by the "Insert Image ▸ from server" browser. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];

/** Open the VFS browser to pick a model file and import it. */
export function importModelFromServerCmd() {
  if (!isVfsConfigured()) {
    dialogService.showAlert({ title: 'Import from server', message: 'Configure a VFS server (File ▸ Application Settings) first.', mode: 'warning' });
    return;
  }
  actionRegistry.invoke('studio:_openVfsBrowser', {
    title: 'Import model from VFS',
    props: {
      configKey: 'config',
      extensions: IMPORT_EXTENSIONS.map((e) => e.replace(/^\./, '')),
      onPick: async (sel: { rootId: string; filePath: string; name: string; configKey: string }) => {
        const blob = await fetchFileBlob(sel.rootId, sel.filePath, sel.configKey);
        await importModelFromFile(new File([blob], sel.name));
      },
    },
  });
}

/** Open the VFS browser to pick an image and insert it into the sketch. */
export function insertImageFromServerCmd() {
  if (!isVfsConfigured()) {
    dialogService.showAlert({ title: 'Insert image from server', message: 'Configure a VFS server (File ▸ Application Settings) first.', mode: 'warning' });
    return;
  }
  actionRegistry.invoke('studio:_openVfsBrowser', {
    title: 'Insert image from VFS',
    props: {
      configKey: 'config',
      extensions: IMAGE_EXTENSIONS,
      onPick: async (sel: { rootId: string; filePath: string; name: string; configKey: string }) => {
        const blob = await fetchFileBlob(sel.rootId, sel.filePath, sel.configKey);
        await insertImageFromFile(new File([blob], sel.name));
      },
    },
  });
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
    try {
      await applyProjectFile(files[0]);
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
    for (const file of Array.from(files)) await importModelFromFile(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  const onPickImage = async (files: FileList | null) => {
    if (!files?.[0]) return;
    await insertImageFromFile(files[0]);
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
