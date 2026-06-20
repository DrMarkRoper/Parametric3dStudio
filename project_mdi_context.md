# MDI Framework — Project Context

> **Purpose of this document:** Complete context for continuing development in a new session.
> Read this, then read `MDI_Framework_FRS.md` and `style_guide.md` for the full spec.

---

## What This Is

A reusable **MDI (Multiple Document Interface) framework** built in React 18 + TypeScript.
It provides a fully functional shell — title bar, menu bar, toolbar, two-row MDI workspace,
status bar — that host applications drop their own document panel components into.
The framework handles all layout, persistence, drag & drop, keyboard shortcuts, and theming.
Application code only needs to: register panel components, define JSON menus/toolbars, and
wire action callbacks.

The project is currently at **v0.1** — the framework shell is feature-complete and spec-compliant.
No real document panel components exist yet (everything shows `DummyPanel`).

The floating panel / browser popout / modal dialog system was added in May 2026 (layout v1.1).

---

## Repository Layout

```
MDI/
├── MDI_Framework_FRS.md       ← Full functional requirements spec (source of truth)
├── style_guide.md             ← CSS design tokens, patterns, component visual rules
├── project_context.md         ← This file
└── frontend/                  ← Vite + React + TypeScript app
    ├── package.json
    ├── src/
    │   ├── main.tsx                        Entry point
    │   ├── App.tsx                         Root — bootstrap, action wiring, shortcut registration
    │   ├── styles.css                      All styles (CSS custom properties, dark/light themes)
    │   ├── types/index.ts                  All TypeScript interfaces and the AppAction union
    │   ├── contexts/
    │   │   ├── AppStateContext.tsx          Single context + appReducer (651 lines — core logic)
    │   │   └── DragContext.tsx             Drag & drop state (container drag + tab drag)
    │   ├── components/
    │   │   ├── TitleBar.tsx               App title + theme toggle
    │   │   ├── MenuBar.tsx                Menu bar — full keyboard nav, dynamic Window menu
    │   │   ├── MainToolbar.tsx            Toolbar — drag-reorderable blocks, portal submenus
    │   │   ├── MDIWorkspace.tsx           Two-row MDI area + row resize divider + tear-off/dock
    │   │   ├── MDIRow.tsx                 Single row — containers, resize handles, drop zones
    │   │   ├── DocumentContainer.tsx      Container — titlebar, tab bar, doc toolbar, flash
    │   │   ├── DocumentPanel.tsx          Panel host — looks up componentType in COMPONENT_REGISTRY
    │   │   ├── DummyPanel.tsx             Placeholder shown for all unregistered componentTypes
    │   │   ├── FloatingPanel.tsx          Draggable/resizable overlay panel (8-direction resize)
    │   │   ├── FloatingPanelManager.tsx   Portal host — renders all floating panels into document.body
    │   │   ├── ModalDialog.tsx            Modal dialog + ModalManager portal + GenericModal content
    │   │   └── StatusBar.tsx             Permanent + interrupt (toast) message display
    │   └── utils/
    │       ├── actionRegistry.ts          Global string → handler map; invoke(name, args)
    │       ├── shortcutRegistry.ts        Auto-populated from menu JSON shortcutKey fields
    │       ├── layoutSerializer.ts        localStorage hydration, file save/load, migration
    │       ├── containerFlash.ts          Amber flash animation when a container is focused
    │       └── dialogService.ts           Imperative API: showAlert / showConfirm / showInput; DialogController
    └── public/data/
        ├── layout/default_layout.json     Initial layout loaded on first run
        ├── menus/main_menu.json           Menu bar definition (Window children generated at runtime)
        └── toolbars/
            ├── toolbar_manifest.json      Ordered block list for the main toolbar
            ├── toolbar_file.json          File block items
            ├── toolbar_edit.json          Edit block items (Insert submenu + nested Special Character submenu)
            ├── toolbar_view.json          View block items
            ├── toolbar_format.json        Format block items (available but not in manifest by default)
            └── toolbar_dialogs.json       Dialogs demo block (Alert / Confirm / Input variants incl. keepOpen)
```

