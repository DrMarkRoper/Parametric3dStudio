# Mark Roper — App Style Guide
_Derived from VirtualMeadow (meadow-app). Use this guide to replicate the look and feel across projects._

---

## 1. Design Philosophy

Dark-mode first. The palette is built around a near-black background, charcoal surfaces, and a single warm-amber accent (`#f5a623`) that reads like yellow against the dark surroundings. Grey text hierarchy keeps information readable without competing with the accent. Everything is a fixed-height flex column — no scrolling at the shell level. Panels resize and collapse rather than scroll or overflow.

Light mode is a supported, first-class variant. A single `:root[data-theme="light"]` block overrides the surface and text tokens; accent amber shifts slightly darker to maintain WCAG contrast on near-white backgrounds. The title bar receives a distinct slate-blue gradient so it retains visual weight even without the dark surround.

---

## 2. Colour Tokens

Define these as CSS custom properties in `:root`. Every component should reference these variables, never hard-code hex values.

```css
:root {
  /* Backgrounds */
  --bg:        #1c1c1e;   /* page / shell background — near-black */
  --surface:   #2a2a2d;   /* panels, toolbar, tab panel surface */
  --border:    #3a3a3f;   /* all dividing lines */

  /* Accent colours */
  --accent:    #f5a623;   /* amber/yellow — primary accent: tabs, drag handles, active states */
  --accent2:   #4caf50;   /* green — secondary accent: mode badges, active toolbar states */

  /* Text */
  --text:      #e8e8ea;   /* primary body text */
  --text-dim:  #888888;   /* secondary / label text */

  /* Layout sizing */
  --title-h:   32px;      /* title bar height */
  --toolbar-h: 36px;      /* toolbar strip height */
  --drag-sz:   5px;       /* horizontal panel divider width */
  --tab-max-width: 160px; /* max width of a tab label before it ellipsises (see §10) */
}
```

### Light mode token overrides

Add this block immediately after the `:root` declaration. All layout tokens (`--title-h`, `--toolbar-h`, `--drag-sz`, `--tab-max-width`) are inherited unchanged; only colour tokens are overridden.

```css
:root[data-theme="light"] {
  color-scheme: light;

  /* Backgrounds */
  --bg:        #f6f7fa;   /* page background — warm off-white */
  --surface:   #ffffff;   /* panels, toolbar, tab panel */
  --border:    #d4d8e0;   /* dividing lines */

  /* Accent colours — shifted darker for WCAG contrast on white */
  --accent:    #d4860a;   /* amber darkened from #f5a623 */
  --accent2:   #2e7d32;   /* green darkened from #4caf50 */

  /* Text */
  --text:      #1a1e28;   /* primary body text */
  --text-dim:  #5c6472;   /* secondary / label text */

  /* Extended tokens used by rnasim */
  --viewer-bg:      #e4e7ee;
  --overlay-panel:  rgba(255, 255, 255, 0.72);
  --overlay-strong: rgba(255, 255, 255, 0.82);
  --active-site-bg: #111218;
  --active-site-fg: #ffffff;
}
```

**Why `--accent` darkens.** `#f5a623` on a white `#ffffff` background gives a contrast ratio of only ~2.5:1 — below WCAG AA for text. `#d4860a` achieves ~3.8:1, which clears the 3:1 threshold for large/bold text and UI components.

### Colour usage at a glance

