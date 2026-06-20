# Parametric3dStudio v.0.1 — Project Context

> **Purpose**: self-contained carry-forward reference for continuing development
> in a fresh session or after the project is moved to a new folder. Everything
> needed to understand this app is in this file plus its three sibling docs:
> `project_mdi_context.md` (framework architecture), `MDI_Framework_FRS.md`
> (framework functional spec), `style_guide.md` (CSS tokens), and
> `framework_changes.md` (log of edits to framework-core files).

---

## 1. What the app is

A browser-based **parametric 3D modeller / viewer** built with React 19 +
TypeScript + Vite + Three.js, presented inside a desktop-style **MDI shell**
(title bar, menu bar, toolbar, resizable document containers, MDI status bar).

The modelling engine is a self-contained library under `frontend/src/studio/`;
the MDI shell hosts it through three document panels and a JSON/action-driven
toolbar. Prototype stage.

### Project shell

- **Project metadata**: every project carries `{ name, description, createdAt,
  modifiedAt }`, displayed after the em-dash in the title bar (or `— unsaved`
  before the first save). A trailing `*` marks the doc as dirty.
- **Save / Save As**: first save (or any time the name is blank) opens
  `SaveProjectModal` (name required, description optional, created date shown
  when known). Subsequent saves just refresh `modifiedAt`. **Save Project As…**
  (`Ctrl+Shift+A`) always re-opens the dialog with the existing values
  pre-filled.
- **Open / New** with unsaved changes prompt the user (Yes / No / Cancel) via
  `dialogService.showConfirm`. Open also forces the canvas back to 3D model
  view — so a sketch left open in the previous project never persists into the
  newly loaded one. New always starts on the default 3D canvas.
- **Project file format** stays `version: 2` JSON, now with a top-level `meta`
  object alongside `doc` and `meshes`. Legacy files without `meta` load with
  empty metadata; the file name (sans `.cad.json`) becomes the fallback name.

### Modelling capabilities

- **File I/O**: import STL / OBJ / glTF / GLB / STEP; export STL; save / load
  JSON project files (with metadata + embedded meshes).
- **Primitives**: box (labelled **Cube**), sphere, cylinder, cone, torus — each
  with position, XYZ rotation, optional fillet/chamfer edge, colour, opacity.
- **Custom thread primitives** (Create → Torus → **Custom ▸** in model mode —
  see §4.5 / §5):
  - `bulbScrew` — glass-bulb sphere over an Edison-threaded cap with a small
    contact "pip" dome at the foot (default E27, 60 mm bulb). Renders as **two
    bodies sharing one feature id** — the cap + contact use `f.color` /
    `f.opacity`, the glass envelope uses `f.secondaryColor` /
    `f.secondaryOpacity`. The Info panel shows both pickers on adjacent rows
    (**Cap colour & opacity** + **Bulb glass & opacity**); selecting either
    body still picks the same feature in the tree. The split path only fires
    when `op === 'new'`; for cut / fuse the cap + bulb merge back into a single
    mesh that uses `f.color`.
  - `bulbSocket` — cylindrical holder with an Edison-threaded bore that mates
    with `bulbScrew`. Default E27 + 3 mm wall.
  - `screwThread` — ISO metric hex-head bolt (cylindrical hex sized across
    corners). Default M8 × 1.25, 30 mm shaft, 5 mm head.
  - `nutThread` — hex prism with a V-threaded bore. `outerSize` is quoted
    across the **flats** (the universal nut convention); the build internally
    converts to across-corners for `CylinderGeometry(radialSegs = 6)`.

  All four share the dim keys `outerDiameter / pitch / threadDepth / height`;
  shape-specific extras are `bulbDiameter` / `wallThickness` /
  `headDiameter + headHeight` / `outerSize`. The Info panel surfaces a
  **Standard** preset dropdown — IEC 60061 bulb sizes (E10/E12/E14/E17/E26/
  E27/E40) for the bulb shapes and ISO 261 coarse (M3..M20) for the bolt/nut;
  the dropdown drops back to "Custom" automatically when the live dims don't
  match a preset.

  Threads are generated as helical parametric meshes (rounded sinusoidal for
  Edison, 60° V-triangle for ISO) by `buildThreadedShaft(...)` in
  `buildGeometry.ts`. Side-surface winding is `(a, c, b) / (b, c, d)` so
  outward normals face away from the axis — getting this wrong produces a
  silently-inverted "inside-out" plug that `three-bvh-csg` happily subtracts
  but leaves the nut / socket bore looking smoothly cylindrical (initial bug
  during development). Bolt + bulb-screw merge head + shaft / cap + bulb via
  raw buffer concatenation (`mergeRaw`); nut + socket cut the threaded plug
  from a hex / cylinder shell via `three-bvh-csg` SUBTRACTION. The thread
  surface tapers smoothly to `rMinor` over one pitch at each end so the end
  caps close cleanly as flat discs.
- **2D Sketching**: line chains, rectangles, circles / **ovals** (axis-aligned
  ellipses with optional `radiusY`, plus accumulated `rotation` so they can
  spin), **arcs** (centre + radius + start/end angle), **cogs** (closed
  spur-gear profile — centre + outer & inner radii + integer tooth count +
  selectable tooth `profile`: `pointy` / `trapezoid` / `square`), and image
  references; per-entity construction-line toggle + a global Show construction
  checkbox in the sketch info panel.
- **Sketch tools**: Select, Line, Rectangle, Circle / Oval, **Arc** (3-click
  centre → start → end), **Cog** (two-click centre → outer radius, defaults
  tooth count off the radius and seeds `profile: 'pointy'`; lives under
  Create → **Custom** → Cog while sketching — see §4.5), Fillet, Chamfer,
  **Offset** (line / circle / ellipse / rect — rect offset carries equivalent
  fillets / chamfers at the offset corners), Construction toggle, Insert Image,
  **Measure** (two-point distance readout in the canvas + a Measurement table
  in the Info panel), **Dimension** (perpendicular extension lines + parallel
  dim line, draggable label, customisable label with `{}` substitution for the
  measured distance, anchored to entity feature points so it tracks them as
  they move).