---

## Running the App

```bash
cd frontend
npm install        # first time only
npm run dev        # starts Vite dev server at http://localhost:5173
npx tsc --noEmit   # type-check without building
```

---

## Architecture in One Page

### State

Single `AppState` object held in `AppStateContext`, updated by `appReducer`, debounce-persisted
to `localStorage` (`mdi:layout`) 300 ms after every dispatch. Theme is also written to
`mdi:theme` for pre-render flash prevention.

```typescript
interface AppState {
  theme: 'dark' | 'light';
  mdi: MDIWorkspaceState;       // two rows, rowSplit %, rowResizeDisabled
  toolbar: MainToolbarState;    // blockOrder[], blocks{} (each has loaded items[])
  statusBar: StatusBarState;    // visible, allowClose, text, interruptText, interruptDuration
  documents: Record<string, DocumentPanelState>;  // ALL known panels keyed by instanceId
  modals: ModalState[];         // stack of open modal dialogs
  floatZCounter: number;        // monotonically increasing z-index for floating panels
}
```

`DocumentPanelState` carries these notable fields beyond the basics:
- `title: string` — full descriptive title, used by the container header, Window menu, floating-panel title bar, and the tab tooltip.
- `tabTitle?: string` — optional short label for the tab bar / tab-list dropdown only; falls back to `title` when omitted. Even when omitted, the framework applies a CSS `max-width` + ellipsis on tabs as a defensive fallback (see "Tabs" below).
- `floating: FloatingWindowState | null` — non-null while the panel is floating (x, y, width, height, zIndex, minimized)
- `poppedOut: boolean` — true while the panel is rendering in its own browser window

Containers live inside `mdi.topRow.containers[]` and `mdi.bottomRow.containers[]`.
Each container's `documentIds[]` references keys in `state.documents`.

### Actions (AppAction union — types/index.ts)

Every reducer case is one of these action types. The full union is in `types/index.ts`.
Key ones to know:

| Action | What it does |
|---|---|
| `CLOSE_DOCUMENT` | Removes doc from container; hides or kills doc; applies forceCloseOnEmpty |
| `RESTORE_DOCUMENT` | Restores a hidden doc to its original / compatible / new container |
| `INSERT_CONTAINER_WITH_DOC` | Tab dropped on gap — reuses hidden container or creates new |
| `MOVE_DOCUMENT_TAB` | Tab dropped on another container |
| `MOVE_CONTAINER` | Container title dragged to new position |
| `TOGGLE_CONTAINER_COLLAPSE` | Collapses/expands a container to an 18 px strip |
| `SET_STATUS_INTERRUPT` | Shows a timed toast; auto-clears via StatusBar useEffect |
| `REORDER_TOOLBAR` | Updates toolbar.blockOrder after drag reorder |
| `FLOAT_DOCUMENT` | Removes doc from container, sets doc.floating, records closedState for later dock |
| `CLOSE_FLOATING` | Hides or kills a floating panel (mirrors CLOSE_DOCUMENT logic) |
| `DOCK_DOCUMENT` | Docks a floating panel into an existing container |
| `DOCK_DOCUMENT_AT` | Docks a floating panel as a new container at a row position |
| `SET_FLOAT_GEOMETRY` | Updates x/y of a floating panel (panel moved without docking) |
| `BRING_FLOAT_TO_FRONT` | Increments floatZCounter, sets doc.floating.zIndex to the new max |
| `MINIMIZE_FLOAT` | Toggles doc.floating.minimized |
| `POP_OUT_DOCUMENT` | Sets doc.poppedOut = true (App.tsx usePopoutWatcher opens browser window) |
| `POP_IN_DOCUMENT` | Clears doc.poppedOut (called when popout window closes) |
| `OPEN_MODAL` | Pushes a ModalState onto state.modals (auto-assigns uuid id) |
| `CLOSE_MODAL` | Removes a modal by id from state.modals |

### Drag & Drop

