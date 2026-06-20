// ── Floating windows ───────────────────────────────────────────────────────

export interface FloatingWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
}

// ── Modal dialogs ─────────────────────────────────────────────────────────

export type ModalButtonVariant = 'default' | 'primary' | 'danger';
export type ModalButtonAlignment = 'left' | 'center' | 'right';

export interface ModalButton {
  label: string;
  /** actionRegistry key to invoke on click. Omit for a pure close button. */
  action?: string;
  /** Static args forwarded to the action. For dynamic form data, the content
   *  component should register a capturing handler on mount. */
  args?: Record<string, unknown>;
  /** Alignment zone in the button bar (default: 'right') */
  alignment?: ModalButtonAlignment;
  variant?: ModalButtonVariant;
  /**
   * Controls whether the modal closes after the action runs.
   *
   *   `false` / omitted — never closes (action handles close itself, if needed).
   *   `true`            — closes synchronously after invoking the action,
   *                       regardless of whether the action succeeded.
   *   `'on-success'`    — awaits the action's return value. The modal closes
   *                       only if the returned promise resolves (or the
   *                       handler returns synchronously without throwing).
   *                       A thrown error or a rejected promise leaves the
   *                       modal open so the handler can display a validation
   *                       error inline (e.g. via `setError`).
   *
   * Default: `false`.
   */
  closesModal?: boolean | 'on-success';
  /**
   * Keyboard keys that trigger this button (e.g. ['Enter'], ['Escape']).
   * Only the topmost open modal processes key bindings.
   * Keys not listed on any button have no effect.
   */
  keys?: string[];
}

export interface ModalState {
  id: string;
  title: string;
  /** Key into MODAL_REGISTRY in ModalDialog.tsx */
  componentType: string;
  width?: number;
  height?: number;
  /** Arbitrary props forwarded to the modal component */
  props?: Record<string, unknown>;
  /** Show × in title bar (default: true) */
  allowClose?: boolean;
  /** actionRegistry key invoked when the × button is clicked (fires before close) */
  onCloseAction?: string;
  /** Bottom button bar items */
  buttons?: ModalButton[];
  /** Show bottom-right resize handle (default: true) */
  allowResize?: boolean;
  /** Minimum width (px) when resizing */
  minWidth?: number;
  /** Minimum height (px) when resizing */
  minHeight?: number;
}

// ── Shared Menu / Toolbar types ────────────────────────────────────────────

export type MenuItemType = 'action' | 'separator' | 'section-title' | 'submenu';

export interface ShortcutKey {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  key: string;
}

export interface MenuItemTrailingAction {
  icon: string;
  title?: string;
  action: string;
  actionArgs?: Record<string, unknown>;
  /** When true the icon is always visible; when false (default) it appears only on row hover. */
  alwaysVisible?: boolean;
}

export interface MenuItem {
  id: string;
  type: MenuItemType;
  label?: string;
  icon?: string;
  shortcut?: string;
  shortcutKey?: ShortcutKey;
  action?: string;
  actionArgs?: Record<string, unknown>;
  visible?: boolean;
  disabled?: boolean;
  children?: MenuItem[];
  /** Optional secondary button rendered on the right side of the item. */
  trailingAction?: MenuItemTrailingAction;
}

export interface MenuRootItem {
  id: string;
  label: string;
  visible: boolean;
  disabled: boolean;
  children: MenuItem[];
}

// ── Toolbar ────────────────────────────────────────────────────────────────

export type ToolbarAlignment = 'left' | 'center' | 'right';
export type ToolbarLabelMode = 'icon-title' | 'icon-only';

export interface ToolbarBlockDef {
  id: string;
  title: string;
  menuFile: string;
  visible: boolean;
  disabled: boolean;
  /** Which end of the toolbar this block anchors to. Defaults to 'left'. */
  alignment?: ToolbarAlignment;
  /** Whether buttons show icon + label text, or icon only. Defaults to 'icon-title'. */
  labelMode?: ToolbarLabelMode;
}

export interface ToolbarBlockState {
  id: string;
  title: string;
  menuFile: string;
  visible: boolean;
  disabled: boolean;
  items: MenuItem[];
  /** Which end of the toolbar this block anchors to. Defaults to 'left'. */
  alignment: ToolbarAlignment;
  /** Whether buttons show icon + label text, or icon only. Defaults to 'icon-title'. */
  labelMode: ToolbarLabelMode;
}

// ── Document Panels ────────────────────────────────────────────────────────

