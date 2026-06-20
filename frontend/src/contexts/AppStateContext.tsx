import React, { createContext, useContext, useReducer, useEffect, useRef } from 'react';
import type { AppState, AppAction, MDIRowState, RowId, DocumentContainerState, DocumentPanelState } from '../types';
import { persistState } from '../utils/layoutSerializer';

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true if `container` can accept `doc` as an additional tab.
 * Used by RESTORE_DOCUMENT to find an existing home before creating a new container.
 */
function isContainerCompatibleWithDoc(
  container: DocumentContainerState,
  doc: { instanceId: string; restrictToTabTypes: string[] },
): boolean {
  if (container.killed || !container.visible) return false;
  if (!container.allowTabs) return false;
  if (container.documentIds.includes(doc.instanceId)) return false;
  // An unrestricted container accepts any doc; a restricted one requires a type match.
  if (
    container.restrictTabToTypes.length > 0 &&
    !doc.restrictToTabTypes.some(t => container.restrictTabToTypes.includes(t))
  ) return false;
  return true;
}

/**
 * Normalise the widthPercent values of all visible, non-killed, non-collapsed
 * containers in a row so they sum to 100.  §9.3.
 *
 * Called after any operation that adds, removes, or collapses a container,
 * so stored values stay accurate and don't drift over time.
 */
function normaliseRowWidths(row: MDIRowState): MDIRowState {
  const active = row.containers.filter(c => c.visible && !c.killed && !c.collapsed);
  if (active.length === 0) return row;
  const total = active.reduce((s, c) => s + c.widthPercent, 0);
  if (total === 0 || Math.abs(total - 100) < 0.01) return row;
  const scale = 100 / total;
  return {
    ...row,
    containers: row.containers.map(c =>
      (c.visible && !c.killed && !c.collapsed)
        ? { ...c, widthPercent: c.widthPercent * scale }
        : c,
    ),
  };
}

function getRow(state: AppState, rowId: RowId): MDIRowState {
  return rowId === 'row-top' ? state.mdi.topRow : state.mdi.bottomRow;
}

function setRow(state: AppState, rowId: RowId, row: MDIRowState): AppState {
  return {
    ...state,
    mdi: {
      ...state.mdi,
      ...(rowId === 'row-top' ? { topRow: row } : { bottomRow: row }),
    },
  };
}

function updateContainer(
  state: AppState,
  rowId: RowId,
  instanceId: string,
  updater: (c: DocumentContainerState) => DocumentContainerState
): AppState {
  const row = getRow(state, rowId);
  const containers = row.containers.map(c =>
    c.instanceId === instanceId ? updater(c) : c
  );
  return setRow(state, rowId, { ...row, containers });
}

