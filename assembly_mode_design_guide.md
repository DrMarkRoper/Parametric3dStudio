# Assembly Mode — Design Guide

> **Status**: implemented (v1 shipped — see §10 "As-built notes" for what
> landed and where it deviates from the design below).
> **Purpose**: define a third top-level mode — **Assembly** — alongside the
> existing **Sketch** and **3D model** modes, in which the user declares
> mechanical *joints* on bodies and *links* between joints, then drives the
> mechanism with on-canvas handles. This document is the carry-forward
> reference for implementing the feature. It follows the conventions of
> `project_context.md`; read that first for engine, MDI shell, store, and
> bridge background.
>
> **Hard rule**: Assembly mode is **non-destructive**. It never edits the
> parametric tree (sketch → extrude lock), never mutates feature geometry,
> and produces no permanent change to body positions. All motion is a
> transient transform overlay that is discarded on exit.

---

## 1. Concept & vocabulary

Assembly mode is built on a **joint-based** model: each joint **declares the
degrees of freedom a body is allowed**, and the body may then move only within
those declared freedoms. This is the opposite of a *constraint* model, in which
one would assert geometric relationships (this face touches that face, these
axes are concentric) and rely on a solver to deduce whatever freedom is left
over. Declaring the freedom directly is more predictable, needs no general
degree-of-freedom solver, and maps directly onto what the user wants to
express ("this part rotates here, between these angles").

The reasoning from first principles: a rigid body in space has six degrees of
freedom (three translation, three rotation). A mechanism is just a set of
bodies whose freedoms have been deliberately reduced — a hinge leaves exactly
one rotational DOF, a slide leaves exactly one translational DOF. So rather
than model what *stops* a body from moving, we model the single freedom it
*keeps*. That single retained freedom, plus its limits, **is** the joint.

Two layers, kept deliberately separate:

| Concept | Owns | What it answers |
|---|---|---|
| **Joint** | one body's single retained freedom relative to ground, plus its limits | "what can this part do on its own?" |
| **Link** | a coupling between two joints with a ratio + phase offset | "what is this joint wired to?" |

Keeping them independent means a joint's range and a
link's ratio can be edited separately, and a joint with no link is still fully
usable (free-drag within its limits).

### Locked v1 scope

- **Joint types**: **Revolute** (rotation about an axis) and **Prismatic**
  (translation along a vector). Cylindrical / pin-slot / ball / planar are
  explicitly deferred.
- **Link (coupling) types**: **Rotation↔Rotation**, **Rotation↔Linear**
  (rack-and-pinion / screw), and **Linear↔Linear** — all three.
- **Ratio source**: auto-derive from cog tooth counts when both ends are cogs
  (`N₁ / N₂`, negative for an external mesh), with a manual override always
  available; manual entry for every other case.
- **Topology**: **acyclic driver→driven chains only.** Cycles (closed gear
  trains, four-bar loops) are **detected and warned**, never solved.
- **Exit behaviour**: **snap every body back to its home/rest pose.** The pose
  is purely transient; no posed state survives leaving the mode.

---

## 2. The home/rest pose — why nothing permanent changes

Every body that participates in a mechanism has a **home transform**: the
world-space position/orientation it already occupies from its design
definition (primitive `position`/`rotation`, extrude placement, import
transform, etc.). This is the joint's **zero**.

When Assembly mode is entered:

1. The parametric regen result (`regen.bodies` from `useRegen()`) is captured
   as the baseline. Each jointed body's current world transform becomes its
   stored `homeMatrix`.
2. The sketch→extrude dependency lock is **frozen**, not released for editing —
   regen does not re-run from sketch edits while in Assembly mode (there are no
   sketch edits in this mode). Bodies are treated as rigid.
3. Joint motion is applied as a **delta transform around the joint origin**,
   composed on top of `homeMatrix`. The underlying `Feature` data is never
   touched.

When Assembly mode is exited, the delta transforms are dropped and every body
renders at `homeMatrix` again. Because no `Feature` is mutated and no
`setDoc` (the dirty-flagging path) is called, **the document never becomes
dirty from posing a mechanism**. The principle is simple: the design defines
where a body *rests*, and driving a joint only displaces it temporarily from
that rest position, so returning to rest is always a no-op on the underlying
model.

> Consequence for the store: joint/link *definitions* are persistent project
> data (they should save/load and mark the doc dirty when created/edited), but
> joint *values* (the current drive position) are transient UI state that is
> reset to zero on enter/exit.

