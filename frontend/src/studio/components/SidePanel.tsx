import { useEffect, useState } from 'react';
import { uid, type Parameter } from '../types';
import { confirmDeleteFeature, useStore } from '../state/store';
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
  return (
    <>
      {s.doc.features.map((f) => {
        const sketchName =
          f.type === 'extrude'
            ? s.doc.features.find((x) => x.id === f.sketchId)?.name ?? '?'
            : null;
        return (
        <div
          key={f.id}
          className={`feature-row ${s.selectedFeatureId === f.id ? 'selected' : ''}`}
          onClick={() => s.select(f.id)}
          onDoubleClick={() => {
            if (f.type === 'sketch') s.enterSketch(f.id);
          }}
          title={f.type === 'sketch' ? 'Double-click to edit sketch' : f.name}
        >
          <span className="ftype">{TYPE_LABEL[f.type]}</span>
          <span className="fname" style={{ opacity: f.visible ? 1 : 0.45 }}>
            {f.name}
          </span>
          {f.type === 'extrude' && (
            <span
              className="flock"
              title={`Locked to sketch "${sketchName}" — open properties to detach`}
            >
              🔒
            </span>
          )}
          {errorFor(f.id) && (
            <span className="fwarn" title={errorFor(f.id)}>
              ⚠
            </span>
          )}
          <button
            className={`mini mini-eye${f.visible ? '' : ' mini-eye-closed'}`}
            title={f.visible ? 'Hide' : 'Show'}
            onClick={(e) => {
              e.stopPropagation();
              s.updateFeature(f.id, (x) => ({ ...x, visible: !x.visible }));
            }}
          >
            {f.visible ? <EyeOpenIcon /> : <EyeClosedIcon />}
          </button>
          <button
            className="mini mini-close"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              confirmDeleteFeature(f.id);
            }}
          >
            <CrossIcon />
          </button>
        </div>
        );
      })}
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
