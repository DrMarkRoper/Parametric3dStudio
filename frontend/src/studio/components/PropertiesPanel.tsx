import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type {
  ArcEntity,
  BooleanFeature,
  CircleEntity,
  CogEntity,
  CogProfile,
  DimensionEntity,
  EdgeKind,
  ExtrudeFeature,
  Feature,
  ImageEntity,
  ImportFeature,
  Joint,
  JointType,
  LineEntity,
  Link,
  MergeOp,
  PinSlotJoint,
  PrimitiveFeature,
  PrimitiveShape,
  RectEntity,
  SketchEntity,
  SketchFeature,
  ThreadPreset,
  Vec3,
} from '../types';
import { BOLT_PRESETS, BULB_PRESETS, THREAD_SHAPES, isEdisonThread } from '../types';
import { importCache, nextName, uid, useStore, type DynamicOp } from '../state/store';
import { tryEval, type Params } from '../core/expressions';
import { isLoopSolvedJoint, linkKind, resolvedRange, teethRatio, type Range } from '../core/assembly';
import { cogTeethForFeature } from '../studioBridge';
import type { BodyOut } from '../core/buildGeometry';
import { dist2d, entitiesBounds, modColor, modsForEntity, rectCorners, resolveDimAnchor, rotateEntitiesInSketch, translateEntitiesInSketch, translateEntityInSketch } from '../core/sketchGeometry';
import type { CornerMod } from '../types';
import { formatNum } from './SidePanel';
import type { Vec2 } from '../types';

/* ---------- Expression input ---------- */

export function ExprInput({
  label,
  value,
  params,
  onCommit,
  autoFocus,
}: {
  label: string;
  value: string;
  params: Params;
  onCommit: (v: string) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const v = tryEval(text, params);
  const commit = () => {
    if (text !== value && v !== null) onCommit(text);
    else if (v === null) setText(value);
  };
  return (
    <div className="field">
      <span className="flabel">{label}</span>
      <input
        className={v === null ? 'invalid' : ''}
        value={text}
        autoFocus={autoFocus}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setText(value);
        }}
      />
      <div className="hint">{v === null ? 'Invalid expression' : `= ${formatNum(v)}`}</div>
    </div>
  );
}

function NumInput({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <div className="field">
      <span className="flabel">{label}</span>
      <input
        value={text}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = parseFloat(text);
          if (isFinite(v)) onCommit(v);
          else setText(String(value));
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

function EdgeControls({
  edge,
  params,
  onChange,
}: {
  edge?: { kind: EdgeKind; size: string };
  params: Params;
  onChange: (edge?: { kind: EdgeKind; size: string }) => void;
}) {
  return (
    <>
      <div className="props-sub">Edge treatment</div>
      <div className="field-row">
        <select
          value={edge?.kind ?? 'none'}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === 'none' ? undefined : { kind: v as EdgeKind, size: edge?.size ?? '2' });
          }}
        >
          <option value="none">None</option>
          <option value="fillet">Fillet</option>
          <option value="chamfer">Chamfer</option>
        </select>
        {edge && (
          <ExprInput label="" value={edge.size} params={params} onCommit={(v) => onChange({ ...edge, size: v })} />
        )}
      </div>
    </>
  );
}

/* ---------- Thread presets ---------- */

// Map camelCase dim keys to human-readable labels for the primitives editor.
// Falls back to capitalising the key (the legacy behaviour) for anything not
// listed here, so non-thread primitives still display nicely.
const DIM_LABELS: Record<string, string> = {
  outerDiameter: 'Outer diameter',
  pitch: 'Pitch',
  threadDepth: 'Thread depth',
  height: 'Height',
  bulbDiameter: 'Bulb diameter',
  wallThickness: 'Wall thickness',
  headDiameter: 'Head diameter',
  headHeight: 'Head height',
  outerSize: 'Hex flat-to-flat',
};

export function prettyDimLabel(key: string): string {
  return DIM_LABELS[key] ?? key[0].toUpperCase() + key.slice(1);
}

/** Quick-pick row that drops standardised thread dimensions into the feature's
 *  `dims` map. Edison shapes (bulb screw / socket) get IEC bulb sizes; bolt
 *  shapes get ISO metric coarse sizes. "Custom" leaves whatever the user has
 *  typed alone. The select goes back to "Custom" automatically whenever the
 *  current dims don't match any preset exactly — so editing any field clears
 *  the preset indicator. */
function ThreadPresetPicker({
  shape,
  dims,
  onApply,
}: {
  shape: PrimitiveShape;
  dims: Record<string, string>;
  onApply: (d: Record<string, string>) => void;
}) {
  const presets: ThreadPreset[] = isEdisonThread(shape) ? BULB_PRESETS : BOLT_PRESETS;
  // Detect whether current dims match a preset (string compare on the three
  // shared fields). If yes, show that preset in the dropdown.
  const matched = presets.find(
    (p) =>
      dims.outerDiameter === String(p.outerDiameter) &&
      dims.pitch === String(p.pitch) &&
      dims.threadDepth === String(p.threadDepth),
  );
  return (
    <div className="field">
      <span className="flabel">Standard</span>
      <select
        value={matched?.id ?? 'custom'}
        onChange={(e) => {
          const id = e.target.value;
          if (id === 'custom') return; // no-op — keeps user values
          const p = presets.find((pr) => pr.id === id);
          if (!p) return;
          onApply({
            outerDiameter: String(p.outerDiameter),
            pitch: String(p.pitch),
            threadDepth: String(p.threadDepth),
          });
        }}
      >
        <option value="custom">Custom</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <div className="hint">
        {isEdisonThread(shape)
          ? 'IEC 60061 Edison series — rounded thread profile'
          : 'ISO 261 metric coarse — 60° V profile'}
      </div>
    </div>
  );
}

/* ---------- Panel ---------- */

export function PropertiesPanel({ params, bodies }: { params: Params; bodies: BodyOut[] }) {
  const s = useStore();
  const feature = s.doc.features.find((f) => f.id === s.selectedFeatureId);

  // Assembly mode: joints + links editor.
  if (s.mode === 'assembly') {
    return (
      <div className="props-panel" key="assembly">
        <AssemblyProps params={params} />
      </div>
    );
  }

  // Sketch entity selected?
  if (s.mode === 'sketch' && s.activeSketchId) {
    const sketch = s.doc.features.find((f) => f.id === s.activeSketchId) as SketchFeature | undefined;
    if (sketch) {
      // Multi-select: more than one entity selected
      if (s.selectedEntityIds.length > 1) {
        return (
          <div className="props-panel" key={`${sketch.id}:multi:${s.selectedEntityIds.length}`}>
            <MultiSelectPanel sketch={sketch} ids={s.selectedEntityIds} params={params} />
          </div>
        );
      }
      const ent = sketch.entities.find((e) => e.id === s.selectedEntityId);
      return (
        <div className="props-panel" key={`${sketch.id}:${ent?.id ?? 'none'}`}>
          {ent ? (
            <EntityProps sketch={sketch} entId={ent.id} params={params} />
          ) : (
            <SketchProps sketch={sketch} params={params} />
          )}
        </div>
      );
    }
  }

  return (
    <div className="props-panel" key={feature?.id ?? 'none'}>
      {!feature ? (
        <div className="empty-note">Nothing selected. Click a body in the viewport or a feature in the tree.</div>
      ) : (
        <FeatureProps feature={feature} params={params} bodies={bodies} />
      )}
    </div>
  );
}

function CommonHeader({ feature }: { feature: Feature }) {
  const s = useStore();
  const [text, setText] = useState(feature.name);
  useEffect(() => setText(feature.name), [feature.name]);

  const trimmed = text.trim();
  const duplicate = s.doc.features.some((f) => f.id !== feature.id && f.name.trim() === trimmed);
  const invalid = !trimmed || duplicate;

  const commit = () => {
    if (!invalid && trimmed !== feature.name) {
      s.updateFeature(feature.id, (f) => ({ ...f, name: trimmed }));
    } else if (invalid) {
      setText(feature.name); // revert
    }
  };

  return (
    <>
      <div className="props-title">{feature.type.toUpperCase()}</div>
      <div className="field">
        <span className="flabel">Name</span>
        <input
          className={invalid ? 'invalid' : ''}
          value={text}
          title={duplicate ? 'Another feature already has this name' : !trimmed ? 'Name cannot be empty' : feature.name}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setText(feature.name);
          }}
        />
        {invalid && <div className="hint" style={{ color: 'var(--error)' }}>
          {duplicate ? 'Name already in use — will revert' : 'Name cannot be empty — will revert'}
        </div>}
      </div>
    </>
  );
}

function ColourField({
  feature,
  label,
  showOpacity = true,
}: {
  feature: ExtrudeFeature | PrimitiveFeature | ImportFeature | BooleanFeature;
  label?: string;
  /** When false, omit the opacity slider — used by bulb screws so the slider
   *  lives on the bulb-glass row below (where it visually belongs). */
  showOpacity?: boolean;
}) {
  const s = useStore();
  const opacity = feature.opacity ?? 1;
  return (
    <div className="field">
      <span className="flabel">{label ?? (showOpacity ? 'Colour & opacity' : 'Colour')}</span>
      <div className="colour-row">
        <input
          type="color"
          value={feature.color}
          onChange={(e) => s.updateFeature(feature.id, (f) => ({ ...f, color: e.target.value }) as Feature)}
        />
        {showOpacity && (
          <>
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={Math.round(opacity * 100)}
              title={`Opacity ${Math.round(opacity * 100)}%`}
              onChange={(e) =>
                s.updateFeature(feature.id, (f) => ({ ...f, opacity: Number(e.target.value) / 100 }) as Feature)
              }
            />
            <span className="pval">{Math.round(opacity * 100)}%</span>
          </>
        )}
      </div>
    </div>
  );
}

/* (per-object boolean ops were replaced by the Merge tool in the toolbar) */

