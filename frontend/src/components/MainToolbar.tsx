import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { MenuItem, ToolbarBlockState, ToolbarAlignment } from '../types';
import { useAppState } from '../contexts/AppStateContext';
import { actionRegistry } from '../utils/actionRegistry';

/**
 * Render an icon string inline. When the string begins with `<svg` it is
 * inserted as raw HTML so callers can ship monochrome SVG glyphs (which
 * inherit `currentColor` and so participate in hover / disabled colouring).
 * Otherwise the string is rendered as plain text (emoji or Unicode glyph).
 *
 * Icon JSON is loaded from local `/data/...` files we control, so the html
 * injection surface is intentionally restricted to that input.
 */
function IconNode({ icon, className, fallback = '' }: { icon?: string; className: string; fallback?: string }) {
  const text = icon ?? fallback;
  if (text.trimStart().startsWith('<svg')) {
    return <span className={className} dangerouslySetInnerHTML={{ __html: text }} />;
  }
  return <span className={className}>{text}</span>;
}

// ── ToolbarMenuPortal ────────────────────────────────────────────────────
//
// Renders a toolbar submenu dropdown into document.body via a React portal,
// positioned with `position: fixed` so it is never clipped by ancestor
// overflow:hidden containers (MDI rows, document panels, etc.).
//
// Supports nested submenus: items with type='submenu' inside the portal
// open a second-level flyout panel on hover, positioned to the right.

export interface ToolbarMenuPortalProps {
  items: MenuItem[];
  anchorRect: DOMRect;
  onClose: () => void;
}

// ── Nested submenu item (within a portal dropdown) ───────────────────────
// Opens a fixed-position flyout to the right on hover, with a short
// delay on leave so the mouse can travel into the flyout without it closing.

interface PortalSubmenuItemProps {
  item: MenuItem;
  onClose: () => void;
  zIndex: number;
}

