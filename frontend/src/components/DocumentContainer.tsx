import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { DocumentContainerState, DocumentPanelState } from '../types';
import { useAppState } from '../contexts/AppStateContext';
import { useDrag } from '../contexts/DragContext';
import { subscribeFlash, peekPendingFlashDoc, clearPendingFlashDoc } from '../utils/containerFlash';
import { DocumentPanel } from './DocumentPanel';
import { ToolbarButton } from './MainToolbar';

/** Default size for a newly-floated panel. */
const FLOAT_DEFAULT_W = 520;
const FLOAT_DEFAULT_H = 380;

// ── Tab drop validity ────────────────────────────────────────────────────

function isValidTabDrop(
  doc: DocumentPanelState,
  target: DocumentContainerState,
  sourceContainerId: string,
): boolean {
  if (target.instanceId === sourceContainerId) return false;
  if (!doc.allowAsTab) return false;
  if (!target.allowTabs) return false;
  // Type-compatibility rule:
  //   • Container with restrictTabToTypes = [] → unrestricted, accepts any doc.
  //   • Container with restrictTabToTypes non-empty → doc must declare at least one
  //     type that appears in the container's accepted list.
  //   A doc with restrictToTabTypes = [] has no declared type and therefore cannot
  //   satisfy a restricted container's requirement — correctly rejected.
  if (
    target.restrictTabToTypes.length > 0 &&
    !doc.restrictToTabTypes.some(t => target.restrictTabToTypes.includes(t))
  ) return false;
  return true;
}

// ── Tab Bar ──────────────────────────────────────────────────────────────

interface TabBarProps {
  container: DocumentContainerState;
}

function TabBar({ container }: TabBarProps) {
  const { state, dispatch } = useAppState();
  const { startTabDrag, tabDrag, setTabDropTarget } = useDrag();
  const rowId = container.rowId;
  const tabbarRef = useRef<HTMLDivElement>(null);
  const [dropIndicator, setDropIndicator] = useState<{ x: number; index: number } | null>(null);

  // Active only when the drag originated from this tab bar
  const isSameContainerDrag = !!tabDrag && tabDrag.sourceContainerId === container.instanceId;

  useEffect(() => {
    if (!tabDrag) setDropIndicator(null);
  }, [tabDrag]);

  const onTabbarMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isSameContainerDrag || !tabbarRef.current) return;
    const slots = Array.from(tabbarRef.current.querySelectorAll<HTMLElement>('[data-tab-slot]'));
    if (slots.length === 0) return;

    let dropAt = slots.length;
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { dropAt = i; break; }
    }

    const barRect = tabbarRef.current.getBoundingClientRect();
    let ix: number;
    if (dropAt === 0) {
      ix = slots[0].getBoundingClientRect().left - barRect.left;
    } else if (dropAt >= slots.length) {
      ix = slots[slots.length - 1].getBoundingClientRect().right - barRect.left;
    } else {
      const prev = slots[dropAt - 1].getBoundingClientRect();
      const next = slots[dropAt].getBoundingClientRect();
      ix = (prev.right + next.left) / 2 - barRect.left;
    }

    setDropIndicator({ x: ix, index: dropAt });
    setTabDropTarget({ containerInstanceId: container.instanceId, rowId: container.rowId, reorderIndex: dropAt });
  }, [isSameContainerDrag, container, setTabDropTarget]);

  const onTabbarMouseLeave = useCallback(() => {
    if (!isSameContainerDrag) return;
    setDropIndicator(null);
    setTabDropTarget(null);
  }, [isSameContainerDrag, setTabDropTarget]);

  return (
    <div
      className="tabbar"
      role="tablist"
      ref={tabbarRef}
      style={{ position: 'relative' }}
      onMouseMove={isSameContainerDrag ? onTabbarMouseMove : undefined}
      onMouseLeave={isSameContainerDrag ? onTabbarMouseLeave : undefined}
    >
      {container.documentIds.map(docId => {
        const doc = state.documents[docId];
        if (!doc) return null;
        const isActive = container.activeDocumentId === docId;
        const draggable = doc.allowAsTab;

        return (
          <button
            key={docId}
            data-tab-slot
            role="tab"
            aria-selected={isActive}
            className={`tab-btn${isActive ? ' active' : ''}`}
            title={doc.title}
            onMouseDown={draggable
              ? (e) => startTabDrag(doc, container.instanceId, rowId, e)
              : undefined}
            onClick={() => dispatch({
              type: 'SET_ACTIVE_DOCUMENT',
              containerInstanceId: container.instanceId,
              docInstanceId: docId,
            })}
          >
            <span className="tab-label">{doc.tabTitle ?? doc.title}</span>
            {doc.allowClose && (
              <span
                className="tab-close"
                title="Close"
                onClick={e => {
                  e.stopPropagation();
                  dispatch({
                    type: 'CLOSE_DOCUMENT',
                    docInstanceId: docId,
                    containerInstanceId: container.instanceId,
                    rowId,
                    containerIndex: container.rowIndex,
                  });
                }}
              >
                ×
              </span>
            )}
          </button>
        );
      })}

      {/* Reorder indicator — yellow if sequence changes, dark red if no-op */}
      {isSameContainerDrag && dropIndicator !== null && (() => {
        const srcIdx = container.documentIds.indexOf(tabDrag!.doc.instanceId);
        const isNoOp = dropIndicator.index === srcIdx || dropIndicator.index === srcIdx + 1;
        return (
          <div
            className={`tab-reorder-indicator${isNoOp ? ' no-op' : ''}`}
            style={{ left: dropIndicator.x }}
          />
        );
      })()}
    </div>
  );
}