function FeatureProps({ feature, params, bodies }: { feature: Feature; params: Params; bodies: BodyOut[] }) {
  const s = useStore();
  const up = (fn: (f: Feature) => Feature) => s.updateFeature(feature.id, fn);

  if (feature.type === 'sketch') {
    return (
      <>
        <CommonHeader feature={feature} />
        {feature.customPlane ? (
          <div className="field">
            <span className="flabel">Plane</span>
            <span style={{ fontSize: 11, opacity: 0.7, padding: '2px 0' }}>Face (custom)</span>
          </div>
        ) : (
          <>
            <div className="field">
              <span className="flabel">Plane</span>
              <select value={feature.plane} onChange={(e) => up((f) => ({ ...f, plane: e.target.value }) as Feature)}>
                <option value="XZ">Top (XZ)</option>
                <option value="XY">Front (XY)</option>
                <option value="YZ">Right (YZ)</option>
              </select>
            </div>
            <ExprInput
              label="Plane offset"
              value={feature.offset}
              params={params}
              onCommit={(v) => up((f) => ({ ...f, offset: v }) as Feature)}
            />
          </>
        )}
        <button onClick={() => s.enterSketch(feature.id)} style={{ width: '100%' }}>
          ✎ Edit sketch
        </button>
      </>
    );
  }

  if (feature.type === 'extrude') {
    const sourceSketch = s.doc.features.find((f) => f.id === feature.sketchId);
    const detach = () => {
      const body = bodies.find((b) => b.featureId === feature.id);
      if (!body || !body.geometry.getAttribute('position')?.count) {
        alert('Cannot detach — the extrude has no valid geometry. Fix any errors first.');
        return;
      }
      if (!window.confirm(
        `Detach "${feature.name}" from sketch "${sourceSketch?.name ?? '?'}"?\n\n` +
        `The current shape will be baked into a free-form body that can be moved and rotated freely. ` +
        `It will no longer update when the sketch changes.`
      )) return;
      importCache.set(feature.id, body.geometry.clone());
      const baked: ImportFeature = {
        id: feature.id,
        type: 'import',
        name: feature.name,
        visible: feature.visible,
        fileName: `${feature.name} (detached)`,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: 1,
        color: feature.color,
        opacity: feature.opacity,
        embedded: true,
      };
      s.setDoc({
        ...s.doc,
        features: s.doc.features.map((x) => (x.id === feature.id ? baked : x)),
      });
    };
    return (
      <>
        <CommonHeader feature={feature} />
        <div className="props-sub">🔒 Locked to sketch</div>
        <div className="field-row" style={{ alignItems: 'center' }}>
          <div className="hint" style={{ flex: 1 }}>
            {sourceSketch ? sourceSketch.name : '⚠ source sketch missing'}
          </div>
          {sourceSketch && (
            <button
              className="mini"
              title={`Edit sketch "${sourceSketch.name}"`}
              onClick={() => s.enterSketch(sourceSketch.id)}
              style={{ fontSize: 13 }}
            >
              ✎
            </button>
          )}
        </div>
        <button
          style={{ width: '100%', marginBottom: 8 }}
          title="Bake current shape into a free-form body that can be moved and rotated independently of the sketch"
          onClick={detach}
        >
          🔓 Detach from sketch
        </button>
        <div className="hint" style={{ marginTop: -4, marginBottom: 8 }}>
          Once detached, the body becomes free-form (like a primitive or import) and stops following
          sketch changes. The shape is saved with the project file.
        </div>

        <ExprInput
          label="Distance"
          value={feature.distance}
          params={params}
          autoFocus
          onCommit={(v) => up((f) => ({ ...f, distance: v }) as Feature)}
        />
        <ExprInput
          label="Offset (height above plane)"
          value={feature.offset ?? '0'}
          params={params}
          onCommit={(v) => up((f) => ({ ...f, offset: v }) as Feature)}
        />
        <div className="hint" style={{ marginTop: -4, marginBottom: 8 }}>
          Perpendicular start height: the extrude begins this far along the sketch
          plane normal (0 = flush with the plane).
        </div>
        <div className="field">
          <span className="flabel">Profiles</span>
          <div className="hint">
            {feature.regionPts?.length
              ? `${feature.regionPts.length} selected region${feature.regionPts.length > 1 ? 's' : ''}`
              : 'All closed profiles in the sketch'}
          </div>
        </div>
        <EdgeControls
          edge={feature.edge}
          params={params}
          onChange={(edge) => up((f) => ({ ...f, edge }) as Feature)}
        />
        <ColourField feature={feature} />
      </>
    );
  }

  if (feature.type === 'primitive') {
    const dimKeys = Object.keys(feature.dims);
    const isThread = THREAD_SHAPES.has(feature.shape);
    return (
      <>
        <CommonHeader feature={feature} />
        {isThread && (
          <ThreadPresetPicker
            shape={feature.shape}
            dims={feature.dims}
            onApply={(d) =>
              up((f) => ({ ...f, dims: { ...(f as PrimitiveFeature).dims, ...d } }) as Feature)
            }
          />
        )}
        {dimKeys.map((k, i) => (
          <ExprInput
            key={k}
            label={prettyDimLabel(k)}
            value={feature.dims[k]}
            params={params}
            autoFocus={i === 0}
            onCommit={(v) => up((f) => ({ ...f, dims: { ...(f as PrimitiveFeature).dims, [k]: v } }) as Feature)}
          />
        ))}
        <div className="props-sub">Placement</div>
        <div className="field-row">
          {(['X', 'Y', 'Z'] as const).map((axis, i) => (
            <ExprInput
              key={axis}
              label={axis}
              value={feature.position[i]}
              params={params}
              onCommit={(v) =>
                up((f) => {
                  const pos = [...(f as PrimitiveFeature).position] as [string, string, string];
                  pos[i] = v;
                  return { ...f, position: pos } as Feature;
                })
              }
            />
          ))}
        </div>
        <div className="field-row">
          {(['RX', 'RY', 'RZ'] as const).map((axis, i) => (
            <ExprInput
              key={axis}
              label={`${axis} (deg)`}
              value={feature.rotation[i]}
              params={params}
              onCommit={(v) =>
                up((f) => {
                  const rot = [...(f as PrimitiveFeature).rotation] as [string, string, string];
                  rot[i] = v;
                  return { ...f, rotation: rot } as Feature;
                })
              }
            />
          ))}
        </div>
        {(feature.shape === 'box' || feature.shape === 'cylinder') && (
          <EdgeControls edge={feature.edge} params={params} onChange={(edge) => up((f) => ({ ...f, edge }) as Feature)} />
        )}
        <ColourField
          feature={feature}
          label={feature.shape === 'bulbScrew' ? 'Cap colour & opacity' : undefined}
        />
        {feature.shape === 'bulbScrew' && (
          <div className="field">
            <span className="flabel">Bulb glass &amp; opacity</span>
            <div className="colour-row">
              <input
                type="color"
                value={feature.secondaryColor ?? '#f4e6a8'}
                onChange={(e) =>
                  up((f) => ({ ...f, secondaryColor: e.target.value }) as Feature)
                }
              />
              <input
                type="range"
                min={5}
                max={100}
                step={5}
                value={Math.round((feature.secondaryOpacity ?? 1) * 100)}
                title={`Glass opacity ${Math.round((feature.secondaryOpacity ?? 1) * 100)}%`}
                onChange={(e) =>
                  up((f) => ({ ...f, secondaryOpacity: Number(e.target.value) / 100 }) as Feature)
                }
              />
              <span className="pval">{Math.round((feature.secondaryOpacity ?? 1) * 100)}%</span>
            </div>
          </div>
        )}
      </>
    );
  }

  if (feature.type === 'boolean') {
    const A = s.doc.features.find((f) => f.id === feature.targetId);
    const B = s.doc.features.find((f) => f.id === feature.toolId);
    return (
      <>
        <CommonHeader feature={feature} />
        <div className="field">
          <span className="flabel">Operation</span>
          <select value={feature.op} onChange={(e) => up((f) => ({ ...f, op: e.target.value as MergeOp }) as Feature)}>
            <option value="cut">Cut (A − B)</option>
            <option value="fuse">Fuse (A + B)</option>
            <option value="intersect">Intersect (A ∩ B)</option>
          </select>
        </div>
        <div className="field">
          <span className="flabel">A{feature.op === 'cut' ? ' (kept)' : ''}</span>
          <div className="hint">{A?.name ?? '⚠ missing'}</div>
        </div>
        <div className="field">
          <span className="flabel">B{feature.op === 'cut' ? ' (removed)' : ''}</span>
          <div className="hint">{B?.name ?? '⚠ missing'}</div>
        </div>
        {feature.op === 'cut' && (
          <button
            style={{ width: '100%', marginBottom: 8 }}
            title="Fuse and intersect give the same result either way — order only matters for cut"
            onClick={() =>
              up((f) => {
                const bf = f as BooleanFeature;
                return { ...bf, targetId: bf.toolId, toolId: bf.targetId } as Feature;
              })
            }
          >
            ⇄ Swap A / B
          </button>
        )}
        <button
          style={{ width: '100%', marginBottom: 8 }}
          title="Copies the current merge result into a standalone body that no longer depends on A, B, or this merge"
          onClick={() => {
            const body = bodies.find((b) => b.featureId === feature.id);
            if (!body || !body.geometry.getAttribute('position')?.count) {
              alert('The merge result is not available — fix its errors first.');
              return;
            }
            const id = uid();
            importCache.set(id, body.geometry.clone());
            const baked: ImportFeature = {
              id,
              type: 'import',
              name: nextName(s.doc, 'Body'),
              visible: true,
              fileName: `${feature.name} (baked)`,
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: 1,
              color: feature.color,
              opacity: feature.opacity,
              embedded: true,
            };
            s.addFeature(baked);
          }}
        >
          ⎘ Create independent body
        </button>
        <div className="hint" style={{ marginTop: -4, marginBottom: 8 }}>
          Bakes the current result into a standalone body — it will not follow later changes to A or B.
          The baked shape is saved with the project file.
        </div>
        <ColourField feature={feature} />
      </>
    );
  }

  // import
  return (
    <>
      <CommonHeader feature={feature} />
      <div className="props-sub">Placement</div>
      <div className="field-row">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <NumInput
            key={axis}
            label={axis}
            value={feature.position[i]}
            onCommit={(v) =>
              up((f) => {
                const pos = [...(f as ImportFeature).position] as [number, number, number];
                pos[i] = v;
                return { ...f, position: pos } as Feature;
              })
            }
          />
        ))}
      </div>
      <div className="field-row">
        {(['RX', 'RY', 'RZ'] as const).map((axis, i) => (
          <NumInput
            key={axis}
            label={`${axis} (deg)`}
            value={feature.rotation[i]}
            onCommit={(v) =>
              up((f) => {
                const rot = [...(f as ImportFeature).rotation] as [number, number, number];
                rot[i] = v;
                return { ...f, rotation: rot } as Feature;
              })
            }
          />
        ))}
      </div>
      <NumInput label="Scale" value={feature.scale} onCommit={(v) => up((f) => ({ ...f, scale: v || 1 }) as Feature)} />
      <ColourField feature={feature} />
      <div className="empty-note">Tip: CAD files are often Z-up — set RX to -90 if the model lies on its side.</div>
    </>
  );
}