// ── Reducer ──────────────────────────────────────────────────────────────

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {

    case 'SET_THEME':
      return { ...state, theme: action.theme };

    // [framework-core] Added for Parametric3dStudio: toggle a single toolbar
    // block's visibility so the host can swap tool sets per editing mode.
    // Returns the same state object when unchanged to avoid effect loops.
    case 'SET_TOOLBAR_BLOCK_VISIBLE': {
      const block = state.toolbar.blocks[action.blockId];
      if (!block || block.visible === action.visible) return state;
      return {
        ...state,
        toolbar: {
          ...state.toolbar,
          blocks: {
            ...state.toolbar.blocks,
            [action.blockId]: { ...block, visible: action.visible },
          },
        },
      };
    }

    case 'SET_ROW_SPLIT':
      return { ...state, mdi: { ...state.mdi, rowSplit: action.split } };

    case 'TOGGLE_ROW_COLLAPSE': {
      const row = getRow(state, action.rowId);
      const collapsed = !row.collapsed;
      return setRow(state, action.rowId, { ...row, collapsed });
    }

    case 'SET_ROW_VISIBLE': {
      const row = getRow(state, action.rowId);
      return setRow(state, action.rowId, { ...row, visible: action.visible });
    }

    case 'SET_CONTAINER_FLEX': {
      const row = getRow(state, action.rowId);
      const containers = row.containers.map(c => {
        if (c.instanceId === action.instanceId) return { ...c, widthPercent: action.flex };
        if (c.instanceId === action.neighborInstanceId) return { ...c, widthPercent: action.neighborFlex };
        return c;
      });
      return setRow(state, action.rowId, { ...row, containers });
    }

    case 'TOGGLE_CONTAINER_COLLAPSE': {
      const afterToggle = updateContainer(state, action.rowId, action.instanceId, c => {
        const newCollapsed = !c.collapsed;
        return {
          ...c,
          collapsed: newCollapsed,
          // When RESTORING (collapsed → open), guarantee the container is wide
          // enough that a subsequent drag can never instantly re-collapse it.
          // MIN_RESTORE_FLEX (15) ≈ 15 % of a typical 100-unit row → ~210 px
          // on a 1400 px window, well above the 90 px collapse threshold.
          widthPercent: newCollapsed
            ? c.widthPercent
            : Math.max(c.widthPercent, 15),
        };
      });
      // Re-normalise so the remaining visible+uncollapsed containers sum to 100.
      const toggledRow = getRow(afterToggle, action.rowId);
      return setRow(afterToggle, action.rowId, normaliseRowWidths(toggledRow));
    }

    case 'CLOSE_CONTAINER': {
      const row = getRow(state, action.rowId);
      const container = row.containers.find(c => c.instanceId === action.instanceId);
      if (!container) return state;

      let nextRow: MDIRowState;
      if (container.killOnClose) {
        nextRow = { ...row, containers: row.containers.filter(c => c.instanceId !== action.instanceId) };
      } else {
        nextRow = {
          ...row,
          containers: row.containers.map(c =>
            c.instanceId === action.instanceId ? { ...c, visible: false } : c,
          ),
        };
      }
      return setRow(state, action.rowId, normaliseRowWidths(nextRow));
    }

    case 'SET_ACTIVE_DOCUMENT':
      return (() => {
        // Find which row the container is in
        for (const rowId of ['row-top', 'row-bottom'] as RowId[]) {
          const row = getRow(state, rowId);
          const container = row.containers.find(c => c.instanceId === action.containerInstanceId);
          if (container) {
            return updateContainer(state, rowId, action.containerInstanceId, c => ({
              ...c, activeDocumentId: action.docInstanceId,
            }));
          }
        }
        return state;
      })();

    case 'CLOSE_DOCUMENT': {
      const { docInstanceId, containerInstanceId, rowId, containerIndex } = action;
      const doc = state.documents[docInstanceId];
      if (!doc) return state;

      // Save closed state on the document
      const updatedDoc = {
        ...doc,
        visible: false,
        closedState: { containerId: containerInstanceId, rowId, containerIndex },
      };

      // Track whether the container transitions to hidden (needs width normalisation)
      let containerBecameHidden = false;

      // Remove from container's documentIds
      let newState = updateContainer(state, rowId, containerInstanceId, c => {
        const docIds = c.documentIds.filter(id => id !== docInstanceId);
        const newActive = docIds.length > 0
          ? (c.activeDocumentId === docInstanceId ? docIds[0] : c.activeDocumentId)
          : null;

        let updated = { ...c, documentIds: docIds, activeDocumentId: newActive };

        // Handle forceCloseOnEmpty
        if (docIds.length === 0 && c.forceCloseOnEmpty) {
          updated = { ...updated, visible: false, killed: c.killOnClose };
          containerBecameHidden = true;
        }
        return updated;
      });

      // Re-normalise if a container just disappeared from the row.
      if (containerBecameHidden) {
        newState = setRow(newState, rowId, normaliseRowWidths(getRow(newState, rowId)));
      }

      return {
        ...newState,
        documents: { ...newState.documents, [docInstanceId]: updatedDoc },
      };
    }

    case 'RESTORE_DOCUMENT': {
      const doc = state.documents[action.docInstanceId];
      if (!doc || (!doc.closedState && !doc.floating)) return state;
      const closed = doc.closedState;
      // If no closedState (shouldn't happen normally) fall back to row-top index 0
      const containerId     = closed?.containerId    ?? '';
      const rowId           = closed?.rowId          ?? 'row-top';
      const containerIndex  = closed?.containerIndex ?? 0;

      // Restore document to visible — also clear any floating / poppedOut state
      const restoredDoc = { ...doc, visible: true, closedState: null, floating: null, poppedOut: false };
      let newState = { ...state, documents: { ...state.documents, [doc.instanceId]: restoredDoc } };

      // Track which row the doc actually lands in so we can ensure it's visible.
      let resolvedRowId: RowId = rowId;

      // Find the original container
      const row = getRow(newState, rowId);
      const container = row.containers.find(c => c.instanceId === containerId);

      if (container && !container.killed) {
        // Original container still exists — re-add to it.
        newState = updateContainer(newState, rowId, containerId, c => ({
          ...c,
          visible: true,
          documentIds: c.documentIds.includes(doc.instanceId)
            ? c.documentIds
            : [...c.documentIds, doc.instanceId],
          activeDocumentId: doc.instanceId,
        }));
        resolvedRowId = rowId;
      } else {
        // Original container is gone.  Rule #3: scan every open container in both
        // rows for one that is already compatible before creating a brand-new one.
        const allContainers = [
          ...getRow(newState, 'row-top').containers,
          ...getRow(newState, 'row-bottom').containers,
        ];
        const compatible = allContainers.find(c => isContainerCompatibleWithDoc(c, doc));

        if (compatible) {
          newState = updateContainer(newState, compatible.rowId, compatible.instanceId, c => ({
            ...c,
            documentIds: [...c.documentIds, doc.instanceId],
            activeDocumentId: doc.instanceId,
          }));
          resolvedRowId = compatible.rowId;
        } else {
          // No compatible container — create a new one at the original index or end.
          const insertAt = Math.min(containerIndex, row.containers.length);
          const defaultOpts = doc.defaultContainerOptions ?? {};
          const newContainer: DocumentContainerState = {
            id: `dc-restored-${Date.now()}`,
            instanceId: `dc-restored-${Date.now()}`,
            widthPercent: 30,
            collapsed: false,
            visible: true,
            killed: false,
            allowTabs: defaultOpts.allowTabs ?? true,
            allowClose: defaultOpts.allowClose ?? true,
            allowDragMove: true,
            forbidDropBefore: false,
            forbidDropAfter: false,
            forceCloseOnEmpty: defaultOpts.forceCloseOnEmpty ?? true,
            killOnClose: defaultOpts.killOnClose ?? false,
            resizable: true,
            defaultWidth: 300,
            defaultTitle: doc.title,
            prefixTitle: false,
            restrictTabToTypes: defaultOpts.restrictTabToTypes ?? [],
            activeDocumentId: doc.instanceId,
            documentIds: [doc.instanceId],
            rowId,
            rowIndex: insertAt,
          };
          const containers = [...row.containers];
          containers.splice(insertAt, 0, newContainer);
          // New container path already ensures row is visible + uncollapsed.
          newState = setRow(newState, rowId, { ...row, containers, visible: true, collapsed: false });
          return newState;
        }
      }

      // §4.8 Rule 5: ensure the target row is visible and not collapsed so the
      // restored document is immediately reachable without extra user steps.
      const resolvedRow = getRow(newState, resolvedRowId);
      if (!resolvedRow.visible || resolvedRow.collapsed) {
        newState = setRow(newState, resolvedRowId, {
          ...resolvedRow,
          visible: true,
          collapsed: false,
        });
      }

      return newState;
    }

    case 'RESTORE_CONTAINER':
      return updateContainer(state, action.rowId, action.containerInstanceId, c => ({
        ...c, visible: true,
      }));

    case 'MOVE_CONTAINER': {
      const { containerInstanceId, sourceRowId, targetRowId, targetIndex } = action;
      const sourceRow = getRow(state, sourceRowId);
      const container = sourceRow.containers.find(c => c.instanceId === containerInstanceId);
      if (!container) return state;

      // Safety guard: forbidDropBefore / forbidDropAfter enforcement.
      // targetIndex is an index into the visible (non-killed, visible) containers of the target row.
      const targetRowForCheck = getRow(state, targetRowId);
      const targetVisible = targetRowForCheck.containers.filter(c => !c.killed && c.visible);
      if (targetIndex < targetVisible.length && targetVisible[targetIndex].forbidDropBefore) return state;
      if (targetIndex > 0 && targetVisible[targetIndex - 1].forbidDropAfter) return state;

      const sourceWithout = sourceRow.containers.filter(c => c.instanceId !== containerInstanceId);

      if (sourceRowId === targetRowId) {
        // Same-row reorder.
        // targetIndex is an index into the ORIGINAL visible array (before removal).
        // After removing the dragged container every slot to its right shifts down by 1,
        // so we must subtract 1 when the target is to the right of the source.
        const originalVisible = sourceRow.containers.filter(c => !c.killed && c.visible);
        const srcVisIdx = originalVisible.findIndex(c => c.instanceId === containerInstanceId);
        const adjustedTarget = srcVisIdx >= 0 && targetIndex > srcVisIdx
          ? targetIndex - 1
          : targetIndex;

        const visible = sourceWithout.filter(c => !c.killed && c.visible);
        const insertBeforeId = adjustedTarget < visible.length ? visible[adjustedTarget].instanceId : null;
        const next = [...sourceWithout];
        const at = insertBeforeId ? next.findIndex(c => c.instanceId === insertBeforeId) : next.length;
        next.splice(at, 0, container);
        return setRow(state, sourceRowId, { ...sourceRow, containers: next.map((c, i) => ({ ...c, rowIndex: i })) });
      } else {
        // Cross-row move
        const targetRow = getRow(state, targetRowId);
        const targetVisible = targetRow.containers.filter(c => !c.killed && c.visible);
        const insertBeforeId = targetIndex < targetVisible.length ? targetVisible[targetIndex].instanceId : null;
        const nextTarget = [...targetRow.containers];
        const at = insertBeforeId ? nextTarget.findIndex(c => c.instanceId === insertBeforeId) : nextTarget.length;
        nextTarget.splice(at, 0, { ...container, rowId: targetRowId });
        // Normalise source row after removing a container from it.
        const newSourceRow = normaliseRowWidths({ ...sourceRow, containers: sourceWithout.map((c, i) => ({ ...c, rowIndex: i })) });
        let ns = setRow(state, sourceRowId, newSourceRow);
        ns     = setRow(ns,    targetRowId, { ...targetRow, containers: nextTarget.map((c, i) => ({ ...c, rowIndex: i })) });
        return ns;
      }
    }

    case 'MOVE_DOCUMENT_TAB': {
      const { docInstanceId, sourceContainerInstanceId, sourceRowId, targetContainerInstanceId, targetRowId } = action;
      if (sourceContainerInstanceId === targetContainerInstanceId) return state;

      // Track whether the source container becomes hidden so we can normalise.
      let sourceContainerBecameHidden = false;

      // Remove from source container
      let ns = updateContainer(state, sourceRowId, sourceContainerInstanceId, c => {
        const docIds = c.documentIds.filter(id => id !== docInstanceId);
        const newActive = docIds.length > 0
          ? (c.activeDocumentId === docInstanceId ? docIds[0] : c.activeDocumentId)
          : null;
        let updated = { ...c, documentIds: docIds, activeDocumentId: newActive };
        if (docIds.length === 0 && c.forceCloseOnEmpty) {
          updated = { ...updated, killed: c.killOnClose, visible: false };
          sourceContainerBecameHidden = true;
        }
        return updated;
      });

      // Re-normalise source row if a container just disappeared.
      if (sourceContainerBecameHidden) {
        ns = setRow(ns, sourceRowId, normaliseRowWidths(getRow(ns, sourceRowId)));
      }

      // Add to target container
      ns = updateContainer(ns, targetRowId, targetContainerInstanceId, c => ({
        ...c,
        documentIds: c.documentIds.includes(docInstanceId) ? c.documentIds : [...c.documentIds, docInstanceId],
        activeDocumentId: docInstanceId,
      }));

      return ns;
    }

    case 'INSERT_CONTAINER_WITH_DOC': {
      const { docInstanceId, sourceContainerInstanceId, sourceRowId, targetRowId, insertAfterContainerId, insertAtIndex } = action;
      const doc = state.documents[docInstanceId];
      if (!doc) return state;

      // Safety guard: forbidDropBefore / forbidDropAfter enforcement.
      {
        const targetRowCheck = getRow(state, targetRowId);
        const visCheck = targetRowCheck.containers.filter(c => !c.killed && c.visible);
        let checkAt: number;
        if (insertAtIndex !== undefined) {
          checkAt = Math.max(0, Math.min(insertAtIndex, visCheck.length));
        } else {
          const afterIdx = visCheck.findIndex(c => c.instanceId === insertAfterContainerId);
          checkAt = afterIdx >= 0 ? afterIdx + 1 : visCheck.length;
        }
        if (checkAt < visCheck.length && visCheck[checkAt].forbidDropBefore) return state;
        if (checkAt > 0 && visCheck[checkAt - 1].forbidDropAfter) return state;
      }

      // Remove doc from its source container
      let ns = updateContainer(state, sourceRowId, sourceContainerInstanceId, c => {
        const docIds = c.documentIds.filter(id => id !== docInstanceId);
        const newActive = docIds.length > 0
          ? (c.activeDocumentId === docInstanceId ? docIds[0] : c.activeDocumentId)
          : null;
        let updated = { ...c, documentIds: docIds, activeDocumentId: newActive };
        if (docIds.length === 0 && c.forceCloseOnEmpty) {
          updated = { ...updated, killed: c.killOnClose, visible: c.killOnClose ? false : c.visible };
        }
        return updated;
      });

      // ── §6.3 Rule 1: reuse a hidden (visible:false, not killed) container ──
      // Before creating a brand-new container, look for a hidden one that
      // allowTabs and is type-compatible with this doc.  Search the target row
      // first, then the other row, to prefer keeping the doc near its origin.
      const hiddenCompatible = (() => {
        const searchRows: RowId[] = targetRowId === 'row-top'
          ? ['row-top', 'row-bottom']
          : ['row-bottom', 'row-top'];
        for (const rid of searchRows) {
          const found = getRow(ns, rid).containers.find(
            c =>
              !c.killed &&
              !c.visible &&
              c.allowTabs &&
              (c.restrictTabToTypes.length === 0 ||
                doc.restrictToTabTypes.some(t => c.restrictTabToTypes.includes(t))),
          );
          if (found) return { container: found, rowId: rid as RowId };
        }
        return null;
      })();

      if (hiddenCompatible) {
        const { container: hc, rowId: hcRowId } = hiddenCompatible;

        // Remove the hidden container from its current row so we can relocate it.
        const hcRow = getRow(ns, hcRowId);
        ns = setRow(ns, hcRowId, {
          ...hcRow,
          containers: hcRow.containers.filter(c => c.instanceId !== hc.instanceId),
        });

        // Now compute the insertion position in the (possibly updated) target row.
        const targetRow = getRow(ns, targetRowId);
        let spliceAt: number;
        let neighborIdx: number;

        if (insertAtIndex !== undefined) {
          spliceAt    = Math.max(0, Math.min(insertAtIndex, targetRow.containers.length));
          neighborIdx = spliceAt < targetRow.containers.length ? spliceAt : spliceAt - 1;
          if (neighborIdx < 0) return ns;
        } else {
          const afterIdx = targetRow.containers.findIndex(c => c.instanceId === insertAfterContainerId);
          if (afterIdx === -1) return ns;
          spliceAt    = afterIdx + 1;
          neighborIdx = afterIdx;
        }

        const neighbor    = targetRow.containers[neighborIdx];
        const newWidth    = Math.max(10, neighbor.widthPercent / 2);
        const neighborNew = neighbor.widthPercent - newWidth;

        // Reactivate the hidden container at the drop position.
        const reused: DocumentContainerState = {
          ...hc,
          visible: true,
          widthPercent: newWidth,
          rowId: targetRowId,
          documentIds: hc.documentIds.includes(docInstanceId)
            ? hc.documentIds
            : [...hc.documentIds, docInstanceId],
          activeDocumentId: docInstanceId,
        };

        const updatedContainers = targetRow.containers.map((c, i) =>
          i === neighborIdx ? { ...c, widthPercent: neighborNew } : c,
        );
        updatedContainers.splice(spliceAt, 0, reused);

        ns = setRow(ns, targetRowId, {
          ...targetRow,
          containers: updatedContainers.map((c, i) => ({ ...c, rowIndex: i })),
        });
        return ns;
      }

      // ── No hidden container available — create a brand-new one ────────────

      // Resolve insertion position:
      //   insertAfterContainerId → insert AFTER that container (existing handle-drop path)
      //   insertAtIndex          → insert at an absolute index (edge-drop path)
      const targetRow = getRow(ns, targetRowId);
      let spliceAt: number;      // index where new container is inserted in the array
      let neighborIdx: number;   // index of the container we steal width from

      if (insertAtIndex !== undefined) {
        // Clamp to valid range
        spliceAt   = Math.max(0, Math.min(insertAtIndex, targetRow.containers.length));
        // Steal from right neighbor if available, else from left
        neighborIdx = spliceAt < targetRow.containers.length ? spliceAt : spliceAt - 1;
        if (neighborIdx < 0) return ns; // empty row — shouldn't happen
      } else {
        const afterIdx = targetRow.containers.findIndex(c => c.instanceId === insertAfterContainerId);
        if (afterIdx === -1) return ns;
        spliceAt    = afterIdx + 1;
        neighborIdx = afterIdx; // steal from the left (existing behaviour)
      }

      const neighbor    = targetRow.containers[neighborIdx];
      const newWidth    = Math.max(10, neighbor.widthPercent / 2);
      const neighborNew = neighbor.widthPercent - newWidth;

      const defaultOpts = doc.defaultContainerOptions ?? {};
      const newId = `dc-new-${Date.now()}`;
      const newContainer: DocumentContainerState = {
        id: newId,
        instanceId: newId,
        widthPercent: newWidth,
        collapsed: false,
        visible: true,
        killed: false,
        allowTabs: defaultOpts.allowTabs ?? true,
        allowClose: defaultOpts.allowClose ?? true,
        allowDragMove: true,
        forbidDropBefore: false,
        forbidDropAfter: false,
        forceCloseOnEmpty: defaultOpts.forceCloseOnEmpty ?? true,
        killOnClose: true,
        resizable: true,
        defaultWidth: 300,
        defaultTitle: doc.title,
        prefixTitle: false,
        restrictTabToTypes: defaultOpts.restrictTabToTypes ?? doc.restrictToTabTypes,
        activeDocumentId: docInstanceId,
        documentIds: [docInstanceId],
        rowId: targetRowId,
        rowIndex: spliceAt,
      };

      const updatedContainers = targetRow.containers.map((c, i) =>
        i === neighborIdx ? { ...c, widthPercent: neighborNew } : c
      );
      updatedContainers.splice(spliceAt, 0, newContainer);

      ns = setRow(ns, targetRowId, {
        ...targetRow,
        containers: updatedContainers.map((c, i) => ({ ...c, rowIndex: i })),
      });
      return ns;
    }

    case 'REORDER_DOCUMENT_TABS': {
      const { containerInstanceId, rowId, docInstanceId, targetIndex } = action;
      return updateContainer(state, rowId, containerInstanceId, c => {
        const srcIdx = c.documentIds.indexOf(docInstanceId);
        if (srcIdx === -1) return c;
        const ids = [...c.documentIds];
        ids.splice(srcIdx, 1);
        const adjusted = targetIndex > srcIdx ? targetIndex - 1 : targetIndex;
        ids.splice(adjusted, 0, docInstanceId);
        return { ...c, documentIds: ids };
      });
    }

    case 'REORDER_TOOLBAR':
      return {
        ...state,
        toolbar: { ...state.toolbar, blockOrder: action.newOrder },
      };

    case 'SET_STATUS':
      // Permanent message also clears any active interrupt.
      return { ...state, statusBar: { ...state.statusBar, text: action.text, interruptText: null, interruptDuration: null } };

    case 'SET_STATUS_INTERRUPT':
      // Overrides the display temporarily; permanent text is untouched.
      return { ...state, statusBar: { ...state.statusBar, interruptText: action.text, interruptDuration: action.duration } };

    case 'CLEAR_STATUS_INTERRUPT':
      return { ...state, statusBar: { ...state.statusBar, interruptText: null, interruptDuration: null } };

    case 'TOGGLE_STATUS_BAR':
      return { ...state, statusBar: { ...state.statusBar, visible: !state.statusBar.visible } };

    case 'LOAD_STATE':
      return action.state;

    // ── Floating panel actions ─────────────────────────────────────────────

    case 'FLOAT_DOCUMENT': {
      const { docInstanceId, containerInstanceId, rowId, containerIndex, x, y, width, height } = action;
      const doc = state.documents[docInstanceId];
      if (!doc) return state;

      const updatedDoc: DocumentPanelState = {
        ...doc,
        visible: true,
        floating: { x, y, width, height, zIndex: state.floatZCounter + 1, minimized: false },
        poppedOut: false,
        closedState: { containerId: containerInstanceId, rowId, containerIndex },
      };

      // Remove doc from its source container (same logic as CLOSE_DOCUMENT)
      let containerBecameHidden = false;
      let ns = updateContainer(state, rowId, containerInstanceId, c => {
        const docIds = c.documentIds.filter(id => id !== docInstanceId);
        const newActive = docIds.length > 0
          ? (c.activeDocumentId === docInstanceId ? docIds[0] : c.activeDocumentId)
          : null;
        let updated = { ...c, documentIds: docIds, activeDocumentId: newActive };
        if (docIds.length === 0 && c.forceCloseOnEmpty) {
          updated = { ...updated, visible: false, killed: c.killOnClose };
          containerBecameHidden = true;
        }
        return updated;
      });
      if (containerBecameHidden) {
        ns = setRow(ns, rowId, normaliseRowWidths(getRow(ns, rowId)));
      }
      return {
        ...ns,
        floatZCounter: state.floatZCounter + 1,
        documents: { ...ns.documents, [docInstanceId]: updatedDoc },
      };
    }

    case 'CLOSE_FLOATING': {
      const doc = state.documents[action.docInstanceId];
      if (!doc || !doc.floating) return state;
      // Record closedState if not already set (defensive)
      const closedDoc: DocumentPanelState = {
        ...doc,
        visible: false,
        floating: null,
        // closedState is already set from when it was floated — keep it
      };
      return { ...state, documents: { ...state.documents, [action.docInstanceId]: closedDoc } };
    }

    case 'DOCK_DOCUMENT': {
      const { docInstanceId, targetContainerInstanceId, targetRowId } = action;
      const doc = state.documents[docInstanceId];
      if (!doc || !doc.floating) return state;

      const dockedDoc: DocumentPanelState = {
        ...doc,
        floating: null,
        closedState: null,
        visible: true,
        poppedOut: false,
      };

      // Find which row the target container is in (caller provides targetRowId)
      const ns = updateContainer(state, targetRowId, targetContainerInstanceId, c => ({
        ...c,
        documentIds: c.documentIds.includes(docInstanceId)
          ? c.documentIds
          : [...c.documentIds, docInstanceId],
        activeDocumentId: docInstanceId,
        visible: true,
      }));
      return { ...ns, documents: { ...ns.documents, [docInstanceId]: dockedDoc } };
    }

    case 'DOCK_DOCUMENT_AT': {
      // Dock a floating panel into a new (or reused-hidden) container at a gap position.
      // Mirrors INSERT_CONTAINER_WITH_DOC but skips the "remove from source container" step.
      const { docInstanceId, targetRowId, insertAfterContainerId, insertAtIndex } = action;
      const doc = state.documents[docInstanceId];
      if (!doc || !doc.floating) return state;

      // Clear floating state on the doc first
      const dockedDoc: DocumentPanelState = {
        ...doc, floating: null, closedState: null, visible: true, poppedOut: false,
      };
      let ns: AppState = { ...state, documents: { ...state.documents, [docInstanceId]: dockedDoc } };

      // Safety guard: forbidDropBefore / forbidDropAfter
      {
        const targetRowCheck = getRow(ns, targetRowId);
        const visCheck = targetRowCheck.containers.filter(c => !c.killed && c.visible);
        let checkAt: number;
        if (insertAtIndex !== undefined) {
          checkAt = Math.max(0, Math.min(insertAtIndex, visCheck.length));
        } else {
          const afterIdx = visCheck.findIndex(c => c.instanceId === insertAfterContainerId);
          checkAt = afterIdx >= 0 ? afterIdx + 1 : visCheck.length;
        }
        if (checkAt < visCheck.length && visCheck[checkAt].forbidDropBefore) return state;
        if (checkAt > 0 && visCheck[checkAt - 1].forbidDropAfter) return state;
      }

      // Try to reuse a hidden compatible container
      const hiddenCompatible = (() => {
        const searchRows: RowId[] = targetRowId === 'row-top'
          ? ['row-top', 'row-bottom'] : ['row-bottom', 'row-top'];
        for (const rid of searchRows) {
          const found = getRow(ns, rid).containers.find(
            c => !c.killed && !c.visible && c.allowTabs &&
              (c.restrictTabToTypes.length === 0 ||
                doc.restrictToTabTypes.some(t => c.restrictTabToTypes.includes(t))),
          );
          if (found) return { container: found, rowId: rid as RowId };
        }
        return null;
      })();

      if (hiddenCompatible) {
        const { container: hc, rowId: hcRowId } = hiddenCompatible;
        const hcRow = getRow(ns, hcRowId);
        ns = setRow(ns, hcRowId, {
          ...hcRow,
          containers: hcRow.containers.filter(c => c.instanceId !== hc.instanceId),
        });

        const targetRow = getRow(ns, targetRowId);
        let spliceAt: number;
        let neighborIdx: number;
        if (insertAtIndex !== undefined) {
          spliceAt    = Math.max(0, Math.min(insertAtIndex, targetRow.containers.length));
          neighborIdx = spliceAt < targetRow.containers.length ? spliceAt : spliceAt - 1;
          if (neighborIdx < 0) return ns;
        } else {
          const afterIdx = targetRow.containers.findIndex(c => c.instanceId === insertAfterContainerId);
          if (afterIdx === -1) return ns;
          spliceAt    = afterIdx + 1;
          neighborIdx = afterIdx;
        }

        const neighbor  = targetRow.containers[neighborIdx];
        const newWidth  = Math.max(10, neighbor.widthPercent / 2);
        const reused: DocumentContainerState = {
          ...hc,
          visible: true,
          widthPercent: newWidth,
          rowId: targetRowId,
          documentIds: hc.documentIds.includes(docInstanceId)
            ? hc.documentIds : [...hc.documentIds, docInstanceId],
          activeDocumentId: docInstanceId,
        };
        const updContainers = targetRow.containers.map((c, i) =>
          i === neighborIdx ? { ...c, widthPercent: neighbor.widthPercent - newWidth } : c,
        );
        updContainers.splice(spliceAt, 0, reused);
        return setRow(ns, targetRowId, {
          ...targetRow,
          containers: updContainers.map((c, i) => ({ ...c, rowIndex: i })),
        });
      }

      // No hidden container — create a brand-new one
      const targetRow = getRow(ns, targetRowId);
      let spliceAt: number;
      let neighborIdx: number;
      if (insertAtIndex !== undefined) {
        spliceAt    = Math.max(0, Math.min(insertAtIndex, targetRow.containers.length));
        neighborIdx = spliceAt < targetRow.containers.length ? spliceAt : spliceAt - 1;
        if (neighborIdx < 0) return ns;
      } else {
        const afterIdx = targetRow.containers.findIndex(c => c.instanceId === insertAfterContainerId);
        if (afterIdx === -1) return ns;
        spliceAt    = afterIdx + 1;
        neighborIdx = afterIdx;
      }
      const neighbor  = targetRow.containers[neighborIdx];
      const newWidth  = Math.max(10, neighbor.widthPercent / 2);
      const newId = `dc-new-${Date.now()}`;
      const defaultOpts = doc.defaultContainerOptions ?? {};
      const newContainer: DocumentContainerState = {
        id: newId, instanceId: newId,
        widthPercent: newWidth, collapsed: false, visible: true, killed: false,
        allowTabs: defaultOpts.allowTabs ?? true,
        allowClose: defaultOpts.allowClose ?? true,
        allowDragMove: true, forbidDropBefore: false, forbidDropAfter: false,
        forceCloseOnEmpty: defaultOpts.forceCloseOnEmpty ?? true,
        killOnClose: true, resizable: true, defaultWidth: 300,
        defaultTitle: doc.title, prefixTitle: false,
        restrictTabToTypes: defaultOpts.restrictTabToTypes ?? doc.restrictToTabTypes,
        activeDocumentId: docInstanceId, documentIds: [docInstanceId],
        rowId: targetRowId, rowIndex: spliceAt,
      };
      const updContainers = targetRow.containers.map((c, i) =>
        i === neighborIdx ? { ...c, widthPercent: neighbor.widthPercent - newWidth } : c,
      );
      updContainers.splice(spliceAt, 0, newContainer);
      return setRow(ns, targetRowId, {
        ...targetRow,
        containers: updContainers.map((c, i) => ({ ...c, rowIndex: i })),
      });
    }

    case 'SET_FLOAT_GEOMETRY': {
      const { docInstanceId, x, y, width, height } = action;
      const doc = state.documents[docInstanceId];
      if (!doc || !doc.floating) return state;
      return {
        ...state,
        documents: {
          ...state.documents,
          [docInstanceId]: {
            ...doc,
            floating: {
              ...doc.floating,
              x:      x      ?? doc.floating.x,
              y:      y      ?? doc.floating.y,
              width:  width  ?? doc.floating.width,
              height: height ?? doc.floating.height,
            },
          },
        },
      };
    }

    case 'BRING_FLOAT_TO_FRONT': {
      const doc = state.documents[action.docInstanceId];
      if (!doc || !doc.floating) return state;
      const newZ = state.floatZCounter + 1;
      return {
        ...state,
        floatZCounter: newZ,
        documents: {
          ...state.documents,
          [action.docInstanceId]: { ...doc, floating: { ...doc.floating, zIndex: newZ } },
        },
      };
    }

    case 'MINIMIZE_FLOAT': {
      const doc = state.documents[action.docInstanceId];
      if (!doc || !doc.floating) return state;
      return {
        ...state,
        documents: {
          ...state.documents,
          [action.docInstanceId]: {
            ...doc,
            floating: { ...doc.floating, minimized: !doc.floating.minimized },
          },
        },
      };
    }

    // ── Browser popout actions ─────────────────────────────────────────────

    case 'POP_OUT_DOCUMENT': {
      const { docInstanceId, containerInstanceId, rowId, containerIndex } = action;
      const doc = state.documents[docInstanceId];
      if (!doc) return state;

      const poppedDoc: DocumentPanelState = {
        ...doc,
        visible: true,    // still "open" (in popout window)
        poppedOut: true,
        floating: null,
        closedState: { containerId: containerInstanceId, rowId, containerIndex },
      };

      // Remove from source container (same as FLOAT_DOCUMENT)
      let containerBecameHidden = false;
      let ns = updateContainer(state, rowId, containerInstanceId, c => {
        const docIds = c.documentIds.filter(id => id !== docInstanceId);
        const newActive = docIds.length > 0
          ? (c.activeDocumentId === docInstanceId ? docIds[0] : c.activeDocumentId)
          : null;
        let updated = { ...c, documentIds: docIds, activeDocumentId: newActive };
        if (docIds.length === 0 && c.forceCloseOnEmpty) {
          updated = { ...updated, visible: false, killed: c.killOnClose };
          containerBecameHidden = true;
        }
        return updated;
      });
      if (containerBecameHidden) {
        ns = setRow(ns, rowId, normaliseRowWidths(getRow(ns, rowId)));
      }
      return { ...ns, documents: { ...ns.documents, [docInstanceId]: poppedDoc } };
    }

    case 'POP_IN_DOCUMENT': {
      // Return a popped-out doc to the MDI (reuse RESTORE_DOCUMENT logic via closedState)
      const doc = state.documents[action.docInstanceId];
      if (!doc || !doc.poppedOut) return state;
      // Clear poppedOut then let RESTORE_DOCUMENT handle the rest by re-dispatching
      // via a synthetic call. Since we can't dispatch inside a reducer, we inline the logic:
      // Mark as hidden (visible:false, poppedOut:false) and let RESTORE_DOCUMENT run.
      const cleared: DocumentPanelState = { ...doc, poppedOut: false };
      return { ...state, documents: { ...state.documents, [action.docInstanceId]: cleared } };
      // Caller should dispatch RESTORE_DOCUMENT immediately after.
    }

    // ── Modal dialog actions ───────────────────────────────────────────────

    case 'OPEN_MODAL': {
      const id = `modal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      return { ...state, modals: [...state.modals, { ...action.modal, id }] };
    }

    case 'CLOSE_MODAL': {
      return { ...state, modals: state.modals.filter(m => m.id !== action.id) };
    }

    default:
      return state;
  }
}

// ── Context ──────────────────────────────────────────────────────────────

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}

const AppContext = createContext<AppContextValue | null>(null);

interface Props {
  initialState: AppState;
  children: React.ReactNode;
}

export function AppStateProvider({ initialState, children }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced persist
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => persistState(state), 300);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [state]);

  // Apply theme to <html>
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  const value = { state, dispatch };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider');
  return ctx;
}

// Convenience selector hooks
export function useDoc(instanceId: string) {
  const { state } = useAppState();
  return state.documents[instanceId];
}

export function useRow(rowId: RowId) {
  const { state } = useAppState();
  return rowId === 'row-top' ? state.mdi.topRow : state.mdi.bottomRow;
}