function PortalSubmenuItem({ item, onClose, zIndex }: PortalSubmenuItemProps) {
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [flyoutPos, setFlyoutPos] = useState<{ top: number; left: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleClose = () => {
    closeTimer.current = setTimeout(() => setFlyoutOpen(false), 100);
  };
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };

  const handleRowMouseEnter = () => {
    cancelClose();
    if (rowRef.current) {
      const r = rowRef.current.getBoundingClientRect();
      // Open flyout to the right; if it would overflow viewport, open to the left.
      const flyoutWidth = 180;
      const spaceRight = window.innerWidth - r.right;
      const left = spaceRight >= flyoutWidth ? r.right : r.left - flyoutWidth;
      setFlyoutPos({ top: r.top - 3, left });
    }
    setFlyoutOpen(true);
  };

  const handleRowMouseLeave = scheduleClose;
  const handleFlyoutMouseEnter = cancelClose;
  const handleFlyoutMouseLeave = scheduleClose;

  const isDisabled = item.disabled ?? false;

  return (
    <div
      ref={rowRef}
      className="menu-submenu-container"
      onMouseEnter={handleRowMouseEnter}
      onMouseLeave={handleRowMouseLeave}
    >
      <button
        role="menuitem"
        className="menu-dropdown-item"
        disabled={isDisabled}
        aria-disabled={isDisabled}
        aria-haspopup="menu"
        aria-expanded={flyoutOpen}
      >
        <IconNode className="menu-item-icon" icon={item.icon} />
        <span className="menu-item-label">{item.label}</span>
        <span className="menu-item-arrow">›</span>
      </button>

      {flyoutOpen && flyoutPos && createPortal(
        <div
          className="toolbar-btn-dropdown"
          role="menu"
          style={{
            position: 'fixed',
            top: flyoutPos.top,
            left: flyoutPos.left,
            zIndex: zIndex + 100,
            minWidth: 180,
          }}
          onMouseEnter={handleFlyoutMouseEnter}
          onMouseLeave={handleFlyoutMouseLeave}
        >
          {(item.children ?? []).map(child => renderPortalItem(child, onClose, zIndex + 100))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── Shared renderer for portal dropdown items ────────────────────────────
// Handles all four MenuItem types including nested submenus.

function renderPortalItem(child: MenuItem, onClose: () => void, zIndex: number) {
  if (child.visible === false) return null;
  if (child.type === 'separator') {
    return <div key={child.id} className="menu-separator" role="separator" />;
  }
  if (child.type === 'section-title') {
    return (
      <div key={child.id} className="menu-section-title" role="presentation">
        {child.label}
      </div>
    );
  }
  if (child.type === 'submenu' && (child.children?.length ?? 0) > 0) {
    return (
      <PortalSubmenuItem key={child.id} item={child} onClose={onClose} zIndex={zIndex} />
    );
  }
  // Default: action (or submenu with no children — treated as disabled action)
  return (
    <button
      key={child.id}
      role="menuitem"
      className="menu-dropdown-item"
      disabled={child.disabled ?? false}
      aria-disabled={child.disabled ?? false}
      onClick={() => {
        if (child.action) actionRegistry.invoke(child.action, child.actionArgs);
        onClose();
      }}
    >
      <IconNode className="menu-item-icon" icon={child.icon} />
      <span className="menu-item-label">{child.label}</span>
      {child.shortcut && <span className="menu-item-shortcut">{child.shortcut}</span>}
    </button>
  );
}

export function ToolbarMenuPortal({ items, anchorRect, onClose }: ToolbarMenuPortalProps) {
  const dropRef = useRef<HTMLDivElement>(null);
  // Must sit above floating panels (800–899) and modals (900+).
  const BASE_Z = 1100;

  // Close when clicking outside the portal panel
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [onClose]);

  return createPortal(
    <div
      ref={dropRef}
      className="toolbar-btn-dropdown"
      role="menu"
      style={{
        position: 'fixed',
        top:  anchorRect.bottom + 2,
        left: anchorRect.left,
        zIndex: BASE_Z,
      }}
    >
      {items.map(child => renderPortalItem(child, onClose, BASE_Z))}
    </div>,
    document.body,
  );
}

// ── Toolbar button (action or portal submenu) ────────────────────────────

interface ToolbarButtonProps {
  item: MenuItem;
  blockDisabled: boolean;
  /** 'icon-title' shows icon + label below; 'icon-only' shows icon only with tooltip. */
  labelMode: 'icon-title' | 'icon-only';
}

export function ToolbarButton({ item, blockDisabled, labelMode }: ToolbarButtonProps) {
  const [dropOpen,   setDropOpen]   = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  if (item.visible === false) return null;
  if (item.type === 'separator') return <div className="toolbar-block-sep" />;
  if (item.type === 'section-title') return null;

  const isDisabled  = blockDisabled || (item.disabled ?? false);
  const hasChildren = item.type === 'submenu' && (item.children?.length ?? 0) > 0;

  const handleClick = () => {
    if (isDisabled) return;
    if (hasChildren) {
      if (btnRef.current) setAnchorRect(btnRef.current.getBoundingClientRect());
      setDropOpen(o => !o);
      return;
    }
    if (item.action) actionRegistry.invoke(item.action, item.actionArgs);
  };

  // Tooltip logic:
  //   icon-only  → always show tooltip: "Label (Ctrl+S)" or just "Label"
  //   icon-title → show tooltip only if shortcut adds information the label doesn't
  const tooltipText = (() => {
    if (labelMode === 'icon-only') {
      return item.shortcut ? `${item.label} (${item.shortcut})` : item.label;
    }
    // icon-title: label is already visible, only add tooltip when there's a shortcut
    return item.shortcut ? `${item.label} (${item.shortcut})` : undefined;
  })();

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        className="toolbar-btn"
        data-action={item.action}
        disabled={isDisabled}
        aria-disabled={isDisabled}
        aria-haspopup={hasChildren ? 'menu' : undefined}
        aria-expanded={hasChildren ? dropOpen : undefined}
        onClick={handleClick}
        title={tooltipText}
      >
        <span className="toolbar-btn-content">
          <IconNode className="toolbar-btn-icon" icon={item.icon} fallback="▪" />
          {labelMode === 'icon-title' && (
            <span className="toolbar-btn-label">{item.label}</span>
          )}
        </span>
        {hasChildren && <span className="toolbar-btn-chevron">▾</span>}
      </button>

      {hasChildren && dropOpen && anchorRect && (
        <ToolbarMenuPortal
          items={item.children!}
          anchorRect={anchorRect}
          onClose={() => setDropOpen(false)}
        />
      )}
    </div>
  );
}

// ── Single toolbar block ─────────────────────────────────────────────────

interface ToolbarBlockProps {
  block: ToolbarBlockState;
  dragIndex: number;
  onDragStart: (e: React.MouseEvent, index: number) => void;
  isDragOver: boolean;
  dropIsNoOp: boolean;
}

function ToolbarBlock({ block, dragIndex, onDragStart, isDragOver, dropIsNoOp }: ToolbarBlockProps) {
  if (!block.visible) return null;

  return (
    <>
      {isDragOver && <div className={`toolbar-drop-indicator${dropIsNoOp ? ' no-op' : ''}`} />}
      <div className="toolbar-block">
        {/* Drag handle — 6 dots */}
        <span
          className="toolbar-block-drag-handle"
          title={`Drag to reorder "${block.title}" block`}
          onMouseDown={(e) => onDragStart(e, dragIndex)}
        >
          ⠿
        </span>
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
    </>
  );
}

// ── Zone-local drag hook ─────────────────────────────────────────────────
// Encapsulates the mouse-drag reorder logic for a single alignment zone.
// Returns state + a mousedown handler to attach to each block's drag handle.

interface ZoneDragState {
  dragSrc:   number | null;
  dropIndex: number | null;
}

function useZoneDrag(
  zoneRef: React.RefObject<HTMLDivElement | null>,
  zoneIds: string[],
  onDrop: (newZoneIds: string[]) => void,
) {
  const dragSrcRef  = useRef<number | null>(null);
  const dropDestRef = useRef<number | null>(null);
  const zoneIdsRef  = useRef(zoneIds);
  zoneIdsRef.current = zoneIds;

  const [state, setState] = useState<ZoneDragState>({ dragSrc: null, dropIndex: null });

  const handleDragStart = useCallback((e: React.MouseEvent, srcIndex: number) => {
    e.preventDefault();
    dragSrcRef.current = srcIndex;
    dropDestRef.current = null;
    setState({ dragSrc: srcIndex, dropIndex: null });
    document.body.style.cursor = 'grabbing';

    const onMouseMove = (ev: MouseEvent) => {
      const zone = zoneRef.current;
      if (!zone) return;
      const blockEls = Array.from(zone.querySelectorAll(':scope > .toolbar-block'));
      let dropAt = blockEls.length;
      for (let i = 0; i < blockEls.length; i++) {
        const r = blockEls[i].getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) { dropAt = i; break; }
      }
      dropDestRef.current = dropAt;
      setState(s => ({ ...s, dropIndex: dropAt }));
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      const from = dragSrcRef.current;
      const to   = dropDestRef.current;
      if (from !== null && to !== null) {
        const insertAt = to > from ? to - 1 : to;
        if (from !== insertAt) {
          const order = [...zoneIdsRef.current];
          const [moved] = order.splice(from, 1);
          order.splice(insertAt, 0, moved);
          onDrop(order);
        }
      }
      dragSrcRef.current  = null;
      dropDestRef.current = null;
      setState({ dragSrc: null, dropIndex: null });
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);
  }, [zoneRef, onDrop]);

  const isNoOp = (dest: number) =>
    state.dragSrc !== null && (dest === state.dragSrc || dest === state.dragSrc + 1);

  return { state, handleDragStart, isNoOp };
}

// ── Toolbar Zone ─────────────────────────────────────────────────────────
// Renders a single alignment zone with its own drag reorder.

interface ToolbarZoneProps {
  alignment: ToolbarAlignment;
  zoneIds:   string[];
  blocks:    Record<string, ToolbarBlockState>;
  onReorder: (alignment: ToolbarAlignment, newZoneIds: string[]) => void;
}

function ToolbarZone({ alignment, zoneIds, blocks, onReorder }: ToolbarZoneProps) {
  const zoneRef = useRef<HTMLDivElement>(null);

  const handleDrop = useCallback(
    (newZoneIds: string[]) => onReorder(alignment, newZoneIds),
    [alignment, onReorder],
  );

  const { state, handleDragStart, isNoOp } = useZoneDrag(zoneRef, zoneIds, handleDrop);

  return (
    <div
      ref={zoneRef}
      className={`toolbar-zone toolbar-zone-${alignment}`}
    >
      {zoneIds.map((id, i) => {
        const block = blocks[id];
        if (!block) return null;
        return (
          <ToolbarBlock
            key={id}
            block={block}
            dragIndex={i}
            onDragStart={handleDragStart}
            isDragOver={state.dropIndex === i}
            dropIsNoOp={isNoOp(i)}
          />
        );
      })}
      {/* Trailing drop indicator when dragging past the last block */}
      {state.dropIndex === zoneIds.length && (
        <div className={`toolbar-drop-indicator${isNoOp(zoneIds.length) ? ' no-op' : ''}`} />
      )}
    </div>
  );
}

// ── Main Toolbar ─────────────────────────────────────────────────────────

export function MainToolbar() {
  const { state, dispatch } = useAppState();
  const { blockOrder, blocks } = state.toolbar;

  // Partition visible blocks into three alignment zones.
  // Blocks without an explicit alignment default to 'left'.
  const visibleOrder = blockOrder.filter(id => blocks[id]?.visible);

  const leftIds   = visibleOrder.filter(id => (blocks[id]?.alignment ?? 'left') === 'left');
  const centerIds = visibleOrder.filter(id =>  blocks[id]?.alignment === 'center');
  const rightIds  = visibleOrder.filter(id =>  blocks[id]?.alignment === 'right');

  // When a zone reorders, rebuild the full blockOrder by preserving the
  // canonical order of the other two zones and replacing only the reordered zone.
  const handleReorder = useCallback((
    alignment: ToolbarAlignment,
    newZoneIds: string[],
  ) => {
    // All hidden blocks stay in their current positions in blockOrder.
    // Replace visible ids of the changed zone; keep other zones intact.
    const newLeft   = alignment === 'left'   ? newZoneIds : leftIds;
    const newCenter = alignment === 'center' ? newZoneIds : centerIds;
    const newRight  = alignment === 'right'  ? newZoneIds : rightIds;

    // Rebuild blockOrder: hidden blocks are not in any zone list, so append them at the end.
    const visibleSet = new Set([...newLeft, ...newCenter, ...newRight]);
    const hiddenIds  = blockOrder.filter(id => !visibleSet.has(id));

    dispatch({
      type: 'REORDER_TOOLBAR',
      newOrder: [...newLeft, ...newCenter, ...newRight, ...hiddenIds],
    });
  }, [dispatch, blockOrder, leftIds, centerIds, rightIds]);

  return (
    <div className="main-toolbar" role="toolbar" aria-label="Main toolbar">
      <ToolbarZone
        alignment="left"
        zoneIds={leftIds}
        blocks={blocks}
        onReorder={handleReorder}
      />
      {centerIds.length > 0 && (
        <ToolbarZone
          alignment="center"
          zoneIds={centerIds}
          blocks={blocks}
          onReorder={handleReorder}
        />
      )}
      <ToolbarZone
        alignment="right"
        zoneIds={rightIds}
        blocks={blocks}
        onReorder={handleReorder}
      />
    </div>
  );
}
