/**
 * useStudioActions — registers every Parametric-3D command in the MDI action
 * registry, bridges the studio editing mode to toolbar-block visibility, and
 * restores the original keyboard shortcuts (Undo / Redo / Delete) with the
 * input-focus guard the engine expects.
 *
 * Called once from App.tsx's AppInner (inside the AppStateProvider).
 */
import { useEffect, useRef } from 'react';
import { useAppState } from '../contexts/AppStateContext';
import type { RowId } from '../types';
import { actionRegistry } from '../utils/actionRegistry';
import { confirmDeleteFeature, useStore } from './state/store';
import {
  acceptExtrude,
  addJointCmd,
  addLinkCmd,
  addPrimitive,
  cancelFacePick,
  cancelMerge,
  createMerge,
  deleteAssemblyCmd,
  enterAssemblyCmd,
  exitAssemblyCmd,
  exportStlCmd,
  fileTriggers,
  finishSketch,
  newProjectCmd,
  newSketch,
  openProjectCmd,
  redoCmd,
  saveProjectAsCmd,
  saveProjectCmd,
  startExtrude,
  startFaceSketch,
  startMerge,
  toggleConstruction,
  toggleGizmo,
  undoCmd,
} from './studioBridge';

// Toolbar blocks shown only in model mode, and only in sketch mode.
const MODEL_BLOCKS = ['tb-sketch', 'tb-create', 'tb-modify'];
const SKETCH_BLOCKS = ['tb-sketchtools'];

// RHS document instance ids (see default_layout.json).
const DC_INFO = 'dc-info-001';
const DOC_INFO = 'doc-info-001';
const DOC_JOINTS = 'doc-joints-001';
const DOC_LINKS = 'doc-links-001';

