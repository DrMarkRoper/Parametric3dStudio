# Framework-Core Changes Log

**Purpose:** Track every change made to the **MDI Framework core** in this project, so the changes can be reviewed and (where appropriate) folded back into the framework template.

This file is the upstream-feedback channel between this project and the framework template.

---

## Scope: what counts as a "framework-core change"

Per `project_mdi_context.md` §"File Map", the framework-core files this log applies to are:

```
frontend/src/contexts/AppStateContext.tsx
frontend/src/contexts/DragContext.tsx
frontend/src/utils/actionRegistry.ts
frontend/src/utils/shortcutRegistry.ts
frontend/src/utils/layoutSerializer.ts
frontend/src/utils/containerFlash.ts
frontend/src/utils/dialogService.ts
frontend/src/types/index.ts
frontend/src/components/MenuBar.tsx
frontend/src/components/MainToolbar.tsx
frontend/src/components/MDIWorkspace.tsx
frontend/src/components/MDIRow.tsx
frontend/src/components/DocumentContainer.tsx
frontend/src/components/DocumentPanel.tsx          (additions to COMPONENT_REGISTRY are app-layer; structural changes are framework-core)
frontend/src/components/DummyPanel.tsx
frontend/src/components/FloatingPanel.tsx
frontend/src/components/FloatingPanelManager.tsx
frontend/src/components/ModalDialog.tsx            (additions to MODAL_REGISTRY are app-layer; structural changes are framework-core)
frontend/src/components/StatusBar.tsx
frontend/src/main.tsx
frontend/src/styles.css                            (CSS variables and framework rules — additions at the bottom are app-layer)
frontend/src/components/TitleBar.tsx               (branding edits — name/version — are app-layer; structural changes are framework-core)
```

App-layer files (`App.tsx`, `components/panels/**`, `public/data/**`, `index.html`, `package.json`) are NOT framework core. Edits there do not need to be logged here.

---

## Policy

1. **Adapter first.** If the same outcome can be achieved by a wrapper component, a higher-level module, or a per-route provider above the framework, choose that — and **do not** modify framework core.
2. **Smallest possible diff.** When framework core must change, change the minimum needed and isolate the diff so it can be ported back cleanly.
3. **Log it here, in this file, in the same commit as the framework-core edit.**
4. **Tag the commit message** with `[framework-core]` so it stands out in `git log`.
5. **Open a follow-up ticket** in the framework template repo (or note the intent here under "To upstream") so the change is not orphaned.

---

## How to add an entry

Add new entries to the top of the **Change log** below. Use this template:

```markdown
### YYYY-MM-DD — Short title

- **File(s):** `frontend/src/utils/layoutSerializer.ts`
- **Why needed:** One-paragraph reason. What did the framework not allow that we needed?
- **Diff summary:** What changed in plain English (one or two sentences). Link to the commit if available.
- **Adapter alternative considered:** Why an adapter wasn't enough.
- **Upstream candidate?** Yes / No / Maybe — and why.
- **Status:** Pending review / Submitted upstream / Merged upstream / Project-only fork.
```

---

## Change log

### 2026-06-15 — Emit data-action on toolbar buttons

- **File(s):** `frontend/src/components/MainToolbar.tsx`
- **Why needed:** Parametric3dStudio wants the active sketch tool (and the construction toggle) lit up on the toolbar. Without a stable hook on each button, the highlight rule has to live inside the framework toolbar, coupling it to app state. Emitting `data-action="<action-id>"` on every toolbar button lets app-level CSS attribute selectors target individual buttons from a single root-level attribute (e.g. `:root[data-studio-tool="line"] .toolbar-btn[data-action="studio:tool:line"]`).
- **Diff summary:** Added `data-action={item.action}` to the `<button>` rendered by `ToolbarButton`. No other behaviour changes.
- **Adapter alternative considered:** Subscribing to studio state from inside the framework toolbar would import app code into the framework (no go). Mutating button classes externally on each store change is brittle against framework re-renders.
- **Upstream candidate?** Yes — exposing the action id as a DOM attribute is generally useful (e2e tests, app-layer styling, accessibility).
- **Status:** Pending review.