`DragContext.tsx` holds two independent drag states: `drag` (container drag) and `tabDrag`
(tab or container-title drag). Both are resolved in `MDIWorkspace.tsx` via `onDrop`,
`onTabDrop`, and `onNoTarget` callbacks which dispatch the appropriate action.

Tab drag that lands on a gap zone goes through `INSERT_CONTAINER_WITH_DOC`, which first
searches for a hidden (not killed) reusable container before creating a new one.

Tab drag that ends with the mouse **outside** the workspace rectangle triggers `onNoTarget`,
which dispatches `FLOAT_DOCUMENT` to tear the panel into a floating overlay.

Floating panel movement is entirely local to `FloatingPanel.tsx` — it does not use
`DragContext`. Title-bar `mousedown` tracks position via `window.mousemove/mouseup` and
dispatches `SET_FLOAT_GEOMETRY` only on `mouseup`. There are no workspace drop targets
for floating panels; docking is exclusively via the `⊟` button in the floating panel
title bar. The drag handler clamps `y >= 0` (live + final), so the title bar — the only
grab handle — can never be dragged above the viewport top. Horizontal motion is
intentionally unclamped; some grabbable surface always remains when the panel is partly
off-screen left/right/bottom.

### Toolbar Alignment Zones

The main toolbar (and per-document toolbar strip) is divided into three flex zones: `left`
(`flex: 1; justify-content: flex-start`), `center` (`flex: 0 0 auto`), and `right`
(`flex: 1; justify-content: flex-end`). Each `ToolbarBlockState` carries an `alignment`
field (`'left' | 'center' | 'right'`, default `'left'`) that determines which zone it
belongs to. The equal `flex: 1` on the left and right zones ensures the center zone is
always mathematically centred even when the two sides are unequal in width.

Drag-reorder is zone-local: `MainToolbar` spawns one `ToolbarZone` component per zone,
each with its own `useZoneDrag` hook. On drop the three zone arrays are concatenated and
dispatched as `REORDER_TOOLBAR`.

### Toolbar Label Mode

Each `ToolbarBlockState` also carries `labelMode: 'icon-title' | 'icon-only'` (default
`'icon-title'`). `ToolbarButton` reads this from its block:

- `icon-title` — renders icon + label text; tooltip appears only when the item has a
  `shortcut` string (the shortcut adds info the visible label doesn't already convey).
- `icon-only` — renders icon only; tooltip always appears in `"Label (Ctrl+X)"` format.

### Toolbar Submenus

`ToolbarMenuPortal` in `MainToolbar.tsx` renders dropdown menus via `createPortal` into
`document.body` with `position: fixed` — this prevents clipping by `overflow: hidden`
MDI rows. Both the main toolbar and per-document toolbar share the same `ToolbarButton`
component, so submenus work identically in both.

`ToolbarMenuPortal` also handles **nested submenus**: items with `type: "submenu"` inside
a portal dropdown are rendered by `PortalSubmenuItem`, which opens a second-level flyout
(also `position: fixed`, portalled into `document.body`) on hover. A shared close-timer
ref with a 100 ms delay prevents accidental dismissal while the mouse travels from the
parent row into the flyout. The flyout automatically flips left if it would overflow the
viewport right edge. Nesting is theoretically unlimited via the shared `renderPortalItem`
helper, which recurses for any `type: "submenu"` child.

### Action Registry

`actionRegistry.ts` is a simple string → handler map. Global actions are registered in
`App.tsx` `useGlobalActions()`. Document panels register their own actions on mount and
unregister on unmount. The `actionRegistry.invoke(name, args?)` function is called from
menu items, toolbar buttons, and keyboard shortcuts.

`ActionHandler` is typed `(args?) => unknown` and `invoke()` returns whatever the handler
returns (often `undefined`, but may be a `Promise` for async handlers). Most callers ignore
the return; `ModalDialog` uses it to implement `closesModal: 'on-success'` (see "Modal
Dialogs" below).

### Shortcut Registry

`shortcutRegistry.ts` is auto-populated by walking the menu JSON on startup
(`registerShortcutsFromMenuDef`). A single `keydown` listener in `App.tsx` calls
`handleGlobalKeyDown` which looks up the registry and invokes the matching action.
A `clearShortcuts()` function is also exported for multi-app hosts that need to wipe
stale entries on shell teardown before re-registering the next app's menu; single-app
hosts never need it.

### Floating Panels

`FloatingPanel.tsx` renders each `doc.floating`-set document as a draggable/resizable
overlay. It receives a stub `DocumentContainerState` (`makeFloatingStub()`) so `DocumentPanel`
works without modification. Title-bar drag uses purely local state — `window.mousemove/mouseup`
listeners track the live position and `SET_FLOAT_GEOMETRY` is dispatched only on mouseup.
Resize uses 8 direction handles (`n/s/e/w/ne/nw/se/sw`) with `window.addEventListener` for
smooth tracking.

Per-panel resize options on `DocumentPanelState`:
- `floatResizable?: boolean` — show resize handles (default: true)
- `floatMinWidth?: number` — minimum width in px (default: 220)
- `floatMinHeight?: number` — minimum height in px (default: 120)

Title bar buttons: `−`/`□` (minimize/restore), `⊟` (dock back via `RESTORE_DOCUMENT`),
`⧉` (pop out via `POP_OUT_DOCUMENT`), `×` (close via `CLOSE_FLOATING`). Z-index management
is via `BRING_FLOAT_TO_FRONT` (dispatched on pointer-down anywhere on the panel), which
increments `state.floatZCounter` and assigns the new value to `doc.floating.zIndex`.
Floating panels occupy z-index 800–899.

**Session persistence:** On reload, floating panels are **restored at their saved geometry**.
Panels that were popped out are demoted to floating (720×520, staggered by 30 px per panel).
`restoreOrphanedDocuments()` then re-inserts any panel absent from all containers back into
its original container via `closedState`, or marks it `visible: false` as a fallback.

`FloatingPanelManager` is rendered inside `MDIWorkspace`'s `DragProvider` (so it can call
`useDrag()`) and uses `createPortal` to place panels in `document.body`.

### Modal Dialogs

`ModalDialog.tsx` exports `ModalManager` (portal into `document.body`) which renders all
`state.modals` entries. A single backdrop sits behind all modals (z-index 900); each dialog
sits above it, z-indexed by stack position (1-based). Multiple modals stack with a 22 px
cascade offset so each dialog is visually distinct from the one beneath it.

Each modal is **draggable** by its title bar (local `mousedown/move/up`; no DragContext).
When `allowResize: true` (default), a diagonal-stripe grip appears in the bottom-right corner
for free resizing, with `minWidth`/`minHeight` floors (defaults: 260×120 px). Initial width
defaults to 400 px; height is content-driven unless explicitly set.

**Stacking detail:** `.modal-layer` no longer uses flex centering. Each `.modal-dialog` centres
itself via CSS `position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%)`.
`ModalDialog` receives an `index` prop from `ModalManager` and applies a cascade transform
(`translate(calc(-50% + index*22px), calc(-50% + index*22px))`) plus a per-index z-index.
Dragged dialogs use explicit `left`/`top` with `transform: none` as before.

**`ModalState` key fields:** `title`, `componentType`, `width?`, `height?`, `props?`,
`allowClose?` (default true), `onCloseAction?` (fired before close when × is clicked),
`buttons?`, `allowResize?`, `minWidth?`, `minHeight?`.

**Button bar (`buttons` array):** Three alignment zones — left / center / right. Each button
has `label`, optional `action` (actionRegistry key), optional `args`, `variant`
(`default | primary | danger`), `alignment` (default `right`), `closesModal`, and
optional `keys?: string[]` (keyboard shortcuts, e.g. `['Enter']`, `['Escape']`). Only the
topmost open modal processes key bindings; keys not listed on any button have no effect.
When `buttons` is absent/empty, `GenericModal` renders its own inline OK button.

**`closesModal: boolean | 'on-success'`.** `true` closes the modal synchronously after the
action runs (regardless of whether it succeeded). `'on-success'` wraps the action's return
value in `Promise.resolve(...)` and closes only on resolution — a rejection or thrown error
keeps the modal open so the handler can surface an inline validation error. `false`/omitted
never closes (action handles close itself). Both the click path and the keyboard path use a
single `runModalButton(btn, closeModal)` helper so behaviour is identical across mouse and
key triggers.

**Form-modal pattern (`NewLayoutModal` example):** The content component registers a capturing
action on mount (e.g. `'newLayout:create'`) that reads a `formRef` updated by `useEffect`.
The Create button in the button bar invokes this action. This avoids prop threading and keeps
form state local to the content component.

**`MODAL_REGISTRY`** (in `ModalDialog.tsx`):

| componentType | Purpose |
|---|---|
| `GenericModal` | Shows `props.message` as text; self-contained OK button when no `buttons` array |
| `NewLayoutModal` | New layout form (name, description, row-visibility checkboxes) |
| `AlertDialog` | Icon + message + single OK button (no × close). Used by `dialogService.showAlert`. |
| `ConfirmDialog` | Icon + message + preset button arrangement. Used by `dialogService.showConfirm`. |
| `InputDialog` | Icon + message + input widget (text/select/listbox) with validation. Used by `dialogService.showInput`. |

To open a modal from anywhere:
```typescript
// Via action (works from menus, toolbar buttons, keyboard shortcuts):
actionRegistry.invoke('openModal', { title, componentType, props?, width?, height? });

// Via dispatch (from components with access to useAppState):
dispatch({ type: 'OPEN_MODAL', modal: { title, componentType, buttons: [...], ... } });
```

### Dialog Service (`utils/dialogService.ts`)

Imperative API for the three standard dialog types. Wire-up: `dialogService.setDialogDispatch(dispatch)`
is called in `App.tsx`'s `useGlobalActions`. The `'_dialogResult'` actionRegistry action is also
registered globally there to deliver button-press results.

```typescript
import * as dialogService from './utils/dialogService';

// Alert — no × button, single OK
dialogService.showAlert({
  title?: string,           // default 'Alert'
  message: string,
  mode?: 'info' | 'question' | 'warning' | 'error',
  onClose?: (result: DialogResult) => void,
});

// Confirm — × button, preset buttons
dialogService.showConfirm({
  title?: string,           // default 'Confirm'
  message: string,
  mode?: DialogMode,
  buttons?: ButtonPreset,   // 'ok' | 'ok-cancel' | 'yes-no' | 'yes-no-cancel' | 'retry-cancel' | 'abort-retry-ignore'
  onResult?: (result: DialogResult) => void,
});

// Input — text box, dropdown, or listbox
dialogService.showInput({
  title?: string,           // default 'Input'
  message?: string,
  mode?: DialogMode,
  inputType?: 'text' | 'number' | 'integer' | 'float' | 'email' | 'url',
  widgetType?: 'text' | 'select' | 'listbox',  // inferred from options if omitted
  required?: boolean,
  min?: number,             // for integer / float / number
  max?: number,
  defaultValue?: string | string[],
  placeholder?: string,
  options?: Array<{ key: string; value: string }>,  // for select / listbox
  multiple?: boolean,       // multi-select listbox
  okLabel?: string,         // default 'OK'
  cancelLabel?: string,     // default 'Cancel'
  keepOpen?: boolean,       // default false — keep dialog open after any button press
  // controller is only provided when keepOpen: true
  onResult?: (result: DialogResult, controller?: DialogController) => void,
});
```

**`DialogResult`**: `{ button: string; value?: string | string[] }`
- `button` — label of the pressed button
- `value` — set only for InputDialog when OK is pressed and validation passes (string, or string[] for multi-select listbox)

**`DialogController`** (only provided when `keepOpen: true`):
- `close()` — dismiss the dialog from async code
- `setError(msg)` — show an inline validation error inside the dialog (pass `''` to clear)
- `setValue(val)` — replace the current field value (string or string[])

**Callback delivery mechanism:**
Each `show*` call generates a unique `callbackKey`. Alert/Confirm button bars use the shared
`'_dialogResult'` action with static `args: { callbackKey, button }`. InputDialog's OK button
instead invokes a per-dialog `'_inputDialog:<key>'` action registered by `InputDialog` on mount —
this runs validation, then calls `invokeDialogCallback` + `onClose()` only if validation passes.
No × close button is shown on any of the three standard dialog types (`allowClose: false`).

**keepOpen mode:** When `keepOpen: true` on `showInput`, neither button auto-closes. The callback
receives a second argument: a `DialogController` with `close()`, `setError(msg)`, and
`setValue(val)`. The controller is implemented inside `InputDialog` on mount and registered in
`dialogService`'s `_controllers` map. The Cancel button also delivers to `onResult` (instead of
dismissing immediately) so the caller can decide whether to close. Callbacks are stored in a
separate `_keepOpenCallbacks` map that is NOT cleaned up by effect cleanup cycles (important for
React StrictMode compatibility); the callback is removed when `controller.close()` is called.