- **Default tool**: a brand-new sketch opens on Line ready to draw; opening an
  existing sketch with entities defaults to Select so you don't accidentally
  add geometry while inspecting. `Esc` on any sketch tool falls back to Select.
- **Extrude**: face-picker selects distinct closed regions from a sketch
  (planar arrangement engine includes arcs, ellipses, dimensions are excluded);
  bevel/chamfer on extruded edges; auto-heals when sketch entities move/resize
  /delete (`chooseRegions` snaps saved region points to the nearest region by
  `rep` distance, falls back to all-profiles if nothing matches). Carries
  `distance` (thickness) **and** an optional `offset` — a perpendicular start
  height along the plane normal, so the body can begin above the sketch plane
  instead of flush with it (applied as a local-Z translate in `buildExtrude`).
  Extrudes are always `op: 'new'` (additive) and never CSG-cut each other — each
  sketch + its extrusion is independent. When sketch entities are **moved**
  (interactive drag, dynamic move, or the numeric Move block), the dependent
  extrude's `regionPts` that lie inside the moved entities' bbox are shifted by
  the same delta (`followRegionPts` in `Viewport`, mirrored in
  `PropertiesPanel`) so the extruded face follows the move instead of
  `chooseRegions` snapping to a different region (e.g. a slot's inner hole-disk).
  *Known limitation:* rotation of entities does not yet carry `regionPts`.
  Files saved **before** this fix may already hold stale `regionPts`; the move
  tracking can't retroactively repair baked-in data, so the Info panel offers
  **Re-select profiles…** (`reselectExtrudeFaces` → re-enters the sketch face
  picker bound to that extrude; Accept updates it in place) and **Use all
  profiles** (`resetExtrudeProfiles` → clears `regionPts` → `defaultRegions`).
  `facePick` gained an optional `editId` so `acceptExtrude` updates the existing
  extrude instead of creating a new one.
  Two solids overlapping on a coplanar face still z-fight in the depth buffer
  (looks "cropped" along the overlap) — separate them with `offset` or merge.
  Viewport projection is perspective by default; switch to **Orthographic** (the
  View select on the status bar) to make parallel planes at different offsets
  line up.
- **Detach from sketch**: bakes an extrude into a free-form `ImportFeature`
  (`embedded: true`) that persists in project files and moves/rotates with the
  gizmo.
- **Parameters**: named variables with arithmetic expressions (trig, sqrt, abs,
  floor, ceil, round, min, max, pi); usable in any dimension field.
- **Transform gizmo**: drag-to-move / drag-to-rotate for primitives & imports,
  with live preview.
- **Merge (boolean)**: pairwise cut A−B / cut B−A / fuse / intersect; "Create
  independent body" bakes the result into a new import.
- **Sketch on Face**: click a face of any body to create a sketch aligned to
  that face.
- **Snap modes**: No snap / Grid snap / Edge snap (endpoints, midpoints, circle
  centres / quadrants, rect corners / edge-mids, arc endpoints + centre, cog
  centre + outer-radius quadrants, line-line & line-circle intersections);
  two-shade blue ring indicator.
- **Box selection**: left→right crossing (dashed green), right→left window
  (solid blue); multi-select origin / offset editing.
- **Image import**: reference image placed in a sketch; scale / crop fit modes,
  aspect lock, alignment, opacity.
- **Entity rotation**: rects, images & ovals carry a `rotation` field (CW
  positive — see §10); rects / images pivot around their corner anchor, ovals
  around their centre.
- **Dynamic Move / Dynamic Rotate**: click-driven grab/place with live
  preview, exact-value entry, and a CW-positive readout that follows the
  mouse direction.
- **Split into lines** on a rectangle: bakes each **chamfer** into a real
  `LineEntity` and each **fillet** into an `ArcEntity`, shortens the four
  rect-derived line entities to terminate at the cut / tangent points, and
  removes the consumed corner mods.
- **Undo / redo**: 50-step stack; `Ctrl-Z` / `Ctrl-Shift-Z` / `Ctrl-Y`.
- **Validation**: duplicate-name checks, delete confirmation with dependent
  lists, ⚠ icons on features with errors.
- **Assembly mode** (third mode beside model & sketch — see
  `assembly_mode_design_guide.md` for the full design + as-built notes):
  declare mechanical **joints** on bodies (Revolute = rotate about an axis
  through an origin; Prismatic = slide along a vector) with free or limited
  min/max, and **links** that couple two joints by a ratio + phase
  (Rotation↔Rotation, Rotation↔Linear, Linear↔Linear). Cog-to-cog ratios
  auto-derive from tooth counts (`N₁/N₂`, negative for external mesh). Enter via
  the **Modify ▸ Assembly** toolbar button or the **Assembly** menu; the
  `tb-assembly` block then shows Revolute / Prismatic / Link / Delete / Exit.
  Pick a body (click it) and add a joint — its origin/axis are seeded from the
  body's world bbox (centre + thinnest axis = a flat cog's spin axis) and edited
  numerically in the panel. Drag the on-canvas handle (amber ring / arrow) to
  drive a joint, or use the editor's slider with `«` / `0°` (reset) / `»` step
  buttons and a **Step** field (defaults to ¼ of range, or 90°/10 mm when free;
  free revolute wraps past ±180°). Values clamp to the resolved range
  (own range ∩ each partner's range mapped through the ratio) and propagate
  across links (undirected: forward by ratio, inverse the other way). Acyclic
  driver→driven only — cycles are detected and warned (status bar + Joints tab),
  never solved. **Non-destructive**: the model tree is frozen, geometry is baked
  to world space so the home pose is the identity, motion is a transient overlay
  (`assembly.jointValues`, not undoable, not serialised), and leaving the mode
  snaps everything home. Joint/link *definitions* live on `Doc` (serialised,
  undoable, dirty-flagging). The RHS **Info** tab is swapped for two **Joints**
  and **Links** document tabs while assembling (non-closable, draggable so both
  can be torn out side-by-side; torn containers `killOnClose` and the swap is
  reconciled idempotently on mode change in `useStudioActions`); leaving
  restores Info. New files: `studio/core/assembly.ts` (pure math) +
  `assembly.test.ts` (17 Vitest cases, `npm test`), `components/panels/
  JointsPanel.tsx` + `LinksPanel.tsx`; additive edits to `studio/types.ts`
  (`Joint` / `Link` on `Doc`), `state/store.ts`, `studioBridge.tsx`,
  `io/exporters.ts`, `Viewport.tsx`, `PropertiesPanel.tsx`,
  `useStudioActions.ts`, `StudioStatusBar.tsx`, `DocumentPanel.tsx`
  (COMPONENT_REGISTRY), the toolbar/menu/layout JSON (`tb-assembly`,
  `menu-assembly`, `doc-joints` / `doc-links` in `default_layout.json`).
  *Picking up the toolbar + tabs on an existing install needs one
  View → Reset Workspace Layout (they're defined in `default_layout.json`).*

---

## 2. Tech stack

| Package | Version | Role |
|---|---|---|
| react / react-dom | ^19 | UI (required by react-three-fiber 9) |
| typescript | ^5.7 | Types |
| vite | ^6 | Build |
| three | ^0.184 | 3D rendering |
| @react-three/fiber | ^9 | Three.js React bindings |
| @react-three/drei | ^10 | OrbitControls, TransformControls, Line, Grid, GizmoHelper, Html |
| three-bvh-csg | ^0.0.18 | CSG boolean ops (ADDITION / SUBTRACTION / INTERSECTION) |
| three-mesh-bvh | ^0.9 | BVH acceleration (peer of above) |
| zustand | ^5 | Modelling state management |
| occt-import-js | ^0.0.23 | OpenCascade WASM for STEP import (lazy-loaded) |
| vitest | ^4 | Unit tests (dev-only) — `npm test` |

**Commands** (run inside `frontend/`):

```bash
npm install
npm run dev        # vite dev server
npm run build      # tsc && vite build
npx tsc --noEmit   # type-check only
npm test           # vitest run — currently the assembly-math suite (core/assembly.test.ts)
```

> Sandbox note: if the `dist` folder has ownership issues, build with
> `npx vite build --emptyOutDir=false`. On ARM64 Linux you may need
> `npm install --no-save @rollup/rollup-linux-arm64-gnu` first. `occt-import-js`
> is excluded from Vite dep-optimization (see `vite.config.ts`).

---

## 3. Repository layout

```
Parametric3dStudio/
  project_context.md          ← this file
  project_mdi_context.md      ← framework architecture overview
  MDI_Framework_FRS.md        ← framework functional spec
  style_guide.md              ← CSS tokens / theme rules
  framework_changes.md        ← log of framework-core edits
  frontend/
    index.html
    package.json  vite.config.ts  tsconfig.json  tsconfig.node.json
    public/data/
      layout/   default_layout.json, blank_layout.json
      menus/    main_menu.json
      toolbars/ toolbar_manifest.json + per-block JSON
    src/
      main.tsx                ← React root; imports styles.css then studio/studio.css
      App.tsx                 ← shell wiring (app-layer); calls useStudioActions();
                                 derives sketch-aware menu via useSketchAwareMenu()
      types/index.ts          ← framework types (AppState, AppAction, …)
      contexts/               ← AppStateContext (reducer), DragContext
      utils/                  ← actionRegistry, shortcutRegistry, layoutSerializer, dialogService, …
      components/             ← MDI shell components (TitleBar, MenuBar, MainToolbar,
                                MDIWorkspace, MDIRow, DocumentContainer, DocumentPanel,
                                FloatingPanel(Manager), ModalDialog, StatusBar, DummyPanel)
        StudioStatusBar.tsx   ← APP-LAYER replacement for framework StatusBar
                                 (hint + errors + cursor + grid / snap controls)
        panels/               ← APP PANELS: FeaturesPanel, CanvasPanel, InfoPanel,
                                 JointsPanel, LinksPanel (Assembly-mode tabs)
      studio/                 ← VENDORED modelling engine; small additive edits
                                 logged in framework_changes.md when needed
        types.ts  occt-import-js.d.ts  studio.css
        core/     expressions.ts, sketchGeometry.ts, buildGeometry.ts, assembly.ts (+ assembly.test.ts)
        io/       importers.ts, exporters.ts
        state/    store.ts (Zustand)
        components/ App.tsx*, Toolbar.tsx*, SidePanel.tsx, PropertiesPanel.tsx,
                    Viewport.tsx, StatusBar.tsx   (*App/Toolbar copied but unused)
        studioBridge.tsx      ← glue: useRegen + commands + save/open + file inputs
        useStudioActions.ts   ← registers studio:* actions + mode bridge + shortcuts +
                                 syncs <html data-studio-tool/data-studio-construction>
```

`studio/components/App.tsx` and `studio/components/Toolbar.tsx` are present
for reference but are not mounted (the MDI shell replaces them). Engine files
under `studio/` are treated as a vendored library; only small additive edits
necessary for new features (project metadata, entity types, theme threading)
are made directly — wrap or extend from the bridge / panel layer otherwise.

---

## 4. MDI integration architecture

### 4.1 Document panels (`components/DocumentPanel.tsx` registry)

| componentType | Wraps | Tab / title | Notes |
|---|---|---|---|
| `FeaturesPanel` | studio `SidePanel` | `Features` | Features + Parameters tabs; SVG eye-open / closed-eye / × glyphs sized 22×22 |
| `CanvasPanel` | studio `Viewport` + `StudioFileInputs` | `Canvas` | 3D view + hidden file inputs (no per-panel status strip — see §4.4) |
| `InfoPanel` | studio `PropertiesPanel` | `Info` | Context-sensitive properties + Measurement readout + Dimension editor |
| `JointsPanel` | `AssemblyJointsSection` (in PropertiesPanel) | `Joints` | Assembly-mode tab — joints list + selected-joint editor + warnings |
| `LinksPanel` | `AssemblyLinksSection` (in PropertiesPanel) | `Links` | Assembly-mode tab — links list + selected-link editor |

Each app panel receives `{ doc, container }` (ignored) and pulls live data from
`useRegen()`. Default layout: top row split **Features 22% · Canvas 56% · Info
22%**; bottom row `visible: false` (no Output / dummy doc — both removed from
the default layout JSON). All defined in
`public/data/layout/default_layout.json` (`appId: "parametric3dstudio-v-0-1"`).
The `Joints` / `Links` documents (`doc-joints-001` / `doc-links-001`) are
defined closed in that layout and live in the `dc-info` container (which now has
`allowTabs: true`); `useStudioActions` opens them and closes `Info` on entering
Assembly mode, and reverses it on exit. They are non-closable + draggable
(`allowAsTab: true`), with `defaultContainerOptions.killOnClose` so a torn-off
container is removed when the mode exits.

### 4.2 The bridge (`studio/studioBridge.tsx`)

- **`useRegen()`** → `{ regen, rev }`. Module-memoised on the Zustand `doc`
  identity, so the three panels share one `regenerate(doc, importCache)` result
  per change. `regen = { bodies, errors, params, paramErrors }`.
- **Project-shell commands**:
  - `newProjectCmd()` — `confirmDiscardIfDirty('new project')` then resets to
    model mode and calls `store.newProject()` (clears doc, meta, dirty, tool,
    selection, gizmo, …).
  - `openProjectCmd()` — same guard, then triggers the hidden project picker;
    on load, calls `resetToModelMode()` + `setDoc(doc, false)` + `setProjectMeta`
    + `markClean()`.
  - `saveProjectCmd()` — if no name, opens `SaveProjectModal`; otherwise
    refreshes `modifiedAt` and writes.
  - `saveProjectAsCmd()` — always opens the modal with current meta pre-filled.
- **Modelling commands** — re-expressed as plain functions over
  `useStore.getState()`: `undoCmd` / `redoCmd`, `newSketch(plane)`,
  `startFaceSketch`, `addPrimitive(shape)`, `startExtrude` /
  `acceptExtrude` / `cancelFacePick`, `toggleGizmo('translate'|'rotate')`,
  `startMerge` / `createMerge(op,swap?)` / `cancelMerge`, `toggleConstruction`,
  `finishSketch`, `exportStlCmd`.
- **Per-entity offset** — `computeOffsetEntity(e, d, params, existingCorners?)`
  returns `{ entities, corners }`. Lines → parallel line; circle / ellipse →
  concentric (rx + d, ry + d, rotation carried over); rect → expanded
  rectangle whose corner mods (fillets, chamfers) are re-created at the offset
  corners with adjusted size (fillet: `r + d`; chamfer: `s + d·(2 − √2)` for
  90° corners).
- **`StudioFileInputs`** — three hidden `<input type=file>` (project JSON,
  model import, image) rendered once inside `CanvasPanel`. Exposes
  `fileTriggers` ({ openProject, importModel, pickImage }) so action handlers
  can open the native picker (the MDI toolbar is action-driven and cannot
  host inputs).

### 4.3 Actions & mode bridge (`studio/useStudioActions.ts`)

Called once from `App.tsx`'s `AppInner` (inside `AppStateProvider`). It:

1. **Registers all `studio:*` actions** in the MDI `actionRegistry` on mount,
   unregisters on unmount.
2. **Bridges editing mode → toolbar-block visibility** by subscribing to the
   Zustand `mode`, `facePick`, `mergePick` and dispatching
   `SET_TOOLBAR_BLOCK_VISIBLE` (see §6).
3. **Sync selected tool / construction to `<html>` data-attributes**
   (`data-studio-tool="line"`, `data-studio-construction="on"`) so the
   "selected-tool" CSS rule (§7) can light the matching toolbar button blue.
4. **Restores keyboard shortcuts** (`Ctrl-Z` / `Ctrl-Shift-Z` / `Ctrl-Y`
   undo-redo, `Delete` / `Backspace` to delete the selected feature in model
   mode) with an INPUT/SELECT/TEXTAREA focus guard so typing in dimension
   fields is unaffected. File shortcuts (`Ctrl+Shift+N/O/S/A`) are declared in
   the menu / toolbar JSON and dispatched through the framework shortcut
   registry.

Action name → handler (namespace `studio:`):

```
new, open, save, saveAs, import, exportStl, undo, redo, _openSaveModal
sketch:top (XZ), sketch:front (XY), sketch:right (YZ), sketch:face
add:box | add:sphere | add:cylinder | add:cone | add:torus
add:bulbScrew | add:bulbSocket | add:screwThread | add:nutThread
extrude, extrude:accept, extrude:cancel
move, rotate, merge, merge:cut, merge:cutswap, merge:fuse, merge:intersect, merge:cancel
tool:select | tool:line | tool:rect | tool:circle | tool:arc | tool:cog
tool:fillet | tool:chamfer | tool:offset | tool:measure | tool:dimension
construction, image, finish
```

Framework-owned actions still used: `onToggleTheme`, `onResetLayout`,
`onAbout`.

### 4.4 Status bar (`components/StudioStatusBar.tsx`)

Replaces the framework's generic `StatusBar`. Single row at the bottom of the
shell carrying everything the canvas used to host on its own strip:

- mode/tool hint (with sketch-mode hints per tool)
- error summary (paramErrors + regen.errors; includes assembly cycle warnings)
- live sketch-coord readout (when in sketch mode)
- **View projection `<select>`** (Perspective / Orthographic → store
  `orthographic` / `toggleProjection`), placed before the grid/snap controls
- grid step `<input>` + snap mode `<select>`
- transient toast text from `SET_STATUS_INTERRUPT` (e.g. "Layout reset to
  default.") preempts the hint while active

The framework `× hide` button is omitted — the bar is always visible
(`statusBar.allowClose: false` in the default layout). View → Status Bar menu
item was removed.

### 4.5 Sketch-aware menu (`App.tsx` `useSketchAwareMenu`)

A small `useMemo` derives a live menu from the JSON menu + the current studio
mode:

- **Create menu**: in sketch mode its children are replaced wholesale with the
  hand-built `SKETCH_MENU_CHILDREN` (Select, Line, Rect, Circle / Oval, Arc,
  **Custom ▸** (cascading submenu — currently just `Cog`, sized to grow as
  more parametric shape tools are added), Fillet, Chamfer, Offset,
  Construction, Measure, Dimension, Insert Image, Extrude, Finish Sketch),
  each carrying the same SVG glyph as the toolbar so the menu and the toolbar
  read identically. The Cog tool is *menu-only* — it has no toolbar button,
  by design: the toolbar is reserved for the always-available primitives and
  the Custom submenu hosts parametric shapes.
- **Sketch menu**: `sk-top` / `sk-front` / `sk-right` / `sk-face` get
  `disabled: true` while a sketch is open (no nested sketches); `sk-finish`
  gets `disabled: true` in model mode (nothing to finish). `menu-create` /
  `menu-sketch` are disabled wholesale while in **assembly** mode (frozen tree).
- **Assembly menu** (`menu-assembly`): `as-enter` disabled while in assembly;
  `as-exit` / `as-revolute` / `as-prismatic` / `as-link` disabled outside it.
- **Window menu** is hidden by default (`visible: false` on `menu-window`) —
  no closable documents in the default layout, but easy to flip back on.

---

## 5. Toolbar & menu definitions

Toolbar blocks live in `public/data/toolbars/` (one JSON per block + a
`toolbar_manifest.json`). Items are MDI `MenuItem`s (`type: action | separator |
submenu`). Blocks are mode-swapped at runtime by `useStudioActions`:

| Block | menuFile | When visible | Contents |
|---|---|---|---|
| `tb-file` | toolbar_file.json | always (left) | New, Open, Save (each `Ctrl+Shift+…`) · Export (STL icon) |
| `tb-edit` | toolbar_edit.json | always (left) | Undo, Redo |
| `tb-sketch` | toolbar_sketch.json | model mode | Sketch ▾ (Top/Front/Right/On Face), Extrude |
| `tb-create` | toolbar_create.json | model mode | Cube, Sphere, Cylinder, Cone, Torus · Import (STL) |
| `tb-modify` | toolbar_modify.json | model mode | Move (4-way arrow), Rotate (CW curve), Merge (two-circles), **Assembly** (enter) |
| `tb-sketchtools` | toolbar_sketchtools.json | sketch mode | Select, Line, Rect, Circle, **Arc**, Fillet, Chamfer, Offset, Measure, Dimension · Construction · Image · Extrude, Finish |
| `tb-extrude` | toolbar_extrude.json | sketch + face-pick (center) | Accept Extrude, Cancel |
| `tb-merge` | toolbar_merge.json | model + merge-pick (center) | Cut A−B, Cut B−A, Fuse, Intersect, Cancel |
| `tb-assembly` | toolbar_assembly.json | assembly mode | Revolute Joint, Prismatic Joint, Link · Delete · Exit Assembly |
| `tb-view` | toolbar_view.json | hidden (`visible: false`) | Theme, Status Bar, Reset Layout |

Icons are inline SVG strings (see §7 for `IconNode` support) — Move, Rotate,
Merge, Cube, Sphere, Cylinder, Cone, Torus, Arc, Offset, Measure, Dimension,
Construction (dotted line), Image, Extrude, Import / Export STL (text badge)
are all CAD-style wireframes. Plain Unicode glyphs survive for the
in-sketch drawing primitives (Select / Line / Rect / Circle / Fillet /
Chamfer) where they read clearly.

Visibility rules in the bridge:

- model & not merging & not assembling → show `tb-sketch` / `tb-create` / `tb-modify`
- model & merge-pick → hide those, show `tb-merge`
- sketch & not face-picking → show `tb-sketchtools`
- sketch & face-pick → hide it, show `tb-extrude`
- assembly → hide model/sketch blocks, show `tb-assembly`

The menu bar (`public/data/menus/main_menu.json`) mirrors the actions:

- **File**: New (Ctrl+Shift+N), Open (Ctrl+Shift+O), Save (Ctrl+Shift+S),
  **Save Project As…** (Ctrl+Shift+A) · Export as STL…
- **Edit**: Undo, Redo
- **Create**: Cube, Sphere, Cylinder, Cone, Torus, **Custom ▸** (Bulb screw,
  Bulb socket, Screw thread, Nut thread) · Import STL · Extrude · Move, Rotate,
  Merge (in sketch mode this is replaced wholesale with the sketch tools list
  — see §4.5; the model-mode Custom submenu is menu-only by design, like the
  sketch-mode Cog — the toolbar `tb-create` block intentionally stays at the
  five always-available primitives)
- **Sketch**: Top / Front / Right / On Face · Finish Sketch (axis & face are
  disabled while in sketch mode; Finish is disabled in model mode)
- **Assembly**: Enter / Exit Assembly Mode · Add Revolute Joint, Add Prismatic
  Joint, Add Link (Enter disabled in assembly; the rest disabled outside it —
  see §4.5)
- **View**: Toggle Light / Dark (Ctrl+Shift+T globally registered) · Reset
  Workspace Layout (the Orthographic / Perspective projection control lives on
  the status bar, not this menu — see §4.4)
- **Window**: hidden by default (toggle `visible: true` in the JSON when
  closable docs come back)
- **Help**: About

To avoid the framework's no-guard global shortcut handler firing while a user
types in a dimension field, undo/redo show shortcut *labels* but are NOT
registered as global shortcuts — they are handled by the guarded handler in
`useStudioActions`. File shortcuts are declared with `shortcutKey` and
registered globally; `Ctrl+Shift+T` (theme) is also global.

---

## 6. Framework-core changes (see `framework_changes.md`)

Logged additions to the framework template, kept minimal:

- **`SET_TOOLBAR_BLOCK_VISIBLE { blockId, visible }`** in the `AppAction`
  union and reducer (loop-safe; returns same state when unchanged). Lets the
  mode bridge flip individual toolbar blocks.
- **`IconNode` SVG-icon support** in `MainToolbar.tsx` and `MenuBar.tsx` —
  detects icon strings starting with `<svg` and renders them via
  `dangerouslySetInnerHTML`. Other strings render as plain text.
- **`data-action={item.action}`** on each toolbar `<button>` so app CSS can
  target individual buttons with attribute selectors.
- **Stronger `:disabled` styling** on `.toolbar-btn` — desaturated icon /
  label, `not-allowed` cursor, diagonal slash via `::after`.
- **`SaveProjectModal`** added to `ModalDialog.tsx`'s `MODAL_REGISTRY`
  (app-layer addition — not logged as framework-core).
- `main.tsx` imports `./studio/studio.css` beside `./styles.css`.

Adding panels to `DocumentPanel.tsx`'s `COMPONENT_REGISTRY` is app-layer (not
logged).

---

## 7. Styling & theming

- The MDI palette is defined as CSS custom properties in `src/styles.css`
  (`--bg`, `--surface`, `--border`, `--accent`, `--accent2`, `--text`,
  `--text-dim`, layout sizes) with a `:root[data-theme="light"]` override block.
  `AppStateContext` writes `document.documentElement.dataset.theme` from
  `state.theme`; View → Toggle Light / Dark flips it.
- `studio/studio.css` no longer defines shell layout or its own colours. Its
  extra tokens derive from the MDI theme so the 3D UI follows light / dark.
- **Selected-tool highlight**. `useStudioActions` writes
  `data-studio-tool="…"` and `data-studio-construction="on"|"off"` on `<html>`.
  CSS attribute selectors at the bottom of `styles.css` light the matching
  toolbar button in blue (`#5b8def`) — background tint, border, icon-as-text
  (via `currentColor`) and label colour all switch together.
- **Viewport palette** lives in `Viewport.tsx`'s `PALETTES` table. A
  `useDocumentTheme()` hook subscribes to `data-theme` via MutationObserver
  and `usePalette()` returns the matching colour set (canvas bg, grid cell /
  section, axis colours, sketch active / faint / construction colours, edge
  colour, lighting intensities, Html-label bg / fg). Light-mode canvas uses a
  soft slate bg with dark sketch lines and high-contrast grid. Dim & measure
  Html labels read off `htmlLabelBg` / `htmlLabelFg` so they stay legible in
  both themes; selected dims still go amber.
- **Sketch mode badge** ("Sketch mode — Sketch 1 (XY)") rebuilt in
  `studio.css` as a high-contrast pill: dark-mode dark background + accent
  text, light-mode override flips it to a white pill with accent text. The
  in-sketch coordinate axes use muted theme-aware reds (X) and blues (Y).
- Bare element selectors in `studio.css` are scoped under **`.studio-scope`**
  so they cannot restyle the MDI shell.

---

## 8. Modelling engine internals (`studio/`)

### 8.1 Key types (`studio/types.ts`)

```typescript
type PlaneId = 'XY' | 'XZ' | 'YZ';        // sketch base planes
type SnapMode = 'none' | 'grid' | 'edge';

interface Doc { parameters: Parameter[]; features: Feature[]; gridSize: number; snap: SnapMode; }
type Feature = SketchFeature | ExtrudeFeature | PrimitiveFeature | ImportFeature | BooleanFeature;

interface SketchFeature   { type:'sketch'; plane:PlaneId; offset:string; entities:SketchEntity[]; corners:CornerMod[]; customPlane?:number[]; }
interface ExtrudeFeature  { type:'extrude'; sketchId:string; distance:string; op:'new'|'cut'|'fuse'; edge?:{kind:'fillet'|'chamfer';size:string}; color:string; opacity?:number; regionPts?:Vec2[]; }
interface PrimitiveFeature{ type:'primitive'; shape:'box'|'sphere'|'cylinder'|'cone'|'torus'|'bulbScrew'|'bulbSocket'|'screwThread'|'nutThread'; dims:Record<string,string>; position:[string,string,string]; rotation:[string,string,string]; edge?:{...}; op:'new'|'cut'|'fuse'; color:string; opacity?:number; secondaryColor?:string; secondaryOpacity?:number; }
interface ImportFeature   { type:'import'; fileName:string; position:[number,number,number]; rotation:[number,number,number]; scale:number; color:string; opacity?:number; embedded?:boolean; }
interface BooleanFeature  { type:'boolean'; op:'cut'|'fuse'|'intersect'; targetId:string; toolId:string; color:string; opacity?:number; }

type SketchEntity =
  | LineEntity | CircleEntity | RectEntity | ImageEntity
  | DimensionEntity | ArcEntity | CogEntity;

type CogProfile = 'square' | 'pointy' | 'trapezoid';
```

Sketch entities:

- `LineEntity { p1, p2, construction, length? }`
- `CircleEntity { center, radius, radiusY?, rotation?, construction }` —
  axis-aligned ellipse when `radiusY` is set; accumulated `rotation` lets
  ovals spin around their centre (true circles ignore the field).
- `RectEntity { corner, width, height, rotation?, construction }` (rotation
  pivot = corner).
- `ImageEntity { corner, width, height, src, fit:'scale'|'crop', cropScale?,
  cropAnchor?, maintainAspect, opacity, rotation? }`.
- `DimensionEntity { p1, p2, offset, label?, p1Anchor?, p2Anchor?,
  construction? }` — perpendicular extension lines + parallel dim line +
  centred label. Anchors are
  `{ kind: 'endpoint'|'midpoint'|'center'|'corner'|'edgemid'; entityId;
  which?; index? }` and resolve live so the dimension tracks its host entity.
  Label override supports `{}` substitution for the measured distance.
- `ArcEntity { center, radius, startAngle, endAngle, construction }` — angles
  in degrees (math-CCW), renderer always takes the shorter of the two arcs.
- `CogEntity { center, outerRadius, innerRadius, teeth, profile?, rotation?,
  construction }` — closed spur-gear / star polygon. `outerRadius` and
  `innerRadius` are expressions; `teeth` is an integer (≥ 3, enforced by the
  Info-panel editor). `profile` chooses the tooth shape — `'pointy'` (star
  polygon, 2 verts/tooth — default for newly-drawn cogs), `'trapezoid'` (4
  verts/tooth, tip narrower than root — classic gear silhouette), or
  `'square'` (4 verts/tooth, flat-topped blocks — the legacy shape used when
  `profile` is undefined). `rotation` is screen-CW positive and accumulates
  through the static-rotate UI like rect / image / ellipse rotations.
  The renderer treats the perimeter as a single closed cycle, so `Extrude`
  picks the cog body up as one face automatically.

`CornerMod = { id, at:Vec2, kind:'fillet'|'chamfer', size:string }` — still
position-keyed.

Migration notes baked into the engine: legacy `rotationY` on primitives is
read as `['0', rotationY, '0']`; legacy boolean `snap` migrates to
`SnapMode`; project files are `version: 2` with a top-level `meshes` map of
serialised embedded geometry **and** a `meta` object (`{ name?,
description, createdAt?, modifiedAt? }`). Older files without `meta` load
with empty metadata + the file name as the project-name fallback. v1 still
loads.

### 8.2 Core engine

- **`core/expressions.ts`** — `evalExpression`, `tryEval`, `resolveParameters`
  (topological sort), `isValidParamName`; functions sin / cos / tan (degrees),
  sqrt, abs, floor, ceil, round, min, max, pi.
- **`core/sketchGeometry.ts`** — planar arrangement engine: `splitSegments`,
  `traceCycles` (DCEL half-edges), `computeRegions` (ground truth for face
  picking / extrude — now consumes line, ellipse, arc and cog segments,
  ignores dimensions), `defaultRegions`, `regionContains`; corner-mod visuals
  (chamfer = polyline replacement, fillet = arc points); entity translate /
  rotate (`translateEntityInSketch`, `translateEntitiesInSketch`,
  `rotateEntitiesInSketch` — handles dim, arc & cog; arc rotation rotates the
  centre and shifts both stored angles; cog rotation rotates the centre and
  accumulates the entity's `rotation` field); `entityVertices`,
  `entityBounds`, `entityInBox` (dim excluded from box-select; arc & cog use
  their outer-radius / polyline AABB); `snapPoints` (line endpoints + circle
  / ellipse centre + arc centre + arc endpoints + rect corners + cog centre);
  `edgeSnapPoints` (midpoints, circle quadrants, cog outer-radius quadrants,
  intersections); `pickEntity` (ellipse hit-test inverse-rotates into local
  frame; arc hit-test uses radius distance when cursor angle is in range,
  otherwise nearer endpoint; cog hit-test sweeps point-to-segment distance
  against the actual tooth polyline so a click on any flank / tip / valley
  selects the cog); `rectCorners`, `circlePoly`, `ellipsePoly` (CW-positive
  rotation matching `rectCorners`), `arcPoly`, `cogPoly(center, outerR,
  innerR, teeth, rotation?, profile?)` (returns the closed CCW perimeter
  vertices for the chosen profile), `circleRadii`, `cogRadii`,
  `findDimAnchorAt` (cog reports a `center` anchor, like circle),
  `resolveDimAnchor`, `vkey` quantised position key.
- **`core/buildGeometry.ts`** — `planeBasis` / `planeNormal` / `sketchMatrix`
  (honours `customPlane`), `chooseRegions` (auto-heal), helical thread
  builders **`buildThreadedShaft({ rMinor, rMajor, pitch, height, profile,
  angularSegs?, axialSegsPerPitch? })`** + per-shape wrappers
  (`buildBulbScrew` / `buildBulbScrewParts` / `buildBulbSocket` /
  `buildBoltScrew` / `buildBoltNut`), `applyPrimitiveTransform` (shared
  position + rotation matrix application), `mergeRaw` (non-CSG buffer
  concatenation for the multi-piece bolt + bulb assemblies), and
  **`regenerate(doc, importCache)` → `{ bodies, errors, params, paramErrors }`**.
  All geometry is baked to world space (meshes render at identity), so
  raycast positions / normals are already world-space. `bulbScrew` with
  `op === 'new'` is the only feature that pushes two `BodyOut` entries under
  one `featureId` — see §1 and `Viewport` keys mesh nodes on
  `${featureId}:${i}:${rev}` so the second body doesn't collide with the
  first across re-renders.
- **`io/exporters.ts`** — `saveProject(doc, fileName, meta?)` serialises
  `{ app, version: 2, meta, doc, meshes }`; `loadProject(file)` returns
  `{ doc, meta }`, fills missing meta fields from the file name. STL export
  unchanged.

### 8.3 State store (`studio/state/store.ts`, Zustand)

UI / editing state: `mode:'model'|'sketch'`, `activeSketchId`, `tool` (now
includes `'arc'`, `'measure'`, `'dimension'`, `'offset'`), `pendingImage`,
`gizmoMode`, `facePick`, `mergePick`, `faceSketchMode`, `selectedFeatureId`,
`selectedEntityId`, `selectedEntityIds`, `dynamicOp`, `dimPrompt`,
`showConstruction` (default `true` — drives the SketchProps checkbox),
`measureState` (`{ p1, p2 }`), `dimensionDraft` (`{ p1, p2 }`), plus
`past[]` / `future[]` (50-step undo).

Project-shell state: `projectMeta` (`{ name, description, createdAt,
modifiedAt }`), `dirty: boolean` — flipped on every undoable `setDoc` and on
undo / redo; cleared by `markClean()` (called after save / load / new).

Actions used by the bridge: `setDoc`, `newProject` (also resets meta + dirty +
tool + selection), `addFeature`, `enterSketch` (chooses `'line'` for empty
sketches, `'select'` for sketches with entities), `exitSketch`, `setTool`
(clears measure / dimension drafts when switching away),
`setConstruction` / `setShowConstruction`, `select`, `selectEntities`,
`setGizmoMode`, `startFacePick` / `cancelFacePick`,
`startMergePick` / `cancelMergePick`,
`startFaceSketchMode` / `cancelFaceSketchMode`, `setPendingImage`, `setGrid`,
`setSnap`, `setMeasure`, `setDimensionDraft`, `setProjectMeta`, `markClean`,
`undo` / `redo`. Exported helpers: `confirmDeleteFeature(id)`,
`nextName(doc, prefix)`, `emptyProjectMeta()`, and the
`importCache: Map<string, THREE.BufferGeometry>`.

### 8.4 Viewport (`studio/components/Viewport.tsx`)

R3F `<Canvas>` with OrbitControls, model-mode infinite Grid (theme-aware
cell / section colours), body meshes (select / merge-pick / face-sketch click
handling), faint inactive-sketch overlays, an `ActiveSketchEditor`
(interaction plane → local 2D coords, draft previews for every tool — line,
circle, rect, image, **arc** 3-click, measure, dimension — region outlines,
corner-mod markers, box-select), a camera rig that locks orientation in
sketch mode, the transform gizmo with a CW-positive readout that follows the
mouse, and a floating `DimInput` popup. Dimensions render their own overlay
group: extension lines + dim line + a circle-mesh drag handle (which selects
the dim on click, drags it perpendicular on motion, commits one undo step on
release) + an Html label whose colour comes from the theme palette.

Coordinates in sketch mode are local to `sketchMatrix`;
`inv = sketchMatrix.clone().invert()` maps world hits back. The viewport
canvas background, grid, sketch lines, axes and orientation-cube label all
adapt via `usePalette()`.

### 8.5 Properties panel (`studio/components/PropertiesPanel.tsx`)

- **SketchProps** (sketch + nothing selected): `✓ Finish Sketch` button,
  `Show construction lines (N)` checkbox; live `MeasureReadout` when the
  Measure tool is active; tool-specific hints for Offset / Dimension. Corner
  mod list has been removed — fillets / chamfers live on the containing
  rectangle (via `modsForEntity`) and bake into entities on Split.
- **EntityProps** per kind:
  - Line: start / end point editors.
  - Circle / Oval: `CircleProps` with Radius + optional Y Radius and an
    "Oval" checkbox; rotation field surfaces via the Move / Rotate block.
  - Arc: Radius, Start angle°, End angle° expression inputs + Centre editor.
  - Cog: `CogProps` with a **Tooth profile** select (Pointy / Trapezoid /
    Square), Outer radius + Inner radius expression inputs, an integer
    **Teeth** field (`CogTeethInput`, modelled on `ExprInput` — local string
    state, red `invalid` border while the value isn't a whole number ≥ 3,
    blur-while-invalid restores the last good value, Esc reverts, Enter
    commits) and a Centre editor. Hint line shows the live tooth height
    (`outerR − innerR`).
  - Image: full image-fit editor (existing).
  - Dimension: `DimensionProps` with Label override (with `{}` template
    hint), numeric Offset, and a Measurement table showing live distance +
    anchor descriptions; the generic Move / Rotate block is skipped for dims
    since they're anchor-driven.
- **Move / Rotate block** (single-entity selection):
  - Pivot: circle / ellipse / arc / cog → centre; rect / image → corner
    anchor; line / dim → bbox bottom-left; multi-select → bbox bottom-left.
  - Positive typed angle = clockwise (matches the dynamic-rotate readout).

---

## 9. Conventions

- **Rotation sign**: positive angle = clockwise everywhere in the sketch UI —
  the dynamic-rotate readout, the typed-angle prompt, the Properties Rotate
  block, accumulated `rotation` fields on entities. Internally
  `rotatePoint(p, origin, angleDeg)` uses CW-positive; UI inputs pass through
  unchanged. The atan2-derived live preview negates from math-CCW to match.
- **Sketch-tool fall-back**: `Esc` on any sketch tool (with nothing in
  progress) drops the selection and switches the active tool back to Select.
- **Esc semantics**: cancels dynamic op → cancels face-pick → clears
  in-progress draft (chainStart / centerPt / cornerPt / arcCenter / arcStart)
  → clears measure / dimension drafts → switches to Select tool → clears
  selection (in that order).

---

## 10. Ideas for next steps

- More Arc tool entry modes (3-point arc, start/end/bulge), arc dimensioning,
  arc snap quadrants on the perimeter.
- Dimension constraints (driving parameters from dim labels), angular and
  radial dimensions.
- Shell / offset on solids; pattern & mirror; named views; multi-body
  assembly; OBJ / glTF export; history-tree reorder; section view.
- "Trim" tool on intersecting offset lines / circles so the offset tool can
  produce clean profile contours without the user pruning by hand.
- More parametric shapes under Create → **Custom** (sketch-mode Cog, model-
  mode bulbScrew / bulbSocket / screwThread / nutThread already live there):
  polygon / star / arrow / slot, plus an involute-gear profile for the Cog
  (current tooth profiles are visual, not engineering-grade).
- Thread primitives: more standards (UNC / UNF imperial, BSP pipe), proper
  involute / rounded-trapezoidal Edison profile (current Edison is a sinusoid
  approximation — close visually but not gauge-accurate), slotted / Phillips /
  hex-socket head options for `screwThread`, locking-ring inserts, and a
  shared chase/clearance parameter so a bolt + nut pair fit together with a
  realistic running-fit gap. CSG cost on long fine-pitch threads is
  noticeable — investigate a "skip helix, draw symbolic stripes" toggle for
  fast preview.
- Cog: offset support (currently `computeOffsetEntity` only handles line /
  circle / rect — selecting a cog with the Offset tool no-ops); dedicated
  outer-radius / tooth-tip / tooth-root snap points beyond the current
  centre + outer-quadrant set.
- MDI side: per-panel doc toolbars, a real Output / console panel for the
  bottom row, floating / pop-out support for the Canvas, restore Window menu
  when closable / restorable documents are introduced.
