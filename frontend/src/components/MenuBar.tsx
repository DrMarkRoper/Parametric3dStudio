import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { MenuItem, MenuRootItem } from '../types';
import { useAppState } from '../contexts/AppStateContext';
import { actionRegistry } from '../utils/actionRegistry';
import { emitFlash, setPendingFlashDoc } from '../utils/containerFlash';

/**
 * Render an icon. Strings starting with `<svg` are injected as raw HTML so
 * callers can ship monochrome SVG glyphs (which inherit `currentColor`).
 * Other strings render as plain text (emoji or Unicode). Icon JSON is loaded
 * from local `/data/...` files we control, so the html surface is restricted.
 */
function IconNode({ icon, className, fallback = '' }: { icon?: string; className: string; fallback?: string }) {
  const text = icon ?? fallback;
  if (text.trimStart().startsWith('<svg')) {
    return <span className={className} dangerouslySetInnerHTML={{ __html: text }} />;
  }
  return <span className={className}>{text}</span>;
}

// ── Debug flag ───────────────────────────────────────────────────────────
// Flip to false to hide the "Closed Containers" section from the Window menu.
const SHOW_CLOSED_CONTAINERS_DEBUG = true;

// ── Menu keyboard-navigation helpers (pure) ──────────────────────────────

function isNavigable(item: MenuItem): boolean {
  return (
    item.visible !== false &&
    item.type !== 'separator' &&
    item.type !== 'section-title' &&
    !(item.disabled ?? false)
  );
}

function navigableItems(items: MenuItem[]): MenuItem[] {
  return items.filter(isNavigable);
}

/**
 * Return the items at the given path level.
 * path=[] → root items; path=['a','b'] → children of 'a' → children of 'b'.
 */
function itemsAtPath(root: MenuItem[], path: string[]): MenuItem[] {
  if (path.length === 0) return root;
  const head = root.find(i => i.id === path[0]);
  if (!head || head.type !== 'submenu' || !head.children?.length) return [];
  return itemsAtPath(head.children, path.slice(1));
}

/** Return the item pointed at by the last element of path. */
function itemAtPath(root: MenuItem[], path: string[]): MenuItem | null {
  if (path.length === 0) return null;
  const item = root.find(i => i.id === path[0]);
  if (!item) return null;
  if (path.length === 1) return item;
  if (item.type === 'submenu' && item.children) return itemAtPath(item.children, path.slice(1));
  return null;
}

// ── Recursive dropdown item renderer ────────────────────────────────────

interface DropdownItemProps {
  item: MenuItem;
  onClose: () => void;
  depth?: number;
  isKbFocused?: boolean;  // this item is the keyboard cursor leaf
  kbSubPath?: string[];   // non-empty → a descendant in this item's submenu has focus
}

