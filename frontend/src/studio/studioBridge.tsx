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
import { regenerate } from './core/buildGeometry';
import { importCache, nextName, useStore, type PendingImage, type ProjectMeta } from './state/store';
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
  type MergeOp,
  type PlaneId,
  type PrimitiveFeature,
  type PrimitiveShape,
  type SketchFeature,
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

/** Always prompt with the stored details pre-filled, then save under a (possibly new) name. */
export function saveProjectAsCmd() {
  const s = useStore.getState();
  const meta = s.projectMeta;
  openSaveProjectDialog(true, meta, (next) => {
    const now = new Date().toISOString();
    const updated: ProjectMeta = {
      name: next.name.trim(),
      description: next.description,
      createdAt: meta.createdAt ?? now,
      modifiedAt: now,
    };
    saveProject(useStore.getState().doc, projectFileName(updated.name), updated);
    useStore.getState().setProjectMeta(updated);
    useStore.getState().markClean();
  });
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

export function acceptExtrude() {
  const s = useStore.getState();
  const fp = s.facePick;
  if (!fp) return;
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