**Input dialog select behaviour:** When no `defaultValue` is provided, select dropdowns display a
disabled "— Select an option —" placeholder (value `''`). Listboxes render with nothing selected.
The user must make an explicit choice before OK is accepted.

**Stacking behaviour:** A document panel callback can call `showAlert`, which pushes a second
modal. The new modal renders on top with a 22 px cascade offset, fully interactive. When it
closes, focus returns to the dialog below. This can cascade arbitrarily deep.

**Development:** `window.mdi` exposes `{ showAlert, showConfirm, showInput }` for quick
testing in the browser console without needing to wire UI actions.

**Input validation rules:**
- `integer`: keyboard-restricted to `-` and `0–9`; validates `/^-?\d+$/`; checks min/max
- `float`: keyboard-restricted to `-`, `0–9`, `.`; validates `Number()`; checks min/max
- `number`: standard HTML number input; checks min/max
- `email`: regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
- `url`: `new URL(value)` must not throw
- `required`: blocks OK if the trimmed value (or selected items) is empty

### Browser Popout Windows

When `doc.poppedOut` is set, `usePopoutWatcher` in `App.tsx` opens a new browser window at
`#popout=<instanceId>`. `main.tsx` detects the hash and renders `PopoutApp` (full state
load + `AppStateProvider` + minimal `PopoutInner` title bar). On `beforeunload`, the popout
writes `localStorage.setItem('mdi:popout-closed:<id>', ...)` — the main window's `storage`
event listener sees this and dispatches `POP_IN_DOCUMENT` + `RESTORE_DOCUMENT` to bring
the panel back.

