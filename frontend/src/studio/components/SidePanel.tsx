import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { uid, type Parameter } from '../types';
import { confirmDeleteFeature, featureTree, useStore } from '../state/store';
import type { Feature } from '../types';
import { isValidParamName, type Params } from '../core/expressions';

/** Parameter name editor: commits on blur/Enter, rejects invalid or duplicate names. */
function ParamNameInput({
  param,
  others,
  onCommit,
}: {
  param: Parameter;
  others: string[];
  onCommit: (name: string) => void;
}) {
  const [text, setText] = useState(param.name);
  useEffect(() => setText(param.name), [param.name]);
  const trimmed = text.trim();
  const duplicate = others.includes(trimmed);
  const invalid = !isValidParamName(trimmed) || duplicate;
  const commit = () => {
    if (!invalid && trimmed !== param.name) onCommit(trimmed);
    else if (invalid) setText(param.name); // revert
  };
  return (
    <input
      className={invalid ? 'invalid' : ''}
      value={text}
      title={
        duplicate
          ? `"${trimmed}" is already used by another parameter`
          : !isValidParamName(trimmed)
            ? 'Invalid name (letters, digits, _; must not start with a digit or shadow a function)'
            : param.name
      }
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setText(param.name);
      }}
    />
  );
}

const TYPE_LABEL: Record<string, string> = {
  sketch: 'sketch',
  extrude: 'extrude',
  primitive: 'solid',
  import: 'import',
  boolean: 'merge',
};

/* ── Row mini-icons (open / closed eye + small cross) ──────────────────────
 * Inlined SVG so every mini button renders at the same intrinsic size — the
 * old emoji eye + en-dash + cross trio had three different glyph metrics and
 * the row buttons jiggled depending on visibility. `currentColor` lets the
 * row's hover / selected / hidden styling flow through unchanged.            */

function EyeOpenIcon() {
  // Almond outline + filled iris dot — the solid pupil reads as an eye at
  // small sizes where a hollow inner circle just looks like noise.
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
      strokeLinecap="round"
      width={15}
      height={15}
      aria-hidden="true"
    >
      <path d="M2 8 C 4 4 12 4 14 8 C 12 12 4 12 2 8 Z" />
      <circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function EyeClosedIcon() {
  // A single downward arc, like a sleeping eye. Deliberately minimal so it
  // reads unambiguously at 14–15 px instead of dissolving into stray lines.
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      width={15}
      height={15}
      aria-hidden="true"
    >
      <path d="M2 7.2 C 5 11 11 11 14 7.2" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      width={12}
      height={12}
      aria-hidden="true"
    >
      <path d="M4 4 L12 12" />
      <path d="M12 4 L4 12" />
    </svg>
  );
}

export function SidePanel({
  params,
  paramErrors,
  featureErrors,
}: {
  params: Params;
  paramErrors: Record<string, string>;
  featureErrors: { featureId: string; message: string }[];
}) {
  const [tab, setTab] = useState<'features' | 'params'>('features');
  const hasFeatureErrors = featureErrors.length > 0;
  return (
    <div className="side-panel">
      <div className="panel-tabs">
        <button className={tab === 'features' ? 'active' : ''} onClick={() => setTab('features')}>
          Features{hasFeatureErrors ? ' ⚠' : ''}
        </button>
        <button className={tab === 'params' ? 'active' : ''} onClick={() => setTab('params')}>
          Parameters
        </button>
      </div>
      <div className="panel-body">
        {tab === 'features' ? (
          <FeatureList featureErrors={featureErrors} />
        ) : (
          <ParamTable params={params} paramErrors={paramErrors} />
        )}
      </div>
    </div>
  );
}