/* ---------- Sketch-mode panels ---------- */

/** Color-coded list of corner fillets/chamfers; dots match the markers in the viewport. */
function CornerModList({ sketch, mods, params }: { sketch: SketchFeature; mods: CornerMod[]; params: Params }) {
  const s = useStore();
  if (!mods.length) return null;
  return (
    <>
      <div className="props-sub">Corner fillets / chamfers</div>
      {mods.map((c) => (
        <div className="field-row" key={c.id} style={{ alignItems: 'flex-end' }}>
          <span className="mod-dot" style={{ background: modColor(sketch, c.id) }} title="Marker colour in the viewport" />
          <ExprInput
            label={`${c.kind} @ (${formatNum(c.at.x)}, ${formatNum(c.at.y)})`}
            value={c.size}
            params={params}
            onCommit={(v) =>
              s.updateFeature(sketch.id, (f) => ({
                ...f,
                corners: (f as SketchFeature).corners.map((x) => (x.id === c.id ? { ...x, size: v } : x)),
              }) as Feature)
            }
          />
          <button
            className="mini"
            style={{ marginBottom: 22 }}
            title="Remove"
            onClick={() =>
              s.updateFeature(sketch.id, (f) => ({
                ...f,
                corners: (f as SketchFeature).corners.filter((x) => x.id !== c.id),
              }) as Feature)
            }
          >
            ✕
          </button>
        </div>
      ))}
    </>
  );
}

/** Replace a rectangle entity with four free-standing line entities along its
 *  edges. Any corner mods (fillets / chamfers) on the rect's corners are
 *  handled as the user expects:
 *    – **chamfer** → baked into a real LineEntity between the two cut points,
 *      and the two adjacent edge lines are shortened to terminate at those
 *      cut points (no overshoot). The original chamfer CornerMod is removed.
 *    – **fillet** → kept as a CornerMod on the sketch. The new line entities
 *      share their endpoint with the fillet's position, so cornerModVisuals
 *      continues to trim them and draw the arc on top — no ArcEntity type in
 *      this MVP but the visual behaviour is preserved.
 *  Corner-mod sizes that overflow the rect dimensions are skipped (left as a
 *  hard corner) — same guard cornerModVisuals already applies. */
function SplitRectButton({
  sketch,
  rect,
  params,
}: {
  sketch: SketchFeature;
  rect: RectEntity;
  params: Params;
}) {
  const s = useStore();
  const w = tryEval(rect.width, params);
  const h = tryEval(rect.height, params);
  const disabled = !w || !h || w <= 0 || h <= 0;

  const verts = !disabled ? rectCorners(rect.corner, w!, h!, rect.rotation) : [];
  const attachedMods = sketch.corners.filter((c) =>
    verts.some((v) => dist2d(v, c.at) < 0.05),
  );
  const chamferCount = attachedMods.filter((m) => m.kind === 'chamfer').length;
  const filletCount  = attachedMods.filter((m) => m.kind === 'fillet').length;

  const split = () => {
    if (disabled) return;
    const construction = rect.construction;

    // For each corner, figure out the trim points pA (toward previous corner)
    // and pB (toward next corner). For a 90° corner both fillet and chamfer
    // have setback == size, so the geometry is identical here — the only
    // difference is whether a baked LineEntity replaces the corner (chamfer)
    // or the cornermod stays in place to draw the arc (fillet).
    const cornerInfo = verts.map((v, i) => {
      const prev = verts[(i - 1 + 4) % 4];
      const next = verts[(i + 1) % 4];
      const mod = sketch.corners.find((c) => dist2d(c.at, v) < 0.05);
      let pA = v;
      let pB = v;
      let bakedEntity: SketchEntity | undefined;
      let removeMod = false;
      if (mod) {
        const size = tryEval(mod.size, params);
        // Same setback overflow guard cornerCut / cornerModVisuals use.
        const distA = dist2d(prev, v);
        const distB = dist2d(next, v);
        if (size !== null && size > 0 && size < distA * 0.95 && size < distB * 0.95) {
          const uA = { x: (prev.x - v.x) / distA, y: (prev.y - v.y) / distA };
          const uB = { x: (next.x - v.x) / distB, y: (next.y - v.y) / distB };
          pA = { x: v.x + uA.x * size, y: v.y + uA.y * size };
          pB = { x: v.x + uB.x * size, y: v.y + uB.y * size };
          if (mod.kind === 'chamfer') {
            bakedEntity = { id: uid(), kind: 'line', construction, p1: pA, p2: pB };
            removeMod = true;
          } else {
            // Fillet → bake a real ArcEntity. For a 90° corner the arc centre
            // sits at corner + r·(uA + uB) (= corner + r·bisector·√2) and the
            // tangent points pA / pB are at distance r from corner along each
            // edge — exactly the setback we computed above.
            const center = { x: v.x + size * (uA.x + uB.x), y: v.y + size * (uA.y + uB.y) };
            const startDeg = (Math.atan2(pA.y - center.y, pA.x - center.x) * 180) / Math.PI;
            const endDeg   = (Math.atan2(pB.y - center.y, pB.x - center.x) * 180) / Math.PI;
            bakedEntity = {
              id: uid(),
              kind: 'arc',
              construction,
              center,
              radius: String(Math.round(size * 1000) / 1000),
              startAngle: String(Math.round(startDeg * 1000) / 1000),
              endAngle:   String(Math.round(endDeg   * 1000) / 1000),
            };
            removeMod = true;
          }
        }
      }
      return { mod, pA, pB, bakedEntity, removeMod };
    });

    // Build four rect-derived line entities — each edge runs from the cut
    // point on its "B" side of corner i to the cut point on the "A" side of
    // corner i+1.
    const edgeLines: LineEntity[] = [];
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      edgeLines.push({
        id: uid(),
        kind: 'line',
        construction,
        p1: cornerInfo[i].pB,
        p2: cornerInfo[next].pA,
      });
    }
    const bakedEntities = cornerInfo
      .map((c) => c.bakedEntity)
      .filter((e): e is SketchEntity => e !== undefined);
    const removedModIds = new Set(
      cornerInfo.filter((c) => c.removeMod && c.mod).map((c) => c.mod!.id),
    );

    s.updateFeature(sketch.id, (f) => ({
      ...f,
      entities: [
        ...(f as SketchFeature).entities.filter((e) => e.id !== rect.id),
        ...edgeLines,
        ...bakedEntities,
      ],
      corners: (f as SketchFeature).corners.filter((c) => !removedModIds.has(c.id)),
    }) as Feature);
    s.select(sketch.id, edgeLines[0].id);
  };

  return (
    <>
      <button
        style={{ width: '100%', marginTop: 4, marginBottom: 8 }}
        disabled={disabled}
        title={disabled ? 'Rectangle has invalid dimensions' : 'Explode this rectangle into separate line / arc entities.'}
        onClick={split}
      >
        ⤲ Split into lines
      </button>
      {attachedMods.length > 0 && (
        <div className="hint" style={{ marginTop: -4, marginBottom: 8 }}>
          {chamferCount > 0 && (
            <>
              {chamferCount} chamfer{chamferCount > 1 ? 's' : ''} → line
              entit{chamferCount > 1 ? 'ies' : 'y'}.
            </>
          )}
          {chamferCount > 0 && filletCount > 0 && <> </>}
          {filletCount > 0 && (
            <>
              {filletCount} fillet{filletCount > 1 ? 's' : ''} → arc
              entit{filletCount > 1 ? 'ies' : 'y'}.
            </>
          )}
          {' '}Adjacent edges shorten to terminate at the cut points; the
          original corner mods are removed.
        </div>
      )}
    </>
  );
}

/** Editor for a DimensionEntity. Shows the live measured distance (resolved
 *  through the entity's anchor points when present), a Label override field,
 *  and the perpendicular offset of the dim line — the same value the drag
 *  handle on the canvas modifies. */
function DimensionProps({
  dim,
  sketch,
  params,
  upEnt,
}: {
  dim: DimensionEntity;
  sketch: SketchFeature;
  params: Params;
  upEnt: (fn: (e: SketchEntity) => SketchEntity) => void;
}) {
  const [text, setText] = useState(dim.label ?? '');
  useEffect(() => setText(dim.label ?? ''), [dim.label]);

  const ep1 = (dim.p1Anchor && resolveDimAnchor(dim.p1Anchor, sketch, params)) ?? dim.p1;
  const ep2 = (dim.p2Anchor && resolveDimAnchor(dim.p2Anchor, sketch, params)) ?? dim.p2;
  const measured = dist2d(ep1, ep2);

  const commitLabel = () => {
    const v = text.trim();
    upEnt((e) => {
      const next = { ...e } as DimensionEntity;
      if (v) next.label = v;
      else delete next.label;
      return next as typeof e;
    });
  };

  const describeAnchor = (a?: DimensionEntity['p1Anchor']) => {
    if (!a) return 'free point';
    const ent = sketch.entities.find((x) => x.id === a.entityId);
    const name = ent ? ent.kind : '(deleted)';
    if (a.kind === 'endpoint') return `${name} · ${a.which ?? 'p1'}`;
    if (a.kind === 'corner') return `${name} · corner ${a.index ?? 0}`;
    if (a.kind === 'edgemid') return `${name} · edge ${a.index ?? 0} mid`;
    return `${name} · ${a.kind}`;
  };

  return (
    <>
      <div className="field">
        <span className="flabel">Label override</span>
        <input
          value={text}
          placeholder={`(auto: ${measured.toFixed(2)})`}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setText(dim.label ?? '');
          }}
        />
        <div className="hint">
          Leave blank to show the measured distance.
          Use <code>{'{}'}</code> as a placeholder — e.g.&nbsp;
          <code>{'width = {} mm'}</code> renders as
          {' '}<code>{`width = ${measured.toFixed(2)} mm`}</code>.
        </div>
      </div>

      <NumInput
        label="Offset"
        value={Math.round(dim.offset * 1000) / 1000}
        onCommit={(v) => upEnt((e) => ({ ...e, offset: v }) as typeof e)}
      />
      <div className="hint" style={{ marginTop: -4, marginBottom: 8 }}>
        Or drag the dim label on the canvas.
      </div>

      <div className="props-sub">Measurement</div>
      <table className="status-table" style={{ marginBottom: 10, fontSize: 11 }}>
        <tbody>
          <tr><td style={{ color: 'var(--muted)', paddingRight: 8 }}>Distance</td><td><strong>{measured.toFixed(3)}</strong></td></tr>
          <tr><td style={{ color: 'var(--muted)', paddingRight: 8 }}>P1</td><td>{describeAnchor(dim.p1Anchor)}</td></tr>
          <tr><td style={{ color: 'var(--muted)', paddingRight: 8 }}>P2</td><td>{describeAnchor(dim.p2Anchor)}</td></tr>
        </tbody>
      </table>
    </>
  );
}

