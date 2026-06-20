import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import type { DocumentContainerState, DocumentPanelState, RowId } from '../types';

// ── Container drag ───────────────────────────────────────────────────────────

export interface DropTarget {
  rowId: RowId;
  index: number;
}

export interface ActiveDrag {
  container: DocumentContainerState;
  sourceRowId: RowId;
  mouseX: number;
  mouseY: number;
  dropTarget: DropTarget | null;
}

// ── Tab drag ─────────────────────────────────────────────────────────────────

export interface TabDropTarget {
  containerInstanceId: string;
  rowId: RowId;
  reorderIndex?: number;           // drop within same container → reorder tabs
  insertAfterContainerId?: string; // drop on a resize handle → create new container
  rowDropIndex?: number;           // container-title drag dropped in row → MOVE_CONTAINER
}

export interface ActiveTabDrag {
  doc: DocumentPanelState;
  sourceContainerId: string;
  sourceRowId: RowId;
  mouseX: number;
  mouseY: number;
  dropTarget: TabDropTarget | null;
  /** true when initiated by dragging a single-tab container's title bar */
  isContainerTitleDrag: boolean;
}

// ── Context ──────────────────────────────────────────────────────────────────

interface DragContextValue {
  // Container drag
  drag: ActiveDrag | null;
  startDrag: (container: DocumentContainerState, rowId: RowId, e: React.MouseEvent) => void;
  setDropTarget: (target: DropTarget | null) => void;
  // Tab drag (also used for single-tab container-title drags)
  tabDrag: ActiveTabDrag | null;
  startTabDrag: (
    doc: DocumentPanelState,
    sourceContainerId: string,
    sourceRowId: RowId,
    e: React.MouseEvent,
    isContainerTitleDrag?: boolean,
  ) => void;
  setTabDropTarget: (target: TabDropTarget | null) => void;
}

const DragContext = createContext<DragContextValue | null>(null);

export function useDrag(): DragContextValue {
  const ctx = useContext(DragContext);
  if (!ctx) throw new Error('useDrag must be used within DragProvider');
  return ctx;
}

// ── Provider ─────────────────────────────────────────────────────────────────

interface Props {
  onDrop:    (container: DocumentContainerState, sourceRowId: RowId, target: DropTarget) => void;
  onTabDrop: (doc: DocumentPanelState, sourceContainerId: string, sourceRowId: RowId, target: TabDropTarget, isContainerTitleDrag: boolean) => void;
  /** Called when a tab drag ends with no drop target (for tear-off to float). */
  onNoTarget?: (doc: DocumentPanelState, sourceContainerId: string, sourceRowId: RowId, mouseX: number, mouseY: number, isContainerTitleDrag: boolean) => void;
  children: React.ReactNode;
}

const TAB_DRAG_THRESHOLD = 6; // px movement before tab drag activates