function DropdownItem({
  item,
  onClose,
  depth = 0,
  isKbFocused = false,
  kbSubPath = [],
}: DropdownItemProps) {
  const [subOpen, setSubOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Drive native DOM focus when this item is the keyboard cursor.
  useEffect(() => {
    if (isKbFocused) btnRef.current?.focus();
  }, [isKbFocused]);

  if (item.visible === false) return null;
  if (item.type === 'separator') return <div className="menu-separator" role="separator" />;
  if (item.type === 'section-title') return <div className="menu-section-title" role="presentation">{item.label}</div>;

  const isDisabled  = item.disabled ?? false;
  const hasChildren = item.type === 'submenu' && (item.children?.length ?? 0) > 0;

  // Keep submenu open while the keyboard cursor is somewhere inside it.
  const effectiveSubOpen = subOpen || kbSubPath.length > 0;

  const handleClick = (e: React.MouseEvent) => {
    if (isDisabled) return;
    if (hasChildren) { e.stopPropagation(); setSubOpen(s => !s); return; }
    if (item.action) actionRegistry.invoke(item.action, item.actionArgs);
    onClose();
  };

  const handleTrailingClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.trailingAction) {
      actionRegistry.invoke(item.trailingAction.action, item.trailingAction.actionArgs);
    }
    onClose();
  };

  return (
    <div
      className="menu-submenu-container"
      onMouseEnter={() => hasChildren && setSubOpen(true)}
      onMouseLeave={() => hasChildren && setSubOpen(false)}
    >
      <button
        ref={btnRef}
        role="menuitem"
        className={`menu-dropdown-item${isDisabled ? ' disabled' : ''}${item.trailingAction ? ' has-trailing' : ''}`}
        disabled={isDisabled}
        aria-disabled={isDisabled}
        aria-haspopup={hasChildren ? 'menu' : undefined}
        aria-expanded={hasChildren ? effectiveSubOpen : undefined}
        onClick={handleClick}
      >
        <IconNode className="menu-item-icon" icon={item.icon} />
        <span className="menu-item-label">{item.label}</span>
        {item.shortcut && !hasChildren && (
          <span className="menu-item-shortcut">{item.shortcut}</span>
        )}
        {hasChildren && <span className="menu-item-arrow">›</span>}
        {item.trailingAction && (
          <span
            className={`menu-item-trailing${item.trailingAction.alwaysVisible ? ' always-visible' : ''}`}
            title={item.trailingAction.title}
            onClick={handleTrailingClick}
            role="button"
          >
            {item.trailingAction.icon}
          </span>
        )}
      </button>

      {hasChildren && effectiveSubOpen && (
        <div className="menu-submenu-flyout" role="menu">
          {item.children!.map(child => (
            <DropdownItem
              key={child.id}
              item={child}
              onClose={onClose}
              depth={depth + 1}
              isKbFocused={kbSubPath.length === 1 && kbSubPath[0] === child.id}
              kbSubPath={
                kbSubPath.length > 1 && kbSubPath[0] === child.id
                  ? kbSubPath.slice(1)
                  : []
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Dropdown panel ───────────────────────────────────────────────────────

interface DropdownProps {
  items: MenuItem[];
  anchorRect: DOMRect;
  onClose: () => void;
  kbPath: string[];
}

function Dropdown({ items, anchorRect, onClose, kbPath }: DropdownProps) {
  const ref = useRef<HTMLDivElement>(null);

  const style: React.CSSProperties = {
    top: anchorRect.bottom,
    left: anchorRect.left,
  };

  return (
    <div ref={ref} className="menu-dropdown" style={style} role="menu" onMouseDown={e => e.stopPropagation()}>
      {items.map(item => (
        <DropdownItem
          key={item.id}
          item={item}
          onClose={onClose}
          isKbFocused={kbPath.length === 1 && kbPath[0] === item.id}
          kbSubPath={
            kbPath.length > 1 && kbPath[0] === item.id
              ? kbPath.slice(1)
              : []
          }
        />
      ))}
    </div>
  );
}

// ── Dynamic Window menu builder ──────────────────────────────────────────

function useWindowMenuItems(): MenuItem[] {
  const { state, dispatch } = useAppState();
  const { documents, mdi } = state;

  // Collect all containers across both rows
  const allContainers = [
    ...mdi.topRow.containers,
    ...mdi.bottomRow.containers,
  ];

  const visibleDocs: MenuItem[] = [];
  const closedDocs: MenuItem[] = [];

  for (const [instanceId, doc] of Object.entries(documents)) {
    if (!doc.visible && !doc.closedState) continue;

    if (doc.visible) {
      visibleDocs.push({
        id: `win-open-${instanceId}`,
        type: 'action',
        label: doc.title,
        icon: '📄',
        action: '__focusDoc__',
        actionArgs: { instanceId },
        visible: true,
        disabled: false,
        children: [],
        trailingAction: doc.allowClose ? {
          icon: '×',
          title: 'Close document',
          action: '__closeDoc__',
          actionArgs: { instanceId },
          alwaysVisible: true,
        } : undefined,
      });
    } else {
      closedDocs.push({
        id: `win-closed-${instanceId}`,
        type: 'action',
        label: doc.title,
        icon: '↩',
        action: '__restoreDoc__',
        actionArgs: { instanceId },
        visible: true,
        disabled: false,
        children: [],
      });
    }
  }

  // Closed containers: visible=false, not killed (debug section)
  const closedContainers = SHOW_CLOSED_CONTAINERS_DEBUG
    ? allContainers.filter(c => !c.visible && !c.killed)
    : [];

  // Register transient actions for this render
  useEffect(() => {
    actionRegistry.register('__closeDoc__', (args) => {
      const id = String(args?.instanceId ?? '');
      for (const c of [...mdi.topRow.containers, ...mdi.bottomRow.containers]) {
        if (c.documentIds.includes(id)) {
          dispatch({
            type: 'CLOSE_DOCUMENT',
            docInstanceId: id,
            containerInstanceId: c.instanceId,
            rowId: c.rowId,
            containerIndex: c.rowIndex,
          });
          break;
        }
      }
    });
    actionRegistry.register('__restoreDoc__', (args) => {
      if (args?.instanceId) {
        const docId = String(args.instanceId);
        setPendingFlashDoc(docId);
        dispatch({ type: 'RESTORE_DOCUMENT', docInstanceId: docId });
      }
    });
    actionRegistry.register('__focusDoc__', (args) => {
      const id = String(args?.instanceId ?? '');
      for (const c of [...mdi.topRow.containers, ...mdi.bottomRow.containers]) {
        if (c.documentIds.includes(id)) {
          dispatch({ type: 'SET_ACTIVE_DOCUMENT', containerInstanceId: c.instanceId, docInstanceId: id });
          emitFlash(c.instanceId);
          break;
        }
      }
    });
    actionRegistry.register('__restoreContainer__', (args) => {
      const instanceId = String(args?.instanceId ?? '');
      const rowId = String(args?.rowId ?? '') as import('../types').RowId;
      if (instanceId && rowId) {
        dispatch({ type: 'RESTORE_CONTAINER', containerInstanceId: instanceId, rowId });
        emitFlash(instanceId);
      }
    });
  });

  const closedContainerItems: MenuItem[] = closedContainers.map(c => ({
    id: `win-cc-${c.instanceId}`,
    type: 'action' as const,
    label: c.defaultTitle || c.instanceId,
    icon: '🗂',
    action: '__restoreContainer__',
    actionArgs: { instanceId: c.instanceId, rowId: c.rowId },
    visible: true,
    disabled: false,
    children: [],
  }));

  const items: MenuItem[] = [
    ...visibleDocs,
    { id: 'win-sep', type: 'separator' },
    { id: 'win-closed-title', type: 'section-title', label: 'Closed' },
    ...closedDocs,
    // ── Debug: closed containers ─────────────────────────────────────────
    ...(SHOW_CLOSED_CONTAINERS_DEBUG ? [
      { id: 'win-cc-sep', type: 'separator' as const },
      { id: 'win-cc-title', type: 'section-title' as const, label: 'Closed Containers (debug)' },
      ...(closedContainerItems.length > 0
        ? closedContainerItems
        : [{ id: 'win-cc-empty', type: 'action' as const, label: 'None', visible: true, disabled: true, children: [] }]
      ),
    ] : []),
  ];

  return items;
}

// ── Main MenuBar ─────────────────────────────────────────────────────────

interface Props {
  menuDef: MenuRootItem[];
}

export function MenuBar({ menuDef }: Props) {
  const [openId, setOpenId]       = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  // Keyboard cursor: array of item IDs from root of the open dropdown down to
  // the focused item.  Empty = dropdown open but no keyboard cursor yet.
  const [kbPath, setKbPath]       = useState<string[]>([]);
  const barRef                    = useRef<HTMLDivElement>(null);
  // Stable map from menu ID → root button element (for programmatic opens)
  const rootButtonRefs            = useRef<Map<string, HTMLButtonElement>>(new Map());
  const windowItems               = useWindowMenuItems();

  // Always-current snapshot — lets native event handlers read fresh state
  // without being included in effect deps (avoids excess re-registrations).
  const live = useRef({ kbPath, openId, menuDef, windowItems });
  useEffect(() => { live.current = { kbPath, openId, menuDef, windowItems }; });

  const close = useCallback(() => {
    setOpenId(null);
    setAnchorRect(null);
    setKbPath([]);
  }, []);

  /**
   * Open a root menu by ID and immediately focus its first navigable item.
   * Used for keyboard-triggered root switching (← →).
   * Intentionally empty deps — reads everything through live ref.
   */
  const openByKeyboard = useCallback((id: string) => {
    const el = rootButtonRefs.current.get(id);
    if (!el) return;
    setOpenId(id);
    setAnchorRect(el.getBoundingClientRect());
    const { menuDef, windowItems } = live.current;
    const m = menuDef.find(m => m.id === id);
    const items = id === 'menu-window' ? windowItems : (m?.children ?? []);
    const first = navigableItems(items)[0];
    setKbPath(first ? [first.id] : []);
  }, []);

  // ── Close on outside click ────────────────────────────────────────────
  useEffect(() => {
    if (!openId) return;
    const handle = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [openId, close]);

  // ── Close on Escape ───────────────────────────────────────────────────
  useEffect(() => {
    if (!openId) return;
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [openId, close]);

  // ── Arrow-key / Enter navigation within the open dropdown ────────────
  useEffect(() => {
    if (!openId) return;

    const handle = (e: KeyboardEvent) => {
      const NAV_KEYS = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Tab'];
      if (!NAV_KEYS.includes(e.key)) return;

      // Tab key: close the dropdown and let the browser move focus normally.
      if (e.key === 'Tab') { close(); return; }

      // Always read from live ref so we never have stale kbPath / items
      const { kbPath, openId, menuDef, windowItems } = live.current;
      if (!openId) return;

      const rootItems = openId === 'menu-window'
        ? windowItems
        : (menuDef.find(m => m.id === openId)?.children ?? []);
      const visMenus = menuDef.filter(m => m.visible && !m.disabled);
      const rootIdx  = visMenus.findIndex(m => m.id === openId);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (kbPath.length === 0) {
          // No cursor yet — jump to first item
          const first = navigableItems(rootItems)[0];
          if (first) setKbPath([first.id]);
        } else {
          const parentPath = kbPath.slice(0, -1);
          const siblings   = navigableItems(itemsAtPath(rootItems, parentPath));
          const curId      = kbPath[kbPath.length - 1];
          const idx        = siblings.findIndex(i => i.id === curId);
          if (idx < siblings.length - 1) setKbPath([...parentPath, siblings[idx + 1].id]);
          // At last item — no wrap (matches native OS behaviour)
        }

      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (kbPath.length === 0) {
          // No cursor — jump to last item
          const items = navigableItems(rootItems);
          const last  = items[items.length - 1];
          if (last) setKbPath([last.id]);
        } else {
          const parentPath = kbPath.slice(0, -1);
          const siblings   = navigableItems(itemsAtPath(rootItems, parentPath));
          const curId      = kbPath[kbPath.length - 1];
          const idx        = siblings.findIndex(i => i.id === curId);
          if (idx > 0) setKbPath([...parentPath, siblings[idx - 1].id]);
        }

      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (kbPath.length === 0) {
          // No cursor, right → next root menu
          if (rootIdx < visMenus.length - 1) openByKeyboard(visMenus[rootIdx + 1].id);
        } else {
          const item = itemAtPath(rootItems, kbPath);
          if (item?.type === 'submenu' && (item.children?.length ?? 0) > 0) {
            // Enter submenu
            const first = navigableItems(item.children!)[0];
            if (first) setKbPath([...kbPath, first.id]);
          } else if (kbPath.length === 1) {
            // Root-level non-submenu item → switch to next root menu
            if (rootIdx < visMenus.length - 1) openByKeyboard(visMenus[rootIdx + 1].id);
          }
        }

      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (kbPath.length > 1) {
          // Exit submenu — return focus to parent item
          setKbPath(kbPath.slice(0, -1));
        } else {
          // At root dropdown level → switch to prev root menu
          if (rootIdx > 0) openByKeyboard(visMenus[rootIdx - 1].id);
        }

      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (kbPath.length === 0) return;
        const item = itemAtPath(rootItems, kbPath);
        if (!item) return;
        if (item.type === 'submenu' && (item.children?.length ?? 0) > 0) {
          // Treat Enter on a submenu item the same as →
          const first = navigableItems(item.children!)[0];
          if (first) setKbPath([...kbPath, first.id]);
        } else if (item.action) {
          actionRegistry.invoke(item.action, item.actionArgs);
          close();
        }
      }
    };

    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [openId, close, openByKeyboard]);

  // ── Root button handlers ──────────────────────────────────────────────

  const handleRootClick = (id: string, e: React.MouseEvent<HTMLButtonElement>) => {
    if (openId === id) { close(); return; }
    setOpenId(id);
    setAnchorRect(e.currentTarget.getBoundingClientRect());
    setKbPath([]); // mouse open — no kb cursor until user presses arrows
  };

  const handleRootMouseEnter = (id: string, e: React.MouseEvent<HTMLButtonElement>) => {
    if (openId && openId !== id) {
      setOpenId(id);
      setAnchorRect(e.currentTarget.getBoundingClientRect());
      setKbPath([]); // switching via mouse — clear kb cursor
    }
  };

  const openMenu = menuDef.find(m => m.id === openId);
  const openItems = openMenu
    ? openMenu.id === 'menu-window' ? windowItems : openMenu.children
    : null;

  return (
    <div ref={barRef} className="menubar" role="menubar">
      {menuDef
        .filter(m => m.visible)
        .map(menu => (
          <button
            key={menu.id}
            ref={el => {
              if (el) rootButtonRefs.current.set(menu.id, el);
              else    rootButtonRefs.current.delete(menu.id);
            }}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openId === menu.id}
            aria-disabled={menu.disabled}
            className={`menubar-item${openId === menu.id ? ' open' : ''}`}
            disabled={menu.disabled}
            onClick={e => handleRootClick(menu.id, e)}
            onMouseEnter={e => handleRootMouseEnter(menu.id, e)}
            onKeyDown={e => {
              // ArrowDown from a focused root button opens the menu with kb focus
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                openByKeyboard(menu.id);
              }
            }}
          >
            {menu.label}
          </button>
        ))}

      {openId && openItems && anchorRect && createPortal(
        <Dropdown items={openItems} anchorRect={anchorRect} onClose={close} kbPath={kbPath} />,
        document.body,
      )}
    </div>
  );
}