function FeatureList({ featureErrors }: { featureErrors: { featureId: string; message: string }[] }) {
  const s = useStore();
  const dragId = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const errorFor = (id: string) => featureErrors.find((e) => e.featureId === id)?.message;
  if (!s.doc.features.length) {
    return (
      <div className="empty-note">
        No features yet.
        <br />
        <br />
        Start a sketch (Top/Front/Right), add a primitive, or import a model.
      </div>
    );
  }
  const setVis = (pred: (f: Feature) => boolean, visible: boolean) =>
    s.setDoc({ ...s.doc, features: s.doc.features.map((f) => (pred(f) ? { ...f, visible } : f)) });
  const sketches = s.doc.features.filter((f) => f.type === 'sketch');
  const objects = s.doc.features.filter((f) => f.type !== 'sketch');
  const anyVis = s.doc.features.some((f) => f.visible);
  const anySketchVis = sketches.some((f) => f.visible);
  const anyObjVis = objects.some((f) => f.visible);
  const bulkBtn: CSSProperties = { flex: 1, fontSize: 11, padding: '3px 4px', whiteSpace: 'nowrap' };

  const tree = featureTree(s.doc);
  const featureById = new Map(s.doc.features.map((f) => [f.id, f] as const));
  const catById = new Map(tree.categories.map((c) => [c.id, c] as const));
  const containerOf = (fid: string) => tree.categories.find((c) => c.children.includes(fid))?.id ?? null;

  // ── drag & drop ──────────────────────────────────────────────────────────
  const onDragStart = (e: DragEvent, id: string) => {
    dragId.current = id;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch { /* some browsers */ }
  };
  const allowDrop = (e: DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (overId !== id) setOverId(id);
  };
  const endDrag = () => { dragId.current = null; setOverId(null); };
  const dropBeforeFeature = (e: DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const drag = dragId.current;
    endDrag();
    if (!drag || drag === targetId) return;
    s.moveTreeItem(drag, containerOf(targetId), targetId); // insert before target, in its container
  };
  const dropOnCategory = (e: DragEvent, catId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const drag = dragId.current;
    endDrag();
    if (!drag || drag === catId) return;
    if (catById.has(drag)) s.moveTreeItem(drag, null, catId); // reorder a category before this one
    else s.moveTreeItem(drag, catId, null); // drop a feature into this category
  };
  const dropAtRootEnd = (e: DragEvent) => {
    e.preventDefault();
    const drag = dragId.current;
    endDrag();
    if (drag) s.moveTreeItem(drag, null, null);
  };
  const dropAtCategoryEnd = (e: DragEvent, catId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const drag = dragId.current;
    endDrag();
    if (!drag || catById.has(drag)) return; // features only; categories live at root
    s.moveTreeItem(drag, catId, null); // append to the end of this category
  };

  const renderFeature = (f: Feature, indented: boolean) => {
    const sketchName = f.type === 'extrude' ? s.doc.features.find((x) => x.id === f.sketchId)?.name ?? '?' : null;
    return (
      <div
        key={f.id}
        className={`feature-row ${s.selectedFeatureId === f.id ? 'selected' : ''}`}
        draggable
        onDragStart={(e) => onDragStart(e, f.id)}
        onDragEnd={endDrag}
        onDragOver={(e) => allowDrop(e, f.id)}
        onDrop={(e) => dropBeforeFeature(e, f.id)}
        onClick={() => s.select(f.id)}
        onDoubleClick={() => { if (f.type === 'sketch') s.enterSketch(f.id); }}
        title={f.type === 'sketch' ? 'Double-click to edit sketch' : f.name}
        style={{
          marginLeft: indented ? 16 : 0,
          borderTop: overId === f.id ? '2px solid var(--accent)' : '2px solid transparent',
        }}
      >
        <span className="ftype">{TYPE_LABEL[f.type]}</span>
        <span className="fname" style={{ opacity: f.visible ? 1 : 0.45 }}>{f.name}</span>
        {f.type === 'extrude' && (
          <span className="flock" title={`Locked to sketch "${sketchName}" — open properties to detach`}>🔒</span>
        )}
        {errorFor(f.id) && <span className="fwarn" title={errorFor(f.id)}>⚠</span>}
        <button
          className={`mini mini-eye${f.visible ? '' : ' mini-eye-closed'}`}
          title={f.visible ? 'Hide' : 'Show'}
          onClick={(e) => { e.stopPropagation(); s.updateFeature(f.id, (x) => ({ ...x, visible: !x.visible })); }}
        >
          {f.visible ? <EyeOpenIcon /> : <EyeClosedIcon />}
        </button>
        <button
          className="mini mini-close"
          title="Delete"
          onClick={(e) => { e.stopPropagation(); confirmDeleteFeature(f.id); }}
        >
          <CrossIcon />
        </button>
      </div>
    );
  };

  return (
    <>
      <div style={{ padding: '2px 2px 6px' }}>
        <button
          style={{ width: '100%', fontSize: 11, padding: '3px 4px' }}
          title="Add a category to group features. Drag features onto it; drag to reorder."
          onClick={() => {
            const name = window.prompt('New category name:', `Group ${(s.doc.categories?.length ?? 0) + 1}`);
            if (name && name.trim()) s.addCategory(name.trim());
          }}
        >
          + Add category
        </button>
      </div>
      <div style={{ display: 'flex', gap: 4, padding: '0 2px 4px', flexWrap: 'wrap' }}>
        <button style={bulkBtn} title={anyVis ? 'Hide every feature' : 'Show every feature'} onClick={() => setVis(() => true, !anyVis)}>
          {anyVis ? 'Hide all' : 'Show all'}
        </button>
        <button style={bulkBtn} disabled={!sketches.length} title={anySketchVis ? 'Hide all sketches' : 'Show all sketches'} onClick={() => setVis((f) => f.type === 'sketch', !anySketchVis)}>
          {anySketchVis ? 'Hide sketches' : 'Show sketches'}
        </button>
        <button style={bulkBtn} disabled={!objects.length} title={anyObjVis ? 'Hide all bodies (extrudes, primitives, imports)' : 'Show all bodies'} onClick={() => setVis((f) => f.type !== 'sketch', !anyObjVis)}>
          {anyObjVis ? 'Hide objects' : 'Show objects'}
        </button>
      </div>

      {tree.rootOrder.map((id) => {
        const cat = catById.get(id);
        if (cat) {
          return (
            <div key={cat.id}>
              <div
                className="feature-row"
                draggable
                onDragStart={(e) => onDragStart(e, cat.id)}
                onDragEnd={endDrag}
                onDragOver={(e) => allowDrop(e, cat.id)}
                onDrop={(e) => dropOnCategory(e, cat.id)}
                style={{
                  fontWeight: 600,
                  background: overId === cat.id ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : undefined,
                  borderTop: '2px solid transparent',
                }}
                title="Drag features here to group them · drag to reorder · double-click name to rename"
              >
                <button
                  className="mini"
                  title={cat.collapsed ? 'Expand' : 'Collapse'}
                  onClick={(e) => { e.stopPropagation(); s.updateCategory(cat.id, (c) => ({ ...c, collapsed: !c.collapsed })); }}
                >
                  {cat.collapsed ? '▶' : '▼'}
                </button>
                <span
                  className="fname"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    const name = window.prompt('Rename category:', cat.name);
                    if (name && name.trim()) s.updateCategory(cat.id, (c) => ({ ...c, name: name.trim() }));
                  }}
                >
                  {cat.name} <span style={{ opacity: 0.55, fontWeight: 400 }}>({cat.children.length})</span>
                </span>
                {(() => {
                  const childSet = new Set(cat.children);
                  const anyChildVis = cat.children.some((fid) => featureById.get(fid)?.visible);
                  return (
                    <button
                      className={`mini mini-eye${anyChildVis ? '' : ' mini-eye-closed'}`}
                      title={anyChildVis ? 'Hide all items in this category' : 'Show all items in this category'}
                      disabled={!cat.children.length}
                      onClick={(e) => { e.stopPropagation(); setVis((f) => childSet.has(f.id), !anyChildVis); }}
                    >
                      {anyChildVis ? <EyeOpenIcon /> : <EyeClosedIcon />}
                    </button>
                  );
                })()}
                <button
                  className="mini mini-close"
                  title="Delete category (keeps its features, moves them out)"
                  onClick={(e) => { e.stopPropagation(); s.removeCategory(cat.id); }}
                >
                  <CrossIcon />
                </button>
              </div>
              {!cat.collapsed && (
                <>
                  {cat.children.map((fid) => {
                    const f = featureById.get(fid);
                    return f ? renderFeature(f, true) : null;
                  })}
                  {/* end-of-category drop zone: append into this category */}
                  <div
                    onDragOver={(e) => allowDrop(e, `end:${cat.id}`)}
                    onDrop={(e) => dropAtCategoryEnd(e, cat.id)}
                    title={`Drop here to add to the end of "${cat.name}"`}
                    style={{
                      marginLeft: 16,
                      height: overId === `end:${cat.id}` ? 16 : 9,
                      borderTop: overId === `end:${cat.id}` ? '2px solid var(--accent)' : '2px dashed var(--border)',
                      borderRadius: 2,
                      opacity: overId === `end:${cat.id}` ? 1 : 0.5,
                    }}
                  />
                </>
              )}
            </div>
          );
        }
        const f = featureById.get(id);
        return f ? renderFeature(f, false) : null;
      })}

      {/* root drop zone (append to root end) */}
      <div
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        onDrop={dropAtRootEnd}
        style={{ minHeight: 16 }}
      />
    </>
  );
}