export function DragProvider({ onDrop, onTabDrop, onNoTarget, children }: Props) {

  // ── Container drag state ────────────────────────────────────────────────
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  const dragRef = useRef<ActiveDrag | null>(null);

  const startDrag = useCallback((
    container: DocumentContainerState,
    rowId: RowId,
    e: React.MouseEvent,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const initial: ActiveDrag = {
      container, sourceRowId: rowId,
      mouseX: e.clientX, mouseY: e.clientY, dropTarget: null,
    };
    dragRef.current = initial;
    setDrag(initial);
    document.body.style.cursor     = 'grabbing';
    document.body.style.userSelect = 'none';
    document.body.classList.add('mdi-container-dragging');

    const onMouseMove = (me: MouseEvent) => {
      setDrag(prev => {
        if (!prev) return null;
        const next = { ...prev, mouseX: me.clientX, mouseY: me.clientY };
        dragRef.current = next;
        return next;
      });
    };
    const onMouseUp = () => {
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      document.body.classList.remove('mdi-container-dragging');
      const cur = dragRef.current;
      if (cur?.dropTarget) onDrop(cur.container, cur.sourceRowId, cur.dropTarget);
      dragRef.current = null;
      setDrag(null);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);
  }, [onDrop]);

  const setDropTarget = useCallback((target: DropTarget | null) => {
    setDrag(prev => {
      if (!prev) return null;
      const next = { ...prev, dropTarget: target };
      dragRef.current = next;
      return next;
    });
  }, []);

  // ── Tab drag state ──────────────────────────────────────────────────────
  const [tabDrag, setTabDrag] = useState<ActiveTabDrag | null>(null);
  const tabDragRef      = useRef<ActiveTabDrag | null>(null);
  const tabDragActiveRef = useRef(false); // true once threshold crossed

  const startTabDrag = useCallback((
    doc: DocumentPanelState,
    sourceContainerId: string,
    sourceRowId: RowId,
    e: React.MouseEvent,
    isContainerTitleDrag = false,
  ) => {
    // Don't preventDefault — allow normal click/tab-select if mouse never moves past threshold
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const initial: ActiveTabDrag = {
      doc, sourceContainerId, sourceRowId,
      mouseX: e.clientX, mouseY: e.clientY,
      dropTarget: null,
      isContainerTitleDrag,
    };
    tabDragRef.current    = initial;
    tabDragActiveRef.current = false;

    const activateDrag = () => {
      tabDragActiveRef.current = true;
      setTabDrag(tabDragRef.current);
      document.body.style.cursor     = 'grabbing';
      document.body.style.userSelect = 'none';
      document.body.classList.add('mdi-container-dragging');
    };

    const onMouseMove = (me: MouseEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (!tabDragActiveRef.current && Math.hypot(dx, dy) > TAB_DRAG_THRESHOLD) {
        activateDrag();
      }
      if (tabDragActiveRef.current) {
        setTabDrag(prev => {
          if (!prev) return null;
          const next = { ...prev, mouseX: me.clientX, mouseY: me.clientY };
          tabDragRef.current = next;
          return next;
        });
      }
    };

    const onMouseUp = (me: MouseEvent) => {
      if (tabDragActiveRef.current) {
        document.body.style.cursor     = '';
        document.body.style.userSelect = '';
        document.body.classList.remove('mdi-container-dragging');
        const cur = tabDragRef.current;
        if (cur?.dropTarget) {
          onTabDrop(cur.doc, cur.sourceContainerId, cur.sourceRowId, cur.dropTarget, cur.isContainerTitleDrag);
        } else if (onNoTarget && cur) {
          // No drop target — let the workspace decide whether to float the panel
          onNoTarget(cur.doc, cur.sourceContainerId, cur.sourceRowId, me.clientX, me.clientY, cur.isContainerTitleDrag);
        }
      }
      tabDragRef.current       = null;
      tabDragActiveRef.current = false;
      setTabDrag(null);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);
  }, [onTabDrop, onNoTarget]);

  const setTabDropTarget = useCallback((target: TabDropTarget | null) => {
    setTabDrag(prev => {
      if (!prev) return null;
      const next = { ...prev, dropTarget: target };
      tabDragRef.current = next;
      return next;
    });
  }, []);

  return (
    <DragContext.Provider value={{
      drag, startDrag, setDropTarget,
      tabDrag, startTabDrag, setTabDropTarget,
    }}>
      {children}

      {/* Container drag ghost */}
      {drag && (
        <div className="container-drag-ghost"
          style={{ left: drag.mouseX + 14, top: drag.mouseY - 12 }}>
          ⠿ {drag.container.defaultTitle}
        </div>
      )}

      {/* Tab / container-title drag ghost */}
      {tabDrag && (
        <div className="container-drag-ghost tab-drag-ghost"
          style={{ left: tabDrag.mouseX + 14, top: tabDrag.mouseY - 12 }}>
          {tabDrag.isContainerTitleDrag ? '⠿' : '⇥'} {tabDrag.doc.title}
        </div>
      )}

    </DragContext.Provider>
  );
}