/** Circle / ellipse property block. Default mode shows just Radius; toggling
 *  "Oval" exposes a separate Y-radius so the entity becomes an axis-aligned
 *  ellipse. Setting Y back to the X expression reverts to a true circle. */
function CircleProps({
  circle,
  params,
  upEnt,
}: {
  circle: CircleEntity;
  params: Params;
  upEnt: (fn: (e: SketchEntity) => SketchEntity) => void;
}) {
  const isOval = circle.radiusY !== undefined;
  return (
    <>
      <ExprInput
        label={isOval ? 'X radius' : 'Radius'}
        value={circle.radius}
        params={params}
        autoFocus
        onCommit={(v) => upEnt((e) => ({ ...e, radius: v }) as typeof e)}
      />
      {isOval && (
        <ExprInput
          label="Y radius"
          value={circle.radiusY ?? circle.radius}
          params={params}
          onCommit={(v) => upEnt((e) => ({ ...e, radiusY: v }) as typeof e)}
        />
      )}
      <label className="check" style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={isOval}
          onChange={(e) => {
            if (e.target.checked) {
              upEnt((c) => ({ ...c, radiusY: circle.radius }) as typeof c);
            } else {
              upEnt((c) => {
                const next = { ...c } as CircleEntity;
                delete next.radiusY;
                return next as typeof c;
              });
            }
          }}
        />
        Oval (independent Y radius)
      </label>
    </>
  );
}

/** Cog editor — outer radius, integer tooth count, inner (root) radius.
 *  Outer radius is the "circle" the user dragged out; the tooth fields default
 *  to sensible values when the cog lands but live here so the user can dial in
 *  whatever profile they want. */
/** Integer input for the cog's tooth count. Mirrors ExprInput's UX so the
 *  user can highlight + retype without the field auto-clamping mid-edit:
 *  local string state, red `invalid` border while the value can't parse,
 *  commit on blur (Enter) when valid, restore to the last good value when
 *  blurring while invalid (or on Escape). */
function CogTeethInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  // Treat the field as invalid while it can't yet describe an integer ≥ 3 —
  // that lets the user delete the existing digits and type a new number
  // without the field snapping back at every keystroke.
  const trimmed = text.trim();
  const parsed = /^-?\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
  const valid = Number.isFinite(parsed) && parsed >= 3;
  const commit = () => {
    if (valid && parsed !== value) onCommit(parsed);
    else if (!valid) setText(String(value));
  };
  return (
    <div className="field">
      <span className="flabel">Teeth</span>
      <input
        className={valid ? '' : 'invalid'}
        inputMode="numeric"
        value={text}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setText(String(value));
        }}
      />
      <div className="hint">{valid ? `${parsed} teeth` : 'Enter a whole number, 3 or more'}</div>
    </div>
  );
}

function CogProps({
  cog,
  params,
  upEnt,
}: {
  cog: CogEntity;
  params: Params;
  upEnt: (fn: (e: SketchEntity) => SketchEntity) => void;
}) {
  const outerVal = tryEval(cog.outerRadius, params);
  const profile: CogProfile = cog.profile ?? 'square';
  return (
    <>
      <label style={{ display: 'block', marginBottom: 8 }}>
        <div style={{ marginBottom: 2, fontSize: 12, color: 'var(--text-dim, #9aa1ad)' }}>Tooth profile</div>
        <select
          value={profile}
          onChange={(e) => {
            const next = e.target.value as CogProfile;
            upEnt((c) => ({ ...c, profile: next }) as typeof c);
          }}
          style={{ width: '100%' }}
        >
          <option value="pointy">Pointy (star)</option>
          <option value="trapezoid">Trapezoid (gear)</option>
          <option value="square">Square (block)</option>
        </select>
      </label>
      <ExprInput
        label="Outer radius"
        value={cog.outerRadius}
        params={params}
        autoFocus
        onCommit={(v) => upEnt((e) => ({ ...e, outerRadius: v }) as typeof e)}
      />
      <ExprInput
        label="Inner radius"
        value={cog.innerRadius}
        params={params}
        onCommit={(v) => upEnt((e) => ({ ...e, innerRadius: v }) as typeof e)}
      />
      <CogTeethInput
        value={cog.teeth}
        onCommit={(n) => upEnt((c) => ({ ...c, teeth: n }) as typeof c)}
      />
      <div className="hint" style={{ marginTop: -4, marginBottom: 8 }}>
        {outerVal !== null && outerVal > 0
          ? `Outer ${outerVal.toFixed(2)} · tooth height ${(outerVal - (tryEval(cog.innerRadius, params) ?? 0)).toFixed(2)}`
          : 'Set the outer radius first.'}
      </div>
    </>
  );
}

function SketchProps({ sketch, params }: { sketch: SketchFeature; params: Params }) {
  const s = useStore();
  // Count construction entities so the user knows what the toggle will hide.
  const constructionCount = sketch.entities.filter((e) =>
    'construction' in e && (e as { construction?: boolean }).construction,
  ).length;

  // Editable sketch name (mirrors CommonHeader used in model mode).
  const [nameText, setNameText] = useState(sketch.name);
  useEffect(() => setNameText(sketch.name), [sketch.name]);
  const trimmed = nameText.trim();
  const duplicate = s.doc.features.some((f) => f.id !== sketch.id && f.name.trim() === trimmed);
  const invalidName = !trimmed || duplicate;
  const commitName = () => {
    if (!invalidName && trimmed !== sketch.name) s.updateFeature(sketch.id, (f) => ({ ...f, name: trimmed }));
    else if (invalidName) setNameText(sketch.name);
  };

  return (
    <>
      <div className="props-title">SKETCH</div>
      <div className="field">
        <span className="flabel">Name</span>
        <input
          className={invalidName ? 'invalid' : ''}
          value={nameText}
          title={duplicate ? 'Another feature already has this name' : !trimmed ? 'Name cannot be empty' : sketch.name}
          onChange={(e) => setNameText(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setNameText(sketch.name);
          }}
        />
        {invalidName && (
          <div className="hint" style={{ color: 'var(--error)' }}>
            {duplicate ? 'Name already in use — will revert' : 'Name cannot be empty — will revert'}
          </div>
        )}
      </div>
      <button
        onClick={() => s.exitSketch()}
        style={{ width: '100%', marginBottom: 10 }}
        title="Exit sketch mode and return to the 3D view"
      >
        ✓ Finish Sketch
      </button>
      <label className="check" style={{ marginBottom: 10, display: 'flex' }}>
        <input
          type="checkbox"
          checked={s.showConstruction}
          onChange={(e) => s.setShowConstruction(e.target.checked)}
        />
        <span>Show construction lines{constructionCount > 0 ? ` (${constructionCount})` : ''}</span>
      </label>
      {s.tool === 'measure' && <MeasureReadout />}
      {s.tool === 'offset' && (
        <div className="empty-note" style={{ marginBottom: 10 }}>
          <strong>Offset:</strong> click an entity, then enter a distance.
          Positive distance offsets outward (lines: to the left of p1→p2);
          negative shrinks the entity.
        </div>
      )}
      {s.tool === 'dimension' && (
        <div className="empty-note" style={{ marginBottom: 10 }}>
          <strong>Dimension:</strong> click two points to drop a linear dimension.
          The dim line sits perpendicular to the segment between the picks.
        </div>
      )}
      <div className="empty-note">
        Draw with the tools above. Type a number while drawing to set the dimension exactly (expressions allowed).
        Click an entity with Select to edit it — its fillets / chamfers live on
        the containing rectangle (or get baked into arc / line entities on
        Split) and are no longer surfaced here.
      </div>
    </>
  );
}

/** Live readout of the Measure-tool picks. Shows current distance, dx, dy
 *  whenever at least one point has been clicked. */
function MeasureReadout() {
  const m = useStore((s) => s.measureState);
  if (!m.p1) {
    return (
      <div className="empty-note" style={{ marginBottom: 10 }}>
        <strong>Measure:</strong> click two points to read out their distance.
      </div>
    );
  }
  if (!m.p2) {
    return (
      <>
        <div className="props-sub">Measurement</div>
        <div className="hint" style={{ marginBottom: 10 }}>
          From&nbsp;
          <code>x {m.p1.x.toFixed(2)}, y {m.p1.y.toFixed(2)}</code>
          &nbsp;— click second point.
        </div>
      </>
    );
  }
  const dx = m.p2.x - m.p1.x;
  const dy = m.p2.y - m.p1.y;
  const len = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (
    <>
      <div className="props-sub">Measurement</div>
      <table className="status-table" style={{ marginBottom: 10, fontSize: 11 }}>
        <tbody>
          <tr><td style={{ color: 'var(--muted)', paddingRight: 8 }}>Distance</td><td><strong>{len.toFixed(3)}</strong></td></tr>
          <tr><td style={{ color: 'var(--muted)', paddingRight: 8 }}>Δ X</td><td>{dx.toFixed(3)}</td></tr>
          <tr><td style={{ color: 'var(--muted)', paddingRight: 8 }}>Δ Y</td><td>{dy.toFixed(3)}</td></tr>
          <tr><td style={{ color: 'var(--muted)', paddingRight: 8 }}>Angle</td><td>{angle.toFixed(2)}°</td></tr>
          <tr><td style={{ color: 'var(--muted)', paddingRight: 8 }}>P1</td><td>({m.p1.x.toFixed(2)}, {m.p1.y.toFixed(2)})</td></tr>
          <tr><td style={{ color: 'var(--muted)', paddingRight: 8 }}>P2</td><td>({m.p2.x.toFixed(2)}, {m.p2.y.toFixed(2)})</td></tr>
        </tbody>
      </table>
    </>
  );
}