export function useStudioActions() {
  const { state, dispatch } = useAppState();
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Register commands (once) ─────────────────────────────────────────────
  useEffect(() => {
    const reg: Record<string, (args?: Record<string, unknown>) => void> = {
      'studio:new': () => newProjectCmd(),
      'studio:open': () => openProjectCmd(),
      'studio:save': () => saveProjectCmd(),
      'studio:saveAs': () => saveProjectAsCmd(),
      // Internal: opens the SaveProjectModal with its Save/Cancel button bar
      'studio:_openSaveModal': (args) => {
        dispatch({
          type: 'OPEN_MODAL',
          modal: {
            title: String(args?.title ?? 'Save Project'),
            componentType: 'SaveProjectModal',
            width: Number(args?.width ?? 460),
            allowClose: true,
            props: args?.props as Record<string, unknown> | undefined,
            buttons: [
              { label: 'Cancel', alignment: 'right', closesModal: true, keys: ['Escape'] },
              { label: 'Save', alignment: 'right', variant: 'primary', action: 'saveProjectModal:save', closesModal: false, keys: ['Enter'] },
            ],
          },
        });
      },
      'studio:import': () => fileTriggers.importModel?.(),
      'studio:exportStl': () => exportStlCmd(),
      'studio:undo': () => undoCmd(),
      'studio:redo': () => redoCmd(),

      'studio:sketch:top': () => newSketch('XZ'),
      'studio:sketch:front': () => newSketch('XY'),
      'studio:sketch:right': () => newSketch('YZ'),
      'studio:sketch:face': () => startFaceSketch(),

      'studio:add:box': () => addPrimitive('box'),
      'studio:add:sphere': () => addPrimitive('sphere'),
      'studio:add:cylinder': () => addPrimitive('cylinder'),
      'studio:add:cone': () => addPrimitive('cone'),
      'studio:add:torus': () => addPrimitive('torus'),
      // Custom thread primitives (Create → Torus → Custom)
      'studio:add:bulbScrew': () => addPrimitive('bulbScrew'),
      'studio:add:bulbSocket': () => addPrimitive('bulbSocket'),
      'studio:add:screwThread': () => addPrimitive('screwThread'),
      'studio:add:nutThread': () => addPrimitive('nutThread'),

      'studio:extrude': () => startExtrude(),
      'studio:extrude:accept': () => acceptExtrude(),
      'studio:extrude:cancel': () => cancelFacePick(),

      'studio:move': () => toggleGizmo('translate'),
      'studio:rotate': () => toggleGizmo('rotate'),
      'studio:merge': () => startMerge(),
      'studio:merge:cut': () => createMerge('cut'),
      'studio:merge:cutswap': () => createMerge('cut', true),
      'studio:merge:fuse': () => createMerge('fuse'),
      'studio:merge:intersect': () => createMerge('intersect'),
      'studio:merge:cancel': () => cancelMerge(),

      'studio:tool:select': () => useStore.getState().setTool('select'),
      'studio:tool:line': () => useStore.getState().setTool('line'),
      'studio:tool:rect': () => useStore.getState().setTool('rect'),
      'studio:tool:circle': () => useStore.getState().setTool('circle'),
      'studio:tool:arc': () => useStore.getState().setTool('arc'),
      'studio:tool:cog': () => useStore.getState().setTool('cog'),
      'studio:tool:fillet': () => useStore.getState().setTool('fillet'),
      'studio:tool:chamfer': () => useStore.getState().setTool('chamfer'),
      'studio:tool:measure': () => useStore.getState().setTool('measure'),
      'studio:tool:dimension': () => useStore.getState().setTool('dimension'),
      'studio:tool:offset': () => useStore.getState().setTool('offset'),
      'studio:construction': () => toggleConstruction(),
      'studio:image': () => fileTriggers.pickImage?.(),
      'studio:finish': () => finishSketch(),

      // Assembly mode
      'studio:assembly:enter': () => enterAssemblyCmd(),
      'studio:assembly:exit': () => exitAssemblyCmd(),
      'studio:assembly:revolute': () => addJointCmd('revolute'),
      'studio:assembly:prismatic': () => addJointCmd('prismatic'),
      'studio:assembly:link': () => addLinkCmd(),
      'studio:assembly:delete': () => deleteAssemblyCmd(),
    };

    for (const [name, fn] of Object.entries(reg)) actionRegistry.register(name, fn);
    return () => {
      for (const name of Object.keys(reg)) actionRegistry.unregister(name);
    };
  }, []);

  // ── Mode → toolbar visibility bridge ─────────────────────────────────────
  // Mirrors the original mode-aware Toolbar: model tools, sketch tools, the
  // extrude face-pick bar, and the merge-op bar each appear in their context.
  const mode = useStore((s) => s.mode);
  const inFacePick = useStore((s) => s.facePick !== null);
  const inMergePick = useStore((s) => s.mergePick !== null);
  useEffect(() => {
    const sketching = mode === 'sketch';
    const assembling = mode === 'assembly';
    const set = (id: string, visible: boolean) =>
      dispatch({ type: 'SET_TOOLBAR_BLOCK_VISIBLE', blockId: id, visible });

    // Model tool blocks: visible in model mode when not choosing a merge target
    // and not assembling.
    for (const id of MODEL_BLOCKS) set(id, !sketching && !assembling && !inMergePick);
    // Sketch tool block: visible in sketch mode when not picking extrude faces.
    for (const id of SKETCH_BLOCKS) set(id, sketching && !inFacePick);
    // Transient bars.
    set('tb-extrude', sketching && inFacePick);
    set('tb-merge', !sketching && inMergePick);
    // Assembly tool block.
    set('tb-assembly', assembling);
  }, [mode, inFacePick, inMergePick, dispatch]);

  // ── RHS panel swap: Info ⇄ Joints/Links document tabs ────────────────────
  // In assembly mode the Info tab is replaced by two non-closable, non-draggable
  // document tabs (Joints, Links); leaving assembly restores the Info tab.
  // Reconciles idempotently on every mode change (and on mount), so a layout
  // persisted mid-assembly is corrected on the next load. If the tab documents
  // aren't present (e.g. an older saved layout), this is a no-op and the Info
  // panel keeps showing the combined assembly editor as a fallback.
  useEffect(() => {
    const st = stateRef.current;
    const docs = st.documents;
    if (!docs[DOC_JOINTS] || !docs[DOC_LINKS] || !docs[DOC_INFO]) return;
    const isOpen = (id: string) => !!docs[id]?.visible;
    const locate = (docId: string): { containerInstanceId: string; rowId: RowId; containerIndex: number } | null => {
      for (const rowId of ['row-top', 'row-bottom'] as RowId[]) {
        const row = rowId === 'row-top' ? st.mdi.topRow : st.mdi.bottomRow;
        const idx = row.containers.findIndex((c) => c.documentIds.includes(docId));
        if (idx >= 0) return { containerInstanceId: row.containers[idx].instanceId, rowId, containerIndex: idx };
      }
      return null;
    };
    const close = (id: string) => {
      const loc = locate(id);
      if (loc) dispatch({ type: 'CLOSE_DOCUMENT', docInstanceId: id, ...loc });
    };

    if (mode === 'assembly') {
      if (!isOpen(DOC_JOINTS)) dispatch({ type: 'RESTORE_DOCUMENT', docInstanceId: DOC_JOINTS });
      if (!isOpen(DOC_LINKS)) dispatch({ type: 'RESTORE_DOCUMENT', docInstanceId: DOC_LINKS });
      if (isOpen(DOC_INFO)) close(DOC_INFO);
      dispatch({ type: 'SET_ACTIVE_DOCUMENT', containerInstanceId: DC_INFO, docInstanceId: DOC_JOINTS });
    } else {
      if (!isOpen(DOC_INFO)) dispatch({ type: 'RESTORE_DOCUMENT', docInstanceId: DOC_INFO });
      if (isOpen(DOC_JOINTS)) close(DOC_JOINTS);
      if (isOpen(DOC_LINKS)) close(DOC_LINKS);
      dispatch({ type: 'SET_ACTIVE_DOCUMENT', containerInstanceId: DC_INFO, docInstanceId: DOC_INFO });
      // If a Joints/Links tab was torn into the (normally hidden) bottom row,
      // its container is killed when the doc closes above — hide the row too so
      // we don't leave an empty row behind on exit.
      const liveBottom = st.mdi.bottomRow.containers.filter((c) => c.visible && !c.killed);
      const onlyAssemblyTabs =
        liveBottom.length > 0 &&
        liveBottom.every((c) => c.documentIds.every((id) => id === DOC_JOINTS || id === DOC_LINKS));
      if (onlyAssemblyTabs) dispatch({ type: 'SET_ROW_VISIBLE', rowId: 'row-bottom', visible: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ── Toolbar "selected tool" highlight ────────────────────────────────────
  // Mirrors the current sketch tool + construction toggle into data attributes
  // on <html> so plain CSS attribute selectors can light up the corresponding
  // toolbar button (see .toolbar-btn[data-action] rules in styles.css). Doing
  // it via DOM attributes avoids coupling the framework toolbar to studio
  // state — the rules match on the existing data-action we already emit.
  const tool = useStore((s) => s.tool);
  const construction = useStore((s) => s.construction);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.studioTool = mode === 'sketch' ? tool : '';
    root.dataset.studioConstruction = construction ? 'on' : 'off';
    return () => {
      delete root.dataset.studioTool;
      delete root.dataset.studioConstruction;
    };
  }, [mode, tool, construction]);

  // ── Keyboard shortcuts (with input-focus guard) ──────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const s = useStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        s.mode === 'model' &&
        s.selectedFeatureId
      ) {
        e.preventDefault();
        confirmDeleteFeature(s.selectedFeatureId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
