import React, { useRef, useCallback, useState, useEffect, useLayoutEffect } from 'react';
import type { MDIRowState, DocumentContainerState } from '../types';
import { useAppState } from '../contexts/AppStateContext';
import { useDrag } from '../contexts/DragContext';
import { DocumentContainer } from './DocumentContainer';

// Pixel width below which a container auto-collapses during a drag
const COLLAPSE_THRESHOLD_PX = 90;

interface Props {
  row: MDIRowState;
}

// ── Render item types ────────────────────────────────────────────────────

type RenderItem =
  | { kind: 'container'; container: DocumentContainerState }
  | { kind: 'handle'; left: DocumentContainerState; right: DocumentContainerState };

/**
 * Build the ordered list of containers and resize handles.
 *
 * Key rule: a handle connects the nearest non-collapsed container on its left
 * with the nearest non-collapsed container on its right, skipping any
 * collapsed strips in between. The handle is placed just before the right
 * non-collapsed container so collapsed strips appear between the left panel
 * and the handle, which is visually natural.
 *
 * Example with [Explorer, Editor(collapsed), Properties]:
 *   → [Explorer] [Editor-strip] [handle(Explorer↔Properties)] [Properties]
 */
function buildRenderItems(visible: DocumentContainerState[]): RenderItem[] {
  const items: RenderItem[] = [];
  let prevNonCollapsed: DocumentContainerState | null = null;
  const pendingCollapsed: DocumentContainerState[] = [];

  for (const container of visible) {
    if (container.collapsed) {
      // Buffer collapsed strips; they will be flushed before the next handle
      pendingCollapsed.push(container);
    } else {
      // Flush any collapsed strips that sit between prevNonCollapsed and here
      for (const cc of pendingCollapsed) {
        items.push({ kind: 'container', container: cc });
      }
      pendingCollapsed.length = 0;

      // Insert a handle between the previous non-collapsed and this one
      if (prevNonCollapsed !== null) {
        items.push({ kind: 'handle', left: prevNonCollapsed, right: container });
      }

      items.push({ kind: 'container', container });
      prevNonCollapsed = container;
    }
  }

  // Flush any trailing collapsed containers (at the far right of the row)
  for (const cc of pendingCollapsed) {
    items.push({ kind: 'container', container: cc });
  }

  return items;
}

// ── Forbidden drop helper ────────────────────────────────────────────────

/**
 * Returns true if inserting a container/tab at position `dropAt` (in the visible
 * array) is blocked by a forbidDropBefore or forbidDropAfter flag.
 *
 * dropAt=0 → before the first container
 * dropAt=visible.length → after the last container
 */
function isForbiddenDrop(visible: DocumentContainerState[], dropAt: number): boolean {
  if (dropAt < visible.length && visible[dropAt].forbidDropBefore) return true;
  if (dropAt > 0 && visible[dropAt - 1].forbidDropAfter) return true;
  return false;
}

// ── MDIRow ───────────────────────────────────────────────────────────────