| Element | Dark mode | Light mode |
|---|---|---|
| Title bar background | `linear-gradient(135deg, #0a1a2a 0%, #080810 100%)` — very dark blue-black | `linear-gradient(135deg, #dde7f5 0%, #cdd8ee 100%)` — slate blue |
| Title bar border | `var(--border)` `#3a3a3f` | `#a8bdd8` — hardcoded (see §20) |
| Title text | `var(--accent)` `#f5a623` amber | `var(--accent)` `#d4860a` darker amber |
| Title subtitle | `#888` — dim grey | `var(--text-dim)` `#5c6472` |
| Toolbar / surface | `var(--surface)` `#2a2a2d` | `var(--surface)` `#ffffff` |
| Drag handle (idle) | `var(--border)` | `var(--border)` |
| Drag handle (hover / dragging) | `var(--accent)` — amber | `var(--accent)` — darker amber |
| Tab text (inactive) | `var(--text-dim)` | `var(--text-dim)` |
| Tab text (active) | `var(--accent)` | `var(--accent)` |
| Tab underline (active) | `var(--accent)` — 2 px bottom border | `var(--accent)` — 2 px bottom border |
| Info panel headings | `var(--accent)` | `var(--accent)` |
| Info panel key column | `var(--accent)` monospace | `var(--accent)` monospace |
| Info panel value text | `var(--text)` | `var(--text)` |
| Info panel note / dim text | `var(--text-dim)` | `var(--text-dim)` |
| Slider / checkbox accent | `var(--accent)` via `accent-color` | `var(--accent)` via `accent-color` |
| Slider value readout | `rgba(255,255,255,0.65)` | `rgba(0,0,0,0.45)` |
| Active OSC / toggle button | `rgba(245,166,35,0.20)` bg + `var(--accent)` border + text | `rgba(212,134,10,0.15)` bg + `var(--accent)` border + text |
| Collapse strip background | `#1e2a1e` (slight green tint to suggest restore) | `#1e2a1e` (unchanged — hardcoded) |
| Collapse strip label | `var(--accent2)` green, uppercase, small | `var(--accent2)` `#2e7d32` darker green |

---

## 3. Typography

```css
html, body, #root {
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  color: var(--text);
  background: var(--bg);
}
```

| Usage | Size | Weight | Notes |
|---|---|---|---|
| App title | 15 px | 700 | letter-spacing: 0.5 px, `var(--accent)` |
| Title subtitle | 12 px | 400 | `#888` |
| Toolbar buttons | 12 px | normal | |
| Tab labels | 12 px | normal | bold when active |
| Info section headings | 12 px | normal | uppercase, letter-spacing: 0.5 px, `var(--accent)` |
| Info table keys | 11 px | normal | monospace, `var(--accent)` |
| Info table values | 12 px | normal | `var(--text)` |
| Viewport labels / overlays | 10 px | normal | |
| Slider labels | 10 px | normal | `var(--text-dim)` |
| Badge text | 10 px | 600 | |

---

## 4. Global Reset

```css
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body, #root {
  width: 100%; height: 100%;
  overflow: hidden;   /* shell never scrolls — panels handle their own overflow */
}
```

---

## 5. App Shell Layout

The app is a single full-viewport flex column. Nothing overflows at the root — each section is a fixed or flex-grow layer.

```
┌──────────────────────────────────────────┐  ← --title-h (32 px)
│  TITLE BAR                               │
├──────────────────────────────────────────┤  ← --toolbar-h (36 px)
│  TOOLBAR                                 │
├──────────────────────────────────────────┤
│                                          │
│  WORKSPACE  (flex: 1, flex-direction:    │
│             column, overflow: hidden)    │
│  ┌────────────────────────────────────┐  │
│  │  VIEWPORT AREA  (flex: N%)         │  │
│  │  ┌───────────┐5px┌───────────────┐│  │
│  │  │ LEFT      │▓▓▓│ RIGHT         ││  │
│  │  │ PANEL     │▓▓▓│ PANEL         ││  │
│  │  └───────────┘▓▓▓└───────────────┘│  │
│  └────────────────────────────────────┘  │
│  ════════════════════════════════════════ │  ← vdrag-handle (10 px, resizes vertically)
│  ┌────────────────────────────────────┐  │
│  │  TAB PANEL  (flex: remaining %)    │  │
│  │  [ Help ] [ Status ] [ About ]     │  │
│  │  ─────────────────────────────────│  │
│  │  content                           │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

```css
.app {
  display: flex;
  flex-direction: column;
  width: 100%; height: 100%;
  overflow: hidden;
}