/** Two numeric fields editing a 2D point. */
function PointFields({ label, p, onCommit }: { label: string; p: Vec2; onCommit: (p: Vec2) => void }) {
  return (
    <>
      <div className="props-sub">{label}</div>
      <div className="field-row">
        <NumInput label="X" value={Math.round(p.x * 1000) / 1000} onCommit={(v) => onCommit({ x: v, y: p.y })} />
        <NumInput label="Y" value={Math.round(p.y * 1000) / 1000} onCommit={(v) => onCommit({ x: p.x, y: v })} />
      </div>
    </>
  );
}

/** Offset (ΔX/ΔY), Dynamic Move, Rotate angle + Rotate button, Dynamic Rotate. Shared by single-entity, multi-select, and image panels. */
function MoveRotateBlock({ sketch, entIds, params }: { sketch: SketchFeature; entIds: string[]; params: Params }) {
  const s = useStore();
  const [dx, setDx] = useState('0');
  const [dy, setDy] = useState('0');
  const [deg, setDeg] = useState('0');
  const vx = tryEval(dx, params);
  const vy = tryEval(dy, params);
  const vd = tryEval(deg, params);

  // Rotation origin — single-entity selections use the entity's natural pivot
  // so the rotation reads intuitively:
  //   • circle / ellipse → its centre (so ovals spin in place)
  //   • rect / image     → its corner anchor (the visible bottom-left)
  //   • line / dimension → the bbox bottom-left of the two endpoints
  // Multi-selections still pivot around the combined bbox bottom-left.
  const ents = sketch.entities.filter((e) => entIds.includes(e.id));
  const bounds = entitiesBounds(ents, params);
  const naturalPivot = (() => {
    if (ents.length !== 1) return null;
    const e = ents[0];
    if (e.kind === 'circle' || e.kind === 'cog' || e.kind === 'arc') return e.center;
    if (e.kind === 'rect' || e.kind === 'image') return e.corner;
    if (e.kind === 'line' || e.kind === 'dimension') {
      return { x: Math.min(e.p1.x, e.p2.x), y: Math.min(e.p1.y, e.p2.y) };
    }
    return null;
  })();
  const rotOrigin = naturalPivot ?? bounds?.min ?? { x: 0, y: 0 };

  const applyOffset = () => {
    if (vx === null || vy === null || (vx === 0 && vy === 0)) return;
    const d = { x: vx, y: vy };
    // Carry any dependent extrude's regionPts that sit inside the moved entities'
    // bbox along with the move, so the extruded face doesn't snap to a different
    // region (mirrors the interactive drag in Viewport).
    const movedEnts = sketch.entities.filter((e) => entIds.includes(e.id));
    const b = entitiesBounds(movedEnts, params);
    const pad = 1e-6;
    const inside = (p: Vec2) =>
      !!b && p.x >= b.min.x - pad && p.x <= b.max.x + pad && p.y >= b.min.y - pad && p.y <= b.max.y + pad;
    const features = s.doc.features.map((f) => {
      if (f.id === sketch.id && f.type === 'sketch') {
        return (entIds.length === 1
          ? translateEntityInSketch(f as SketchFeature, entIds[0], d, params)
          : translateEntitiesInSketch(f as SketchFeature, entIds, d, params)) as Feature;
      }
      if (f.type === 'extrude' && f.sketchId === sketch.id && f.regionPts?.length) {
        return { ...f, regionPts: f.regionPts.map((p) => (inside(p) ? { x: p.x + d.x, y: p.y + d.y } : p)) };
      }
      return f;
    });
    s.setDoc({ ...s.doc, features });
    setDx('0'); setDy('0');
  };

  const applyRotate = () => {
    if (vd === null || vd === 0) return;
    // Convention: positive typed angle = clockwise rotation (same as the
    // dynamic-rotate readout). rotatePoint is CW-positive natively.
    s.updateFeature(sketch.id, (f) =>
      rotateEntitiesInSketch(f as SketchFeature, entIds, rotOrigin, vd, params) as Feature
    );
    setDeg('0');
  };

  const startDynMove = () => {
    s.setDynamicOp({ kind: 'move', sketchId: sketch.id, entityIds: entIds, startDoc: s.doc, grabPt: null, firstAngle: null });
  };

  const startDynRotate = () => {
    s.setDynamicOp({ kind: 'rotate', sketchId: sketch.id, entityIds: entIds, startDoc: s.doc, grabPt: null, firstAngle: null });
  };

  return (
    <>
      <div className="props-sub">Offset</div>
      <div className="field-row" style={{ alignItems: 'flex-end' }}>
        <div className="field">
          <span className="flabel">ΔX</span>
          <input className={vx === null ? 'invalid' : ''} value={dx} onFocus={(e) => e.target.select()} onChange={(e) => setDx(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applyOffset()} />
        </div>
        <div className="field">
          <span className="flabel">ΔY</span>
          <input className={vy === null ? 'invalid' : ''} value={dy} onFocus={(e) => e.target.select()} onChange={(e) => setDy(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applyOffset()} />
        </div>
        <button onClick={applyOffset} disabled={vx === null || vy === null} style={{ marginBottom: 8 }}>Offset</button>
      </div>
      <button style={{ width: '100%', marginBottom: 8 }} onClick={startDynMove}>Dynamic Move</button>

      <div className="props-sub">Rotate</div>
      <div className="field-row" style={{ alignItems: 'flex-end' }}>
        <div className="field">
          <span className="flabel">Angle °</span>
          <input className={vd === null ? 'invalid' : ''} value={deg} onFocus={(e) => e.target.select()} onChange={(e) => setDeg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applyRotate()} />
        </div>
        <button onClick={applyRotate} disabled={vd === null} style={{ marginBottom: 8 }}>Rotate</button>
      </div>
      <div className="hint" style={{ marginTop: -4, marginBottom: 4 }}>
        Positive = clockwise. Single rect / line / image pivots around its
        corner; circle / ellipse around its centre.
      </div>
      <button style={{ width: '100%', marginBottom: 8 }} onClick={startDynRotate}>Dynamic Rotate</button>
    </>
  );
}

function MultiSelectPanel({ sketch, ids, params }: { sketch: SketchFeature; ids: string[]; params: Params }) {
  const s = useStore();

  const selectedEnts = sketch.entities.filter((e) => ids.includes(e.id));
  const bounds = entitiesBounds(selectedEnts, params);
  const origin = bounds?.min ?? { x: 0, y: 0 };

  // Editable origin fields — move everything so bottom-left lands at the new position
  const [ox, setOx] = useState(String(Math.round(origin.x * 1000) / 1000));
  const [oy, setOy] = useState(String(Math.round(origin.y * 1000) / 1000));
  useEffect(() => { setOx(String(Math.round(origin.x * 1000) / 1000)); }, [origin.x]);
  useEffect(() => { setOy(String(Math.round(origin.y * 1000) / 1000)); }, [origin.y]);

  const commitOrigin = (axis: 'x' | 'y', text: string) => {
    const val = parseFloat(text);
    if (!isFinite(val)) return;
    const delta = axis === 'x' ? val - origin.x : val - origin.y;
    if (Math.abs(delta) < 1e-9) return;
    const d = axis === 'x' ? { x: delta, y: 0 } : { x: 0, y: delta };
    s.updateFeature(sketch.id, (f) =>
      translateEntitiesInSketch(f as SketchFeature, ids, d, params) as Feature
    );
  };

  return (
    <>
      <div className="props-title">SELECTION</div>
      <div className="field">
        <span className="flabel">Selected</span>
        <div className="hint">{ids.length} entities</div>
      </div>
      <div className="props-sub">Origin (bottom-left)</div>
      <div className="field-row">
        <div className="field">
          <span className="flabel">X</span>
          <input
            value={ox}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setOx(e.target.value)}
            onBlur={() => commitOrigin('x', ox)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setOx(String(Math.round(origin.x * 1000) / 1000)); }}
          />
        </div>
        <div className="field">
          <span className="flabel">Y</span>
          <input
            value={oy}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setOy(e.target.value)}
            onBlur={() => commitOrigin('y', oy)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setOy(String(Math.round(origin.y * 1000) / 1000)); }}
          />
        </div>
      </div>
      <MoveRotateBlock sketch={sketch} entIds={ids} params={params} />
    </>
  );
}