export function MDIRow({ row }: Props) {
  const { dispatch } = useAppState();
  const { drag, setDropTarget, tabDrag, setTabDropTarget } = useDrag();
  const rowRef = useRef<HTMLDivElement>(null);

  // Track which handle is active by the LEFT container's instanceId
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Track which handle the tab ghost is hovering over (by left container instanceId)
  const [tabDragHandleId, setTabDragHandleId] = useState<string | null>(null);
  // Track which edge drop zone is hovered ('left' | 'right' | null)
  const [edgeHover, setEdgeHover] = useState<'left' | 'right' | null>(null);

  // Clear transient drag state when tab drag ends
  useEffect(() => {
    if (!tabDrag) {
      setTabDragHandleId(null);
      setEdgeHover(null);
    }
  }, [tabDrag]);
  // Drop indicator: pixel x position + insertion index (for no-op/forbidden detection)
  const [dropIndicator, setDropIndicator] = useState<{ x: number; index: number; forbidden?: boolean } | null>(null);

  // Only non-killed, visible containers participate in the layout
  const visible = row.containers.filter(c => !c.killed && c.visible);

  // ── Auto-collapse containers that have become too narrow ─────────────────
  // Runs synchronously after every DOM paint so there's no visible flash.
  // The key encodes each container's id, collapsed state, and flex weight so
  // the effect only fires when the composition or sizing actually changes.
  const visibleKey = visible.map(c => `${c.instanceId}:${c.collapsed}:${c.widthPercent}`).join(',');
  useLayoutEffect(() => {
    if (!rowRef.current) return;
    const slots = Array.from(rowRef.current.querySelectorAll<HTMLElement>('[data-drop-slot]'));
    slots.forEach((el, i) => {
      const container = visible[i];
      if (!container || container.collapsed) return; // skip already-collapsed strips
      const px = el.getBoundingClientRect().width;
      if (px > 0 && px < COLLAPSE_THRESHOLD_PX) {
        dispatch({ type: 'TOGGLE_CONTAINER_COLLAPSE', rowId: row.id, instanceId: container.instanceId });
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, row.id]);

  const onHandleDragStart = useCallback(
    (e: React.MouseEvent, left: DocumentContainerState, right: DocumentContainerState) => {
      e.preventDefault();
      setDraggingId(left.instanceId);

      const startX       = e.clientX;
      const startLeftFl  = left.widthPercent;
      const startRightFl = right.widthPercent;
      const pairFl       = startLeftFl + startRightFl;

      // Sum of ALL non-collapsed containers — converts flex ↔ pixels accurately
      const totalRowFlex = visible
        .filter(c => !c.collapsed)
        .reduce((sum, c) => sum + c.widthPercent, 0);

      let active = true;

      const cleanup = () => {
        active = false;
        setDraggingId(null);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      // Capture row width once at drag-start for the starting-size guard
      const startRowWidth = rowRef.current?.getBoundingClientRect().width ?? 1;
      const startLeftPx   = (startLeftFl  / totalRowFlex) * startRowWidth;
      const startRightPx  = (startRightFl / totalRowFlex) * startRowWidth;

      const onMove = (me: MouseEvent) => {
        if (!active || !rowRef.current) return;
        const rect = rowRef.current.getBoundingClientRect();
        const dx   = me.clientX - startX;

        // Pixel-accurate: scale dx by the full-row flex total
        const dFlex      = (dx / rect.width) * totalRowFlex;
        const newLeftFl  = Math.max(0, Math.min(pairFl, startLeftFl + dFlex));
        const newRightFl = pairFl - newLeftFl;

        // Auto-collapse — three conditions required (see comments in each):
        const leftPx  = (newLeftFl  / totalRowFlex) * rect.width;
        const rightPx = (newRightFl / totalRowFlex) * rect.width;

        const shrinkingLeft  = newLeftFl  < startLeftFl;
        const shrinkingRight = newRightFl < startRightFl;

        // (a) below threshold  (b) drag is shrinking this side
        // (c) started above threshold — prevents instant re-collapse after restore
        if (shrinkingLeft && leftPx < COLLAPSE_THRESHOLD_PX && startLeftPx >= COLLAPSE_THRESHOLD_PX) {
          dispatch({ type: 'TOGGLE_CONTAINER_COLLAPSE', rowId: row.id, instanceId: left.instanceId });
          cleanup();
          return;
        }
        if (shrinkingRight && rightPx < COLLAPSE_THRESHOLD_PX && startRightPx >= COLLAPSE_THRESHOLD_PX) {
          dispatch({ type: 'TOGGLE_CONTAINER_COLLAPSE', rowId: row.id, instanceId: right.instanceId });
          cleanup();
          return;
        }

        dispatch({
          type: 'SET_CONTAINER_FLEX',
          rowId: row.id,
          instanceId: left.instanceId,
          flex: newLeftFl,
          neighborInstanceId: right.instanceId,
          neighborFlex: newRightFl,
        });
      };

      const onUp = cleanup;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [visible, row.id, dispatch]
  );

  // ── Container drag: mouse tracking for drop indicator ───────────────────
  // Note: container-title tab drags do NOT use onRowMouseMove — they use the same
  // per-container onMouseEnter (merge) + per-handle onMouseEnter (reorder) mechanism
  // as regular tab drags, so onRowMouseMove never overwrites those targets.

  const onRowMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drag || !rowRef.current) return;
    const rowRect = rowRef.current.getBoundingClientRect();
    const slots = Array.from(rowRef.current.querySelectorAll<HTMLElement>('[data-drop-slot]'));

    // Empty row — treat the whole row as a single drop zone at index 0
    if (slots.length === 0) {
      setDropIndicator({ x: rowRect.width / 2, index: 0 });
      setDropTarget({ rowId: row.id, index: 0 });
      return;
    }

    // Find insertion index: first slot whose centre is to the right of cursor
    let dropAt = slots.length;
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { dropAt = i; break; }
    }

    // Compute the pixel x for the indicator line
    let ix: number;
    if (dropAt === 0) {
      ix = slots[0].getBoundingClientRect().left - rowRect.left;
    } else if (dropAt >= slots.length) {
      const last = slots[slots.length - 1].getBoundingClientRect();
      ix = last.right - rowRect.left;
    } else {
      const prev = slots[dropAt - 1].getBoundingClientRect();
      const next = slots[dropAt].getBoundingClientRect();
      ix = (prev.right + next.left) / 2 - rowRect.left;
    }

    const forbidden = isForbiddenDrop(visible, dropAt);
    setDropIndicator({ x: ix, index: dropAt, forbidden });
    if (forbidden) {
      setDropTarget(null);
    } else {
      setDropTarget({ rowId: row.id, index: dropAt });
    }
  }, [drag, row.id, setDropTarget, visible]);

  const onRowMouseLeave = useCallback(() => {
    if (!drag) return;
    setDropIndicator(null);
    setDropTarget(null);
  }, [drag, setDropTarget]);

  // ── Empty row ────────────────────────────────────────────────────────────
  if (visible.length === 0) {
    return (
      <div
        ref={rowRef}
        className="mdi-row"
        style={{ flex: 1, position: 'relative' }}
        onMouseMove={drag ? onRowMouseMove : undefined}
        onMouseLeave={drag ? onRowMouseLeave : undefined}
      >
        <div className={`row-drop-zone${drag ? ' drag-active' : ''}`}>
          <span>{drag ? 'Drop panel here' : 'No panels — drag & drop a panel from above'}</span>
        </div>
        {drag && dropIndicator !== null && (
          <div className="container-drop-indicator" style={{ left: dropIndicator.x }} />
        )}
      </div>
    );
  }

  const renderItems = buildRenderItems(visible);

  // The rightmost non-collapsed container gets the › arrow — but only when there
  // are other non-collapsed panels to its left. If it's the sole open panel,
  // collapsing it sends everything to the left, so ‹ is correct.
  const nonCollapsedVisible = visible.filter(c => !c.collapsed);
  const rightmostNonCollapsed = nonCollapsedVisible.length > 1
    ? [...visible].reverse().find(c => !c.collapsed)
    : null;

  return (
    <div
      ref={rowRef}
      className="mdi-row"
      style={{ flex: 1, position: 'relative' }}
      onMouseMove={drag ? onRowMouseMove : undefined}
      onMouseLeave={drag ? onRowMouseLeave : undefined}
    >
      {renderItems.map((item) => {
        if (item.kind === 'handle') {
          const isActive       = draggingId === item.left.instanceId;
          const isTabDragOver  = tabDrag !== null && tabDragHandleId === item.left.instanceId;
          // The insertion index this handle represents (to the left of item.right)
          const handleDropIdx  = visible.findIndex(c => c.instanceId === item.right.instanceId);
          const handleDropAt   = handleDropIdx >= 0 ? handleDropIdx : visible.length;
          // No-op: container-title drag where the source is already left or right of this handle
          const isTabDragNoOp  = isTabDragOver && !!tabDrag?.isContainerTitleDrag && (
            tabDrag.sourceContainerId === item.left.instanceId ||
            tabDrag.sourceContainerId === item.right.instanceId
          );
          // Forbidden: a forbidDrop flag blocks this insertion point
          const isTabDragForbidden = isTabDragOver && isForbiddenDrop(visible, handleDropAt);
          const isTabDragDark  = isTabDragNoOp || isTabDragForbidden;
          // Suppress resize drag when either adjacent container is not resizable.
          const noResize = !item.left.resizable || !item.right.resizable;
          return (
            <div
              key={`handle-${item.left.instanceId}-${item.right.instanceId}`}
              role="separator"
              aria-orientation="vertical"
              aria-label={noResize ? 'Panel divider' : 'Resize panels'}
              className={`hdrag-handle${isActive ? ' dragging' : ''}${noResize ? ' no-resize' : ''}${isTabDragOver ? (isTabDragDark ? ' tab-drag-no-op' : ' tab-drag-over') : ''}`}
              onMouseDown={noResize ? undefined : e => onHandleDragStart(e, item.left, item.right)}
              onMouseEnter={tabDrag ? () => {
                setTabDragHandleId(item.left.instanceId);
                // If forbidden, show the dark indicator but don't set a valid drop target
                if (isForbiddenDrop(visible, handleDropAt)) {
                  setTabDropTarget(null);
                  return;
                }
                if (tabDrag.isContainerTitleDrag) {
                  // Container-title drag: drop on handle reorders the container in the row.
                  setTabDropTarget({ containerInstanceId: '__row__', rowId: row.id, rowDropIndex: handleDropAt });
                } else {
                  // Regular tab drag: drop on handle splits off a new container.
                  setTabDropTarget({ containerInstanceId: '__handle__', rowId: row.id, insertAfterContainerId: item.left.instanceId });
                }
              } : undefined}
              onMouseLeave={tabDrag ? () => {
                setTabDragHandleId(null);
                setTabDropTarget(null);
              } : undefined}
            />
          );
        }

        // Container wrapper — flex drives width; collapsed → fixed 18 px strip
        const { container } = item;
        const isRightmost  = container.instanceId === rightmostNonCollapsed?.instanceId;
        const isDragging   = drag?.container.instanceId === container.instanceId ||
          (tabDrag?.isContainerTitleDrag && tabDrag.sourceContainerId === container.instanceId);

        return (
          <div
            key={container.instanceId}
            data-drop-slot          // used by drop-zone hit detection
            style={{
              flex: container.collapsed ? '0 0 18px' : container.widthPercent,
              minWidth: 0,
              display: 'flex',
              overflow: 'hidden',
            }}
          >
            <DocumentContainer
              container={container}
              isRightmost={isRightmost}
              isDragging={isDragging}
            />
          </div>
        );
      })}

      {/* Vertical drop indicator line — dark red when drop would be a no-op or is forbidden */}
      {drag && dropIndicator !== null && (() => {
        const srcIdx = drag.sourceRowId === row.id
          ? visible.findIndex(c => c.instanceId === drag.container.instanceId)
          : -1;
        const isNoOp = srcIdx >= 0 &&
          (dropIndicator.index === srcIdx || dropIndicator.index === srcIdx + 1);
        const isDark = isNoOp || !!dropIndicator.forbidden;
        return (
          <div
            className={`container-drop-indicator${isDark ? ' no-op' : ''}`}
            style={{ left: dropIndicator.x }}
          />
        );
      })()}

      {/* ── Edge drop zones (tab drag only) ──────────────────────────────
          Thin absolute strips at the far left and right of the row.
          Regular tab drag  → creates a new container at that edge.
          Container-title drag → moves the container to that edge.
          No-op when the source is already the first/last container.     */}
      {tabDrag && (() => {
        const firstVisible = visible[0];
        const lastVisible  = visible[visible.length - 1];
        const isCtd        = tabDrag.isContainerTitleDrag;

        const leftNoOp      = isCtd && tabDrag.sourceContainerId === firstVisible?.instanceId;
        const rightNoOp     = isCtd && tabDrag.sourceContainerId === lastVisible?.instanceId;
        const leftForbidden  = isForbiddenDrop(visible, 0);
        const rightForbidden = isForbiddenDrop(visible, visible.length);

        const onEnterEdge = (side: 'left' | 'right') => {
          setEdgeHover(side);
          const idx = side === 'left' ? 0 : visible.length;
          const forbidden = isForbiddenDrop(visible, idx);
          if (forbidden) {
            setTabDropTarget(null);
          } else {
            setTabDropTarget({ containerInstanceId: '__edge__', rowId: row.id, rowDropIndex: idx });
          }
        };
        const onLeaveEdge = () => {
          setEdgeHover(null);
          setTabDropTarget(null);
        };

        return (
          <>
            <div
              className={`row-edge-drop-zone left${
                edgeHover === 'left'
                  ? (leftNoOp || leftForbidden ? ' no-op' : ' active')
                  : ''
              }`}
              onMouseEnter={() => onEnterEdge('left')}
              onMouseLeave={onLeaveEdge}
            />
            <div
              className={`row-edge-drop-zone right${
                edgeHover === 'right'
                  ? (rightNoOp || rightForbidden ? ' no-op' : ' active')
                  : ''
              }`}
              onMouseEnter={() => onEnterEdge('right')}
              onMouseLeave={onLeaveEdge}
            />
          </>
        );
      })()}
    </div>
  );
}