### localStorage Keys

| Key | Value |
|---|---|
| `mdi:layout` | Full `AppState` JSON (debounced 300 ms; floating geometry restored on load; popped-out panels demoted to floating) |
| `mdi:theme` | `"dark"` or `"light"` (read before first render) |
| `mdi:popout-closed:<id>` | Transient signal written by popout `beforeunload`; cleared by main window immediately |

Both `mdi:layout` and `mdi:theme` are defaults — they can be overridden via
`configureLayoutStorage()` (see "Configurable storage" below). The popout signal key is
intentionally fixed.

### Configurable storage (`layoutSerializer.ts`)

`utils/layoutSerializer.ts` exposes two functions a host can call before `loadInitialState()`
to point the framework at custom keys / paths:

- `configureLayoutStorage(overrides?: Partial<LayoutStorageConfig>)` — replaces the config
  **wholesale** (defaults applied first, then overrides), so previous-app settings cannot
  leak across mounts. Six configurable fields: `storageKey`, `themeKey`, `defaultLayoutPath`,
  `toolbarManifestPath`, `appId` (baked into `saveLayoutToFile()` output), `fileNamePrefix`
  (used for the user-saved layout filename).
- `getLayoutStorageConfig()` — read the active config, e.g. for a cross-tab listener that
  needs to know which key is in use.

If never called, the framework's historical defaults (`'mdi:layout'`, `'mdi:theme'`,
`'/data/layout/default_layout.json'`, `'/data/toolbars/toolbar_manifest.json'`,
`'mdi-framework'`, `'mdi-layout'`) apply byte-for-byte. `main.tsx`'s pre-render theme
fast-path uses the literal `'mdi:theme'` deliberately — it runs before any configure call.