---

## 3. Data model

New persistent entities live in the `Doc`, parallel to `features`. They
reference bodies by **feature id** (the same id space the Viewport keys meshes
on — see `project_context.md` §8.4).

```typescript
type JointType = 'revolute' | 'prismatic';

// A 3D point/vector expressed in world space (baked, like all engine geometry).
type Vec3 = [number, number, number];

interface JointLimits {
  mode: 'free' | 'limited';
  min?: string;   // expression; degrees (revolute) or length units (prismatic)
  max?: string;   // expression; only read when mode === 'limited'
}

interface Joint {
  id: string;
  name: string;             // e.g. "Joint 1" (nextName(doc, 'Joint'))
  featureId: string;        // the body this joint moves
  type: JointType;
  origin: Vec3;             // joint origin in world space (cog centre, etc.)
  axis: Vec3;               // revolute: oriented rotation axis (right-hand rule)
                            // prismatic: oriented translation direction
                            // stored normalised
  limits: JointLimits;
  // transient (NOT serialised): current drive value, reset to 0 on enter/exit
}

type LinkKind =
  | 'rot-rot'      // revolute ↔ revolute
  | 'rot-lin'      // revolute ↔ prismatic  (rack-and-pinion / screw)
  | 'lin-lin';     // prismatic ↔ prismatic

interface Link {
  id: string;
  name: string;             // e.g. "Link 1"
  driverJointId: string;    // the joint that drives
  drivenJointId: string;    // the joint that follows
  kind: LinkKind;           // derived from the two joints' types; stored for clarity
  ratio: string;            // expression. driven = ratio * driver  (see §5)
  ratioSource: 'manual' | 'teeth';   // 'teeth' auto-derives from cog tooth counts
  phase?: string;           // offset added to driven after the ratio (default 0)
}
```

Notes:

- **Expressions, not raw numbers.** `min` / `max` / `ratio` / `phase` are
  expression strings so they can reference named parameters, consistent with
  every other dimension field in the app (`core/expressions.ts`).
- **Axis orientation carries the sign.** A revolute joint's positive direction
  is defined by the right-hand rule about `axis`. The UI presents angles using
  the app's existing **CW-positive** convention (§9 of `project_context.md`);
  the mapping from stored right-hand-rule angle to the CW UI readout happens at
  the panel/handle layer only, exactly as the sketch rotate block already does.
- **Units in `rot-lin` links.** For a Rotation↔Linear coupling the `ratio` has
  units of *length per degree* (driven prismatic) or *degrees per length*
  (driven revolute) depending on which end is the driver. The Link editor
  labels the ratio field with the resolved units so the number is unambiguous.
- **Serialisation.** `Joint[]` and `Link[]` are added to the project file
  alongside `features`. Loading a legacy file with neither yields empty arrays
  (same migration pattern as the `meta` addition — see `project_context.md`
  §1 / §8.1). Creating or editing a joint/link marks the doc dirty; *driving*
  a joint does not.

### Auto-derived gear ratio (`ratioSource: 'teeth'`)

When both `driverJointId` and `drivenJointId` are revolute joints whose
`featureId` resolves (through the extrude → sketch chain) to a **`CogEntity`**,
the Link editor offers "derive ratio from teeth". The ratio is
`N_driver / N_driven`, made **negative** when the cogs are an external mesh
(they turn in opposite directions). The value is recomputed if either cog's
tooth count changes. Manual override switches `ratioSource` back to `'manual'`
and freezes the typed value. Non-cog bodies only ever get manual ratios.

---

## 4. Mode, state & toolbar bridge

Assembly mode plugs into the existing mode plumbing (`store.mode`,
`useStudioActions`, `SET_TOOLBAR_BLOCK_VISIBLE`).

### 4.1 Store changes (`studio/state/store.ts`)

- Extend `mode` to `'model' | 'sketch' | 'assembly'`.
- Persistent doc data: `Doc.joints: Joint[]`, `Doc.links: Link[]`.
- Transient assembly UI state (not undoable, not serialised, reset on
  enter/exit):
  - `assembly: { jointValues: Record<jointId, number>; selectedJointId?; selectedLinkId?; activeDriverJointId?; warnings: string[] }`
  - `homeMatrices: Map<featureId, THREE.Matrix4>` captured on enter.
