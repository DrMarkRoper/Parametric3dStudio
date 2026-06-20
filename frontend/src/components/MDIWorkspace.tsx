import { useRef, useCallback, useState } from 'react';
import { useAppState } from '../contexts/AppStateContext';
import { DragProvider } from '../contexts/DragContext';
import type { DropTarget, TabDropTarget } from '../contexts/DragContext';
import type { DocumentContainerState, DocumentPanelState, RowId } from '../types';

import { MDIRow } from './MDIRow';
import { FloatingPanelManager } from './FloatingPanelManager';

// Default dimensions for a newly-floated panel created by tearing a tab out
const TEAR_FLOAT_W = 520;
const TEAR_FLOAT_H = 380;

export function MDIWorkspace() {
  const { state, dispatch } = useAppState();
  const workspaceRef = useRef<HTMLDivElement>(null);

  // ── Container drop ────────────────────────────────────────────────────────
  const handleContainerDrop = useCallback((
    container: DocumentContainerState,
    sourceRowId: RowId,
    target: DropTarget,
  ) => {
    dispatch({
      type: 'MOVE_CONTAINER',
      containerInstanceId: container.instanceId,
      sourceRowId,
      targetRowId: target.rowId,
      targetIndex: target.index,
    });
  }, [dispatch]);

  // ── Tab drop ──────────────────────────────────────────────────────────────
  const handleTabDrop = useCallback((
    doc: DocumentPanelState,
    sourceContainerId: string,
    sourceRowId: RowId,
    target: TabDropTarget,
    isContainerTitleDrag: boolean,
  ) => {
    if (target.rowDropIndex !== undefined) {
      if (isContainerTitleDrag) {
        dispatch({
          type: 'MOVE_CONTAINER',
          containerInstanceId: sourceContainerId,
          sourceRowId,
          targetRowId: target.rowId,
          targetIndex: target.rowDropIndex,
        });
      } else {
        dispatch({
          type: 'INSERT_CONTAINER_WITH_DOC',
          docInstanceId: doc.instanceId,
          sourceContainerInstanceId: sourceContainerId,
          sourceRowId,
          targetRowId: target.rowId,
          insertAtIndex: target.rowDropIndex,
        });
      }
    } else if (target.insertAfterContainerId !== undefined) {
      dispatch({
        type: 'INSERT_CONTAINER_WITH_DOC',
        docInstanceId: doc.instanceId,
        sourceContainerInstanceId: sourceContainerId,
        sourceRowId,
        targetRowId: target.rowId,
        insertAfterContainerId: target.insertAfterContainerId,
      });
    } else if (target.reorderIndex !== undefined) {
      dispatch({
        type: 'REORDER_DOCUMENT_TABS',
        containerInstanceId: target.containerInstanceId,
        rowId: target.rowId,
        docInstanceId: doc.instanceId,
        targetIndex: target.reorderIndex,
      });
    } else {
      dispatch({
        type: 'MOVE_DOCUMENT_TAB',
        docInstanceId: doc.instanceId,
        sourceContainerInstanceId: sourceContainerId,
        sourceRowId,
        targetContainerInstanceId: target.containerInstanceId,
        targetRowId: target.rowId,
      });
      if (isContainerTitleDrag) {
        dispatch({
          type: 'CLOSE_CONTAINER',
          rowId: sourceRowId,
          instanceId: sourceContainerId,
        });
      }
    }
  }, [dispatch]);

  // ── Tear-off to float: tab drag ends with no drop target ─────────────────
  const handleNoTarget = useCallback((
    doc: DocumentPanelState,
    sourceContainerId: string,
    sourceRowId: RowId,
    mouseX: number,
    mouseY: number,
    _isContainerTitleDrag: boolean,
  ) => {
    if (!workspaceRef.current) return;
    const rect = workspaceRef.current.getBoundingClientRect();
    const isOutside =
      mouseX < rect.left  || mouseX > rect.right ||
      mouseY < rect.top   || mouseY > rect.bottom;

    if (!isOutside) return; // Drop inside workspace with no target = no-op

    // Find the container to get its rowIndex
    const findContainerIndex = (): number => {
      for (const rowId of ['row-top', 'row-bottom'] as RowId[]) {
        const row = rowId === 'row-top' ? state.mdi.topRow : state.mdi.bottomRow;
        const c = row.containers.find(c => c.instanceId === sourceContainerId);
        if (c) return c.rowIndex;
      }
      return 0;
    };

    dispatch({
      type: 'FLOAT_DOCUMENT',
      docInstanceId: doc.instanceId,
      containerInstanceId: sourceContainerId,
      rowId: sourceRowId,
      containerIndex: findContainerIndex(),
      x: mouseX - Math.round(TEAR_FLOAT_W / 2),
      y: mouseY - 14,
      width: TEAR_FLOAT_W,
      height: TEAR_FLOAT_H,
    });
  }, [state.mdi, dispatch]);

  // ── Row resize divider ────────────────────────────────────────────────────
  const { topRow, bottomRow, rowSplit, rowResizeDisabled } = state.mdi;
  const [dragging, setDragging] = useState(false);

  const onVDragStart = useCallback((e: React.MouseEvent) => {
    if (rowResizeDisabled) return;
    e.preventDefault();
    setDragging(true);

    const COLLAPSE_THRESHOLD_PX = 80;
    const rect0 = workspaceRef.current!.getBoundingClientRect();
    const startSplit    = state.mdi.rowSplit;
    const startTopPx    = (startSplit / 100) * rect0.height;
    const startBottomPx = ((100 - startSplit) / 100) * rect0.height;

    let active = true;
    const cleanup = () => {
      active = false;
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    const onMove = (me: MouseEvent) => {
      if (!active || !workspaceRef.current) return;
      const rect = workspaceRef.current.getBoundingClientRect();
      const rawPct = ((me.clientY - rect.top) / rect.height) * 100;
      const topPx    = (rawPct / 100) * rect.height;
      const bottomPx = rect.height - topPx;

      if (rawPct < startSplit && topPx < COLLAPSE_THRESHOLD_PX && startTopPx >= COLLAPSE_THRESHOLD_PX) {
        dispatch({ type: 'TOGGLE_ROW_COLLAPSE', rowId: 'row-top' });
        cleanup(); return;
      }
      if (rawPct > startSplit && bottomPx < COLLAPSE_THRESHOLD_PX && startBottomPx >= COLLAPSE_THRESHOLD_PX) {
        dispatch({ type: 'TOGGLE_ROW_COLLAPSE', rowId: 'row-bottom' });
        cleanup(); return;
      }
      dispatch({ type: 'SET_ROW_SPLIT', split: Math.max(15, Math.min(85, rawPct)) });
    };

    const onUp = cleanup;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [rowResizeDisabled, state.mdi.rowSplit, dispatch]);

  const bothVisible    = topRow.visible && bottomRow.visible;
  const topCollapsed   = topRow.collapsed;
  const bottomCollapsed = bottomRow.collapsed;

  const topFlex    = topCollapsed    ? '0 0 0px' : bottomCollapsed ? '1 1 0' : `0 0 ${rowSplit}%`;
  const bottomFlex = bottomCollapsed ? '0 0 0px' : topCollapsed    ? '1 1 0' : `0 0 ${100 - rowSplit}%`;

  return (
    <DragProvider
      onDrop={handleContainerDrop}
      onTabDrop={handleTabDrop}
      onNoTarget={handleNoTarget}
    >
    <div ref={workspaceRef} className="mdi-workspace">
      {/* Top row */}
      {topRow.visible && !topCollapsed && (
        <div style={{ flex: topFlex, minHeight: 0, overflow: 'hidden', display: 'flex' }}>
          <MDIRow row={topRow} />
        </div>
      )}

      {/* Top collapse-restore strip */}
      {topRow.visible && topCollapsed && (
        <div role="button" aria-label="Restore top row" className="vcol-strip"
          onClick={() => dispatch({ type: 'TOGGLE_ROW_COLLAPSE', rowId: 'row-top' })}>
          <span>▼ Top Row</span>
        </div>
      )}

      {/* Vertical resize divider */}
      {bothVisible && !topCollapsed && !bottomCollapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={rowResizeDisabled ? 'Row divider' : 'Resize rows'}
          className={`vdrag-handle${dragging ? ' dragging' : ''}`}
          onMouseDown={rowResizeDisabled ? undefined : onVDragStart}
          style={rowResizeDisabled ? { cursor: 'default' } : undefined}
        >
          <span role="button" aria-label="Collapse top row" className="vdrag-arrow vdrag-arrow-up"
            onClick={e => { e.stopPropagation(); dispatch({ type: 'TOGGLE_ROW_COLLAPSE', rowId: 'row-top' }); }}
            title="Collapse top row">▲</span>
          <span role="button" aria-label="Collapse bottom row" className="vdrag-arrow vdrag-arrow-down"
            onClick={e => { e.stopPropagation(); dispatch({ type: 'TOGGLE_ROW_COLLAPSE', rowId: 'row-bottom' }); }}
            title="Collapse bottom row">▼</span>
        </div>
      )}

      {/* Bottom collapse-restore strip */}
      {bottomRow.visible && bottomCollapsed && (
        <div role="button" aria-label="Restore bottom row" className="vcol-strip"
          onClick={() => dispatch({ type: 'TOGGLE_ROW_COLLAPSE', rowId: 'row-bottom' })}>
          <span>▲ Bottom Row</span>
        </div>
      )}

      {/* Bottom row */}
      {bottomRow.visible && !bottomCollapsed && (
        <div style={{ flex: bottomFlex, minHeight: 0, overflow: 'hidden', display: 'flex' }}>
          <MDIRow row={bottomRow} />
        </div>
      )}
    </div>
    {/* FloatingPanelManager is portalled to document.body but must live inside DragProvider
        so FloatingPanel components can call useDrag() for startFloatDrag / floatDrag state. */}
    <FloatingPanelManager />
    </DragProvider>
  );
}