### Layout Migration

`layoutSerializer.ts` has `migrateIfNeeded()`. Current version is **v1.1**. Existing v1.0
layouts are automatically migrated by `migrate_1_0_to_1_1()` which adds `floating: null`,
`poppedOut: false`, `modals: []`, and `floatZCounter: 0` defaults. Add further migration
steps here for future schema changes. Unrecognised versions fall back to `default_layout.json`.

---

## Key Design Decisions (and why)

**Single flat `state.documents` map** — Documents are kept in one place rather than per-container.
Containers hold only `documentIds[]` (string references). This makes restore, Window menu
generation, and cross-container moves trivial — no data duplication.

**`widthPercent` as flex weight, not strict %** — Container widths are stored as numbers
that are used directly as CSS `flex` values. `normaliseRowWidths()` is called after any
layout change to keep them summing to 100, but the flex engine handles the actual pixel
distribution. Never assume they sum to exactly 100 mid-reducer.

**`createPortal` for all dropdown menus** — MDI rows have `overflow: hidden`. Any dropdown
rendered inside a row would be clipped. All toolbar dropdowns (main + per-document) use
`ToolbarMenuPortal` which portals into `document.body` with `position: fixed` coordinates
from `getBoundingClientRect()`. The menu bar `Dropdown` is also portalled into `document.body`
for a different reason: the menubar has `position: relative; z-index: 100` which creates its
own stacking context. Even with `position: fixed; z-index: 1100`, a dropdown rendered inside
that context is painted in the menubar's stacking layer (level 100) — below the floating panel
layer (level 800). Portalling into `document.body` puts the dropdown in the root stacking
context where its z-index 1100 correctly beats floating panels. Click-outside detection still
works because the dropdown has `onMouseDown={e => e.stopPropagation()}`, preventing portaled
clicks from reaching the document-level `mousedown` listener.

**DragContext isolation** — Drag state is kept in its own context so `MDIRow` and
`DocumentContainer` can subscribe without re-rendering the whole app tree.

**`containerFlash.ts` event bus** — The amber flash animation when a container receives
focus is done via a tiny event emitter (`subscribeFlash` / `emitFlash`) rather than state,
because it's purely visual and should not trigger a full state update + persist cycle.

**`prefixTitle` on containers** — When `true`, the container's title bar shows
`"{defaultTitle} – {activeDoc.title}"` instead of just the document title. Useful for
fixed containers (e.g. "Properties – My Document").

**`resizable: false` suppresses handles** — When either container adjacent to a resize
handle has `resizable: false`, the handle renders with `.no-resize` class (default cursor,
no `onMouseDown`), but still acts as a tab drop target.

**`forceCloseOnEmpty` vs `allowClose`** — `forceCloseOnEmpty` hides the container when
its last document is removed (e.g. scratch panels). `allowClose` gives the user an explicit
`×` button. Both can be set independently.

---

## Adding a Real Document Panel

1. Create `src/components/panels/MyPanel.tsx` — receives `doc: DocumentPanelState` and
   `container: DocumentContainerState` as props; use `useAppState()` for dispatch.

2. Register it in `src/components/DocumentPanel.tsx`:
   ```typescript
   import { MyPanel } from './panels/MyPanel';
   const COMPONENT_REGISTRY = { DummyPanel, MyPanel };
   ```

3. Add an entry to `public/data/layout/default_layout.json` with `componentType: "MyPanel"`,
   or create it dynamically via a `INSERT_CONTAINER_WITH_DOC` dispatch.

4. If the panel has its own toolbar actions, call `actionRegistry.register(name, handler)`
   in a `useEffect` on mount and return the cleanup.

5. If it needs toolbar buttons, list the toolbar block ids in `doc.toolbarMenus`.

---

## Adding a Menu or Toolbar Item

All menu/toolbar items use the same JSON shape (`MenuItem` in `types/index.ts`).