function ImageProps({ sketch, entId, params }: { sketch: SketchFeature; entId: string; params: Params }) {
  const s = useStore();
  const imgRef = useRef<HTMLInputElement>(null);
  const ent = sketch.entities.find((e) => e.id === entId) as ImageEntity;

  const fmtDim = (v: number) => String(Math.round(v * 1000) / 1000);
  const ar = ent.naturalWidth > 0 && ent.naturalHeight > 0 ? ent.naturalWidth / ent.naturalHeight : 1;

  const upEnt = (fn: (e: ImageEntity) => ImageEntity) =>
    s.updateFeature(sketch.id, (f) => ({
      ...f,
      entities: (f as SketchFeature).entities.map((e) => (e.id === entId ? fn(e as ImageEntity) : e)),
    }) as Feature);

  const commitWidth = (wVal: string) => {
    const wNum = tryEval(wVal, params);
    if (wNum === null || wNum <= 0) return;
    if (ent.maintainAspect && ent.fit === 'scale') {
      upEnt((e) => ({ ...e, width: wVal, height: fmtDim(wNum / ar) }));
    } else {
      upEnt((e) => ({ ...e, width: wVal }));
    }
  };

  const commitHeight = (hVal: string) => {
    const hNum = tryEval(hVal, params);
    if (hNum === null || hNum <= 0) return;
    if (ent.maintainAspect && ent.fit === 'scale') {
      upEnt((e) => ({ ...e, width: fmtDim(hNum * ar), height: hVal }));
    } else {
      upEnt((e) => ({ ...e, height: hVal }));
    }
  };

  const replaceImage = (files: FileList | null) => {
    if (!files?.[0]) return;
    const file = files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      const img = new Image();
      img.onload = () => upEnt((e) => ({
        ...e, src, fileName: file.name,
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
      }));
      img.src = src;
    };
    reader.readAsDataURL(file);
    if (imgRef.current) imgRef.current.value = '';
  };

  const del = () =>
    s.updateFeature(sketch.id, (f) => ({
      ...f,
      entities: (f as SketchFeature).entities.filter((e) => e.id !== entId),
    }) as Feature);

  return (
    <>
      <div className="props-title">IMAGE</div>
      <div className="field">
        <span className="flabel">File</span>
        <div className="hint" style={{ wordBreak: 'break-all', fontSize: 11 }}>{ent.fileName}</div>
      </div>

      <div className="props-sub">Size</div>
      <ExprInput label="Width" value={ent.width} params={params} autoFocus onCommit={commitWidth} />
      <ExprInput label="Height" value={ent.height} params={params} onCommit={commitHeight} />

      <div className="props-sub">Position</div>
      <PointFields
        label="Corner (bottom-left)"
        p={ent.corner}
        onCommit={(p) => upEnt((e) => ({ ...e, corner: p }))}
      />

      <div className="props-sub">Display</div>
      <div className="field">
        <span className="flabel">Fit mode</span>
        <select
          value={ent.fit}
          onChange={(ev) => {
            const newFit = ev.target.value as 'scale' | 'crop';
            if (newFit === 'crop' && ent.cropScale == null) {
              // Auto-initialise cropScale to the "fill to fit" value so the first
              // view looks identical to the current scale-to-fit appearance
              const w = tryEval(ent.width, params) ?? 0;
              const h = tryEval(ent.height, params) ?? 0;
              const defaultCropScale = w > 0 && h > 0 ? Math.max(w, h * ar) : w || 100;
              upEnt((e) => ({ ...e, fit: newFit, cropScale: Math.round(defaultCropScale * 1000) / 1000 }));
            } else if (newFit === 'scale') {
              // Check if current dimensions already match the natural aspect ratio
              const w = tryEval(ent.width, params) ?? 0;
              const h = tryEval(ent.height, params) ?? 0;
              const aspectMatches = w > 0 && h > 0 && Math.abs(h - w / ar) < 0.01 * w;
              upEnt((e) => ({ ...e, fit: newFit, maintainAspect: aspectMatches }));
            } else {
              upEnt((e) => ({ ...e, fit: newFit }));
            }
          }}
        >
          <option value="scale">Scale to fit</option>
          <option value="crop">Crop to fit</option>
        </select>
      </div>

      {ent.fit === 'scale' && (
        <label className="check" style={{ margin: '4px 0' }}>
          <input
            type="checkbox"
            checked={ent.maintainAspect}
            onChange={(ev) => {
              const checked = ev.target.checked;
              if (checked) {
                // Enforce on toggle-on: keep width, recalculate height
                const wNum = tryEval(ent.width, params);
                if (wNum !== null && wNum > 0) {
                  upEnt((e) => ({ ...e, maintainAspect: true, height: fmtDim(wNum / ar) }));
                } else {
                  upEnt((e) => ({ ...e, maintainAspect: true }));
                }
              } else {
                upEnt((e) => ({ ...e, maintainAspect: false }));
              }
            }}
          />
          Maintain aspect ratio
        </label>
      )}

      {ent.fit === 'crop' && (() => {
        const w = tryEval(ent.width, params) ?? 0;
        const currentCropScale = ent.cropScale ?? (w || ent.naturalWidth || 100);
        // Display as %: 100% = 1px per sketch unit (natural size)
        const scalePercent = ent.naturalWidth > 0
          ? Math.round(currentCropScale / ent.naturalWidth * 1000) / 10
          : 100;
        const anchor = ent.cropAnchor ?? 'center';
        return (
          <>
            <NumInput
              label="Scale %"
              value={scalePercent}
              onCommit={(v) => {
                if (v > 0 && ent.naturalWidth > 0) {
                  upEnt((e) => ({ ...e, cropScale: Math.round(v / 100 * e.naturalWidth * 1000) / 1000 }));
                }
              }}
            />
            <div className="hint" style={{ marginTop: -4, marginBottom: 6 }}>
              100% = natural pixel size. &gt;100% zooms in. Rect is the crop window.
            </div>
            <div className="field">
              <span className="flabel">Alignment</span>
              <select
                value={anchor}
                onChange={(ev) => upEnt((e) => ({
                  ...e, cropAnchor: ev.target.value as ImageEntity['cropAnchor'],
                }))}
              >
                <option value="center">Centre</option>
                <option value="top-left">Top-left</option>
                <option value="top-right">Top-right</option>
                <option value="bottom-left">Bottom-left</option>
                <option value="bottom-right">Bottom-right</option>
              </select>
            </div>
            <button
              style={{ width: '100%', marginBottom: 4 }}
              title="Reset scale so image fills the rect width"
              onClick={() => { if (w > 0) upEnt((e) => ({ ...e, cropScale: Math.round(w * 1000) / 1000 })); }}
            >
              Reset scale to fill rect
            </button>
            <button
              style={{ width: '100%', marginBottom: 6 }}
              title="Show image at its natural pixel size (1px = 1 sketch unit, scale = 100%)"
              onClick={() => upEnt((e) => ({ ...e, cropScale: e.naturalWidth }))}
            >
              Show as original size
            </button>
          </>
        );
      })()}

      <div className="field">
        <span className="flabel">Opacity</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.round(ent.opacity * 100)}
            style={{ flex: 1 }}
            onChange={(ev) => upEnt((e) => ({ ...e, opacity: Number(ev.target.value) / 100 }))}
          />
          <span className="pval">{Math.round(ent.opacity * 100)}%</span>
        </div>
      </div>

      <div className="field">
        <span className="flabel">Natural size</span>
        <div className="hint">{ent.naturalWidth} × {ent.naturalHeight} px</div>
      </div>

      <button
        style={{ width: '100%', marginTop: 6 }}
        title="Set width to 100 units and height to match the image's natural aspect ratio"
        onClick={() => upEnt((e) => ({ ...e, width: '100', height: fmtDim(100 / ar) }))}
      >
        Reset to natural ratio
      </button>
      <button style={{ width: '100%', marginTop: 4 }} onClick={() => imgRef.current?.click()}>
        Replace image…
      </button>
      <input
        ref={imgRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(ev) => replaceImage(ev.target.files)}
      />

      <MoveRotateBlock sketch={sketch} entIds={[entId]} params={params} />

      <button className="danger" onClick={del} style={{ width: '100%', marginTop: 8 }}>
        Delete image
      </button>
    </>
  );
}

function EntityProps({ sketch, entId, params }: { sketch: SketchFeature; entId: string; params: Params }) {
  const s = useStore();
  const ent = sketch.entities.find((e) => e.id === entId)!;

  if (ent.kind === 'image') return <ImageProps sketch={sketch} entId={entId} params={params} />;
  const upEnt = (fn: (e: typeof ent) => typeof ent) =>
    s.updateFeature(sketch.id, (f) => ({
      ...f,
      entities: (f as SketchFeature).entities.map((e) => (e.id === entId ? fn(e as typeof ent) : e)),
    }) as Feature);

  const del = () =>
    s.updateFeature(sketch.id, (f) => ({
      ...f,
      entities: (f as SketchFeature).entities.filter((e) => e.id !== entId),
    }) as Feature);

  return (
    <>
      <div className="props-title">{ent.kind.toUpperCase()}</div>
      {ent.kind === 'line' && <LineProps line={ent} params={params} upEnt={upEnt as never} />}
      {ent.kind === 'circle' && (
        <CircleProps
          circle={ent as CircleEntity}
          params={params}
          upEnt={upEnt as never}
        />
      )}
      {ent.kind === 'cog' && (
        <CogProps
          cog={ent as CogEntity}
          params={params}
          upEnt={upEnt as never}
        />
      )}
      {ent.kind === 'arc' && (
        <>
          <ExprInput
            label="Radius"
            value={(ent as ArcEntity).radius}
            params={params}
            autoFocus
            onCommit={(v) => upEnt((e) => ({ ...e, radius: v }) as typeof ent)}
          />
          <ExprInput
            label="Start angle°"
            value={(ent as ArcEntity).startAngle}
            params={params}
            onCommit={(v) => upEnt((e) => ({ ...e, startAngle: v }) as typeof ent)}
          />
          <ExprInput
            label="End angle°"
            value={(ent as ArcEntity).endAngle}
            params={params}
            onCommit={(v) => upEnt((e) => ({ ...e, endAngle: v }) as typeof ent)}
          />
          <div className="hint" style={{ marginTop: -4, marginBottom: 8 }}>
            The arc takes the shorter of the two possible paths between the
            two angles (math/CCW convention).
          </div>
        </>
      )}
      {ent.kind === 'rect' && (
        <>
          <ExprInput
            label="Width"
            value={(ent as RectEntity).width}
            params={params}
            autoFocus
            onCommit={(v) => upEnt((e) => ({ ...e, width: v }) as typeof ent)}
          />
          <ExprInput
            label="Height"
            value={(ent as RectEntity).height}
            params={params}
            onCommit={(v) => upEnt((e) => ({ ...e, height: v }) as typeof ent)}
          />
        </>
      )}

      {/* position */}
      {ent.kind === 'line' && (
        <>
          <PointFields
            label="Start point"
            p={(ent as LineEntity).p1}
            onCommit={(p) => upEnt((e) => ({ ...e, p1: p }) as typeof ent)}
          />
          <PointFields
            label="End point"
            p={(ent as LineEntity).p2}
            onCommit={(p) => upEnt((e) => ({ ...e, p2: p }) as typeof ent)}
          />
        </>
      )}
      {ent.kind === 'circle' && (
        <PointFields
          label="Center"
          p={(ent as CircleEntity).center}
          onCommit={(p) => upEnt((e) => ({ ...e, center: p }) as typeof ent)}
        />
      )}
      {ent.kind === 'cog' && (
        <PointFields
          label="Center"
          p={(ent as CogEntity).center}
          onCommit={(p) => upEnt((e) => ({ ...e, center: p }) as typeof ent)}
        />
      )}
      {ent.kind === 'arc' && (
        <PointFields
          label="Center"
          p={(ent as ArcEntity).center}
          onCommit={(p) => upEnt((e) => ({ ...e, center: p }) as typeof ent)}
        />
      )}
      {ent.kind === 'rect' && (
        <PointFields
          label="Corner"
          p={(ent as RectEntity).corner}
          onCommit={(p) => upEnt((e) => ({ ...e, corner: p }) as typeof ent)}
        />
      )}
      {ent.kind === 'rect' && (
        <SplitRectButton sketch={sketch} rect={ent as RectEntity} params={params} />
      )}
      {ent.kind === 'dimension' && (
        <DimensionProps
          dim={ent as DimensionEntity}
          sketch={sketch}
          params={params}
          upEnt={upEnt as never}
        />
      )}

      {/* Dimensions don't participate in offset / rotate transforms — their
          position is driven by their anchor points (or fallback p1/p2). */}
      {ent.kind !== 'dimension' && (
        <MoveRotateBlock sketch={sketch} entIds={[entId]} params={params} />
      )}

      <CornerModList sketch={sketch} mods={modsForEntity(sketch, entId, params)} params={params} />

      <label className="check" style={{ margin: '6px 0' }}>
        <input
          type="checkbox"
          checked={ent.construction}
          onChange={(e) => upEnt((x) => ({ ...x, construction: e.target.checked }) as typeof ent)}
        />
        Construction geometry
      </label>
      <button className="danger" onClick={del} style={{ width: '100%', marginTop: 8 }}>
        Delete entity
      </button>
    </>
  );
}

