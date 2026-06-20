# Parametric3dStudio

A browser-based parametric 3D modeller and viewer built with **React 19 +
TypeScript + Vite + Three.js**, presented inside a desktop-style multiple-
document-interface (MDI) shell — title bar, menu bar, toolbar, resizable
document containers with draggable tabs, and a status bar.

> **Status:** Prototype (v0.1). The modelling engine and shell are functional
> but the surface API and project file format may still change.

---

## Features

**Modelling**

- Primitives: cube, sphere, cylinder, cone, torus, plus custom **bulb screw**,
  **bulb socket**, **screw thread**, and **nut thread** (helical-mesh threads
  with IEC 60061 Edison and ISO 261 metric presets).
- 2D sketching: lines, rectangles, circles / ovals, arcs, cogs (parametric
  spur-gear profiles), and image references. Fillets, chamfers, offsets,
  measure tool, anchored linear dimensions.
- Extrude with face-picker, auto-healing region selection, bevel / chamfer
  edges. Detach from sketch to free-form bodies.
- Boolean merge (cut A − B / B − A, fuse, intersect) with "create independent
  body" bake-out.
- Sketch on Face — sketches align to any selected face on any body.
- Snap modes (grid / edge / none), box selection, transform gizmo (move +
  rotate) with live preview.
- Named parameters with arithmetic expressions (trig, sqrt, abs, floor, ceil,
  round, min, max, pi); usable in any dimension field.
- 50-step undo / redo, error overlay, dependent-feature delete confirmation.

**File I/O**

- Import STL / OBJ / glTF / GLB / STEP (STEP via lazy-loaded OpenCascade
  WASM).
- Export STL.
- Save / load JSON project files with project metadata (name, description,
  created / modified timestamps) and embedded meshes for detached bodies.

**Shell**

- Resizable document panels (Features tree · 3D canvas · Info / properties)
  in a two-row workspace, draggable tabs, tear-off / browser pop-out support.
- Light / dark theme with palette-aware viewport (canvas background, grid,
  sketch colours, axis colours all switch together).
- Action-driven menu + toolbar defined via JSON manifests under
  `frontend/public/data/`.

---

## Tech stack

| Package | Version | Role |
|---|---|---|
| react / react-dom | ^19 | UI |
| typescript | ^5.7 | Types |
| vite | ^6 | Build / dev server |
| three | ^0.184 | 3D rendering |
| @react-three/fiber | ^9 | Three.js React bindings |
| @react-three/drei | ^10 | OrbitControls, TransformControls, Grid, etc. |
| three-bvh-csg | ^0.0.18 | CSG boolean ops |
| three-mesh-bvh | ^0.9 | BVH acceleration |
| zustand | ^5 | Modelling state store |
| occt-import-js | ^0.0.23 | OpenCascade WASM for STEP import |

---

## Prerequisites

- **Node.js 18+** (Node 20 LTS recommended).
- **npm** (ships with Node). `pnpm` / `yarn` should work as well but the
  scripts below assume npm.

A modern browser with WebGL 2 support — Chrome / Edge / Firefox / Safari (15+)
are all fine.

---

## Installation

```bash
git clone https://github.com/DrMarkRoper/Parametric3dStudio.git
cd Parametric3dStudio/frontend
npm install
```

> **macOS / Linux sandbox note:** if `dist/` ever gets ownership issues
> (typical after a containerised build), use
> `npx vite build --emptyOutDir=false`. On ARM64 Linux you may need
> `npm install --no-save @rollup/rollup-linux-arm64-gnu` first.

---

## Development

All commands run from the `frontend/` directory.

```bash
npm run dev          # Vite dev server (http://localhost:5173)
npm run build        # type-check + production build (outputs to dist/)
npm run preview      # serve the production build locally
npx tsc --noEmit     # type-check without building
```

Hot-module reload is enabled — edits to `.tsx`, `.css`, and JSON manifests
under `public/data/` refresh the running app without losing state.

---

## Project structure

```
Parametric3dStudio/
├── README.md                  ← this file
├── project_context.md         ← carry-forward project context (long form)
├── project_mdi_context.md     ← framework architecture overview
├── MDI_Framework_FRS.md       ← functional spec for the MDI shell
├── style_guide.md             ← CSS tokens / theming rules
├── framework_changes.md       ← log of framework-core edits
└── frontend/
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    ├── public/data/           ← menu + toolbar + layout JSON manifests
    └── src/
        ├── main.tsx           ← React root
        ├── App.tsx            ← shell wiring
        ├── components/        ← MDI shell components (title bar, menu, tabs…)
        ├── contexts/          ← AppStateContext (reducer), DragContext
        ├── utils/             ← actionRegistry, shortcutRegistry, layoutSerializer
        └── studio/            ← parametric modelling engine (vendored)
            ├── core/          ← expressions, sketch geometry, build geometry
            ├── components/    ← Viewport, PropertiesPanel, SidePanel
            ├── io/            ← importers, exporters
            ├── state/         ← Zustand store
            └── useStudioActions.ts
```

The `studio/` engine is a self-contained library; the MDI shell hosts it
through three document panels (**Features**, **Canvas**, **Info**) and an
action-driven JSON toolbar.

---

## Documentation

Detailed engineering notes live alongside this README at the repo root:

- **`project_context.md`** — the canonical "everything you need to keep
  developing" reference. Covers the modelling engine internals, sketch entity
  schemas, state store, viewport conventions, action registry, and a running
  ideas list. Read this first.
- **`project_mdi_context.md`** — architecture of the underlying MDI
  framework (`AppStateContext`, `DocumentContainer`, layout serialisation,
  floating panels).
- **`MDI_Framework_FRS.md`** — functional spec for the MDI shell.
- **`style_guide.md`** — CSS custom-property palette and theming rules.
- **`framework_changes.md`** — log of additive edits to framework-core
  template files.

---

## Contributing

Contributions are welcome while the project is in prototype. Before opening
a PR:

1. Run `npx tsc --noEmit` from `frontend/` — it must report zero errors.
2. Run `npm run build` — must succeed.
3. If touching framework-core files (`AppStateContext.tsx`,
   `DocumentContainer.tsx`, `FloatingPanel.tsx`, `ModalDialog.tsx`,
   `layoutSerializer.ts`), record the change in `framework_changes.md`.
4. If touching the modelling engine in ways that affect users, update the
   relevant section of `project_context.md`.

---

## License

MIT