export interface DocumentWidth {
  default: number;
  current: number;
  fixed: boolean;
}

export type RowId = 'row-top' | 'row-bottom';

export interface ClosedDocState {
  containerId: string;
  rowId: RowId;
  containerIndex: number;
}

export interface DefaultContainerOpts {
  allowTabs?: boolean;
  allowClose?: boolean;
  forceCloseOnEmpty?: boolean;
  killOnClose?: boolean;
  restrictTabToTypes?: string[];
}

export interface DocumentPanelState {
  id: string;
  instanceId: string;
  componentType: string;
  /**
   * Full descriptive title — used for the container header, the Window menu,
   * the floating-panel title bar, and the tooltip shown when hovering a tab.
   */
  title: string;
  /**
   * Optional short label for the tab bar (and tab-list dropdown). Use this
   * when the document title is too long to be readable as a tab — for
   * example: `title: "Q1 2026 Revenue Reconciliation, draft 3"`,
   * `tabTitle: "Q1 Revenue"`.
   *
   * Falls back to `title` when omitted. Even when set, the framework still
   * applies a CSS `max-width` + ellipsis to tabs as a defensive fallback,
   * so apps that forget to set `tabTitle` still get a sensible display.
   */
  tabTitle?: string;
  visible: boolean;
  allowClose: boolean;
  killOnClose: boolean;
  allowAsTab: boolean;
  restrictToTabTypes: string[];
  width: DocumentWidth;
  toolbarMenus: string[];
  closedState: ClosedDocState | null;
  defaultContainerOptions: DefaultContainerOpts | null;
  /** Non-null while the panel is floating above the MDI workspace. */
  floating: FloatingWindowState | null;
  /** True while the panel is open in a separate browser window. */
  poppedOut: boolean;
  /** Show resize handles when floating (default: true) */
  floatResizable?: boolean;
  /** Minimum width (px) when floating — overrides the built-in floor */
  floatMinWidth?: number;
  /** Minimum height (px) when floating — overrides the built-in floor */
  floatMinHeight?: number;
}

// ── Document Containers ────────────────────────────────────────────────────

export interface DocumentContainerState {
  id: string;
  instanceId: string;
  widthPercent: number;     // flex weight — not strictly %, used as flex ratio
  collapsed: boolean;
  visible: boolean;
  killed: boolean;
  allowTabs: boolean;
  allowClose: boolean;
  allowDragMove: boolean;
  forbidDropBefore: boolean;
  forbidDropAfter: boolean;
  forceCloseOnEmpty: boolean;
  killOnClose: boolean;
  resizable: boolean;
  defaultWidth: number;
  defaultTitle: string;
  /** When true, the displayed title is "{defaultTitle} – {activeDoc.title}" */
  prefixTitle: boolean;
  restrictTabToTypes: string[];
  activeDocumentId: string | null;
  documentIds: string[];
  rowId: RowId;
  rowIndex: number;
}

// ── MDI Rows ───────────────────────────────────────────────────────────────

export interface MDIRowState {
  id: RowId;
  visible: boolean;
  collapsed: boolean;
  containers: DocumentContainerState[];
}

// ── Full App State ─────────────────────────────────────────────────────────

export interface MainToolbarState {
  blockOrder: string[];
  blocks: Record<string, ToolbarBlockState>;
}

export interface StatusBarState {
  visible: boolean;
  allowClose: boolean;
  /** Permanent message — shown whenever there is no active interrupt. */
  text: string;
  /** Temporary override text (toast-style). Null when no interrupt is active. */
  interruptText: string | null;
  /** How long the interrupt lasts in milliseconds. Null when no interrupt is active. */
  interruptDuration: number | null;
}

export interface MDIWorkspaceState {
  rowSplit: number;           // flex weight for top row
  rowResizeDisabled: boolean;
  topRow: MDIRowState;
  bottomRow: MDIRowState;
}

export interface AppState {
  theme: 'dark' | 'light';
  mdi: MDIWorkspaceState;
  toolbar: MainToolbarState;
  statusBar: StatusBarState;
  documents: Record<string, DocumentPanelState>;
  /** Active modal dialogs (bottom of stack = oldest). */
  modals: ModalState[];
  /** Monotonically increasing counter used to assign z-index to floating panels. */
  floatZCounter: number;
}

// ── Reducer Actions ────────────────────────────────────────────────────────