function LineProps({
  line,
  params,
  upEnt,
}: {
  line: LineEntity;
  params: Params;
  upEnt: (fn: (e: LineEntity) => LineEntity) => void;
}) {
  const curLen = dist2d(line.p1, line.p2);
  return (
    <>
      <ExprInput
        label="Length (moves end point)"
        value={line.length ?? formatNum(curLen)}
        params={params}
        autoFocus
        onCommit={(v) => {
          const len = tryEval(v, params);
          if (len === null || len <= 0) return;
          upEnt((e) => {
            const d = dist2d(e.p1, e.p2) || 1;
            const dir = { x: (e.p2.x - e.p1.x) / d, y: (e.p2.y - e.p1.y) / d };
            return { ...e, length: v, p2: { x: e.p1.x + dir.x * len, y: e.p1.y + dir.y * len } };
          });
        }}
      />
      <div className="empty-note">
        Note: changing length moves only this line's end point; connected lines are not dragged along.
      </div>
    </>
  );
}

/* ================= Assembly properties ================= */

function fmtRange(r: Range, unit: string): string {
  const lo = r.min === null ? '−∞' : formatNum(r.min);
  const hi = r.max === null ? '∞' : formatNum(r.max);
  return `${lo} … ${hi} ${unit}`;
}

/** Small text input that commits its value on blur / Enter. */
function TextEdit({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="field">
      <span className="flabel">{label}</span>
      <input
        value={text}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const t = text.trim();
          if (t && t !== value) onCommit(t);
          else setText(value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setText(value);
        }}
      />
    </div>
  );
}

function Vec3Fields({ label, value, onChange }: { label: string; value: Vec3; onChange: (v: Vec3) => void }) {
  return (
    <>
      <div className="props-sub">{label}</div>
      <div className="field-row">
        <NumInput label="X" value={value[0]} onCommit={(x) => onChange([x, value[1], value[2]])} />
        <NumInput label="Y" value={value[1]} onCommit={(y) => onChange([value[0], y, value[2]])} />
        <NumInput label="Z" value={value[2]} onCommit={(z) => onChange([value[0], value[1], z])} />
      </div>
    </>
  );
}