### 2026-06-15 — Allow SVG-string icons in toolbar / menu items

- **File(s):** `frontend/src/components/MainToolbar.tsx`, `frontend/src/components/MenuBar.tsx`
- **Why needed:** Parametric3dStudio wants CAD-style monochrome wireframe glyphs (cube / cylinder / torus / move) that follow the current text colour and respond to disabled/grayscale filters. The icon field is a plain text node rendered as `{item.icon}`, so SVG markup placed in the JSON came out as visible angle brackets.
- **Diff summary:** Added a small `IconNode` helper in both files that detects `<svg`-prefixed icon strings and renders them via `dangerouslySetInnerHTML`; everything else still renders as plain text. Icon JSON is loaded from local `/data/...` files we control, so the html injection surface is restricted to that input.
- **Adapter alternative considered:** Replacing `MainToolbar` wholesale at the app layer would duplicate ~480 lines for a one-line render change; CSS background-image icons would lose `currentColor` inheritance (so they couldn't track hover / disabled / accent states) and need a parallel sprite sheet.
- **Upstream candidate?** Yes — every app eventually wants better-than-emoji icons; the change is additive and backwards-compatible.
- **Status:** Pending review.

### 2026-06-15 — Stronger disabled-state styling for toolbar buttons

- **File(s):** `frontend/src/styles.css`
- **Why needed:** The default `opacity: 0.4` on `.toolbar-btn:disabled` was too subtle to be read as "unavailable" — emoji icons stayed full-colour and the cursor change was easy to miss.
- **Diff summary:** Raised opacity slightly, switched to `cursor: not-allowed`, applied `filter: grayscale(1)` to icon and label, and added a thin diagonal slash via `::after` so the unavailable state reads at a glance even when the underlying icon is a colourful emoji.
- **Adapter alternative considered:** None — `.toolbar-btn:disabled` is the documented styling seam for that state, and per-app overrides would need to coexist with framework defaults anyway.
- **Upstream candidate?** Yes — a clearer disabled cue is generally useful; current behaviour is the minimum legible default.
- **Status:** Pending review.

### 2026-06-14 — Add SET_TOOLBAR_BLOCK_VISIBLE action + studio CSS import

- **File(s):** `frontend/src/types/index.ts`, `frontend/src/contexts/AppStateContext.tsx`, `frontend/src/main.tsx`
- **Why needed:** Parametric3dStudio swaps tool sets per editing mode (model vs. sketch, plus transient extrude face-pick and merge-op bars). The toolbar renders only blocks whose `visible` flag is true, but there was no action to flip a single block's visibility at runtime — only `REORDER_TOOLBAR`. The app's mode→toolbar bridge needs to toggle individual blocks. `main.tsx` also needs to import the ported engine's stylesheet.
- **Diff summary:** Added `SET_TOOLBAR_BLOCK_VISIBLE { blockId, visible }` to the `AppAction` union and a matching reducer case that returns the same state object when unchanged (loop-safe). Added one `import './studio/studio.css'` line to `main.tsx`.
- **Adapter alternative considered:** Block `visible` lives in framework state and is read by `MainToolbar`; there is no app-layer seam to flip it without either a reducer action or replacing `MainToolbar` wholesale (a much larger, harder-to-upstream change). The CSS import must sit beside the existing `styles.css` import in the framework entry point.
- **Upstream candidate?** Yes — per-block runtime visibility toggling is generally useful; the menu template even references an (unimplemented) `onToggleToolbarBlock` action, so the intent already exists upstream.
- **Status:** Pending review.

*Add the next entry above this line.*

---

## To upstream (proposed — not yet made)

Use this section to record framework-core changes we **anticipate** needing but have not yet made, so the framework dev project can decide whether to accept them ahead of time.

*No entries yet.*

---

## Conventions

- **Don't restate the diff** in here — link to the commit hash. This file is a register, not a diary.
- **Prune merged-upstream entries** from the change log once they're in the framework template; move them to a `## Merged upstream` archive section at the bottom (added when first needed).
- **Do not** record changes to app-layer files here. That noise drowns out the signal.