export type AppAction =
  | { type: 'SET_THEME'; theme: 'dark' | 'light' }
  | { type: 'SET_TOOLBAR_BLOCK_VISIBLE'; blockId: string; visible: boolean }
  | { type: 'SET_ROW_SPLIT'; split: number }
  | { type: 'TOGGLE_ROW_COLLAPSE'; rowId: RowId }
  | { type: 'SET_ROW_VISIBLE'; rowId: RowId; visible: boolean }
  | { type: 'SET_CONTAINER_FLEX'; rowId: RowId; instanceId: string; flex: number; neighborInstanceId: string; neighborFlex: number }
  | { type: 'TOGGLE_CONTAINER_COLLAPSE'; rowId: RowId; instanceId: string }
  | { type: 'CLOSE_CONTAINER'; rowId: RowId; instanceId: string }
  | { type: 'SET_ACTIVE_DOCUMENT'; containerInstanceId: string; docInstanceId: string }
  | { type: 'CLOSE_DOCUMENT'; docInstanceId: string; containerInstanceId: string; rowId: RowId; containerIndex: number }
  | { type: 'RESTORE_DOCUMENT'; docInstanceId: string }
  | { type: 'REORDER_TOOLBAR'; newOrder: string[] }
  | { type: 'SET_STATUS'; text: string }
  | { type: 'SET_STATUS_INTERRUPT'; text: string; duration: number }
  | { type: 'CLEAR_STATUS_INTERRUPT' }
  | { type: 'TOGGLE_STATUS_BAR' }
  | { type: 'LOAD_STATE'; state: AppState }
  | { type: 'MOVE_CONTAINER'; containerInstanceId: string; sourceRowId: RowId; targetRowId: RowId; targetIndex: number }
  | { type: 'MOVE_DOCUMENT_TAB'; docInstanceId: string; sourceContainerInstanceId: string; sourceRowId: RowId; targetContainerInstanceId: string; targetRowId: RowId }
  | { type: 'REORDER_DOCUMENT_TABS'; containerInstanceId: string; rowId: RowId; docInstanceId: string; targetIndex: number }
  | { type: 'INSERT_CONTAINER_WITH_DOC'; docInstanceId: string; sourceContainerInstanceId: string; sourceRowId: RowId; targetRowId: RowId; insertAfterContainerId?: string; insertAtIndex?: number }
  | { type: 'RESTORE_CONTAINER'; containerInstanceId: string; rowId: RowId }
  // ── Floating panel actions ─────────────────────────────────────────────
  /** Detach a docked document from its container and make it float. */
  | { type: 'FLOAT_DOCUMENT'; docInstanceId: string; containerInstanceId: string; rowId: RowId; containerIndex: number; x: number; y: number; width: number; height: number }
  /** Close (hide) a floating panel — records closedState so Window menu can restore it. */
  | { type: 'CLOSE_FLOATING'; docInstanceId: string }
  /** Dock a floating panel into a specific existing container. */
  | { type: 'DOCK_DOCUMENT'; docInstanceId: string; targetContainerInstanceId: string; targetRowId: RowId }
  /** Dock a floating panel into a new container at a gap position. */
  | { type: 'DOCK_DOCUMENT_AT'; docInstanceId: string; targetRowId: RowId; insertAfterContainerId?: string; insertAtIndex?: number }
  /** Update the position/size of a floating panel (on move or resize). */
  | { type: 'SET_FLOAT_GEOMETRY'; docInstanceId: string; x?: number; y?: number; width?: number; height?: number }
  /** Bring a floating panel to the front (increment its zIndex). */
  | { type: 'BRING_FLOAT_TO_FRONT'; docInstanceId: string }
  /** Toggle the minimized state of a floating panel. */
  | { type: 'MINIMIZE_FLOAT'; docInstanceId: string }
  // ── Browser popout actions ────────────────────────────────────────────
  /** Detach a document (docked or floating) into a separate browser window. */
  | { type: 'POP_OUT_DOCUMENT'; docInstanceId: string; containerInstanceId: string; rowId: RowId; containerIndex: number }
  /** Return a popped-out document to the main window (dispatched on popout close). */
  | { type: 'POP_IN_DOCUMENT'; docInstanceId: string }
  // ── Modal dialog actions ──────────────────────────────────────────────
  /** Open a new modal dialog (id is assigned by the reducer). */
  | { type: 'OPEN_MODAL'; modal: Omit<ModalState, 'id'> }
  /** Close a modal by its id. */
  | { type: 'CLOSE_MODAL'; id: string };