function JointEditor({
  joint,
  params,
  jointValue,
  joints,
  links,
}: {
  joint: Joint;
  params: Params;
  jointValue: number;
  joints: Joint[];
  links: Link[];
}) {
  const doc = useStore((s) => s.doc);
  const update = (fn: (j: Joint) => Joint) => useStore.getState().updateJoint(joint.id, fn);
  const drive = (v: number) => useStore.getState().setJointValue(joint.id, v);
  const evalNum = (e: string) => tryEval(e, params);
  const unit = joint.type === 'revolute' ? '°' : 'mm';
  const bodies = doc.features.filter((f) => f.type !== 'sketch');
  const loopSolved = isLoopSolvedJoint(doc, joint);
  const range = resolvedRange(joint.id, joints, links, evalNum);
  const isFree = range.min === null && range.max === null;
  const lo = range.min ?? (joint.type === 'revolute' ? -180 : -100);
  const hi = range.max ?? (joint.type === 'revolute' ? 180 : 100);
  const sliderStep = (hi - lo) / 200 || 1;
  const clamped = Math.min(hi, Math.max(lo, jointValue));

  // Step size for the « / » buttons: default to ¼ of the allowed range, or 90°
  // (revolute) / 10 mm (prismatic) when the range is unbounded. Component is
  // keyed by joint id, so this initialises fresh per joint.
  const defaultStep =
    range.min !== null && range.max !== null && range.max > range.min
      ? +((range.max - range.min) / 4).toFixed(4)
      : joint.type === 'revolute'
      ? 90
      : 10;
  const [step, setStep] = useState(defaultStep);

  // Free revolute joints wrap past ±180° back to the negative side; everything
  // else relies on setJointValue's clamp to the resolved range.
  const applyStep = (delta: number) => {
    let next = jointValue + delta;
    if (isFree && joint.type === 'revolute') {
      next = ((next + 180) % 360 + 360) % 360 - 180;
    }
    drive(next);
  };

  return (
    <div className="assembly-editor" style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
      <TextEdit label="Name" value={joint.name} onCommit={(v) => update((j) => ({ ...j, name: v }))} />
      <div className="field">
        <span className="flabel">Type</span>
        <select value={joint.type} onChange={(e) => update((j) => ({ ...j, type: e.target.value as JointType }))}>
          <option value="revolute">Revolute (rotate)</option>
          <option value="prismatic">Prismatic (slide)</option>
        </select>
      </div>
      <div className="field">
        <span className="flabel">Base (relative to)</span>
        <select
          value={joint.baseFeatureId ?? ''}
          title="Ground = moves relative to the world. Pick a body to pin this joint to a moving part (e.g. a leg pinned to a crank on the wheel)."
          onChange={(e) => update((j) => ({ ...j, baseFeatureId: e.target.value || undefined }))}
        >
          <option value="">Ground</option>
          {bodies
            .filter((f) => f.id !== joint.featureId)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </select>
      </div>
      <Vec3Fields label="Origin" value={joint.origin} onChange={(v) => update((j) => ({ ...j, origin: v }))} />
      <Vec3Fields
        label={joint.type === 'revolute' ? 'Axis (rotation)' : 'Axis (slide direction)'}
        value={joint.axis}
        onChange={(v) => update((j) => ({ ...j, axis: v }))}
      />
      <div className="props-sub">Limits</div>
      <div className="field">
        <span className="flabel">Range</span>
        <select
          value={joint.limits.mode}
          onChange={(e) =>
            update((j) => ({ ...j, limits: { ...j.limits, mode: e.target.value as 'free' | 'limited' } }))
          }
        >
          <option value="free">Free</option>
          <option value="limited">Limited</option>
        </select>
      </div>
      {joint.limits.mode === 'limited' && (
        <div className="field-row">
          <ExprInput
            label={`Min ${unit}`}
            value={joint.limits.min ?? '0'}
            params={params}
            onCommit={(v) => update((j) => ({ ...j, limits: { ...j.limits, min: v } }))}
          />
          <ExprInput
            label={`Max ${unit}`}
            value={joint.limits.max ?? '0'}
            params={params}
            onCommit={(v) => update((j) => ({ ...j, limits: { ...j.limits, max: v } }))}
          />
        </div>
      )}
      <div className="props-sub">Drive</div>
      {loopSolved ? (
        <div className="hint">
          Solved by a pin-slot loop — this joint follows the driver automatically and isn't dragged directly.
        </div>
      ) : (
        <>
          <div className="hint">Resolved range: {fmtRange(range, unit)}</div>
          <input
            type="range"
            min={lo}
            max={hi}
            step={sliderStep}
            value={clamped}
            onChange={(e) => drive(parseFloat(e.target.value))}
            style={{ width: '100%' }}
          />
          <div className="field-row" style={{ gap: 4, marginTop: 2 }}>
            <button className="link-btn" title={`Step back ${step}${unit}`} style={{ flex: 1 }} onClick={() => applyStep(-step)}>
              «
            </button>
            <button className="link-btn" title="Reset to design position" style={{ flex: 1 }} onClick={() => drive(0)}>
              0{unit}
            </button>
            <button className="link-btn" title={`Step forward ${step}${unit}`} style={{ flex: 1 }} onClick={() => applyStep(step)}>
              »
            </button>
          </div>
          <NumInput label={`Value ${unit}`} value={Math.round(jointValue * 100) / 100} onCommit={(v) => drive(v)} />
          <NumInput label={`Step ${unit}`} value={step} onCommit={(v) => setStep(v > 0 ? v : step)} />
        </>
      )}
      <button className="link-btn" style={{ marginTop: 6 }} onClick={() => useStore.getState().removeJoint(joint.id)}>
        Delete joint
      </button>
    </div>
  );
}

function PinSlotEditor({ ps, params }: { ps: PinSlotJoint; params: Params }) {
  const doc = useStore((s) => s.doc);
  const update = (fn: (p: PinSlotJoint) => PinSlotJoint) => useStore.getState().updatePinSlot(ps.id, fn);
  const bodies = doc.features.filter((f) => f.type !== 'sketch');
  const bodyName = (id: string) => doc.features.find((f) => f.id === id)?.name ?? '(none)';

  return (
    <div className="assembly-editor" style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
      <TextEdit label="Name" value={ps.name} onCommit={(v) => update((p) => ({ ...p, name: v }))} />
      <div className="field">
        <span className="flabel">Slot body</span>
        <div className="hint">{bodyName(ps.slotFeatureId)}</div>
      </div>
      <Vec3Fields label="Slot end A" value={ps.slotA} onChange={(v) => update((p) => ({ ...p, slotA: v }))} />
      <Vec3Fields label="Slot end B" value={ps.slotB} onChange={(v) => update((p) => ({ ...p, slotB: v }))} />
      <div className="field">
        <span className="flabel">Pin body</span>
        <select
          value={ps.pinFeatureId}
          title="The body carrying the pin that rides in the slot (often the static body / ground)."
          onChange={(e) => update((p) => ({ ...p, pinFeatureId: e.target.value }))}
        >
          <option value="">— pick a body —</option>
          {bodies
            .filter((f) => f.id !== ps.slotFeatureId)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </select>
      </div>
      <Vec3Fields label="Pin point" value={ps.pin} onChange={(v) => update((p) => ({ ...p, pin: v }))} />
      <div className="props-sub">Slide limits</div>
      <div className="field">
        <span className="flabel">Range</span>
        <select
          value={ps.limits.mode}
          onChange={(e) => update((p) => ({ ...p, limits: { ...p.limits, mode: e.target.value as 'free' | 'limited' } }))}
        >
          <option value="free">Free (full slot)</option>
          <option value="limited">Limited</option>
        </select>
      </div>
      {ps.limits.mode === 'limited' && (
        <div className="field-row">
          <ExprInput
            label="Min (from A)"
            value={ps.limits.min ?? '0'}
            params={params}
            onCommit={(v) => update((p) => ({ ...p, limits: { ...p.limits, min: v } }))}
          />
          <ExprInput
            label="Max (from A)"
            value={ps.limits.max ?? '0'}
            params={params}
            onCommit={(v) => update((p) => ({ ...p, limits: { ...p.limits, max: v } }))}
          />
        </div>
      )}
      <div className="hint">
        The slot body needs a Revolute joint with a <em>Base</em> of the driving part (the crank) so the loop can be
        inferred and solved. Drive the crank/wheel to see the leg follow.
      </div>
      <button className="link-btn" style={{ marginTop: 6 }} onClick={() => useStore.getState().removePinSlot(ps.id)}>
        Delete pin-slot
      </button>
    </div>
  );
}

function LinkEditor({ link, joints, params }: { link: Link; joints: Joint[]; params: Params }) {
  const doc = useStore((s) => s.doc);
  const update = (fn: (l: Link) => Link) => useStore.getState().updateLink(link.id, fn);
  const driver = joints.find((j) => j.id === link.driverJointId);
  const driven = joints.find((j) => j.id === link.drivenJointId);
  const kindFor = (a?: Joint, b?: Joint): Link['kind'] => (a && b ? linkKind(a, b) : link.kind);

  const driverTeeth = driver ? cogTeethForFeature(doc, driver.featureId) : undefined;
  const drivenTeeth = driven ? cogTeethForFeature(doc, driven.featureId) : undefined;
  const canDerive = driverTeeth != null && drivenTeeth != null;
  const kind = kindFor(driver, driven);
  const unitHint =
    kind === 'rot-rot'
      ? 'driven° = ratio × driver°'
      : kind === 'lin-lin'
      ? 'driven mm = ratio × driver mm'
      : 'rotation ↔ linear: ratio is mm per ° (driven slide) or ° per mm — match it to your driver';

  return (
    <div className="assembly-editor" style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
      <TextEdit label="Name" value={link.name} onCommit={(v) => update((l) => ({ ...l, name: v }))} />
      <div className="field">
        <span className="flabel">Driver</span>
        <select
          value={link.driverJointId}
          onChange={(e) => {
            const nv = e.target.value;
            update((l) => ({
              ...l,
              driverJointId: nv,
              kind: kindFor(joints.find((j) => j.id === nv), joints.find((j) => j.id === l.drivenJointId)),
            }));
          }}
        >
          {joints.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <span className="flabel">Driven</span>
        <select
          value={link.drivenJointId}
          onChange={(e) => {
            const nv = e.target.value;
            update((l) => ({
              ...l,
              drivenJointId: nv,
              kind: kindFor(joints.find((j) => j.id === l.driverJointId), joints.find((j) => j.id === nv)),
            }));
          }}
        >
          {joints
            .filter((j) => j.id !== link.driverJointId)
            .map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
        </select>
      </div>
      <ExprInput
        label="Ratio"
        value={link.ratio}
        params={params}
        onCommit={(v) => update((l) => ({ ...l, ratio: v, ratioSource: 'manual' }))}
      />
      {canDerive && (
        <button
          className="link-btn"
          onClick={() => {
            const r = teethRatio(driverTeeth, drivenTeeth);
            if (r !== null) update((l) => ({ ...l, ratio: String(+r.toFixed(4)), ratioSource: 'teeth' }));
          }}
        >
          Derive ratio from teeth ({driverTeeth}/{drivenTeeth})
        </button>
      )}
      <ExprInput
        label="Phase"
        value={link.phase ?? '0'}
        params={params}
        onCommit={(v) => update((l) => ({ ...l, phase: v }))}
      />
      <div className="hint">
        {link.ratioSource === 'teeth' ? 'Ratio auto-derived from tooth counts. ' : ''}
        {unitHint}
      </div>
      <button className="link-btn" style={{ marginTop: 6 }} onClick={() => useStore.getState().removeLink(link.id)}>
        Delete link
      </button>
    </div>
  );
}

const assemblyRowStyle = (sel: boolean): CSSProperties => ({
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  width: '100%',
  padding: '4px 6px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  marginBottom: 3,
  background: sel ? 'var(--accent)' : 'transparent',
  color: sel ? '#fff' : 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
});

export function AssemblyWarnings() {
  const warnings = useStore((s) => s.assembly.warnings);
  if (warnings.length === 0) return null;
  return (
    <div
      className="hint"
      style={{ color: '#e6a23c', border: '1px solid #e6a23c55', borderRadius: 4, padding: 6, marginBottom: 8 }}
    >
      ⚠ {warnings.join(' ')}
    </div>
  );
}

/** Joints list + selected-joint editor. Used by the Joints document tab and the
 *  combined fallback panel. */
export function AssemblyJointsSection({ params }: { params: Params }) {
  const doc = useStore((s) => s.doc);
  const joints = doc.joints;
  const links = doc.links;
  const pinSlots = doc.pinSlots ?? [];
  const selectedJointId = useStore((s) => s.assembly.selectedJointId);
  const selectedPinSlotId = useStore((s) => s.assembly.selectedPinSlotId);
  const jointValues = useStore((s) => s.assembly.jointValues);
  const selectJoint = useStore((s) => s.selectJoint);
  const selectPinSlot = useStore((s) => s.selectPinSlot);
  const bodyName = (fid: string) => doc.features.find((f) => f.id === fid)?.name ?? '(deleted)';
  const selJoint = joints.find((j) => j.id === selectedJointId) ?? null;
  const selPinSlot = pinSlots.find((p) => p.id === selectedPinSlotId) ?? null;

  return (
    <>
      <div className="props-sub">Joints</div>
      {joints.length === 0 && (
        <div className="empty-note">
          No joints yet. Click a body in the viewport, then add a Revolute or Prismatic joint from the toolbar.
        </div>
      )}
      {joints.map((j) => (
        <button key={j.id} style={assemblyRowStyle(j.id === selectedJointId)} onClick={() => selectJoint(j.id)}>
          <span>{j.name}</span>
          <span style={{ opacity: 0.75, fontSize: 12 }}>
            {j.type === 'revolute' ? '⟳' : '↔'} {bodyName(j.featureId)}
          </span>
        </button>
      ))}
      {selJoint && (
        <JointEditor
          key={selJoint.id}
          joint={selJoint}
          params={params}
          jointValue={jointValues[selJoint.id] ?? 0}
          joints={joints}
          links={links}
        />
      )}

      {pinSlots.length > 0 && <div className="props-sub" style={{ marginTop: 12 }}>Pin-slots</div>}
      {pinSlots.map((p) => (
        <button key={p.id} style={assemblyRowStyle(p.id === selectedPinSlotId)} onClick={() => selectPinSlot(p.id)}>
          <span>{p.name}</span>
          <span style={{ opacity: 0.75, fontSize: 12 }}>
            ⊟ {bodyName(p.slotFeatureId)}
          </span>
        </button>
      ))}
      {selPinSlot && <PinSlotEditor key={selPinSlot.id} ps={selPinSlot} params={params} />}
    </>
  );
}

/** Links list + selected-link editor. Used by the Links document tab and the
 *  combined fallback panel. */
export function AssemblyLinksSection({ params }: { params: Params }) {
  const doc = useStore((s) => s.doc);
  const joints = doc.joints;
  const links = doc.links;
  const selectedLinkId = useStore((s) => s.assembly.selectedLinkId);
  const selectLink = useStore((s) => s.selectLink);
  const selLink = links.find((l) => l.id === selectedLinkId) ?? null;

  return (
    <>
      <div className="props-sub">Links</div>
      {joints.length < 2 ? (
        <div className="empty-note">Add at least two joints to link them, then use Link in the toolbar.</div>
      ) : (
        links.length === 0 && <div className="empty-note">No links yet. Use Link in the toolbar to couple two joints.</div>
      )}
      {links.map((l) => {
        const dr = joints.find((j) => j.id === l.driverJointId)?.name ?? '?';
        const dn = joints.find((j) => j.id === l.drivenJointId)?.name ?? '?';
        return (
          <button key={l.id} style={assemblyRowStyle(l.id === selectedLinkId)} onClick={() => selectLink(l.id)}>
            <span>{l.name}</span>
            <span style={{ opacity: 0.75, fontSize: 12 }}>
              {dr} → {dn} ×{l.ratio}
            </span>
          </button>
        );
      })}
      {selLink && <LinkEditor key={selLink.id} link={selLink} joints={joints} params={params} />}
    </>
  );
}

/** Combined fallback (used only when the Joints/Links document tabs aren't
 *  present, e.g. a layout saved before they existed). */
function AssemblyProps({ params }: { params: Params }) {
  return (
    <>
      <div className="props-title">ASSEMBLY</div>
      <div className="hint" style={{ marginBottom: 8 }}>
        Non-permanent: leaving Assembly mode returns every body to its design position.
      </div>
      <AssemblyWarnings />
      <AssemblyJointsSection params={params} />
      <div style={{ marginTop: 12 }} />
      <AssemblyLinksSection params={params} />
    </>
  );
}