function ParamTable({ params, paramErrors }: { params: Params; paramErrors: Record<string, string> }) {
  const s = useStore();
  const list = s.doc.parameters;

  const update = (id: string, patch: Partial<Parameter>) => {
    s.setParameters(list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const add = () => {
    let n = 1;
    const names = new Set(list.map((p) => p.name));
    while (names.has(`param${n}`)) n++;
    s.setParameters([...list, { id: uid(), name: `param${n}`, expression: '10' }]);
  };

  return (
    <>
      {list.map((p) => {
        const err = paramErrors[p.name];
        return (
          <div className="param-block" key={p.id}>
            <div className="param-row">
              <ParamNameInput
                param={p}
                others={list.filter((x) => x.id !== p.id).map((x) => x.name)}
                onCommit={(name) => update(p.id, { name })}
              />
              <button
                className="mini"
                title={`Delete ${p.name}`}
                onClick={() => {
                  if (window.confirm(`Delete parameter "${p.name}"?\n\nAny dimension still referencing it will show an error.`)) {
                    s.setParameters(list.filter((x) => x.id !== p.id));
                  }
                }}
              >
                ✕
              </button>
            </div>
            <div className="param-row">
              <input
                className={err ? 'invalid' : ''}
                value={p.expression}
                title={err ?? `${p.name} = ${p.expression}`}
                onChange={(e) => update(p.id, { expression: e.target.value })}
              />
              <span className="pval" title={err ?? p.name}>
                = {err ? '—' : formatNum(params[p.name])}
              </span>
            </div>
          </div>
        );
      })}
      <button onClick={add} style={{ marginTop: 6, width: '100%' }}>
        + Add parameter
      </button>
      <div className="empty-note">
        Use parameter names in any dimension field, e.g. <code>width/2 + 5</code>. Renaming a parameter does not
        update expressions that reference it.
      </div>
    </>
  );
}

export function formatNum(v: number | undefined): string {
  if (v === undefined || !isFinite(v)) return '—';
  return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(3);
}
