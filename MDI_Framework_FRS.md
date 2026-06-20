# MDI Framework v0.1 — Functional Requirements Specification

> **Stack:** React 18 + TypeScript  
> **Styling:** CSS custom properties per `style_guide.md` (dark-mode first, amber `#f5a623` accent)  
> **Persistence:** `localStorage` for session state; JSON file import/export for layout snapshots  
> **Key principle:** A full browser refresh must restore the exact layout the user left.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Application State Model](#2-application-state-model)
   - 2.1 Root State
   - 2.2 MDI Workspace State
   - 2.3 Document Container State
   - 2.4 Document Panel State
   - 2.5 Main Toolbar State
   - 2.6 Menu Bar State
   - 2.7 Status Bar State
   - 2.8 Document Registry
   - 2.9 Floating Window State
   - 2.10 Modal State & Modal Button
3. [JSON Formats — Reference](#3-json-formats--reference)
4. [Component Specifications](#4-component-specifications)
   - 4.1 Title Bar
   - 4.2 Menu Bar
   - 4.3 Main Toolbar
   - 4.4 MDI Workspace
   - 4.5 Document Container
   - 4.6 Document Panel
   - 4.7 Status Bar
   - 4.8 Window Menu
   - 4.9 Floating Panel
   - 4.10 Modal Dialog
5. [State Machines](#5-state-machines)
6. [Drag & Drop Rules](#6-drag--drop-rules)
7. [Keyboard Shortcut System](#7-keyboard-shortcut-system)
8. [Persistence Strategy](#8-persistence-strategy)
9. [Application Considerations & Open Questions](#9-application-considerations--open-questions)

---

## 1. Architecture Overview

### 1.1 Component Tree

```
App
├── TitleBar
├── MenuBar
├── MainToolbar
│   ├── ToolbarBlock[]          ← drag-reorderable
│   │   └── ToolbarButton[]     ← same JSON shape as menu items
│   └── ToolbarSeparator
├── MDIWorkspace                ← wraps children in DragProvider
│   ├── MDIRow (id: "row-top")
│   │   ├── DocumentContainer[]
│   │   │   ├── ContainerTitleBar
│   │   │   ├── DocumentToolbar (optional)
│   │   │   ├── DocumentPanel   ← hosts React component
│   │   │   └── TabBar (optional)
│   │   ├── ContainerDragHandle[]  (between containers)
│   │   └── RowDropZone         ← visible when row is empty, during drag
│   ├── RowResizeDivider        ← vertical drag / collapse
│   ├── MDIRow (id: "row-bottom")
│   │   └── (same as row-top)
│   └── FloatingPanelManager   ← rendered inside DragProvider; portals to document.body
│       └── FloatingPanel[]    ← one per doc where floating ≠ null
├── StatusBar
└── ModalManager               ← portalled into document.body, above all other content
    ├── modal-backdrop         ← single backdrop behind all modals
    └── ModalDialog[]          ← one per state.modals entry
```

### 1.2 Data Flow

```
┌─────────────────────────────────────────┐
│          AppStateContext                │  ← single React Context
│  (mdi, menus, toolbar, status, theme)  │
└──────────┬──────────────────────────────┘
           │ dispatch(action)
           ▼
      appReducer()
           │
           ├── writes to localStorage   (auto, on every state change)
           └── reads from localStorage  (on first mount / hydration)

Layout snapshots:  saveLayout() / loadLayout()  ← explicit user action
```

### 1.3 Module / File Structure (suggested)

```
src/
  contexts/
    AppStateContext.tsx
  hooks/
    useTheme.ts
    useLocalStorage.ts
    useDragReorder.ts
    useKeyboardShortcuts.ts
  components/
    TitleBar/
    MenuBar/
    Toolbar/
      MainToolbar.tsx
      ToolbarBlock.tsx
      ToolbarButton.tsx
    MDI/
      MDIWorkspace.tsx
      MDIRow.tsx
      RowResizeDivider.tsx
      DocumentContainer.tsx
      ContainerTitleBar.tsx
      TabBar.tsx
      DropZone.tsx
    Documents/
      DocumentPanel.tsx
      DocumentToolbar.tsx
    StatusBar/
  data/
    menus/
      main_menu.json
    toolbars/
      toolbar_manifest.json
      toolbar_file.json
      toolbar_edit.json
    layout/
      default_layout.json
  types/
    menu.types.ts
    toolbar.types.ts
    mdi.types.ts
    document.types.ts
  utils/
    layoutSerializer.ts
    shortcutRegistry.ts
```

---

## 2. Application State Model

### 2.1 Root State

```typescript
interface AppState {
  theme: 'dark' | 'light';
  menuBar: MenuBarState;
  toolbar: MainToolbarState;
  mdi: MDIWorkspaceState;
  statusBar: StatusBarState;
  documents: Record<string, DocumentPanelState>;  // all known panel instances
  modals: ModalState[];         // stack of open modal dialogs (bottom = oldest)
  floatZCounter: number;        // monotonically increasing; used to assign z-index to floating panels
}
```

> **Implementation note:** The original spec placed documents under `windowRegistry.documents`. The implementation uses a flat `state.documents` map for simplicity — functionally identical.

### 2.2 MDI Workspace State

```typescript
interface MDIWorkspaceState {
  topRow: MDIRowState;
  bottomRow: MDIRowState;
  rowSplitPercent: number;      // % height given to top row (10–90)
  rowResizeDisabled: boolean;   // locks the vertical divider
}

interface MDIRowState {
  id: 'row-top' | 'row-bottom';
  visible: boolean;             // false = entire row hidden (no collapse strip shown)
  collapsed: boolean;           // true = row collapsed to restore strip
  containers: DocumentContainerState[];
}
```

### 2.3 Document Container State

```typescript
interface DocumentContainerState {
  // Identity
  id: string;               // stable config id (e.g. "dc-editor")
  instanceId: string;       // unique runtime instance UUID

  // Layout
  widthPercent: number;     // % of row width
  collapsed: boolean;
  visible: boolean;
  killed: boolean;          // if true, not restorable without reinstantiation

  // Behaviour flags
  allowTabs: boolean;
  allowClose: boolean;
  allowDragMove: boolean;
  forbidDropBefore: boolean;
  forbidDropAfter: boolean;
  forceCloseOnEmpty: boolean;
  killOnClose: boolean;
  resizable: boolean;       // false = fixed width, no drag handle shown

  // Defaults
  defaultTitle: string;
  defaultWidth: number;     // px, used when resizable:false or first creation

  // Tab restriction
  restrictTabToTypes: string[];   // empty = accept any

  // Content
  activeDocumentId: string | null;
  documentIds: string[];         // ordered list; references windowRegistry

  // Location tracking (for Window menu restore)
  rowId: 'row-top' | 'row-bottom';
  rowIndex: number;
}
```

### 2.4 Document Panel State

```typescript
interface DocumentPanelState {
  // Identity
  id: string;               // stable config id
  instanceId: string;       // unique runtime UUID

  // Component
  componentType: string;    // key into registered component map
  title: string;            // full descriptive title — container header, Window menu, floating title bar, tab tooltip
  tabTitle?: string;        // optional short label for the tab bar / tab-list dropdown; falls back to `title` when omitted

  // Behaviour
  visible: boolean;
  allowClose: boolean;
  killOnClose: boolean;
  allowAsTab: boolean;
  restrictToTabTypes: string[];   // empty = can go into any allowTabs container

  // Width (when container has resizable: false for this doc)
  width: {
    default: number;
    current: number;
    fixed: boolean;
  };

  // Per-document toolbar
  toolbarMenus: string[];         // ordered toolbar block ids from toolbar_manifest.json

  // Closed-state memory (for Window menu restore)
  closedState: ClosedDocumentState | null;

  // New-container defaults (used when tab is dropped onto empty row zone)
  defaultContainerOptions: Partial<DocumentContainerState> | null;

  // Floating panel state — non-null while the panel is detached from the MDI workspace
  floating: FloatingWindowState | null;

  // Browser popout state — true while the panel is rendering in its own browser window
  poppedOut: boolean;

  // Floating panel options (all optional; built-in defaults apply when omitted)
  floatResizable?: boolean;    // show 8-direction resize handles when floating (default: true)
  floatMinWidth?: number;      // minimum width in px when floating (default: 220)
  floatMinHeight?: number;     // minimum height in px when floating (default: 120)
}

interface ClosedDocumentState {
  containerId: string;            // instanceId of parent container when closed
  rowId: 'row-top' | 'row-bottom';
  containerIndex: number;
}
```

### 2.5 Main Toolbar State

```typescript
interface MainToolbarState {
  blockOrder: string[];           // ordered ids from toolbar_manifest.json
  blocks: Record<string, ToolbarBlockState>;
}

interface ToolbarBlockState {
  id: string;
  title: string;
  menuFile: string;               // filename of the JSON containing its items
  visible: boolean;
  disabled: boolean;
  alignment: 'left' | 'center' | 'right';  // toolbar zone; default 'left'
  labelMode: 'icon-title' | 'icon-only';   // button display mode; default 'icon-title'
}
```

### 2.6 Menu Bar State

```typescript
interface MenuBarState {
  menuFile: string;               // e.g. "main_menu.json"
  // Runtime open/close of dropdowns is ephemeral (not persisted)
}
```

### 2.7 Status Bar State

```typescript
interface StatusBarState {
  visible: boolean;
  allowClose: boolean;
  text: string;
}
```

### 2.8 Document Registry

All document panel instances ever created this session are stored directly on `AppState.documents` (keyed by `instanceId`). This flat map is used by the Window menu to enumerate open and closed panels, and by any container to look up its active document.

```typescript
// Accessed as: state.documents[instanceId]
type DocumentRegistry = Record<string, DocumentPanelState>;
```

---

### 2.9 Floating Window State

Carried on `DocumentPanelState.floating` while the panel is detached from the MDI workspace. Null when docked.

```typescript
interface FloatingWindowState {
  x: number;        // left edge in viewport px
  y: number;        // top edge in viewport px
  width: number;    // panel width in px
  height: number;   // panel height in px
  zIndex: number;   // current stacking order (derived from floatZCounter)
  minimized: boolean; // true = only title bar visible
}
```

---

### 2.10 Modal State & Modal Button

`AppState.modals` is a stack of `ModalState` objects. Modals are rendered bottom-to-top; the last entry is the topmost dialog. `id` is auto-assigned by the reducer (uuid).

```typescript
type ModalButtonVariant   = 'default' | 'primary' | 'danger';
type ModalButtonAlignment = 'left' | 'center' | 'right';

interface ModalButton {
  label: string;
  /** actionRegistry key invoked on click. Omit for a pure close-only button. */
  action?: string;
  /** Static args forwarded to the action. For dynamic form data, register a
   *  capturing handler in the content component on mount (see NewLayoutModal). */
  args?: Record<string, unknown>;
  /** Alignment zone in the button bar (default: 'right') */
  alignment?: ModalButtonAlignment;
  variant?: ModalButtonVariant;
  /**
   * Controls whether the modal closes after the action runs.
   *   `false` / omitted — never closes (action handles close itself, if needed).
   *   `true`            — closes synchronously after invoking the action,
   *                       regardless of whether the action succeeded.
   *   `'on-success'`    — awaits the action's return value. The modal closes
   *                       only if the returned promise resolves (or the
   *                       handler returns synchronously without throwing).
   *                       A thrown error or rejected promise leaves the
   *                       modal open so the handler can surface a validation
   *                       error inline.
   */
  closesModal?: boolean | 'on-success';
  /**
   * Keyboard keys that trigger this button (e.g. ['Enter'], ['Escape']).
   * Only the topmost open modal processes key bindings.
   * If a key is not listed on any button it has no effect.
   */
  keys?: string[];
}

interface ModalState {
  id: string;                        // assigned by reducer
  title: string;
  /** Key into MODAL_REGISTRY in ModalDialog.tsx */
  componentType: string;
  width?: number;                    // initial width in px (default: 400)
  height?: number;                   // initial height in px (default: content-driven)
  /** Arbitrary props forwarded to the modal content component */
  props?: Record<string, unknown>;
  /** Show × close button in title bar (default: true) */
  allowClose?: boolean;
  /** actionRegistry key invoked when × is clicked, fires before the modal closes */
  onCloseAction?: string;
  /** Bottom button bar items. When empty/absent, GenericModal renders its own OK button. */
  buttons?: ModalButton[];
  /** Show bottom-right resize grip (default: true) */
  allowResize?: boolean;
  /** Minimum width in px when resizing (default: 260) */
  minWidth?: number;
  /** Minimum height in px when resizing (default: 120) */
  minHeight?: number;
}
```

**Button bar alignment zones** mirror the toolbar: buttons with `alignment: 'left'` are grouped left, `'center'` are centred, `'right'` (default) are grouped right. All three zones are always present in the DOM so the groups never shift when buttons are added.

**MODAL_REGISTRY** in `ModalDialog.tsx` maps `componentType` strings to content components:

| componentType | Component | Purpose |
|---|---|---|
| `GenericModal` | `GenericModal` | Displays `props.message` as plain text; renders its own OK button when no `buttons` array is supplied |
| `NewLayoutModal` | `NewLayoutModal` | Form for creating a new layout; registers `'newLayout:create'` action on mount |

Add new modal content components to `MODAL_REGISTRY` as needed.

---

## 3. JSON Formats — Reference

### 3.1 Menu Item (Shared Format)

Used by: main menu bar, toolbar block items, document panel toolbars.

```json
{
  "id": "file-save",
  "type": "action",
  "label": "Save",
  "icon": "💾",
  "shortcut": "Ctrl+S",
  "shortcutKey": {
    "ctrl": true,
    "shift": false,
    "alt": false,
    "key": "s"
  },
  "action": "onFileSave",
  "visible": true,
  "disabled": false,
  "children": []
}
```

**`type` values:**

| Value | Meaning |
|---|---|
| `"action"` | Clickable item with optional icon / shortcut |
| `"separator"` | Non-clickable horizontal rule |
| `"section-title"` | Non-clickable bold label (e.g. "Recent Files") |
| `"submenu"` | Has children; renders a flyout |

**Full annotated example with all types:**

```json
[
  {
    "id": "file-new",
    "type": "action",
    "label": "New",
    "icon": "📄",
    "shortcut": "Ctrl+N",
    "shortcutKey": { "ctrl": true, "key": "n" },
    "action": "onFileNew",
    "visible": true,
    "disabled": false,
    "children": []
  },
  {
    "id": "sep-1",
    "type": "separator"
  },
  {
    "id": "recent-heading",
    "type": "section-title",
    "label": "Recent Files"
  },
  {
    "id": "recent-1",
    "type": "action",
    "label": "project_alpha.json",
    "action": "onOpenRecent",
    "actionArgs": { "file": "project_alpha.json" },
    "visible": true,
    "disabled": false,
    "children": []
  },
  {
    "id": "export-menu",
    "type": "submenu",
    "label": "Export As",
    "icon": "📤",
    "visible": true,
    "disabled": false,
    "children": [
      {
        "id": "export-json",
        "type": "action",
        "label": "JSON",
        "action": "onExportJson",
        "visible": true,
        "disabled": false,
        "children": []
      },
      {
        "id": "export-csv",
        "type": "action",
        "label": "CSV",
        "action": "onExportCsv",
        "visible": true,
        "disabled": false,
        "children": []
      }
    ]
  }
]
```

**Note on `action` callbacks:** The `action` string is a key into a registered callback map maintained by the application. This map is populated at app startup and can be extended by document panel components when they mount. `actionArgs` is an optional arbitrary object passed to the callback.

---

### 3.2 Main Menu Bar File (`main_menu.json`)

Top-level array of menu root items. Each root item has children (the dropdown contents, using the §3.1 format).

```json
[
  {
    "id": "menu-file",
    "label": "File",
    "visible": true,
    "disabled": false,
    "children": [
      {
        "id": "file-new",
        "type": "action",
        "label": "New",
        "icon": "📄",
        "shortcut": "Ctrl+N",
        "shortcutKey": { "ctrl": true, "key": "n" },
        "action": "onFileNew",
        "visible": true,
        "disabled": false,
        "children": []
      },
      { "id": "sep-1", "type": "separator" },
      {
        "id": "file-save",
        "type": "action",
        "label": "Save Layout",
        "icon": "💾",
        "shortcut": "Ctrl+S",
        "shortcutKey": { "ctrl": true, "key": "s" },
        "action": "onSaveLayout",
        "visible": true,
        "disabled": false,
        "children": []
      },
      {
        "id": "file-load",
        "type": "action",
        "label": "Load Layout",
        "icon": "📂",
        "shortcut": "Ctrl+O",
        "shortcutKey": { "ctrl": true, "key": "o" },
        "action": "onLoadLayout",
        "visible": true,
        "disabled": false,
        "children": []
      }
    ]
  },
  {
    "id": "menu-view",
    "label": "View",
    "visible": true,
    "disabled": false,
    "children": [
      {
        "id": "view-theme",
        "type": "action",
        "label": "Toggle Light / Dark",
        "shortcut": "Ctrl+Shift+T",
        "shortcutKey": { "ctrl": true, "shift": true, "key": "t" },
        "action": "onToggleTheme",
        "visible": true,
        "disabled": false,
        "children": []
      },
      { "id": "sep-view-1", "type": "separator" },
      {
        "id": "view-statusbar",
        "type": "action",
        "label": "Status Bar",
        "action": "onToggleStatusBar",
        "visible": true,
        "disabled": false,
        "children": []
      }
    ]
  },
  {
    "id": "menu-window",
    "label": "Window",
    "visible": true,
    "disabled": false,
    "children": []
  }
]
```

**The "Window" menu children are generated dynamically at runtime** — see §4.8.

---

### 3.3 Toolbar Manifest (`toolbar_manifest.json`)

Defines the ordered blocks that appear on the Main Toolbar. Order here matches the initial left→right display order within each zone; user drag-reorder (zone-local) is persisted via localStorage.

**Block fields:**

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | — | Stable block identifier |
| `title` | string | — | Display name (used in drag handle tooltip) |
| `menuFile` | string | — | JSON file in `/data/toolbars/` containing button items |
| `visible` | boolean | — | Whether the block renders |
| `disabled` | boolean | — | If true, all buttons in the block are disabled |
| `alignment` | `"left"` \| `"center"` \| `"right"` | `"left"` | Which zone of the toolbar strip the block anchors to |
| `labelMode` | `"icon-title"` \| `"icon-only"` | `"icon-title"` | Whether buttons show a text label below the icon |

```json
[
  {
    "id": "tb-file",
    "title": "File",
    "menuFile": "toolbar_file.json",
    "visible": true,
    "disabled": false,
    "alignment": "left",
    "labelMode": "icon-title"
  },
  {
    "id": "tb-edit",
    "title": "Edit",
    "menuFile": "toolbar_edit.json",
    "visible": true,
    "disabled": false,
    "alignment": "left",
    "labelMode": "icon-title"
  },
  {
    "id": "tb-view",
    "title": "View",
    "menuFile": "toolbar_view.json",
    "visible": true,
    "disabled": false,
    "alignment": "right",
    "labelMode": "icon-only"
  }
]
```

---

### 3.4 Toolbar Block Items (e.g. `toolbar_file.json`)

Same §3.1 format. The `icon` field here is the large icon shown on the toolbar button face.

**First-level submenus** (`type: "submenu"` at the root of a block file) open a dropdown panel below the button via `ToolbarMenuPortal` — rendered into `document.body` with `position: fixed` to avoid clipping.

**Nested submenus** (`type: "submenu"` inside a dropdown) are supported: hovering a submenu row opens a second-level flyout to the right of the parent row, also portalled into `document.body`. The flyout flips left automatically if there is insufficient viewport space to the right. A 100 ms hover-grace delay prevents accidental closure while the mouse travels between the row and the flyout panel.

```json
[
  {
    "id": "tbf-new",
    "type": "action",
    "label": "New",
    "icon": "📄",
    "shortcut": "Ctrl+N",
    "shortcutKey": { "ctrl": true, "key": "n" },
    "action": "onFileNew",
    "visible": true,
    "disabled": false,
    "children": []
  },
  {
    "id": "tbf-save",
    "type": "action",
    "label": "Save",
    "icon": "💾",
    "shortcut": "Ctrl+S",
    "shortcutKey": { "ctrl": true, "key": "s" },
    "action": "onSaveLayout",
    "visible": true,
    "disabled": false,
    "children": []
  },
  {
    "id": "tbf-sep-1",
    "type": "separator"
  },
  {
    "id": "tbf-load",
    "type": "submenu",
    "label": "Open",
    "icon": "📂",
    "visible": true,
    "disabled": false,
    "children": [
      {
        "id": "tbf-load-layout",
        "type": "action",
        "label": "Load Layout...",
        "action": "onLoadLayout",
        "visible": true,
        "disabled": false,
        "children": []
      }
    ]
  }
]
```

---

### 3.5 Document Container Definition

Used in `default_layout.json` and the persisted localStorage state.

```json
{
  "id": "dc-editor",
  "instanceId": "dc-editor-a1b2c3d4",
  "widthPercent": 60,
  "collapsed": false,
  "visible": true,
  "killed": false,
  "allowTabs": true,
  "allowClose": false,
  "allowDragMove": true,
  "forbidDropBefore": false,
  "forbidDropAfter": false,
  "forceCloseOnEmpty": false,
  "killOnClose": false,
  "resizable": true,
  "defaultWidth": 400,
  "defaultTitle": "Editor",
  "restrictTabToTypes": ["text-editor", "code-editor"],
  "activeDocumentId": "doc-text-001",
  "documentIds": ["doc-text-001", "doc-code-001"],
  "rowId": "row-top",
  "rowIndex": 0
}
```

---

### 3.6 Document Panel Definition

```json
{
  "id": "doc-text-editor",
  "instanceId": "doc-text-001",
  "componentType": "TextEditor",
  "title": "Untitled Document — Long Descriptive Header",
  "tabTitle": "Untitled",
  "visible": true,
  "allowClose": true,
  "killOnClose": false,
  "allowAsTab": true,
  "restrictToTabTypes": ["text-editor"],
  "width": {
    "default": 400,
    "current": 450,
    "fixed": false
  },
  "toolbarMenus": ["tb-edit", "tb-format"],
  "closedState": null,
  "defaultContainerOptions": {
    "allowTabs": true,
    "allowClose": true,
    "forceCloseOnEmpty": true,
    "killOnClose": false,
    "restrictTabToTypes": ["text-editor"]
  },
  "floating": null,
  "poppedOut": false,
  "floatResizable": true,
  "floatMinWidth": 300,
  "floatMinHeight": 200
}
```

> `floating` and `poppedOut` are runtime fields — both are always `null`/`false` in `default_layout.json`. They are set by the reducer when the user detaches or pops out a panel. `floatResizable`, `floatMinWidth`, and `floatMinHeight` are optional configuration fields; omit them to use framework defaults (resizable: true, minWidth: 220, minHeight: 120).
>
> `tabTitle` is an optional short label used only in the tab bar and tab-list dropdown; the container header, Window menu, and floating-panel title bar continue to use the full `title`. When `tabTitle` is omitted the framework falls back to `title` for the tab and applies a CSS `max-width` + ellipsis (see §4.5) so very long titles still display sensibly.

---

### 3.7 MDI Row Definition

```json
{
  "id": "row-top",
  "visible": true,
  "collapsed": false,
  "containers": [
    { "...": "DocumentContainerDefinition (§3.5)" },
    { "...": "DocumentContainerDefinition (§3.5)" }
  ]
}
```

---

### 3.8 Full Layout Snapshot (`default_layout.json` / save file)

This is both the **default layout** loaded on first run and the **export format** for user layout saves.

```json
{
  "version": "1.0",
  "appId": "mdi-framework",
  "savedAt": "2026-05-06T10:00:00.000Z",
  "description": "Default MDI layout",
  "workspace": {
    "rowSplitPercent": 60,
    "rowResizeDisabled": false,
    "topRow": {
      "id": "row-top",
      "visible": true,
      "collapsed": false,
      "containers": [
        {
          "id": "dc-explorer",
          "instanceId": "dc-explorer-001",
          "widthPercent": 25,
          "collapsed": false,
          "visible": true,
          "killed": false,
          "allowTabs": false,
          "allowClose": false,
          "allowDragMove": false,
          "forbidDropBefore": true,
          "forbidDropAfter": false,
          "forceCloseOnEmpty": false,
          "killOnClose": false,
          "resizable": true,
          "defaultWidth": 250,
          "defaultTitle": "Explorer",
          "restrictTabToTypes": [],
          "activeDocumentId": "doc-explorer-001",
          "documentIds": ["doc-explorer-001"],
          "rowId": "row-top",
          "rowIndex": 0
        },
        {
          "id": "dc-main-editor",
          "instanceId": "dc-main-editor-001",
          "widthPercent": 50,
          "collapsed": false,
          "visible": true,
          "killed": false,
          "allowTabs": true,
          "allowClose": false,
          "allowDragMove": false,
          "forbidDropBefore": false,
          "forbidDropAfter": false,
          "forceCloseOnEmpty": false,
          "killOnClose": false,
          "resizable": true,
          "defaultWidth": 600,
          "defaultTitle": "Editor",
          "restrictTabToTypes": [],
          "activeDocumentId": "doc-welcome-001",
          "documentIds": ["doc-welcome-001"],
          "rowId": "row-top",
          "rowIndex": 1
        },
        {
          "id": "dc-properties",
          "instanceId": "dc-properties-001",
          "widthPercent": 25,
          "collapsed": false,
          "visible": true,
          "killed": false,
          "allowTabs": true,
          "allowClose": true,
          "allowDragMove": true,
          "forbidDropBefore": false,
          "forbidDropAfter": true,
          "forceCloseOnEmpty": true,
          "killOnClose": false,
          "resizable": true,
          "defaultWidth": 280,
          "defaultTitle": "Properties",
          "restrictTabToTypes": ["property-panel"],
          "activeDocumentId": "doc-properties-001",
          "documentIds": ["doc-properties-001"],
          "rowId": "row-top",
          "rowIndex": 2
        }
      ]
    },
    "bottomRow": {
      "id": "row-bottom",
      "visible": true,
      "collapsed": false,
      "containers": [
        {
          "id": "dc-output",
          "instanceId": "dc-output-001",
          "widthPercent": 60,
          "collapsed": false,
          "visible": true,
          "killed": false,
          "allowTabs": true,
          "allowClose": true,
          "allowDragMove": true,
          "forbidDropBefore": false,
          "forbidDropAfter": false,
          "forceCloseOnEmpty": true,
          "killOnClose": false,
          "resizable": true,
          "defaultWidth": 500,
          "defaultTitle": "Output",
          "restrictTabToTypes": ["output", "log"],
          "activeDocumentId": "doc-output-001",
          "documentIds": ["doc-output-001"],
          "rowId": "row-bottom",
          "rowIndex": 0
        }
      ]
    }
  },
  "mainToolbar": {
    "blockOrder": ["tb-file", "tb-edit", "tb-view"],
    "blocks": {
      "tb-file": { "id": "tb-file", "title": "File", "menuFile": "toolbar_file.json", "visible": true, "disabled": false },
      "tb-edit": { "id": "tb-edit", "title": "Edit", "menuFile": "toolbar_edit.json", "visible": true, "disabled": false },
      "tb-view": { "id": "tb-view", "title": "View", "menuFile": "toolbar_view.json", "visible": true, "disabled": false }
    }
  },
  "statusBar": {
    "visible": true,
    "allowClose": true,
    "text": ""
  },
  "documents": [
    {
      "id": "doc-explorer",
      "instanceId": "doc-explorer-001",
      "componentType": "FileExplorer",
      "title": "Explorer",
      "visible": true,
      "allowClose": false,
      "killOnClose": false,
      "allowAsTab": false,
      "restrictToTabTypes": [],
      "width": { "default": 250, "current": 250, "fixed": true },
      "toolbarMenus": [],
      "closedState": null,
      "defaultContainerOptions": null
    },
    {
      "id": "doc-welcome",
      "instanceId": "doc-welcome-001",
      "componentType": "WelcomePanel",
      "title": "Welcome",
      "visible": true,
      "allowClose": true,
      "killOnClose": true,
      "allowAsTab": true,
      "restrictToTabTypes": [],
      "width": { "default": 600, "current": 600, "fixed": false },
      "toolbarMenus": [],
      "closedState": null,
      "defaultContainerOptions": {
        "allowTabs": true,
        "allowClose": true,
        "forceCloseOnEmpty": true,
        "killOnClose": false,
        "restrictTabToTypes": []
      }
    }
  ]
}
```

---

## 4. Component Specifications

### 4.1 Title Bar

**Visual layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  MDI Framework  v0.1  — Data Visualiser         [☀️ / 🌙]  │
└─────────────────────────────────────────────────────────────┘
```

**Requirements:**
- Height: `var(--title-h)` = 32 px; `flex-shrink: 0`
- Background: dark-mode gradient `linear-gradient(135deg, #0a1a2a 0%, #080810 100%)` / light-mode slate-blue override (see style guide §6)
- LHS: Project name in `var(--accent)` amber, 15 px, weight 700; version in dim grey `<span>`, 12 px, weight 400
- Optional `subtitle?: string` prop appears after the version using the same dim styling — lets multi-app hosts identify the active app (e.g. `MDI Framework · v0.1 · Data Visualiser`). Omitting the prop preserves the single-app appearance.
- RHS: Theme toggle button (`☀️` / `🌙`); implemented via `useTheme` hook (see §8.1)
- `user-select: none`
- Theme is persisted to `localStorage` key `mdi:theme` (configurable — see §8.1)

---

### 4.2 Menu Bar

**Visual layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  File   Edit   View   Window                                │
└─────────────────────────────────────────────────────────────┘
```

**Requirements:**

- Height: `var(--toolbar-h)` = 36 px; `flex-shrink: 0`
- Background: `var(--surface)`; bottom border: `1px solid var(--border)`
- Loaded from `main_menu.json` on startup
- Root items render as flat text buttons; click opens dropdown below
- Only one dropdown open at a time; click elsewhere or `Escape` to dismiss
- Dropdown panel: `background: var(--surface)`, `border: 1px solid var(--border)`, `border-radius: 4px`, `box-shadow: 0 4px 12px rgba(0,0,0,0.4)`, min-width 180 px, `z-index: 200`

**Dropdown item rendering by type:**

| Type | Render |
|---|---|
| `action` | Row with optional icon (16 px) LHS, label, optional shortcut label RHS. Hover: `background rgba(255,255,255,0.07)`. Disabled: `opacity: 0.4; cursor: not-allowed`. Hidden (`visible:false`): not rendered. |
| `separator` | `<hr>` with `border-color: var(--border)`, margin 4px 0 |
| `section-title` | Non-interactive label, `color: var(--accent)`, uppercase, `font-size: 11px`, `letter-spacing: 0.5px`, `padding: 6px 12px 2px` |
| `submenu` | Row with label + `›` chevron RHS; hover reveals flyout panel to the right |

**Keyboard navigation:**
- Arrow keys navigate items; `Enter` activates; `Escape` closes; `→` opens submenus; `←` closes submenus
- Tab key closes dropdown and moves browser focus

---

### 4.3 Main Toolbar

**Visual layout:**
```
┌─────────────────────────────────────────────────────────────┐
│ [📄 New][💾 Save] ┃ [✂️ Cut][📋 Paste] ┃      ┃ [🌓][🔍][🔎] │
│ ← left zone ──────────────────────────────── right zone → │
└─────────────────────────────────────────────────────────────┘
```

**Requirements:**
- Height: `var(--toolbar-h)` = 36 px; background `var(--surface)`
- Contains **toolbar blocks** — each block is a draggable group of buttons
- Between blocks within a zone: a visible `toolbar-sep` (1 px vertical rule)
- Block reorder: drag block handle left/right within its zone; amber drop indicator shows new position; drop to commit; new order saved to localStorage

**Alignment zones:**

The toolbar strip is divided into three zones controlled by each block's `alignment` field. Zones are implemented as three flex regions; the left and right zones have `flex: 1` with opposing justification so the center zone is always mathematically centred:

| Zone | CSS | Behaviour |
|---|---|---|
| `"left"` | `flex: 1; justify-content: flex-start` | Blocks anchor to the left edge |
| `"center"` | `flex: 0 0 auto` | Blocks sit in the centre; zone absent if no blocks use it |
| `"right"` | `flex: 1; justify-content: flex-end` | Blocks anchor to the right edge |

Drag-reorder is **zone-local**: a block can only be dragged within its own zone. The per-document toolbar strip uses the same three-zone layout so document-level blocks can also be positioned independently.

**Toolbar Block:**
- Has a `title` (shown in drag handle tooltip)
- Has `visible` and `disabled` flags — if `disabled`, all buttons inside are disabled; if `!visible`, block not rendered
- Supports all `type` values: `action`, `submenu` (shows dropdown below button via `ToolbarMenuPortal`), `separator` (vertical rule between buttons within a block)

**Label mode (`labelMode`):**

Controls whether buttons within the block show a text label below the icon:

| Value | Icon | Label | Tooltip |
|---|---|---|---|
| `"icon-title"` | ✓ | ✓ | Only shown when a keyboard shortcut is defined (adds information the visible label doesn't) |
| `"icon-only"` | ✓ | — | Always shown: `"Label (Ctrl+X)"` format, or just `"Label"` if no shortcut |

**Toolbar Button states:**
- Default: transparent background, transparent border
- Hover: `background rgba(255,255,255,0.07)`, `border: var(--border)`
- Active/toggled: amber tint — `background rgba(245,166,35,0.18)`, `border: var(--accent)`, `color: var(--accent)` (see style guide §13)
- Disabled: `opacity: 0.4; cursor: default`

**Dropdown submenus:**
- First-level: clicking a `submenu` button opens a `ToolbarMenuPortal` dropdown below the button
- Nested: `type: "submenu"` items within that dropdown open a second-level flyout to the right on hover (see §3.4 for flyout behaviour details)

---

### 4.4 MDI Workspace

**Visual layout:**
```
┌──────────────────────────────────────────────────┐
│  ROW TOP      (flex: 0 0 {rowSplitPercent}%)     │
│  ┌────────┐5px┌────────────────┐5px┌──────────┐ │
│  │ Cont.A │▓▓▓│  Container B   │▓▓▓│ Cont. C  │ │
│  └────────┘▓▓▓└────────────────┘▓▓▓└──────────┘ │
├──────────────────────────────────────────────────┤ ← 10px RowResizeDivider
│  ROW BOTTOM   (flex: 0 0 {100-split}%)           │
│  ┌────────────────────────┐5px┌───────────────┐  │
│  │  Container D           │▓▓▓│  Container E  │  │
│  └────────────────────────┘▓▓▓└───────────────┘  │
└──────────────────────────────────────────────────┘
```

**Requirements:**
- `flex: 1; flex-direction: column; min-height: 0; overflow: hidden`
- Top row and bottom row separated by `RowResizeDivider` (10 px, see style guide §9)
- Row resize: drag handle changes `rowSplitPercent` (clamped 10–90); persisted
- Each row can be individually collapsed via arrows in the divider
- When `rowResizeDisabled: true`, divider is rendered without cursor interaction
- Collapse behaviour follows style guide §9 vcol-strip pattern (green tinted restore strip)
- When a row has `visible: false`, neither the row nor its collapse strip is rendered
- When a row becomes empty (all containers removed), it remains open and shows a full-width `RowDropZone` placeholder; the user may collapse the row manually if desired

**Row (`MDIRow`):**
- `display: flex; flex-direction: row; overflow: hidden`
- Each `DocumentContainer` gets `flex: 0 0 {widthPercent}%`
- Between containers: `hdrag-handle` (5 px, amber on hover, see style guide §8)
- Container widths are normalised to sum to 100% after add/remove

---

### 4.5 Document Container

**Visual layout:**
```
┌───────────────────────────────────────────┐
│ My Document Title             [⊞] [×]    │  ← ContainerTitleBar (28 px)
├───────────────────────────────────────────┤
│ [✂️ Cut][📋 Paste]                         │  ← DocumentToolbar (36 px, optional)
├───────────────────────────────────────────┤
│                                           │
│         < Document Panel content >        │  ← flex: 1
│                                           │
├───────────────────────────────────────────┤
│ [Doc One] [Doc Two ×] [Doc Three]  [⊞▾]  │  ← TabBar (28 px, if allowTabs + >1 doc)
└───────────────────────────────────────────┘
```

**Container Title Bar:**
- Height 28 px; background `var(--surface)`; bottom border `1px solid var(--border)`
- LHS: active document title (or `defaultTitle` if no documents); `var(--text)`, 12 px
- RHS buttons (left to right): Tab list dropdown icon `[⊞▾]` (only if `allowTabs: true`); Close icon `[×]` (only if `allowClose: true`)
- Tab list dropdown `[⊞▾]`: shows all document panels in this container as selectable items; selected item becomes active document; if `allowClose` on document, shows `×` next to its title
- `[⊞▾]` disabled (reduced opacity, not clickable) when only 1 document and `allowTabs: true`; hidden when `allowTabs: false`
- Drag handle: entire title bar is draggable when `allowDragMove: true`; `cursor: grab`; see §6

**Tab Bar (bottom of container):**
- Shown when `allowTabs: true` AND `documentIds.length > 1`
- Tab items: `tab-btn` pattern from style guide §10; active tab has amber underline + amber text
- Each tab shows `doc.tabTitle ?? doc.title` wrapped in a `<span className="tab-label">` so the framework can apply truncation. The full `doc.title` is exposed via a `title=""` tooltip on the tab itself so the long form is discoverable on hover.
- A CSS cap (`--tab-max-width`, default 160 px) plus `text-overflow: ellipsis` truncates any label that exceeds it. Apps SHOULD set `tabTitle` to a short label when `title` is long; the CSS cap is a defensive fallback for apps that don't.
- If document's `allowClose: true`, shows `×` on the tab
- Tabs are draggable — see §6.3
- Background `var(--bg)`; top border `1px solid var(--border)`

**Document Toolbar (per-document):**
- Same design as Main Toolbar but scoped to the active document panel
- Toolbar block IDs come from `activeDocument.toolbarMenus`
- Hidden entirely (`height: 0; overflow: hidden`) if `toolbarMenus` is empty

**Width resize:**
- If `resizable: true`: drag handle between containers; `widthPercent` updated; persisted
- If `resizable: false`: no drag handle; fixed at `defaultWidth`

**Collapse:**
- Collapse strip replaces container content (thin strip with arrow icon); click to restore
- Remaining containers redistribute width proportionally on collapse/restore

---

### 4.6 Document Panel

**Requirements:**
- Fills remaining vertical space in the container below the toolbar
- Renders the React component identified by `componentType` using a registered component map:
  ```typescript
  // src/components/DocumentPanel.tsx
  type PanelComponent = React.ComponentType<{
    doc: DocumentPanelState;
    container: DocumentContainerState;
  }>;

  const COMPONENT_REGISTRY: Record<string, PanelComponent> = {
    DummyPanel,
    // Add real panels here: TextEditor, FileExplorer, OutputPanel, etc.
  };

  // Unknown componentType falls back to DummyPanel
  const Component = COMPONENT_REGISTRY[doc.componentType] ?? DummyPanel;
  ```
- Panel components receive `doc: DocumentPanelState` and `container: DocumentContainerState` as props — all needed values (`instanceId`, `title`, `dispatch` access via context) are available through these objects
- If `toolbarMenus` is empty, panel fills 100% height of container (no toolbar strip rendered)
- Panel registers/unregisters its toolbar actions on mount/unmount via `actionRegistry`

**Visibility:**
- `visible: false` means panel exists in state but renders `display: none` (not destroyed)
- `killOnClose: true` means panel is removed from `state.documents` entirely on close

---

### 4.7 Status Bar

**Visual layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  Ready                                                 [×] │
└─────────────────────────────────────────────────────────────┘
```

**Requirements:**
- Height: 24 px; `flex-shrink: 0`; background `var(--surface)`; top border `1px solid var(--border)`
- LHS: status text; `var(--text-dim)`, 11 px
- RHS: `[×]` only if `allowClose: true`
- When `visible: false`: not rendered (not just hidden) — no gap in layout
- Status text is set programmatically via `dispatch({ type: 'SET_STATUS', text: '...' })`
- Status text auto-clears after a configurable timeout (default: 5 seconds), or stays if set to persistent
- Can be restored via View → Status Bar menu item (toggles `visible` flag)

---

### 4.8 Window Menu (Dynamic)

The `menu-window` entry in `main_menu.json` has empty `children: []`; at render time the children are generated from `state.documents`.

**Generated structure:**

```
Window
  ├── [action] Document Title A          ← visible, allowClose:false
  ├── [action] Document Title B   [×]   ← visible, allowClose:true
  ├── [separator]
  ├── [section-title] Closed
  ├── [action] My Hidden Document        ← visible:false, not killed
  └── [action] Another Closed Doc
```

**Generation rules:**
1. Loop `state.documents` in insertion order
2. If `visible: true` and `!killed`: add as action item; label = `doc.title`; if `doc.allowClose` add an inline `×` control (not part of action, separate click target)
3. Add separator
4. Add section-title "Closed"
5. All `visible: false` and `!killed` docs: add as action item

**Restore behaviour (clicking a closed item):**
1. Check if `closedState.containerId` still exists in `mdi` state (match by `instanceId`)
2. If yes: add document back to that container's `documentIds`; set `visible: true`; set as `activeDocumentId`
3. If no (container was killed/removed): look for any existing container in `closedState.rowId` that has `allowTabs: true` and matching `restrictTabToTypes`; if found use that
4. If still none: create new container in `closedState.rowId` at `closedState.containerIndex` (or end if out of bounds) using `document.defaultContainerOptions`; add document to it
5. Ensure the target row is visible and not collapsed

---

### 4.9 Floating Panel

A document panel can be detached from the MDI workspace and rendered as a freely movable, resizable overlay window above the workspace. Its state is held in `doc.floating` (`FloatingWindowState`).

**How a panel becomes floating:**

- Dragging a document tab and releasing the mouse **outside the MDI workspace rectangle** dispatches `FLOAT_DOCUMENT`, which removes the doc from its container's `documentIds`, sets `doc.floating` with initial geometry, and records `doc.closedState` for later docking.

**Visual layout:**
```
┌─ Panel Title ─────────────────── [−] [⊟] [⧉] [×] ─┐
│                                                      │
│   < DocumentPanel content >                          │
│                                                      │
└──────────────────────────────────────────────────────┘▗ ← resize grip
```

**Title bar buttons:**

| Button | Action |
|---|---|
| `−` / `□` | Minimize / restore — toggles `floating.minimized`; when minimized only the title bar is visible |
| `⊟` | Dock back — dispatches `RESTORE_DOCUMENT` to re-insert the doc into its original or a compatible container |
| `⧉` | Pop out — dispatches `POP_OUT_DOCUMENT`; opens the panel in a new browser window |
| `×` | Close — dispatches `CLOSE_FLOATING`; applies the same hide/kill rules as `CLOSE_DOCUMENT` |

**Movement:** Title bar `mousedown` begins a local drag tracked via `window.mousemove/mouseup`. On mouseup, `SET_FLOAT_GEOMETRY` is dispatched to persist the final position. There are no workspace drop targets for floating panel movement — docking is exclusively via the `⊟` button.

The drag handler clamps `y >= 0` for both the live drag position and the dispatched final position, so the title bar — the only grab handle — cannot be dragged above the viewport top. Without this clamp the panel becomes unreachable. The horizontal axis is intentionally not clamped; some part of the title bar or a resize edge always remains grabbable when the panel is partially off-screen left/right/bottom.

**Resize:** Eight directional handles (`n`, `s`, `e`, `w`, `ne`, `nw`, `se`, `sw`) surround the panel border. Dragging any handle dispatches `SET_FLOAT_GEOMETRY` with updated x/y/width/height. The SE corner additionally shows a diagonal-stripe visual grip. Resize can be disabled per-panel via `floatResizable: false`; minimum dimensions are controlled by `floatMinWidth` / `floatMinHeight`.

**Z-index:** Floating panels occupy z-index 800–899. Clicking anywhere on a floating panel dispatches `BRING_FLOAT_TO_FRONT`, which increments `state.floatZCounter` and assigns the new value to `doc.floating.zIndex`.

**Browser popout (`⧉`):** `POP_OUT_DOCUMENT` sets `doc.poppedOut = true`. `usePopoutWatcher` in `App.tsx` opens a new browser window at `#popout=<instanceId>`. When the popout window closes, it writes a `localStorage` signal (`mdi:popout-closed:<id>`) which the main window's `storage` listener picks up to dispatch `POP_IN_DOCUMENT` + `RESTORE_DOCUMENT`.

**Session persistence:** On page reload, floating panels are restored to their saved position and size. Panels that were popped out are converted to floating panels (browser cannot auto-reopen windows). A `restoreOrphanedDocuments()` pass re-inserts any docs that were floating/popped-out back into their original containers (via `closedState`), or marks them `visible: false` for Window menu access if the original container no longer exists.

**FloatingPanelManager** is rendered inside `MDIWorkspace`'s `DragProvider` (so `FloatingPanel` components can call `useDrag()`). It uses `createPortal` to render the panels into `document.body`.

---

### 4.10 Modal Dialog

Modals are pushed onto `state.modals` via `OPEN_MODAL` and popped via `CLOSE_MODAL`. All open modals are rendered by `ModalManager` (portalled into `document.body`) behind a single shared backdrop.

**Opening a modal:**
```typescript
// From anywhere via actionRegistry:
actionRegistry.invoke('openModal', {
  title: 'My Dialog',
  componentType: 'GenericModal',
  props: { message: 'Hello world' },
  width: 400,
});

// Or via dispatch directly:
dispatch({
  type: 'OPEN_MODAL',
  modal: {
    title: 'New Layout',
    componentType: 'NewLayoutModal',
    width: 420,
    allowClose: true,
    buttons: [
      { label: 'Cancel', alignment: 'right', closesModal: true },
      { label: 'Create', action: 'newLayout:create', alignment: 'right', variant: 'primary', closesModal: true },
    ],
  },
});
```

**Visual layout:**
```
┌─ Dialog Title ───────────────────────────── [×] ─┐
│                                                   │
│   < modal content component >                     │
│                                                   │
├───────────────────────────────────────────────────┤
│ [Left btn]          [Center btn]    [Cancel] [OK] │ ← button bar (optional)
└───────────────────────────────────────────────────┘▗ ← resize grip (optional)
```

**Movement:** Title bar drag moves the modal using local `mousedown/move/up` listeners (no DragContext involved). Modals start centred via CSS; first drag pins an absolute `left/top` position.

**Resize:** When `allowResize: true` (default), a diagonal-stripe grip appears in the bottom-right corner. Dragging it updates the modal's `width` and `height` local state. `minWidth` and `minHeight` set the resize floor.

**Button bar:** Rendered below the content area when `buttons` is non-empty. Buttons are grouped into left / center / right alignment zones. Each button can invoke an `actionRegistry` action and/or close the modal. For form-modal patterns (where the button needs to read live form state), the content component should register a capturing action on mount and unregister on unmount (see `NewLayoutModal`).

**`closesModal` semantics.** Both the click handler and the keyboard handler route through a single `runModalButton(btn, closeModal)` helper so the three settings behave identically across mouse and keyboard:

| Value | Behaviour |
|---|---|
| `false` / omitted | Action runs; modal stays open. The action is responsible for closing the modal itself (e.g. via `dispatch({ type: 'CLOSE_MODAL', id })`). |
| `true` | Action runs; modal closes synchronously regardless of the action's return value or whether it threw. |
| `'on-success'` | Action runs; result is wrapped in `Promise.resolve(...)`. The modal closes only when the promise resolves. A rejection or thrown error leaves the modal open so the handler can surface a validation error inline. |

This relies on `actionRegistry.invoke()` returning the handler's result — see §7.2. Form modals with async validation are the primary use case for `'on-success'`: the Save button can use `closesModal: 'on-success'` and the action handler `await`s its validation/persistence work; a rejected promise (e.g. validation failure) keeps the dialog open with no extra wiring on the caller side.

**Keyboard bindings:** Each `ModalButton` may carry a `keys` array (e.g. `['Enter']`, `['Escape']`). A single `keydown` listener attached to `ModalDialog` fires the button action (and closes, if `closesModal`) when the user presses a listed key. Only the topmost modal handles key events; keys not listed on any button have no effect. `dialogService` uses this automatically: the primary button always gets `['Enter']`, the natural cancel position gets `['Escape']`.

**Z-index:** Modal backdrop at 900; modal dialogs at 901+. This places them above floating panels (800–899) and the menu bar dropdown (1100) and below nothing except browser chrome.

---

### 4.11 Dialog Service (`utils/dialogService.ts`)

Imperative API for the three standard dialog types. Call `dialogService.setDialogDispatch(dispatch)` once after the `AppStateContext` is available (done in `App.tsx`).

**`showAlert(opts)`** — Information / warning box with a single OK button. No × close.
```typescript
showAlert({
  title?: string,           // default 'Alert'
  message: string,
  mode?: 'info' | 'question' | 'warning' | 'error',
  onClose?: (result: DialogResult) => void,
});
```

**`showConfirm(opts)`** — Confirmation dialog with a preset button arrangement. No × close.
```typescript
showConfirm({
  title?: string,           // default 'Confirm'
  message: string,
  mode?: 'info' | 'question' | 'warning' | 'error',
  buttons?: 'ok' | 'ok-cancel' | 'yes-no' | 'yes-no-cancel' | 'retry-cancel' | 'abort-retry-ignore',
  onResult?: (result: DialogResult) => void,
});
```

**`showInput(opts)`** — Input dialog with text field, dropdown, or listbox. No × close. Field validation runs before the OK button is accepted.
```typescript
showInput({
  title?: string,           // default 'Input'
  message?: string,
  mode?: 'info' | 'question' | 'warning' | 'error',
  inputType?: 'text' | 'number' | 'integer' | 'float' | 'email' | 'url',
  widgetType?: 'text' | 'select' | 'listbox',   // inferred from options if omitted
  required?: boolean,
  min?: number,             // for integer / float / number fields
  max?: number,
  defaultValue?: string | string[],
  placeholder?: string,
  options?: Array<{ key: string; value: string }>,   // for select / listbox
  multiple?: boolean,       // multi-select listbox
  okLabel?: string,         // default 'OK'
  cancelLabel?: string,     // default 'Cancel'
  keepOpen?: boolean,       // see below — default false
  onResult?: (result: DialogResult, controller?: DialogController) => void,
});
```

**`DialogResult`**: `{ button: string; value?: string | string[] }`  
`button` — label of the pressed button. `value` — set only when OK is pressed and validation passes (string for text/select/single listbox; string[] for multi-select listbox).

**`keepOpen` mode:** When `keepOpen: true`, neither OK nor Cancel auto-closes the dialog. Both deliver their result to `onResult` along with a `DialogController`, allowing async server-side validation, error display, and programmatic control:

```typescript
interface DialogController {
  close(): void;                          // dismiss the dialog
  setError(msg: string): void;           // show inline error (pass '' to clear)
  setValue(val: string | string[]): void; // replace the field value
}
```

Usage pattern:
```typescript
dialogService.showInput({
  keepOpen: true,
  onResult: (result, controller) => {
    if (result.button === 'Cancel') { controller!.close(); return; }
    // async check:
    myApi.checkUsername(result.value as string).then(taken => {
      if (taken) {
        controller!.setError('That name is taken — choose another.');
        controller!.setValue('');
      } else {
        controller!.close();
      }
    });
  },
});
```

**Select / listbox default:** When no `defaultValue` is provided, select dropdowns show a disabled `"— Select an option —"` placeholder; listboxes render with nothing selected. The user must make an explicit choice.

**Input validation rules:**
- `integer` — keyboard-restricted to `-` and `0–9`; validates `/^-?\d+$/`; checks min/max
- `float` — keyboard-restricted to `-`, `0–9`, `.`; validates `Number()`; checks min/max
- `number` — standard HTML `<input type="number">`; checks min/max
- `email` — regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
- `url` — `new URL(value)` must not throw
- `required` — blocks OK if the trimmed value (or selected set) is empty

**Stacking:** A callback may open a second dialog (e.g. an error alert on top of a confirmation). The new modal renders on top with a 22 px cascade offset; when it closes, the one below regains keyboard focus.

---

## 5. State Machines

### 5.1 Document Container State Machine

```
                ┌──────────────┐
      create    │              │  collapse click
   ──────────►  │    ACTIVE    │ ─────────────────► COLLAPSED
                │  (has docs)  │ ◄─────────────────
                │              │  restore click
                └──────┬───────┘
                       │ last doc removed
                       │ + forceCloseOnEmpty:true
                       │ OR user clicks [×]
                       ▼
                ┌──────────────┐
                │    HIDDEN    │ ──── killOnClose:true ──► KILLED
                │  (no docs)   │
                └──────┬───────┘
                       │ Window menu restore
                       │ or drag-drop restore
                       ▼
                ┌──────────────┐
                │    ACTIVE    │  (re-enters, new doc added)
                └──────────────┘

EMPTY state (forceCloseOnEmpty:false):
  ACTIVE ──► EMPTY ──► ACTIVE (new doc added)
                └──► HIDDEN  (user clicks [×])
```

**State → visual mapping:**

| State | Container visible | Collapse strip | In Window menu |
|---|---|---|---|
| ACTIVE | Yes | No | Yes (open list) |
| COLLAPSED | Thin strip only | Yes | Yes (open list) |
| EMPTY | Yes (shows defaultTitle, no close btn unless allowClose) | No | Yes (open list) |
| HIDDEN | No | No | Yes (closed list) |
| KILLED | No | No | No |

---

### 5.2 Document Panel State Machine

```
              ┌──────────────┐
    create    │              │ tab drag / move
  ──────────► │    ACTIVE    │ ─────────────────► (moved to new container)
              │   (docked)   │
              └──────┬───┬───┘
                     │   │ tab drag released outside
                     │   │ workspace → FLOAT_DOCUMENT
                     │   ▼
                     │  ┌──────────────┐
                     │  │   FLOATING   │ ◄── SET_FLOAT_GEOMETRY (move/resize)
                     │  │              │ ──── ⊟ button ──────────► ACTIVE (re-docked)
                     │  │              │ ──── × button ──────────► HIDDEN / KILLED
                     │  │              │ ──── ⧉ button ──────────► POPPED_OUT
                     │  │              │ ──── minimize toggle ───► FLOATING (minimized)
                     │  └──────────────┘
                     │
                     │  ┌──────────────┐
                     │  │  POPPED_OUT  │ ──── window closes ─────► ACTIVE (re-docked)
                     │  └──────────────┘
                     │
                     │ user closes (allowClose:true)
                     ▼
              ┌──────────────┐
              │    HIDDEN    │ ──── killOnClose:true ──► KILLED (removed from registry)
              │              │
              └──────┬───────┘
                     │ Window menu restore
                     ▼
              ┌──────────────┐
              │    ACTIVE    │ (restored to original or new container)
              └──────────────┘
```

**State summary:**

| State | `floating` | `poppedOut` | `visible` | Where rendered |
|---|---|---|---|---|
| ACTIVE | null | false | true | Inside a DocumentContainer |
| FLOATING | non-null | false | true | FloatingPanel overlay |
| FLOATING (minimized) | non-null (minimized:true) | false | true | FloatingPanel title bar only |
| POPPED_OUT | null | true | true | Separate browser window |
| HIDDEN | null | false | false | Not rendered; in Window menu |
| KILLED | null | false | false | Removed from state entirely |

---

### 5.3 MDI Row State Machine

```
              ┌──────────────┐
  at least    │              │  all containers removed
  one         │    ACTIVE    │ ──────────────────────► EMPTY
  container   │              │   (RowDropZone shown)
              └──────┬───────┘
                     │ collapse arrow clicked
                     ▼
              ┌──────────────┐
              │  COLLAPSED   │ ─── restore strip click ──► ACTIVE
              └──────────────┘

EMPTY: row remains open; full-width RowDropZone shown inline.
       Container dragged in ──► ACTIVE. User may collapse manually.
```

---

## 6. Drag & Drop Rules

### 6.1 Toolbar Block Reorder

- **Drag target:** block separator / drag handle between blocks
- **Ghost:** no ghost — drop indicator line only (keeps implementation simple)
- **Drop indicator:** `2px var(--accent)` vertical line between target blocks
- **Drop:** reorder `mainToolbar.blockOrder`; persist to localStorage
- **Constraint:** cannot drag outside the toolbar

### 6.2 Document Container Drag (by TitleBar)

- **Trigger:** `allowDragMove: true` on container; `cursor: grab` on title bar
- **Drop zones:** between any two containers in either row; at start/end of row; empty row `RowDropZone`
- **Indicator:** `4px var(--accent)` vertical bar shown between containers at valid drop location
- **Forbidden zones:**
  - Cannot drop immediately before a container with `forbidDropBefore: true`
  - Cannot drop immediately after a container with `forbidDropAfter: true`
  - Forbidden zones: indicator bar not shown; drop is a no-op
- **Cross-row drop:** allowed; container moves from source row to target row; source row collapses if now empty
- **Width normalisation:** after drop, all container `widthPercent` in each row renormalised to sum to 100%

### 6.3 Document Tab Drag

- **Trigger:** tab item in TabBar; `allowAsTab: true` on document
- **Valid drop targets (in priority order):**
  1. Another container in any row where `allowTabs: true` AND `restrictTabToTypes` matches
  2. A container drop zone (between containers or at row end) — creates new container
  3. Empty row `RowDropZone` — creates new container + expands row
- **Tab-to-container matching** (`restrictToTabTypes` / `restrictTabToTypes`):
  - If document `restrictToTabTypes` is non-empty: at least one entry must appear in container `restrictTabToTypes`
  - If document `restrictToTabTypes` is empty: document accepts any container
  - If container `restrictTabToTypes` is empty: container accepts any document
- **New container creation on drop:**
  1. First check for HIDDEN (not KILLED) containers that `allowTabs` and match type restrictions → reuse, move to drop location
  2. Otherwise create new container using `document.defaultContainerOptions`
  3. New container `instanceId` = new UUID; `widthPercent` = equal split of row
- **Source container:** document removed from `documentIds`; if now empty, apply container close rules
- **Drop indicator:** `4px var(--accent)` vertical bar at container drop zones; amber highlight ring on valid container targets

---

## 7. Keyboard Shortcut System

### 7.1 Registry

```typescript
// src/utils/shortcutRegistry.ts

interface ShortcutDef {
  id: string;           // matches menu item id
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  key: string;          // e.g. "s", "n", "F4"
  action: string;       // callback key in actionRegistry
  actionArgs?: Record<string, unknown>;
}

const shortcutRegistry: Map<string, ShortcutDef> = new Map();

// Registered automatically when menu JSON is loaded
export function registerShortcutsFromMenu(items: MenuItem[]): void {
  // recursively walk items; for each with shortcutKey, register
}

// Convenience: register every shortcut found in the top-level menu definition
export function registerShortcutsFromMenuDef(menuDef: MenuRootItem[]): void { /* … */ }

// Wipe every entry from the registry — multi-app hosts call this on shell
// teardown before re-registering the next app's shortcuts so stale entries
// can't fire after navigation. Single-app hosts never need it.
export function clearShortcuts(): void { /* registry.clear() */ }

// Global keydown listener (attached once in App.tsx)
export function handleGlobalKeyDown(e: KeyboardEvent, actionRegistry: ActionRegistry): void {
  const key = buildKeyString(e);  // e.g. "ctrl+s"
  const def = shortcutRegistry.get(key);
  if (def) {
    e.preventDefault();
    actionRegistry.invoke(def.action, def.actionArgs);
  }
}
```

### 7.2 Action Registry

```typescript
// src/utils/actionRegistry.ts

/**
 * Handlers may be synchronous (returning anything, including `void`) or
 * asynchronous (returning a `Promise`). `invoke()` forwards the result so
 * callers that need async-awareness (notably `ModalDialog`'s
 * `closesModal: 'on-success'`) can `await` completion. Callers that ignore
 * the return value continue to work — `void` is assignable to `unknown`.
 */
type ActionHandler = (args?: Record<string, unknown>) => unknown;

const actionRegistry: Map<string, ActionHandler> = new Map();

export function registerAction(name: string, handler: ActionHandler): void {
  actionRegistry.set(name, handler);
}

/**
 * Invoke a registered action and return its result (often `undefined`, but
 * may be a `Promise` for async handlers). Returns `undefined` when no
 * handler is registered under `name`.
 */
export function invokeAction(name: string, args?: Record<string, unknown>): unknown {
  const handler = actionRegistry.get(name);
  if (handler) return handler(args);
  console.warn(`[ActionRegistry] No handler for action: ${name}`);
  return undefined;
}
```

Actions are registered at startup for global operations (file, view, window). Document panels register/unregister their own actions on mount/unmount.

---

## 8. Persistence Strategy

### 8.1 localStorage Keys

| Key | Value | When updated |
|---|---|---|
| `mdi:theme` | `"dark"` \| `"light"` | On theme toggle |
| `mdi:layout` | Full `AppState` as JSON (includes toolbar order, floating geometry) | On every state-changing dispatch (debounced 300 ms) |
| `mdi:popout-closed:<id>` | Transient signal | Written by a popout window on `beforeunload`; read and immediately deleted by the main window's `storage` event listener |

> **Note:** toolbar block order is persisted as part of `mdi:layout` rather than a separate key — no need to read it independently.

**Configurable keys.** Both `mdi:layout` and `mdi:theme` are *defaults*. Multi-app hosts (e.g. a router mounting several MDI shells under one page) call `configureLayoutStorage()` before `loadInitialState()` to give each app its own keys — see §8.2. The popout signal key `mdi:popout-closed:<id>` is intentionally not configurable; it is a narrow, transient channel shared between the popout window and its opener.

**Hydration on startup (`loadInitialState`):**
1. Read `mdi:layout` from localStorage
2. If present and `version` matches: apply `migrateIfNeeded()`, reload toolbar block items from JSON files (not serialised), then:
   a. **Restore floating panels** at their saved `x/y/width/height` geometry — `floating` is kept as-is
   b. **Convert popped-out panels to floating** — browser cannot auto-reopen windows; panels that were `poppedOut: true` become floating at a sensible default geometry (720×520, staggered by 30 px for each)
   c. **Run `restoreOrphanedDocuments()`** — re-inserts any panel that is `visible` but absent from all containers (because it was floating/popped-out at serialisation time) back into its original container via `closedState`, or marks it `visible: false` for Window menu access if the container no longer exists
3. If absent or version mismatch: load `default_layout.json` and use as initial state
4. Always read `mdi:theme` separately (applied before first render to avoid flash)

```typescript
// src/utils/layoutSerializer.ts

interface LayoutStorageConfig {
  storageKey:          string;   // default 'mdi:layout'
  themeKey:            string;   // default 'mdi:theme'
  defaultLayoutPath:   string;   // default '/data/layout/default_layout.json'
  toolbarManifestPath: string;   // default '/data/toolbars/toolbar_manifest.json'
  appId:               string;   // default 'mdi-framework' (baked into saveLayoutToFile output)
  fileNamePrefix:      string;   // default 'mdi-layout' (used by saveLayoutToFile)
}

/**
 * Replace the layout-storage configuration wholesale. Defaults are applied
 * first and `overrides` are merged on top, so previous-call settings cannot
 * leak into the new configuration — important for multi-app hosts that
 * switch shells. Call once per shell mount, before `loadInitialState()`.
 */
export function configureLayoutStorage(overrides?: Partial<LayoutStorageConfig>): void { /* … */ }

/** Read the active configuration (e.g. for a cross-tab listener that needs to know which key is in use). */
export function getLayoutStorageConfig(): Readonly<LayoutStorageConfig> { /* … */ }

export async function loadInitialState(): Promise<AppState> {
  const cfg = getLayoutStorageConfig();
  const stored = localStorage.getItem(cfg.storageKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed.version === CURRENT_VERSION) return migrateIfNeeded(parsed);
    } catch { /* fall through */ }
  }
  const defaultLayout = await fetch(cfg.defaultLayoutPath).then(r => r.json());
  return buildStateFromLayout(defaultLayout);
}

export function persistState(state: AppState): void {
  const cfg = getLayoutStorageConfig();
  localStorage.setItem(cfg.storageKey, JSON.stringify({ ...state, version: CURRENT_VERSION }));
  localStorage.setItem(cfg.themeKey, state.theme);
}
```

**Backwards compatibility.** If `configureLayoutStorage` is never called the behaviour is byte-for-byte identical to the previous version — all six values resolve to their historical defaults. Single-app hosts can ignore the configuration surface entirely.

**Out of scope.** `main.tsx`'s pre-render theme fast-path (`localStorage.getItem('mdi:theme')`) and the popout window's `storage` listener execute before any `configureLayoutStorage()` could fire and intentionally use the literal keys; multi-app hosts that share a theme across apps get the right behaviour for free, and theme-per-app is not currently supported.

### 8.2 Layout Save / Load (User-Facing)

```typescript
export function saveLayoutToFile(state: AppState): void {
  const snapshot = JSON.stringify(serializeLayout(state), null, 2);
  const blob = new Blob([snapshot], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mdi-layout-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function loadLayoutFromFile(): Promise<AppState> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('No file selected'));
      const text = await file.text();
      resolve(buildStateFromLayout(JSON.parse(text)));
    };
    input.click();
  });
}
```

### 8.3 Version Migration

The layout JSON carries a `version` field. A `migrateIfNeeded(state)` function applies incremental migrations when the stored version is older than `CURRENT_VERSION`. This ensures existing localStorage layouts survive app updates.

---

## 9. Application Considerations & Open Questions

### 9.1 Component Registration

Document panel components are registered in `COMPONENT_REGISTRY` in `src/components/DocumentPanel.tsx`. Currently only `DummyPanel` is registered; add real components here as they are built. Unknown `componentType` values fall back to `DummyPanel` rather than crashing.

`React.lazy()` / `Suspense` can be added per-component when bundle size becomes a concern — the registry pattern supports it without wider changes.

### 9.2 State Persistence Volume

Storing the full `AppState` on every dispatch may write large JSON to localStorage frequently. Consider:
- **Debounce** the `persistState` call (e.g. 300 ms after last dispatch)
- **Exclude** ephemeral fields (open dropdown state, drag position) from serialisation
- `state.documents` should store only serialisable fields; runtime refs (component instances) are excluded

### 9.3 Row Width Normalisation

When containers are added, removed, or collapsed, widths must renormalise to sum to 100%. Algorithm:

1. Collect all `visible: true && !collapsed` containers in the row
2. Sum their current `widthPercent`
3. Scale each proportionally so the sum = 100
4. If a new container is added, give it an equal share (divide 100 by n+1, then scale existing)

### 9.4 z-index Hierarchy

All layered elements use a reserved z-index ladder:

| Range | Element |
|---|---|
| 10 | Panel content, container borders |
| 20 | Resize grips within panels/modals |
| 100–199 | Menu bar dropdowns |
| 500 | Drag drop-indicator bars and container ghosts |
| 800–899 | Floating panels (base 800; each `BRING_FLOAT_TO_FRONT` increments `floatZCounter` within this band) |
| 900 | Modal backdrop |
| 901+ | Modal dialog windows |
| 1100 | Toolbar dropdown portals |
| 1101 | Toolbar nested submenu flyout portals |
| 9999 | Drag ghost overlay (if used) |

Toolbar dropdowns must sit above floating panels and modals (hence 1100) to remain usable while panels are floating.

### 9.5 Tab Type Restriction Edge Cases

- If a document has `restrictToTabTypes: []`, it can be dragged into any container that is `allowTabs: true`, regardless of that container's `restrictTabToTypes`
- If a container has `restrictTabToTypes: []`, it accepts any `allowAsTab: true` document
- Both empty = unrestricted drag

### 9.6 Empty Row Drop Zone

When a row is empty (all containers removed/killed), the row remains open and shows a `RowDropZone` — a full-width dashed border area with text "No panels — drag & drop a panel from above". The row stays at its current height; the user may collapse it manually. Minimum height 80 px so the drop target is easily reachable.

### 9.7 localStorage Quota

Browsers typically allow 5–10 MB of localStorage. Full AppState serialisation should stay well below this, but if `state.documents` grows large (many killed but remembered panels), consider pruning KILLED entries from the registry on startup after a retention period.

### 9.8 Toolbar Block Drag UX

The toolbar block drag reorder should use HTML5 drag-and-drop API or a pointer-event based system. Recommend pointer events for consistency with panel drag (which cannot use HTML5 D&D due to custom visuals). A shared `useDragReorder` hook can be parameterised for both use cases.

### 9.9 Shortcut Conflict Detection

When document panels register actions, they may use shortcuts that conflict with global shortcuts. The `registerAction` call should accept a `priority` flag; document-level actions take priority over global ones when a document panel is focused.

### 9.10 Accessibility

- All toolbar buttons and menu items: `role="button"` or `role="menuitem"`; `aria-disabled` for disabled state
- Dropdown menus: `role="menu"` + `role="menuitem"`
- Tab bar: `role="tablist"` + `role="tab"`; `aria-selected` on active tab
- Drag handles: `aria-label="Resize panel"` + keyboard fallback (arrow keys to nudge split)
- Colour contrast: style guide amber on dark `#1c1c1e` gives ~4.5:1 — passes WCAG AA for normal text

### 9.11 Production Build Notes

- Menu JSON files and `default_layout.json` should be served from `/public/data/` so they are available at runtime (not bundled)
- Toolbar JSON files similarly in `/public/data/toolbars/`
- This allows layouts and menus to be updated without rebuilding the app

---

*MDI Framework v0.1 — Functional Requirements Specification*  
*Generated: 2026-05-06*