// ── Tab list dropdown (from titlebar ⊞ button) ───────────────────────────

interface TabListDropdownProps {
  container: DocumentContainerState;
  onClose: () => void;
}

function TabListDropdown({ container, onClose }: TabListDropdownProps) {
  const { state, dispatch } = useAppState();

  return (
    <div className="tab-list-dropdown">
      {container.documentIds.map(docId => {
        const doc = state.documents[docId];
        if (!doc) return null;
        const isActive = container.activeDocumentId === docId;

        return (
          <div
            key={docId}
            className={`tab-list-item${isActive ? ' active' : ''}`}
            title={doc.title}
            onClick={() => {
              dispatch({
                type: 'SET_ACTIVE_DOCUMENT',
                containerInstanceId: container.instanceId,
                docInstanceId: docId,
              });
              onClose();
            }}
          >
            <span className="tab-label">{doc.tabTitle ?? doc.title}</span>
            {doc.allowClose && (
              <span
                className="tab-list-item-close"
                title="Close"
                onClick={e => {
                  e.stopPropagation();
                  dispatch({
                    type: 'CLOSE_DOCUMENT',
                    docInstanceId: docId,
                    containerInstanceId: container.instanceId,
                    rowId: container.rowId,
                    containerIndex: container.rowIndex,
                  });
                  onClose();
                }}
              >
                ×
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Document Container ───────────────────────────────────────────────────

interface Props {
  container: DocumentContainerState;
  isRightmost?: boolean;
  isDragging?: boolean;
}

export function DocumentContainer({ container, isRightmost = false, isDragging = false }: Props) {
  const { state, dispatch } = useAppState();
  const { startDrag, startTabDrag, tabDrag, setTabDropTarget } = useDrag();
  const [tabListOpen, setTabListOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const tabListLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Flash animation ───────────────────────────────────────────────────────
  // A key increment unmounts/remounts the overlay div, re-triggering the CSS animation.
  const [flashKey, setFlashKey] = useState(0);
  const triggerFlash = useCallback(() => setFlashKey(k => k + 1), []);

  // Direct flash: fired when user focuses a visible doc (SET_ACTIVE_DOCUMENT).
  useEffect(() => subscribeFlash((id) => {
    if (id === container.instanceId) triggerFlash();
  }), [container.instanceId, triggerFlash]);

  // Pending-doc flash: fired when this container receives a restored doc.
  // The pending id is set before dispatch; we check after documentIds updates.
  const docIdsKey = container.documentIds.join(',');
  useEffect(() => {
    const pending = peekPendingFlashDoc();
    if (pending && container.documentIds.includes(pending)) {
      clearPendingFlashDoc();
      triggerFlash();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docIdsKey, triggerFlash]);

  const onContainerMouseEnter = useCallback(() => {
    if (!tabDrag) return;
    if (isValidTabDrop(tabDrag.doc, container, tabDrag.sourceContainerId)) {
      setTabDropTarget({ containerInstanceId: container.instanceId, rowId: container.rowId });
    } else {
      setTabDropTarget(null);
    }
  }, [tabDrag, container, setTabDropTarget]);

  const onContainerMouseLeave = useCallback(() => {
    if (tabDrag) setTabDropTarget(null);
  }, [tabDrag, setTabDropTarget]);

  // Show amber border when a tab drag can drop into this container
  const showDropBorder = !!tabDrag && isValidTabDrop(tabDrag.doc, container, tabDrag.sourceContainerId);

  const onTabListMouseEnter = () => {
    if (tabListLeaveTimer.current) clearTimeout(tabListLeaveTimer.current);
  };
  const onTabListMouseLeave = () => {
    tabListLeaveTimer.current = setTimeout(() => setTabListOpen(false), 150);
  };

  const activeDoc = container.activeDocumentId
    ? state.documents[container.activeDocumentId]
    : null;

  const title = (() => {
    if (!activeDoc) return container.defaultTitle;
    if (container.prefixTitle && container.defaultTitle)
      return `${container.defaultTitle} – ${activeDoc.title}`;
    return activeDoc.title;
  })();
  const hasMultipleDocs = container.documentIds.length > 1;
  const showTabBar = container.allowTabs && hasMultipleDocs;
  const showTabListBtn = container.allowTabs;
  const tabListBtnDisabled = !hasMultipleDocs;

  // Doc toolbar: shown only if the active doc has toolbarMenus
  const docToolbarBlocks = activeDoc?.toolbarMenus ?? [];
  const showDocToolbar = docToolbarBlocks.length > 0;

  if (container.collapsed) {
    return (
      <div
        role="button"
        aria-label={`Expand ${title}`}
        className="doc-container-collapsed"
        style={{ width: '100%', position: 'relative' }}
        onClick={() => dispatch({
          type: 'TOGGLE_CONTAINER_COLLAPSE',
          rowId: container.rowId,
          instanceId: container.instanceId,
        })}
        title={`Expand ${title}`}
      >
        <div className="doc-container-collapsed-label">{title}</div>
        {flashKey > 0 && <div key={flashKey} className="container-flash-overlay" />}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`doc-container${isDragging ? ' drag-source' : ''}`}
      style={{ flex: 1, position: 'relative' }}
      onMouseEnter={onContainerMouseEnter}
      onMouseLeave={onContainerMouseLeave}
    >
      {/* Flash overlay — re-mounts on each key increment to re-trigger the animation */}
      {flashKey > 0 && <div key={flashKey} className="container-flash-overlay" />}

      {/* Tab/float-drop valid overlay — rendered via portal into document.body so no
          ancestor overflow:hidden can clip the border, including at the bottom
          of the bottom row. Position is fixed relative to the viewport. */}
      {showDropBorder && containerRef.current && createPortal(
        <div style={{
          position: 'fixed',
          ...containerRef.current.getBoundingClientRect().toJSON(),
          border: '2px solid var(--accent)',
          pointerEvents: 'none',
          zIndex: 1000,
        }} />,
        document.body,
      )}

      {/* Container titlebar */}
      <div className="container-titlebar">
        <span
          className="container-titlebar-title"
          style={{ cursor: container.allowDragMove ? 'grab' : 'default' }}
          onMouseDown={container.allowDragMove
            ? (e) => {
                // Single-tab containers with an allowAsTab doc: treat as a tab drag so the
                // user can merge it into another container or reorder it in the row.
                if (
                  container.allowTabs &&
                  container.documentIds.length === 1 &&
                  activeDoc?.allowAsTab
                ) {
                  e.preventDefault(); // stop browser text-selection during the drag
                  startTabDrag(activeDoc, container.instanceId, container.rowId, e, true);
                } else {
                  startDrag(container, container.rowId, e);
                }
              }
            : undefined}
        >{title}</span>

        {/* Collapse button — points toward the direction it will collapse */}
        <button
          className="container-titlebar-btn"
          title="Collapse"
          aria-label="Collapse panel"
          onClick={() => dispatch({
            type: 'TOGGLE_CONTAINER_COLLAPSE',
            rowId: container.rowId,
            instanceId: container.instanceId,
          })}
        >
          {isRightmost ? '›' : '‹'}
        </button>

        {/* Float button — shown when the active doc allows being floated */}
        {activeDoc?.allowClose && (
          <button
            className="container-titlebar-btn float-btn"
            title="Float panel"
            aria-label="Float panel"
            onClick={() => {
              if (!activeDoc || !containerRef.current) return;
              const rect = containerRef.current.getBoundingClientRect();
              // Open the floating panel offset slightly from the container's position
              dispatch({
                type: 'FLOAT_DOCUMENT',
                docInstanceId: activeDoc.instanceId,
                containerInstanceId: container.instanceId,
                rowId: container.rowId,
                containerIndex: container.rowIndex,
                x: rect.left + 24,
                y: rect.top + 24,
                width: FLOAT_DEFAULT_W,
                height: FLOAT_DEFAULT_H,
              });
            }}
          >
            ↗
          </button>
        )}

        {/* Tab list dropdown button */}
        {showTabListBtn && (
          <div
            style={{ position: 'relative', display: 'inline-flex' }}
            onMouseEnter={onTabListMouseEnter}
            onMouseLeave={onTabListMouseLeave}
          >
            <button
              className="container-titlebar-btn"
              title="Document list"
              aria-label="Document list"
              aria-haspopup="listbox"
              aria-expanded={tabListOpen}
              aria-disabled={tabListBtnDisabled}
              disabled={tabListBtnDisabled}
              onClick={() => setTabListOpen(o => !o)}
            >
              ⊞
            </button>

            {/* Tab list dropdown panel */}
            {tabListOpen && (
              <TabListDropdown container={container} onClose={() => setTabListOpen(false)} />
            )}
          </div>
        )}

        {/* Close button */}
        {container.allowClose && (
          <button
            className="container-titlebar-btn close-btn"
            title="Close panel"
            aria-label="Close panel"
            onClick={() => {
              if (activeDoc && activeDoc.allowClose) {
                dispatch({
                  type: 'CLOSE_DOCUMENT',
                  docInstanceId: activeDoc.instanceId,
                  containerInstanceId: container.instanceId,
                  rowId: container.rowId,
                  containerIndex: container.rowIndex,
                });
              } else {
                dispatch({
                  type: 'CLOSE_CONTAINER',
                  rowId: container.rowId,
                  instanceId: container.instanceId,
                });
              }
            }}
          >
            ×
          </button>
        )}

      </div>

      {/* Per-document toolbar */}
      {showDocToolbar && (
        <div className="doc-toolbar">
          <DocToolbarBlocks blockIds={docToolbarBlocks} />
        </div>
      )}

      {/* Document content area */}
      <div className="doc-area">
        <div className="doc-panel-host">
          {container.documentIds.map(docId => {
            const doc = state.documents[docId];
            if (!doc) return null;
            const isActive = container.activeDocumentId === docId;
            return (
              <div
                key={docId}
                style={{
                  display: isActive ? 'flex' : 'none',
                  flexDirection: 'column',
                  height: '100%',
                }}
              >
                <DocumentPanel doc={doc} container={container} />
              </div>
            );
          })}

          {container.documentIds.length === 0 && (
            <div style={{ padding: 16, color: 'var(--text-dim)', fontSize: 12 }}>
              No documents open
            </div>
          )}
        </div>
      </div>

      {/* Tab bar at bottom */}
      {showTabBar && <TabBar container={container} />}
    </div>
  );
}

// ── Doc toolbar: renders only the toolbar blocks relevant to this doc ────
// Uses the shared ToolbarButton component (same as the main toolbar) so
// submenu dropdowns work identically in both locations.
// Blocks are grouped into left / center / right zones matching their
// alignment property, mirroring the main toolbar zone layout.

function DocToolbarBlocks({ blockIds }: { blockIds: string[] }) {
  const { state } = useAppState();
  const { blockOrder, blocks } = state.toolbar;

  // Visible blocks for this document, in manifest order
  const filteredOrder = blockOrder.filter(id => blockIds.includes(id) && blocks[id]?.visible);

  if (filteredOrder.length === 0) return null;

  const leftIds   = filteredOrder.filter(id => (blocks[id]?.alignment ?? 'left') === 'left');
  const centerIds = filteredOrder.filter(id =>  blocks[id]?.alignment === 'center');
  const rightIds  = filteredOrder.filter(id =>  blocks[id]?.alignment === 'right');

  const renderZone = (ids: string[], zoneClass: string) => {
    if (ids.length === 0) return null;
    return (
      <div className={`toolbar-zone ${zoneClass}`}>
        {ids.map(id => {
          const block = blocks[id];
          if (!block) return null;
          return (
            <div key={id} className="toolbar-block" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              {block.items.map(item => (
                <ToolbarButton
                  key={item.id}
                  item={item}
                  blockDisabled={block.disabled}
                  labelMode={block.labelMode}
                />
              ))}
              <div className="toolbar-block-sep" />
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <>
      {renderZone(leftIds,   'toolbar-zone-left')}
      {centerIds.length > 0 && renderZone(centerIds, 'toolbar-zone-center')}
      {renderZone(rightIds,  'toolbar-zone-right')}
    </>
  );
}