- Actions: `enterAssembly()` (capture home matrices, zero all joint values),
  `exitAssembly()` (drop transient state — bodies snap home), `addJoint`,
  `updateJoint`, `removeJoint`, `addLink`, `updateLink`, `removeLink`,
  `setJointValue(jointId, value)` (clamps to resolved range, then propagates —
  see §5).

> Joint/link **definition** edits go through the normal undoable `setDoc`
> path (they're project data). Joint **value** changes (`setJointValue`) are
> transient and bypass the undo stack.

### 4.2 Toolbar blocks (`public/data/toolbars/`)

Add an `tb-assembly` block, visible only in assembly mode, mirroring the
mode-swap rules in `project_context.md` §5/§6:

| Tool | Action | Behaviour |
|---|---|---|
| Add Revolute Joint | `assembly:joint:revolute` | pick body → pick origin → pick/confirm axis → set limits |
| Add Prismatic Joint | `assembly:joint:prismatic` | pick body → pick origin → pick direction vector → set limits |
| Add Link | `assembly:link` | pick driver joint → pick driven joint → set ratio |
| Drive | `assembly:drive` | select a joint and drag its handle (default tool) |
| Delete | `assembly:delete` | remove selected joint/link |

Visibility rule added to the bridge: `mode === 'assembly'` → hide
`tb-sketch` / `tb-create` / `tb-modify` / `tb-sketchtools`, show `tb-assembly`.
A new mode entry is added to `tb-*` mode-swap logic in `useStudioActions`
(§4.3 of `project_context.md`).

### 4.3 Menu (`public/data/menus/main_menu.json`)

Add a top-level **Assembly** menu (or a mode toggle alongside Sketch): Enter /
Exit Assembly Mode, Add Revolute Joint, Add Prismatic Joint, Add Link, plus
disabled-state rules analogous to the sketch-aware menu (`useSketchAwareMenu`,
§4.5): joint/link items disabled outside assembly mode.

### 4.4 Status bar (`components/StudioStatusBar.tsx`)

Reuse the existing hint/error slots: show the active joint's resolved range and
live value while dragging (e.g. `Joint 1 — 32.0° (range −40°…40°)`), and
surface cycle/over-constraint warnings in the error summary slot.

---

## 5. Driving & propagation

### 5.1 Resolved range = intersection

A free joint with no link drives within its own `limits`. A joint that is the
**driven** end of one or more links has an **effective** range equal to the
**intersection** of:

- its own `limits` (if `limited`), and
- each partner joint's range mapped through that link's `ratio` + `phase`.

For a single link `driven = ratio * driver + phase`, the driver's reachable
range `[dMin, dMax]` maps to driven `[ratio*dMin + phase, ratio*dMax + phase]`
(swap ends when `ratio < 0`). The driven joint's usable range is its own range
intersected with that mapped interval. Symmetrically, dragging the driven end
back-maps to constrain the driver.

If any intersection is **empty**, the configuration is over-constrained: flag
it as a warning (status bar + the offending joint/link highlighted) and clamp
to the nearest feasible value rather than allowing an inconsistent pose.

### 5.2 Propagation (acyclic only)

Links form a directed graph (driver → driven). On `setJointValue(j, v)`:

1. Clamp `v` to joint `j`'s resolved range (§5.1).
2. **DFS** outward along links where `j` is the driver, computing each driven
   value as `ratio * driverValue + phase`, clamping at each node's resolved
   range, and writing into `assembly.jointValues`.
3. For each updated joint, compose its delta transform around `origin`/`axis`
   onto the body's `homeMatrix` and update the rendered mesh transform.

Because the graph is required acyclic, this terminates in one pass with no
solver iteration.

### 5.3 Cycle detection

Before propagating (and whenever a link is added/edited), run a directed-graph
cycle check (DFS colouring / Kahn's algorithm) over the link graph. If a cycle
exists:

- Do **not** attempt to solve it.
- Add a clear warning to `assembly.warnings` ("Closed loop detected:
  Joint 1 → Joint 2 → Joint 1. Linked motion is disabled for this loop.") and
  surface it in the status bar.
- Disable driving through the offending links until the user breaks the loop.

This keeps v1 honest: closed-loop kinematics (the four-bar problem) is a
separate, larger feature explicitly out of scope.

---

## 6. On-canvas handles

Handles reuse the transform-gizmo infrastructure in
`studio/components/Viewport.tsx` (the existing translate/rotate gizmo and its
CW-positive readout), constrained to a single DOF:

- **Revolute handle** — a ring/arc lying in the plane perpendicular to `axis`,
  centred on `origin`. Dragging sweeps an angle; the readout follows the mouse
  using the app's CW-positive convention. Drag value feeds `setJointValue`.
- **Prismatic handle** — a single arrow along `axis` from `origin`. Dragging
  projects the cursor onto the axis to produce a signed distance; feeds
  `setJointValue`.

Both clamp live to the resolved range, so the handle visibly stops at limits.
When a link makes a joint driven, its handle still works (back-propagating to
the driver), unless it sits on a flagged cycle, in which case it's inert and
visually marked.

For an extruded cog, the natural revolute setup is `origin` = cog centre,
`axis` = the extrude normal through that centre. Snap support (cog centre is
already a snap point — `project_context.md` §8.2) makes origin-picking precise.

---

## 7. Conventions & gotchas (carry-forward)

- **CW-positive at the UI, right-hand-rule internally.** Store the oriented
  `axis`; convert to the CW readout only in the panel/handle layer, mirroring
  the existing sketch rotate block. Getting this inconsistent will make handles
  appear to drive "backwards" — the same class of bug as the inverted thread
  winding noted in `project_context.md` §1.
- **`rot-lin` ratio units.** Always label the ratio field with resolved units
  (length/° or °/length) so the number is interpretable. Internally the ratio
  is just a scalar in `driven = ratio*driver + phase`.
- **External-gear sign.** Auto-derived cog ratios are negative for an external
  mesh (opposite rotation). Don't silently drop the sign.
- **Non-destructive guarantee.** Driving a joint must never call the dirty
  path. Only joint/link *definition* edits mark the doc dirty. Audit that
  `setJointValue` and the per-frame transform overlay touch transient state
  only.
- **Empty range / over-constraint** is a user-visible warning state, not a
  silent clamp — surface it.
- **Cycles** are detected and disabled, never solved (v1).

---

## 8. Out of scope for v1 (future ideas)

- Additional joint types: cylindrical, pin-slot, planar, ball.
- Closed-loop / multi-driver solving (four-bar, planetary gear trains) — needs
  an iterative constraint solver, a real project of its own.
- Collision / interference detection and contact-driven meshing (purely
  kinematic for now — gears don't actually have to mesh geometrically).
- Motion recording / timeline / export (animate a drive value over time).
- Auto-detect meshing cogs (pitch circles tangent) to suggest a link.
- Driving joint values from named parameters or dimension constraints.
- Persisting a "posed" display state (deliberately excluded — exit snaps home).

---

## 9. Implementation checklist (all shipped)

1. ✅ `studio/types.ts`: `Joint`, `Link`, `JointType`, `JointLimits`,
   `LinkKind`, `Vec3`; `joints` / `links` on `Doc` + `emptyDoc`.
2. ✅ `studio/core/assembly.ts`: pure range-intersection, propagation, cycle
   detection, `jointDeltaMatrix` / `bodyDeltaMatrix`, `teethRatio`, `linkKind`.
3. ✅ `studio/state/store.ts`: `mode` extended to `'assembly'`; transient
   `assembly` state (`jointValues` / `selectedJointId` / `selectedLinkId` /
   `warnings`); `enterAssembly` / `exitAssembly` / joint+link CRUD /
   `setJointValue`; joint/link cleanup in `deleteFeature`.
4. ✅ `studio/io/exporters.ts`: `joints` / `links` load (legacy → `[]`); save
   is automatic (they live on `doc`).
5. ✅ `studio/studioBridge.tsx`: `enterAssemblyCmd` / `exitAssemblyCmd` /
   `addJointCmd` / `addLinkCmd` / `deleteAssemblyCmd`; default origin/axis from
   the body's world bounding box; `cogTeethForFeature`.
6. ✅ `studio/useStudioActions.ts`: `assembly:*` actions; `'assembly'` in the
   mode → toolbar-block bridge; the Info ⇄ Joints/Links document-tab swap.
7. ✅ `public/data/`: `tb-assembly` toolbar block (+ layout + manifest entry),
   Assembly menu, mode-aware disabled rules in `useSketchAwareMenu`.
8. ✅ `Viewport.tsx`: `AssemblyDriveHandle` (constrained revolute ring /
   prismatic arrow) + per-body delta-transform overlay on the identity home.
9. ✅ Panels: `AssemblyJointsSection` / `AssemblyLinksSection` in
   `PropertiesPanel.tsx`, surfaced as the `JointsPanel` / `LinksPanel`
   document tabs.
10. ✅ **Verification**: `studio/core/assembly.test.ts` (17 Vitest cases —
    range intersection incl. negative ratio + empty, propagation on a 3-joint
    chain, inverse drive, clamping, phase, cycle detection, transforms,
    teeth ratio). Run with `npm test`.

---

## 10. As-built notes (where the shipped code differs from the design above)

- **Home pose is the identity.** Engine geometry is baked to world space
  (`project_context.md` §8.2), so each body's home matrix is the identity and
  the joint delta (§3 / §9.x) is applied directly to the rendered mesh via a
  wrapping `<group matrixAutoUpdate={false}>`. No separate `homeMatrix` is
  stored — "snap home" is simply dropping the overlay.

- **Joint origin / axis are seeded, then edited numerically.** Rather than the
  interactive origin/axis *picking* sketched in §4.2/§6, `addJointCmd` seeds the
  origin from the body's world-bbox centre and the axis from its thinnest
  principal direction (the spin axis of a flat cog). Both are then editable as
  X/Y/Z fields in the joint editor. On-canvas click-to-pick of origin/axis
  remains a natural future enhancement.

- **Driving is handle-drag + a slider, not a separate "Drive" tool.** Selecting
  a joint (click its body, or its row in the Joints tab) shows the amber
  ring/arrow handle and a slider in the editor. Under the slider: `«` / `0°`
  (reset to design position) / `»` step buttons, plus a **Step** field that
  defaults to ¼ of the resolved range (or 90° revolute / 10 mm prismatic when
  the range is free; free revolute wraps past ±180° back to negative).

- **Joints & Links are two MDI document tabs**, not one Info-panel section.
  They live in the RHS (`dc-info`) container as `JointsPanel` / `LinksPanel`,
  **non-closable** (`allowClose: false`) and **draggable** (`allowAsTab: true`)
  so both can be viewed at once; torn-off containers are created with
  `killOnClose: true` and are removed on exit. Entering Assembly swaps the Info
  tab out for the two; leaving restores Info. The swap is reconciled
  idempotently on every mode change in `useStudioActions`, and falls back to a
  combined editor in the Info panel if the tab documents are absent (older saved
  layout). The combined fallback (`AssemblyProps`) is still present.

- **Resolved range is one-hop.** `resolvedRange` intersects a joint's own range
  with each *incident* link partner's **own** range mapped through the ratio
  (not a full transitive solve) — sufficient for v1 acyclic chains. Drive
  propagation traverses links undirectedly (forward by `ratio`, inverse the
  other way), clamping at each node; joints in a detected cycle are not
  propagated through and raise a warning (surfaced in the status bar + the
  Joints tab).

- **Layout note.** Because the toolbar and the Joints/Links tabs are defined in
  `public/data/layout/default_layout.json`, a browser with an older persisted
  layout must run **View → Reset Workspace Layout** once to pick them up.

---

## 11. Pin-slot joints & closed-loop mechanisms (proposed — not yet implemented)

> **Status**: **implemented** (decisions locked: straight-segment slot only;
> slot stored in the slot body's local/home frame; loops inferred automatically;
> unreachable driver angles clamp-and-stop). Extends v1 (revolute + prismatic
> joints, ratio links, acyclic chains) with (a) a **pin-slot** joint and (b) a
> minimal **closed-loop position solver**, because the motivating mechanism — a
> crank driving a slotted rocker — is a single-DOF *closed loop* the ratio-link
> model cannot express. As-built summary at §11.9.

### 11.1 Motivating mechanism (the wheel-leg)

From a real project file, the leg assembly is a textbook **crank + slotted
rocker**:

- The **wheel** spins about its axle (one revolute to ground — the driver).
- An **off-centre crank pin** (the "wheel sprocket") is rigid to the wheel, so it
  orbits the axle at a fixed radius as the wheel turns.
- The **leg**'s lower hole is **pinned** to that crank pin (a revolute between leg
  and wheel).
- The leg has a **slot**; a **pin fixed to the body** (the "body sprocket") rides
  in that slot.

The leg is therefore grounded **twice** — once through the wheel/crank, once
through the slot pin back to the body — which **closes a kinematic loop**.

Planar mobility (Gruebler), with body = ground and wheel + leg as the two moving
links, two revolutes and one pin-slot:

```
M = 3(N − 1) − 2·P − 1·H
  = 3(3 − 1) − 2·2 − 1·1 = 1
```

**Mobility = 1**: one input (the wheel angle) fully determines the leg's
orientation and its slide along the slot. The leg's angle is a *nonlinear
(trigonometric)* function of the wheel angle — **not** a constant ratio — so it
cannot be modelled with a `ratio` link, and any attempt to link the leg to both
the wheel and the body trips the existing cycle detector (by design, §5.3).

Note: the leg must **not** rotate rigidly with the crank pin. It is *pinned* to
it; the slot-on-fixed-pin is precisely what converts the crank's orbit into the
leg's rocking. A rigid weld would make the slot meaningless.

### 11.2 New joint type — Pin-slot

A **pin-slot** constrains a *point* (the pin) to lie on a *line segment* fixed in
another body (the slot). It is a 2-DOF "higher pair": the pin may **slide** along
the slot and the two bodies may **rotate** relative to each other. It removes one
constraint (the perpendicular-to-slot offset).

```typescript
type JointType = 'revolute' | 'prismatic' | 'pinslot';   // extend the union

interface PinSlotJoint {
  id: string;
  name: string;
  type: 'pinslot';
  /** Body that carries the slot (e.g. the leg). */
  slotFeatureId: string;
  /** Slot centre-line in world space at the design (home) pose: two endpoints.
   *  Stored in world like all baked geometry; transformed by the slot body's
   *  current pose when solving. */
  slotA: Vec3;
  slotB: Vec3;
  /** Body that carries the pin (e.g. the body/ground). */
  pinFeatureId: string;
  /** Pin point in world space at the design pose. */
  pin: Vec3;
  /** Optional slide limits along the slot (length units from slotA). */
  limits: JointLimits;
}
```

Seeding (like revolute/prismatic): when the user adds a pin-slot, default
`slotA` / `slotB` from the two slot-end snap points of the selected slotted body
and `pin` from the selected pin body's hole centre — both editable numerically.

### 11.3 Topology — loops are explicit, and solved (not warned)

Today the link graph must be acyclic; a cycle is detected and *disabled* (§5.3).
This feature introduces a **loop group**: a set of joints/bodies the user marks
(or that the engine infers) as a closed kinematic chain to be solved together.

- Detection: when adding a pin-slot (or a second grounding joint on a body that's
  already connected through another path) the engine recognises a closed loop and
  offers to treat it as a **solved loop** instead of erroring.
- A solved loop still has exactly one **driver** DOF (here, the wheel revolute);
  the remaining joint DOFs in the loop (leg rotation about the crank pin, slide
  along the slot) become **dependent, solved** outputs — neither free-drag nor
  ratio-linked.

### 11.4 The solver

Because mobility is 1, this is a **one-unknown** problem per drive step — small
and robust. For the crank-slotted-rocker:

1. From the driver (wheel angle `θw`), place the crank pin in world:
   `P_crank = wheelCentre + R(axis, θw)·(crankOffset)`.
2. The leg's lower pin coincides with `P_crank` (the leg-wheel revolute), so the
   leg's position is known up to its orientation `φ` about `P_crank`.
3. Solve `φ` so the slot centre-line (through `P_crank`, direction set by `φ`)
   passes through the fixed pin `Pb`. This is a single trig equation:
   the perpendicular distance from `Pb` to the slot line must be zero. Closed-form
   where possible, else 2–3 Newton iterations on the residual.
4. The slide parameter `s` = projection of `Pb` onto the slot line (for limit
   checks / readout).
5. Compose the leg's delta transform from `(P_crank, φ)` and apply it as the
   usual overlay (§2/§9.x).

Generalisation: the same residual-minimisation shape (Newton-Raphson over the
loop's unknown joint values, driving constraint residuals to zero) extends to
other planar loops (four-bar, etc.) later. v1-of-this-feature only needs the
single-loop, single-unknown case to ship the wheel-leg.

**Driver range from a loop.** A solved loop may not be reachable over the full
driver range (the slot pin can hit a slot end, or the linkage can lock). The
driver's resolved range (§5.1) should be intersected with the **feasible** range
found by the solver (where a solution exists and slide stays within slot limits);
outside it, clamp and flag, consistent with the existing over-constraint warning.

### 11.5 UI

- **Toolbar / menu**: add **Pin-slot Joint** beside Revolute / Prismatic in the
  `tb-assembly` block and the Assembly menu.
- **Pin-slot editor** (Joints tab): slot body + two slot endpoints (X/Y/Z each),
  pin body + pin point, optional slide min/max, and a live slide readout.
- **Handles**: draw the slot as a capsule/line on the slot body and the pin as a
  small sphere; the pin visibly slides along the slot as the driver moves. The
  loop's driver keeps its normal ring/arrow handle.
- **Loop affordance**: when a loop is recognised, show it as a solved group (e.g.
  a badge on its joints) rather than the red cycle warning.

### 11.6 Data-model / engine touch-points (when implemented)

- `types.ts`: extend `JointType`; add `PinSlotJoint` (or fold slot fields into a
  discriminated `Joint` union).
- `core/assembly.ts`: pin-slot residual + a `solveLoop(driverValue, loop, …)`
  routine; feasibility-range helper; keep the existing pure/tested style (add
  cases to `assembly.test.ts`: crank-slotted-rocker positions at a few angles,
  slide-limit clamping, unreachable-angle handling).
- `store.ts`: loop grouping in the assembly state; `setJointValue` routes a
  driver that belongs to a loop through `solveLoop` instead of ratio-propagation.
- `Viewport.tsx`: slot + pin handles; apply solved leg transform.
- `PropertiesPanel.tsx`: pin-slot editor; loop badge.

### 11.7 Scope & sequencing

This is the **closed-loop solving** item parked in §8, not a tweak to the
ratio-link system. Suggested order: (1) pin-slot joint type + handle + editor as
a *visual* constraint first; (2) the single-loop solver wired into the drive
path; (3) feasibility-range + limit handling; (4) generalise the solver to
multi-bar loops later. The motivating wheel-leg is the simplest non-trivial loop
(1-DOF, one slot), so the solver itself is small — most of the effort is the new
joint type and routing loop-solving into the drive/propagation path.

### 11.8 Open questions for review

- Should the slot be a straight segment only (v1) or allow an arc/curve slot too?
- Define the slot in **world** (baked, like other joint geometry) or **relative to
  the slot body's local frame** (more robust if that body is later re-edited)?
- Is the loop **inferred** automatically when a pin-slot closes a path back to
  ground, or must the user explicitly mark the loop group?
- For unreachable driver angles, prefer **clamp-and-stop** at the feasibility
  limit, or visibly **flag and freeze**? (Mirror §5.1's empty-range behaviour.)

### 11.9 As-built (what shipped)

- **`PinSlotJoint`** added to `types.ts` (`Doc.pinSlots`, serialised + loaded with
  legacy `[]`); slot endpoints `slotA`/`slotB` stored in the slot body's home
  frame. **Straight segment only.** Joints gained an optional **`baseFeatureId`**
  so a revolute can be pinned to a *moving* body (the crank), default ground.
- **`solveBodyTransforms(doc, jointValues, evalNum)`** in `core/assembly.ts` is
  now the single source of body transforms in Assembly mode: it forward-resolves
  simple/based bodies, then **infers** each crank-slotted-rocker loop (a body
  that is a pin-slot's slot body *and* has a based revolute) and solves the slot
  body's angle with `solveSlotAngle` (full-circle scan + bisect, branch nearest
  the previous solution). Returns `{ transforms, solvedValues, feasible }`.
- **Clamp-and-stop**: `store.setJointValue` runs the solver on the candidate
  values and, if any loop is infeasible (no solution or the pin leaves the slot /
  exceeds slide limits), leaves state unchanged — the driver stops at the limit.
- **UI**: Pin-slot in the `tb-assembly` toolbar + Assembly menu; a `PinSlotEditor`
  (slot endpoints, pin body + point, slide limits) and a **Base** select on the
  joint editor; loop-solved revolutes hide their drive slider. The Viewport draws
  the slot centre-line (amber, moves with the leg) and the fixed pin (blue).
- **Tests**: `assembly.test.ts` covers `solveSlotAngle` at home, the loop home
  pose, pin-stays-on-slot as the wheel turns, and clamp-and-stop on an
  out-of-range slide.
- **Deferred** (unchanged from the proposal): curved slots, multi-bar / >1-DOF
  loops, and on-canvas picking of slot/pin/crank points (currently numeric entry,
  seeded from the body bbox). Loop **inference** is automatic — no explicit loop
  object — per the locked decision.