.workspace {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.viewport-area {
  display: flex;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.tab-area {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
```

Vertical flex sizing is controlled by inline styles: `viewport-area` gets `flex: 0 0 {N}%` and `tab-area` gets the remainder, driven by drag state in React.

---

## 6. Title Bar

```css
.titlebar {
  height: var(--title-h);
  background: linear-gradient(135deg, #0a1a2a 0%, #080810 100%);
  display: flex;
  align-items: center;
  padding: 0 14px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--accent);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  user-select: none;
}

.titlebar span {
  color: #888;
  font-weight: 400;
  font-size: 12px;
  margin-left: 6px;
}
```

**Standard pattern:** project title LHS in `var(--accent)`, optional subtitle/version in dim grey `<span>`. RHS items (e.g. light/dark toggle, mode badge) use `margin-left: auto` on the first RHS element to push everything right.

#### Light mode title bar override

The default dark gradient (`#0a1a2a → #080810`) disappears entirely in light mode — it just looks like solid black in an otherwise light UI. Override it with a slate-blue gradient that gives the title bar visual weight without forcing a dark zone:

```css
:root[data-theme="light"] .titlebar,
:root[data-theme="light"] .app-header {
  background: linear-gradient(135deg, #dde7f5 0%, #cdd8ee 100%);
  border-bottom-color: #a8bdd8;
}
```

**Why hardcode `#a8bdd8` instead of using `var(--border)`?** The light-mode border token is `#d4d8e0`, which is almost indistinguishable from the gradient end colour `#cdd8ee` (both are pale blue-grey at ~210° hue). A 1 px border at that contrast disappears visually. `#a8bdd8` is the same hue family but meaningfully darker — the border is visible without breaking the palette character.

```jsx
<div className="titlebar">
  My App Title <span>v1.0</span>
  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
    {/* RHS: theme toggle, user badge, etc. */}
  </div>
</div>
```

---

## 7. Toolbar

```css
.toolbar {
  height: var(--toolbar-h);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 8px;
  gap: 4px;
  flex-shrink: 0;
}

/* Standard button */
.toolbar-btn {
  background: #38383c;
  border: 1px solid var(--border);
  color: var(--text);
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s;
}
.toolbar-btn:hover { background: #4a4a50; }

/* Active / toggled state */
.toolbar-btn-active {
  background: #2a3a1a !important;
  border-color: var(--accent2) !important;
  color: var(--accent2) !important;
}

/* Vertical separator between groups */
.toolbar-sep {
  width: 1px;
  height: 20px;
  background: var(--border);
  margin: 0 4px;
}

/* RHS status / badge area */
.toolbar-status {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
  display: flex;
  gap: 12px;
  align-items: center;
}

/* Mode badge (pill) */
.toolbar-status .mode-badge {
  background: var(--accent2);
  color: #000;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
}
.toolbar-status .mode-badge.alt-mode {
  background: #2196f3;
  color: #fff;
}
```

**Usage pattern:**
```jsx
<div className="toolbar">
  <button className="toolbar-btn">Open</button>
  <button className="toolbar-btn">Save</button>
  <div className="toolbar-sep" />
  <button className="toolbar-btn toolbar-btn-active">Some Toggle</button>
  <div className="toolbar-status">
    <span>Status text</span>
    <span className="mode-badge">MODE A</span>
  </div>
</div>
```

---

## 8. LHS / RHS Resizable Panel Split

### Horizontal drag handle (between two side-by-side panels)

The handle is `var(--drag-sz)` (5 px) wide. On hover and while dragging it turns `var(--accent)` — the "chunky yellow" feel. A small tick mark in the centre signals it is draggable.

```css
.hdrag-handle {
  width: var(--drag-sz);
  background: var(--border);
  cursor: col-resize;
  flex-shrink: 0;
  z-index: 5;
  transition: background 0.15s;
  position: relative;
}
.hdrag-handle:hover,
.hdrag-handle.dragging { background: var(--accent); }

/* Centre tick mark */
.hdrag-handle::after {
  content: '';
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  height: 30px; width: 2px;
  background: #555;
  border-radius: 1px;
}
```

### Collapse strips (LHS and RHS)

Thin vertical strips (18 px wide) flanking each panel. Click to collapse or restore. Arrow glyph indicates direction.

```css
.collapse-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  background: #232325;
  border-right: 1px solid var(--border);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s;
}
.collapse-strip:hover { background: #38383c; }

/* Mirror for the right-side strip */
.collapse-strip-r {
  border-right: none;
  border-left: 1px solid var(--border);
}

.collapse-strip .arrow {
  color: var(--text-dim);
  font-size: 10px;
}
```

### Panel container

```css
.viewport-container {
  display: flex;
  width: 100%; height: 100%;
  overflow: hidden;
  position: relative;
}
```

### React pattern for split + collapse

```jsx
// State
const [splitPercent, setSplitPercent] = useState(50);
const [leftCollapsed, setLeftCollapsed]   = useState(false);
const [rightCollapsed, setRightCollapsed] = useState(false);

const COLLAPSE_THRESHOLD = 5; // % at which dragging snaps to full-collapse

// Flex values
let leftFlex, rightFlex;
if (leftCollapsed) {
  leftFlex  = '0 0 0px';
  rightFlex = '1 1 0';
} else if (rightCollapsed) {
  leftFlex  = '1 1 0';
  rightFlex = '0 0 0px';
} else {
  leftFlex = `0 0 ${splitPercent}%`;
  rightFlex = `0 0 ${100 - splitPercent}%`;
}

// Mouse-drag handler (attach onMouseDown to .hdrag-handle)
const onMouseDown = useCallback((e) => {
  e.preventDefault();
  const onMove = (me) => {
    const rect = containerRef.current.getBoundingClientRect();
    let pct = ((me.clientX - rect.left) / rect.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    if (pct < COLLAPSE_THRESHOLD) {
      setLeftCollapsed(true); setRightCollapsed(false);
    } else if (pct > 100 - COLLAPSE_THRESHOLD) {
      setRightCollapsed(true); setLeftCollapsed(false);
    } else {
      setLeftCollapsed(false); setRightCollapsed(false);
      setSplitPercent(pct);
    }
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}, []);

// JSX
<div ref={containerRef} className="viewport-container">
  {leftCollapsed ? (
    <div className="collapse-strip" onClick={() => { setLeftCollapsed(false); setSplitPercent(35); }}>
      <span className="arrow">›</span>
    </div>
  ) : (
    <div style={{ flex: leftFlex, display: 'flex', minWidth: 0, overflow: 'hidden' }}>
      <LeftPanel />
    </div>
  )}

  {!leftCollapsed && !rightCollapsed && (
    <div className="hdrag-handle" onMouseDown={onMouseDown} />
  )}

  {rightCollapsed ? (
    <div className="collapse-strip collapse-strip-r"
         onClick={() => { setRightCollapsed(false); setSplitPercent(65); }}>
      <span className="arrow">‹</span>
    </div>
  ) : (
    <div style={{ flex: rightFlex, display: 'flex', minWidth: 0, overflow: 'hidden' }}>
      <RightPanel />
    </div>
  )}
</div>
```

---

## 9. Vertical Drag Handle (Viewport Area ↕ Tab Panel)

A 10 px tall horizontal strip that resizes the viewport area vs the tab panel. Goes amber on hover/drag. Contains two small collapse-arrow buttons for one-click full collapse of either section.

```css
.vdrag-handle {
  height: 10px;
  background: var(--border);
  cursor: row-resize;
  flex-shrink: 0;
  transition: background 0.15s;
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
}
.vdrag-handle:hover,
.vdrag-handle.dragging { background: var(--accent); }

/* Collapse arrow buttons — sit inside the handle */
.vdrag-arrow {
  position: absolute;
  font-size: 8px;
  color: rgba(255,255,255,0.35);
  cursor: pointer;
  padding: 0 6px;
  line-height: 10px;
  z-index: 11;
  pointer-events: auto;
  user-select: none;
  transition: color 0.15s;
}
.vdrag-arrow:hover { color: var(--accent); }
.vdrag-arrow-up   { left: calc(50% - 36px); }  /* collapse top */
.vdrag-arrow-down { left: calc(50% + 12px); }  /* collapse bottom */
```

### Collapsed restore strips

When a section is fully collapsed, the drag handle is replaced by a thin labelled strip that lets the user restore it.

```css
.vcol-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 18px;
  background: #1e2a1e;           /* subtle green tint — signals "restorable" */
  border: 1px solid var(--border);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s;
  z-index: 10;
  user-select: none;
}
.vcol-strip:hover { background: #2a3a2a; }
.vcol-strip span {
  font-size: 10px;
  color: var(--accent2);         /* green label text */
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
```

### React pattern for vertical split + collapse

```jsx
const [viewportFlex, setViewportFlex] = useState(65);  // % for viewport area
const [vpCollapsed,  setVpCollapsed]  = useState(false);
const [tabCollapsed, setTabCollapsed] = useState(false);
const prevFlexRef = useRef(65);
const workspaceRef = useRef(null);

// Vertical drag handler (attach onMouseDown to .vdrag-handle)
const onVDragStart = useCallback((e) => {
  e.preventDefault();
  const onMove = (me) => {
    const rect = workspaceRef.current.getBoundingClientRect();
    let pct = ((me.clientY - rect.top) / rect.height) * 100;
    pct = Math.max(10, Math.min(90, pct));
    setViewportFlex(pct);
    prevFlexRef.current = pct;
    setVpCollapsed(false);
    setTabCollapsed(false);
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}, []);

// JSX
<div ref={workspaceRef} className="workspace">
  {/* Viewport area */}
  {!vpCollapsed && (
    <div className="viewport-area"
         style={{ flex: tabCollapsed ? '1 1 0' : `0 0 ${viewportFlex}%` }}>
      <ViewportContainer />
    </div>
  )}

  {/* Vertical divider / collapse strips */}
  {!vpCollapsed && !tabCollapsed ? (
    <div className="vdrag-handle" onMouseDown={onVDragStart}>
      <span className="vdrag-arrow vdrag-arrow-up"
            onClick={() => { setVpCollapsed(true); }}>▲</span>
      <span className="vdrag-arrow vdrag-arrow-down"
            onClick={() => { setTabCollapsed(true); }}>▼</span>
    </div>
  ) : vpCollapsed ? (
    <div className="vcol-strip vcol-strip-top"
         onClick={() => setVpCollapsed(false)}>
      <span>▼ Viewports</span>
    </div>
  ) : (
    <div className="vcol-strip vcol-strip-bottom"
         onClick={() => setTabCollapsed(false)}>
      <span>▲ Info Panel</span>
    </div>
  )}

  {/* Tab panel */}
  {!tabCollapsed && (
    <div className="tab-area"
         style={{ flex: vpCollapsed ? '1 1 0' : `0 0 ${100 - viewportFlex}%` }}>
      <TabPanel />
    </div>
  )}
</div>
```

---

## 10. Tab Panel (bottom info panel)

```css
.tab-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface);
  border-top: 1px solid var(--border);
  overflow: hidden;
}

/* Tab bar */
.tab-bar {
  display: flex;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

/* Individual tab buttons — KEY: yellow underline for active */
.tab-btn {
  padding: 6px 14px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-dim);
  border-bottom: 2px solid transparent;   /* ← the slot for the yellow line */
  transition: color 0.15s, border-color 0.15s;
  white-space: nowrap;
  user-select: none;
  background: none;
  border-top: none; border-left: none; border-right: none;
}
.tab-btn:hover { color: var(--text); }
.tab-btn.active {
  color: var(--accent);                   /* ← amber text */
  border-bottom-color: var(--accent);     /* ← amber underline */
}

/* Tab label — wrap tab text in <span class="tab-label"> so the framework can
   apply a max-width + ellipsis truncation. The full title is exposed via a
   title="" tooltip on the parent button so the long form is discoverable on
   hover. Apps should still prefer setting doc.tabTitle to a short string for
   long titles; --tab-max-width is the defensive fallback. */
.tab-label {
  display: inline-block;
  max-width: var(--tab-max-width);        /* ← 160px by default; override at :root */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
  min-width: 0;
}

/* Tab content scroll area */
.tab-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 16px;
  line-height: 1.6;
  font-size: 12px;
}
.tab-content::-webkit-scrollbar { width: 6px; }
.tab-content::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
```

---

## 11. Info Panel Content Patterns

Used inside tab content for structured key→value data (status readouts, help tables, etc.)

```css
/* Section heading */
.help-section { margin-bottom: 16px; }
.help-section h3 {
  color: var(--accent);           /* amber heading */
  font-size: 12px;
  margin-bottom: 6px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

/* Two-column key/value table */
.help-table { width: 100%; border-collapse: collapse; }
.help-table td {
  padding: 3px 8px;
  vertical-align: top;
  border-bottom: 1px solid rgba(255,255,255,0.04);  /* very subtle row divider */
}
.help-table td:first-child {
  white-space: nowrap;
  color: var(--accent);           /* amber key */
  font-family: monospace;
  font-size: 11px;
  min-width: 90px;
}

/* Dim italic note under a section */
.help-note {
  color: var(--text-dim);
  font-style: italic;
  margin-top: 4px;
  font-size: 11px;
}

/* Fixed-width first column for value alignment (status panels) */
.status-table { table-layout: fixed; }
.status-table td:first-child { width: 120px; min-width: 120px; }

/* Two-column side-by-side layout within a tab */
.help-two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 20px;
  width: 100%;
}
```

**Colour summary for info panels:**
- Section headings → `var(--accent)` amber
- Key column → `var(--accent)` amber, monospace
- Value column → `var(--text)` white/light grey
- Notes / secondary labels → `var(--text-dim)` mid-grey

---

## 12. Sliders & Checkboxes

Use the native `accent-color` property — the browser renders the thumb and track in `var(--accent)` automatically, giving yellow sliders and checkboxes throughout.

```css
input[type="range"]    { accent-color: var(--accent); cursor: pointer; }
input[type="checkbox"] { accent-color: var(--accent); cursor: pointer; }
```

**Slider row pattern:**

```css
.slider-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
}
.slider-row input[type="range"] { width: 90px; }
.slider-value {
  font-variant-numeric: tabular-nums;
  min-width: 36px;
  text-align: right;
  color: rgba(255,255,255,0.65);   /* slightly dimmed value readout */
}
```

---

## 13. Buttons — Toggle / Active State

Any button that has an active/on state uses a semi-transparent amber background + amber border + amber text:

```css
.my-btn {
  background: transparent;
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 4px;
  color: rgba(255,255,255,0.55);
  font-size: 14px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.my-btn:hover {
  background: rgba(255,255,255,0.08);
  border-color: rgba(255,255,255,0.35);
  color: #fff;
}
.my-btn.active {
  background: rgba(245,166,35,0.20);  /* amber tint */
  border-color: var(--accent);
  color: var(--accent);
}
```

---

## 14. Individual Panel (Viewport / Content Pane)

A panel is a flex column, dark background, clips overflow:

```css
.panel {
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  background: #0a0a0a;   /* near-black for content areas (slightly darker than --bg) */
  flex: 1;
  min-width: 0;          /* critical for flex children — prevents overflow blowout */
}
```

---

## 15. Floating Overlay Bars (inside panels)

Small controls floating over a canvas/content area. Semi-transparent dark pill background, positioned absolute, `z-index: 10`.

```css
.overlay-bar {
  display: flex;
  gap: 4px;
  padding: 4px;
  background: rgba(0,0,0,0.7);
  position: absolute;
  bottom: 6px; left: 6px;
  border-radius: 6px;
  z-index: 10;
  border: 1px solid rgba(255,255,255,0.08);
}

/* Small thumbnail-style buttons inside the bar */
.overlay-thumb {
  width: 44px; height: 30px;
  border-radius: 4px;
  cursor: pointer;
  border: 2px solid transparent;
  background: #222;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 2px;
  transition: border-color 0.15s, background 0.15s;
  user-select: none;
}
.overlay-thumb:hover { background: #333; border-color: rgba(245,166,35,0.4); }
.overlay-thumb.active { border-color: var(--accent); background: #2a2000; }
.overlay-thumb .icon  { font-size: 14px; line-height: 1; }
.overlay-thumb .label {
  font-size: 7px;
  color: var(--text-dim);
  letter-spacing: 0.3px;
  text-transform: uppercase;
}
.overlay-thumb.active .label { color: var(--accent); }
```

---

## 16. Scrollbars

Slim dark scrollbars throughout — 6 px, dark grey thumb:

```css
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
```

---

## 17. Light / Dark Mode Toggle (Standard RHS Titlebar Pattern)

Even when not strictly needed (as in VirtualMeadow), reserve space in the titlebar RHS for a theme toggle. The recommended implementation is a simple icon button:

```jsx
/* In titlebar JSX */
<div className="titlebar">
  My App <span>v1.0</span>
  <div style={{ marginLeft: 'auto' }}>
    <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme">
      {isDark ? '☀️' : '🌙'}
    </button>
  </div>
</div>
```

```css
.theme-toggle {
  background: transparent;
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 4px;
  color: var(--text-dim);
  font-size: 14px;
  width: 28px; height: 24px;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s, border-color 0.15s;
}
.theme-toggle:hover {
  background: rgba(255,255,255,0.08);
  border-color: rgba(255,255,255,0.3);
}
```

---

## 18. Complete `:root` + Reset Block (Copy–Paste Starter)

```css
/* ── Design tokens ───────────────────────────────────────────── */
:root {
  --bg:        #1c1c1e;
  --surface:   #2a2a2d;
  --border:    #3a3a3f;
  --accent:    #f5a623;
  --accent2:   #4caf50;
  --text:      #e8e8ea;
  --text-dim:  #888888;
  --title-h:   32px;
  --toolbar-h: 36px;
  --drag-sz:   5px;
  --tab-max-width: 160px;   /* max width of a tab label before it ellipsises */
}

/* ── Reset ───────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body, #root {
  width: 100%; height: 100%;
  overflow: hidden;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  color: var(--text);
  background: var(--bg);
}

/* ── Scrollbars ──────────────────────────────────────────────── */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }

/* ── Sliders & checkboxes ────────────────────────────────────── */
input[type="range"],
input[type="checkbox"] { accent-color: var(--accent); }

/* ── Light mode token overrides ──────────────────────────────── */
:root[data-theme="light"] {
  color-scheme: light;
  --bg:        #f6f7fa;
  --surface:   #ffffff;
  --border:    #d4d8e0;
  --accent:    #d4860a;
  --accent2:   #2e7d32;
  --text:      #1a1e28;
  --text-dim:  #5c6472;
}

/* ── Light mode title bar ────────────────────────────────────── */
:root[data-theme="light"] .titlebar,
:root[data-theme="light"] .app-header {
  background: linear-gradient(135deg, #dde7f5 0%, #cdd8ee 100%);
  border-bottom-color: #a8bdd8;
}
```

---

## 19. Component Checklist for a New App

Use this checklist when starting a new project in this style:

- [ ] Copy the `:root` token block and reset above
- [ ] `App` shell is `display: flex; flex-direction: column; height: 100%; overflow: hidden`
- [ ] Title bar: amber title LHS, dim subtitle, RHS theme toggle placeholder
- [ ] Toolbar: `var(--surface)` bg, 36 px height, toolbar-btn pattern, RHS status area
- [ ] Workspace: `flex: 1; flex-direction: column; min-height: 0`
- [ ] Viewport area: horizontal flex, LHS/RHS panels, `hdrag-handle` between them, `collapse-strip` on each side
- [ ] Vertical drag handle between viewport area and tab panel, with collapse arrows
- [ ] `vcol-strip` restore bars for fully collapsed sections
- [ ] Tab panel: `tab-bar` + `tab-btn` with `border-bottom: 2px solid var(--accent)` active state
- [ ] Info content: `help-section h3` amber headings, `help-table` with amber key column
- [ ] All sliders/checkboxes: `accent-color: var(--accent)`
- [ ] Active/toggled buttons: `rgba(245,166,35,0.20)` bg + `var(--accent)` border + text
- [ ] Drag handles turn `var(--accent)` on hover and `.dragging`
- [ ] Light mode: add `:root[data-theme="light"]` token block; add slate-blue title bar override (see §20)
- [ ] Theme toggle: `useTheme` hook writes `data-theme` on `<html>`, persists to `localStorage`

---

## 20. Light Mode

### Design intent

Light mode keeps the same amber-and-green accent language but inverts the surface hierarchy: near-white page background, pure-white panels, dark charcoal text. The title bar shifts from near-black to a slate-blue gradient so it retains a distinct identity even without the dark surround.

### Full token block

```css
:root[data-theme="light"] {
  color-scheme: light;

  /* Backgrounds */
  --bg:        #f6f7fa;   /* warm off-white page background */
  --surface:   #ffffff;   /* panel / toolbar surface */
  --border:    #d4d8e0;   /* dividing lines */

  /* Accents — darkened for WCAG contrast on white */
  --accent:    #d4860a;   /* amber: #f5a623 → #d4860a (≈3.8:1 on white) */
  --accent2:   #2e7d32;   /* green: #4caf50 → #2e7d32 */

  /* Text */
  --text:      #1a1e28;   /* primary body text */
  --text-dim:  #5c6472;   /* secondary / label text */

  /* Viewer / overlay tokens (rnasim-specific) */
  --viewer-bg:      #e4e7ee;
  --overlay-panel:  rgba(255, 255, 255, 0.72);
  --overlay-strong: rgba(255, 255, 255, 0.82);
  --active-site-bg: #111218;
  --active-site-fg: #ffffff;
}
```

### Title bar override

```css
:root[data-theme="light"] .titlebar,
:root[data-theme="light"] .app-header {
  background: linear-gradient(135deg, #dde7f5 0%, #cdd8ee 100%);
  border-bottom-color: #a8bdd8;   /* hardcoded — see rationale below */
}
```

**Border colour rationale.** `var(--border)` in light mode is `#d4d8e0`. The gradient end colour is `#cdd8ee`. These two are nearly the same perceived brightness at 210° hue — the 1 px rule effectively vanishes. `#a8bdd8` is the same hue family but ~15% darker in lightness, making the separator clearly visible while staying within the slate-blue palette character.

### Targeted hardcoded overrides

Some colours cannot be expressed purely via token swaps and require element-specific rules in the light-mode block:

| Selector | Property | Value | Reason |
|---|---|---|---|
| `.app-header`, `.titlebar` | `background` | slate-blue gradient | Dark gradient becomes solid black in light mode |
| `.app-header`, `.titlebar` | `border-bottom-color` | `#a8bdd8` | `--border` too close to gradient end colour |
| `.event-marker` | `background` | `#111218` | Timeline marker must stay dark to be visible on light tracks |

### Token naming note

The `rnasim` implementation carries legacy aliases (`--bg-panel → --surface`, `--fg → --text`, `--fg-muted → --text-dim`, `--bg-raised`) declared in `:root` alongside the canonical tokens. These aliases exist so component class names didn't need renaming when the style guide was applied. New projects should use the canonical names only (`--surface`, `--text`, `--text-dim`).

### Theme toggle hook pattern

```ts
// src/hooks/useTheme.ts
const STORAGE_KEY = 'rnasim:theme';   // or '<appname>:theme'

export function useTheme() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const stored = localStorage.getItem(STORAGE_KEY) as 'light' | 'dark' | null;
  const [theme, setTheme] = useState<'light' | 'dark'>(stored ?? (prefersDark ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggle = () => setTheme(t => t === 'dark' ? 'light' : 'dark');
  return { theme, toggle, isDark: theme === 'dark' };
}
```

The hook writes `data-theme` directly on `<html>` so that `:root[data-theme="light"]` selectors match correctly (`<html>` and `:root` are the same element).

---

_Style guide generated from VirtualMeadow — meadow-app/src/App.css, April 2026. Light mode additions: rnasim, May 2026._
