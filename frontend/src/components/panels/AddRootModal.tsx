/**
 * AddRootModal — the "Add root folder" dialog (opened from the VFS Roots tab).
 *
 * Mirrors the VFS skill's RootEditor: a virtual name, a live-validated real
 * server path, enabled / allow-subfolders toggles, allowed-file-type chips, and
 * a description. On Create it ensures the project's VFS config ("topic") exists
 * — creating one keyed by the project id, named after the project, if needed —
 * then adds the root and asks the panel to refresh.
 *
 * The button bar's Create (addRootModal:create, closesModal: 'on-success')
 * runs the async create; a thrown error keeps the dialog open with a message.
 */
import { useEffect, useRef, useState } from 'react';
import type { ModalState } from '../../types';
import { actionRegistry } from '../../utils/actionRegistry';
import {
  addRootEnsuringConfig,
  validatePath,
  VfsApiError,
  type CreateRootBody,
} from '../../vfs/vfsAdmin';

interface AddRootProps {
  projectId: string;
  projectName: string;
  description?: string;
  onCreated?: () => void;
}

const DEFAULT_TYPES = [
  'pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
  'stl', 'obj', 'gltf', 'glb', 'step', 'stp',
  'json', 'csv', 'txt', 'md',
];

export function AddRootModal({ modal }: { modal: ModalState; onClose: () => void }) {
  const props = (modal.props ?? {}) as unknown as AddRootProps;

  const [virtualName, setVirtualName] = useState('');
  const [realPath, setRealPath] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [allowSub, setAllowSub] = useState(true);
  const [types, setTypes] = useState<string[]>(['*']);
  const [typeInput, setTypeInput] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [pathValid, setPathValid] = useState<boolean | null>(null);
  const [pathReason, setPathReason] = useState<string | null>(null);

  // Debounced live validation of the real path (hits the server's disk).
  useEffect(() => {
    if (!realPath.trim()) { setPathValid(null); setPathReason(null); return; }
    const handle = setTimeout(() => {
      validatePath(realPath.trim())
        .then((r) => {
          setPathValid(r.valid);
          setPathReason(
            r.valid ? (r.resolved_path ?? null)
            : !r.exists ? 'Path does not exist'
            : !r.is_directory ? 'Path is not a directory'
            : 'Invalid path',
          );
        })
        .catch((e) => { setPathValid(false); setPathReason(e instanceof VfsApiError ? e.message : String(e?.message ?? e)); });
    }, 350);
    return () => clearTimeout(handle);
  }, [realPath]);

  const addType = (raw: string) => {
    const t = raw.trim().toLowerCase().replace(/^\.+/, '');
    if (!t) return;
    if (t === '*') { setTypes(['*']); setTypeInput(''); return; }
    setTypes((prev) => (prev.includes(t) ? prev : prev.filter((x) => x !== '*').concat(t)));
    setTypeInput('');
  };
  const removeType = (t: string) => setTypes((prev) => prev.filter((x) => x !== t));

  const formRef = useRef({ virtualName, realPath, enabled, allowSub, types, description });
  useEffect(() => { formRef.current = { virtualName, realPath, enabled, allowSub, types, description }; });

  // Register the create handler. Returns a promise so the button's
  // 'on-success' policy closes the modal only when it resolves.
  useEffect(() => {
    actionRegistry.register('addRootModal:create', async () => {
      const v = formRef.current;
      if (!v.virtualName.trim()) { setError('Virtual name is required.'); throw new Error('validation'); }
      if (!v.realPath.trim()) { setError('Real path is required.'); throw new Error('validation'); }
      setError(null);
      const body: CreateRootBody = {
        virtual_name: v.virtualName.trim(),
        real_path: v.realPath.trim(),
        enabled: v.enabled,
        allow_subfolders: v.allowSub,
        allowed_file_types: v.types.length ? v.types : ['*'],
        description: v.description.trim(),
      };
      try {
        await addRootEnsuringConfig(props.projectId, props.projectName, props.description ?? '', body);
        props.onCreated?.();
      } catch (e) {
        if (e instanceof VfsApiError && e.code === 'PERMISSION_DENIED') {
          setError('This application is not permitted to create roots/projects. Ask an administrator.');
        } else if (e instanceof VfsApiError && e.code === 'DUPLICATE_REAL_PATH') {
          setError('Another root in this project already maps to that folder.');
        } else {
          setError(e instanceof VfsApiError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e));
        }
        throw e; // keep the modal open
      }
    });
    return () => actionRegistry.unregister('addRootModal:create');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pathColor = pathValid === null ? 'var(--border)' : pathValid ? '#3a9d4a' : 'var(--danger, #d3534f)';

  return (
    <div className="modal-content-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <div style={st.error}>{error}</div>}

      <div className="dialog-field" style={{ marginTop: 0 }}>
        <label className="dialog-field-label">Virtual name *</label>
        <input className="dialog-input" value={virtualName} autoFocus
               onChange={(e) => setVirtualName(e.target.value)} placeholder="e.g. Project Docs" />
      </div>

      <div className="dialog-field" style={{ marginTop: 0 }}>
        <label className="dialog-field-label">Real path *</label>
        <input className="dialog-input" value={realPath}
               onChange={(e) => setRealPath(e.target.value)}
               placeholder="/Users/you/Documents/SomeFolder"
               style={{ fontFamily: 'monospace', borderColor: pathColor }} />
        {pathReason && (
          <p style={{ margin: '4px 0 0', fontSize: 12, color: pathValid ? '#3a9d4a' : 'var(--danger, #d3534f)' }}>
            {pathValid ? `✓ ${pathReason ?? 'Valid'}` : `✕ ${pathReason}`}
          </p>
        )}
      </div>

      <div style={{ display: 'flex', gap: 18 }}>
        <label style={st.check}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
        <label style={st.check}>
          <input type="checkbox" checked={allowSub} onChange={(e) => setAllowSub(e.target.checked)} /> Allow subfolders
        </label>
      </div>

      <div className="dialog-field" style={{ marginTop: 0 }}>
        <label className="dialog-field-label">Allowed file types</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="dialog-input" value={typeInput}
                 onChange={(e) => setTypeInput(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addType(typeInput); } }}
                 placeholder="add extension, e.g. pdf  (Enter)" />
          <button type="button" className="modal-btn" onClick={() => addType(typeInput)}>Add</button>
        </div>
        <div style={st.chips}>
          {types.map((t) => (
            <span key={t} style={st.chip}>{t === '*' ? '* (all)' : t}
              <button type="button" style={st.chipX} onClick={() => removeType(t)}>×</button>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button type="button" className="modal-btn" onClick={() => setTypes(['*'])}>Allow all (*)</button>
          <button type="button" className="modal-btn" onClick={() => setTypes([...DEFAULT_TYPES])}>Use defaults</button>
        </div>
      </div>

      <div className="dialog-field" style={{ marginTop: 0 }}>
        <label className="dialog-field-label">Description</label>
        <textarea className="dialog-input" value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  style={{ resize: 'vertical', minHeight: 56, fontFamily: 'inherit' }} />
      </div>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  check: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '2px 8px', fontSize: 12 },
  chipX: { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, lineHeight: 1, color: 'var(--text-dim)' },
  error: { padding: '8px 10px', borderRadius: 6, background: 'rgba(211,83,79,0.12)', color: 'var(--danger, #d3534f)', fontSize: 12 },
};