- **Menu bar items** → edit `public/data/menus/main_menu.json`
- **Toolbar buttons** → edit the relevant `public/data/toolbars/toolbar_*.json`
- **New toolbar block** → add an entry to `toolbar_manifest.json` and create the JSON file;
  set `alignment` (`"left"` / `"center"` / `"right"`) and `labelMode` (`"icon-title"` / `"icon-only"`)
- **Block alignment** → set `alignment` on the block in `toolbar_manifest.json` and in the
  `mainToolbar.blocks` entry in `default_layout.json`; the block will render in the
  corresponding zone of both the main toolbar and any per-document toolbar that includes it
- **Label mode** → set `labelMode` on the block; `"icon-only"` always shows a tooltip,
  `"icon-title"` shows one only when a shortcut key is defined
- **Nested submenu** → add a child item with `"type": "submenu"` and its own `"children"`
  array inside any toolbar block JSON; the portal renderer recurses automatically
- **Keyboard shortcut** → add `shortcutKey: { ctrl, shift, alt, key }` to the menu item;
  it is auto-registered on startup
- **Handler** → call `actionRegistry.register('onMyAction', handler)` in `App.tsx`
  `useGlobalActions()` or in the relevant panel's `useEffect`

---

## What's Not Done (Deferred Items)

These are intentionally deferred — noted as TODOs in the code, not forgotten:

- **Layout file validation popup** — `layoutSerializer.ts` `loadLayoutFromFile()` has a
  `TODO` comment. When a loaded file is malformed, it currently just falls through to an
  uncaught error. Now that `ModalDialog` exists, a validation error modal should be wired
  here: catch schema violations and call `actionRegistry.invoke('openModal', { ... })`.

- **`NewLayoutModal` real wiring** — The Create button currently shows a status interrupt
  as a stand-in. The action `'newLayout:create'` needs to dispatch a real reset-workspace +
  apply-settings flow when the layout system is ready.

- **Real document panels** — Only `DummyPanel` exists. `FileExplorer`, `TextEditor`,
  `OutputPanel`, `WelcomePanel` etc. need to be built as real components.

- **`React.lazy()` for panels** — `COMPONENT_REGISTRY` supports it; add when panels are
  heavy enough to justify code-splitting.

- **Shortcut priority / conflict detection** (§9.9) — Document-level actions currently
  register globally. When multiple panels are open, last-registered wins. Add a priority
  flag to `actionRegistry.register()` if this becomes an issue.

- **KILLED entry pruning** (§9.7) — `killed: true` containers/docs stay in localStorage
  indefinitely. Add a startup sweep to prune entries older than N days if the registry grows.

- **Safari resize cursor on `clip-path` elements** — The diagonal-stripe resize grip on
  floating panels and modals uses `clip-path: polygon(...)` to create a triangular corner
  visual. Safari does not show the `se-resize` cursor on hover over `clip-path` elements.
  The grip is still functional (drag works); only the cursor indicator is missing in Safari.
  Chrome is unaffected.

---

## Current Spec Compliance

The framework is fully compliant with `MDI_Framework_FRS.md` v0.1. The FRS has been updated
to match all implementation decisions made during development, including toolbar alignment
zones, labelMode, nested submenus, the floating panel / popout / modal system (all May 2026),
session-persistent floating geometry and orphaned-document recovery (also May 2026).

TypeScript: `npx tsc --noEmit` produces **zero errors** (verified after all May 2026 additions).

---

## Files to Read First in a New Session

In order of importance:

1. `project_context.md` — this file
2. `MDI_Framework_FRS.md` — full requirements and design decisions
3. `frontend/src/types/index.ts` — all interfaces and action union
4. `frontend/src/contexts/AppStateContext.tsx` — the reducer, all state logic
5. `frontend/src/contexts/DragContext.tsx` — drag state for container and tab drags
6. The specific component file for whatever you're working on

Key component files:
- `FloatingPanel.tsx` / `FloatingPanelManager.tsx` — floating overlay windows
- `ModalDialog.tsx` — modal dialogs, button bar, MODAL_REGISTRY
- `layoutSerializer.ts` — persistence, migration, orphan recovery
