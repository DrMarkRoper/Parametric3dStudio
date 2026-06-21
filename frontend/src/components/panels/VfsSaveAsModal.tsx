/**
 * VfsSaveAsModal — step 2 of Save As. A filename edit box above a VFS file
 * browser (root selector + folder navigation). The user picks a writable root
 * and folder, sets the filename (defaults to the name from step 1), and Saves.
 *
 * The button bar's Save (vfsSaveAsModal:save, closesModal: 'on-success') calls
 * the caller-supplied onSave with { rootId, configKey, folderPath, fileName,
 * overwrite } and closes only when the write resolves.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModalState } from '../../types';
import { actionRegistry } from '../../utils/actionRegistry';
import { listRoots, browse, type PublicRoot, type VfsEntry } from '../../vfs/vfsApi';
import { VfsApiError } from '../../vfs/vfsAdmin';

interface SaveArg {
  rootId: string; rootName: string; configKey: string; folderPath: string; fileName: string; overwrite: boolean;
}
interface SaveAsProps {
  defaultFileName: string;
  defaultFolder?: string;
  configKey: string;
  defaultRootId?: string | null;
  onSave: (sel: SaveArg) => Promise<void>;
}

function isJson(name: string): boolean {
  return /\.json$/i.test(name);
}

export function VfsSaveAsModal({ modal }: { modal: ModalState; onClose: () => void }) {
  const props = (modal.props ?? {}) as unknown as SaveAsProps;
  const configKey = props.configKey;

  const [roots, setRoots] = useState<PublicRoot[]>([]);
  const [rootId, setRootId] = useState<string>('');
  const [path, setPath] = useState(props.defaultFolder ?? '');
  const [entries, setEntries] = useState<VfsEntry[]>([]);
  const [fileName, setFileName] = useState(props.defaultFileName ?? '');
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Load writable roots once; preselect the project's default root if present.
  useEffect(() => {
    setError(null);
    listRoots(configKey)
      .then((rs) => {
        const writable = rs.filter((r) => r.can_write !== false);
        setRoots(writable);
        setRootId((prev) => {
          if (prev && writable.some((r) => r.id === prev)) return prev;
          if (props.defaultRootId && writable.some((r) => r.id === props.defaultRootId)) return props.defaultRootId;
          return writable[0]?.id ?? '';
        });
      })
      .catch((e) => setError(describe(e)));
  }, [configKey, props.defaultRootId]);

  // Browse whenever root or path changes.
  useEffect(() => {
    if (!rootId) { setEntries([]); return; }
    setLoading(true);
    setError(null);
    browse(rootId, path, configKey)
      .then((r) => setEntries(r.entries))
      .catch((e) => { setEntries([]); setError(describe(e)); })
      .finally(() => setLoading(false));
  }, [rootId, path, configKey]);

  const rootsRef = useRef(roots);
  useEffect(() => { rootsRef.current = roots; }, [roots]);
  const stateRef = useRef({ rootId, path, fileName, overwrite });
  useEffect(() => { stateRef.current = { rootId, path, fileName, overwrite }; });

  // Register the Save handler (button bar). Returns a promise so 'on-success'
  // closes the modal only when the write resolves.
  useEffect(() => {
    actionRegistry.register('vfsSaveAsModal:save', async () => {
      const s = stateRef.current;
      if (!s.rootId) { setError('Select a folder to save into.'); throw new Error('no-root'); }
      const clean = s.fileName.replace(/\.json$/i, '').trim();
      if (!clean) { setError('Enter a file name.'); throw new Error('no-name'); }
      const rootName = rootsRef.current.find((r) => r.id === s.rootId)?.virtual_name ?? '';
      setError(null);
      try {
        await props.onSave({
          rootId: s.rootId, rootName, configKey, folderPath: s.path, fileName: clean, overwrite: s.overwrite,
        });
      } catch (e) {
        if (e instanceof VfsApiError && e.code === 'FILE_EXISTS') {
          setError('A file with that name already exists here. Tick "Overwrite" to replace it.');
        } else if (e instanceof VfsApiError && e.code === 'WRITE_DENIED') {
          setError('This application is not permitted to write to that root.');
        } else {
          setError(describe(e));
        }
        throw e; // keep the modal open
      }
    });
    return () => actionRegistry.unregister('vfsSaveAsModal:save');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goUp = useCallback(() => setPath((p) => p.split('/').slice(0, -1).join('/')), []);
  const onEntry = (e: VfsEntry) => {
    if (e.type === 'folder') setPath(path ? `${path}/${e.name}` : e.name);
    else if (isJson(e.name)) setFileName(e.name.replace(/\.json$/i, '')); // reuse an existing name
  };

  const crumbs = path ? path.split('/') : [];
  const visible = entries.filter((e) => e.type === 'folder' || isJson(e.name));

  return (
    <div className="modal-content-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Filename box */}
      <div className="dialog-field" style={{ marginTop: 0 }}>
        <label className="dialog-field-label">File name</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            className="dialog-input"
            value={fileName}
            onChange={(e) => { setFileName(e.target.value); setError(null); }}
            placeholder="my-project"
            autoFocus
          />
          <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>.json</span>
        </div>
      </div>

      {/* Toolbar: root selector + breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <select
          className="dialog-input"
          style={{ width: 'auto', flex: '0 0 auto' }}
          value={rootId}
          onChange={(e) => { setRootId(e.target.value); setPath(''); }}
        >
          {roots.length === 0 && <option value="">(no writable roots)</option>}
          {roots.map((r) => <option key={r.id} value={r.id}>{r.virtual_name}</option>)}
        </select>
        <div style={st.breadcrumb}>
          <span style={st.crumb} onClick={() => setPath('')}>/</span>
          {crumbs.map((c, i) => (
            <span key={i} style={st.crumb} onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c} /</span>
          ))}
        </div>
        {path && <button type="button" className="modal-btn" onClick={goUp}>↑ Up</button>}
      </div>

      {error && <div style={st.error}>{error}</div>}

      <div style={st.list}>
        {loading && <div style={st.empty}>Loading…</div>}
        {!loading && roots.length === 0 && (
          <div style={st.empty}>No writable roots in this project.</div>
        )}
        {!loading && roots.length > 0 && visible.length === 0 && (
          <div style={st.empty}>Empty folder — the file will be created here.</div>
        )}
        {!loading && visible.map((e) => (
          <div key={e.name} style={st.row} onClick={() => onEntry(e)} title={e.name}>
            <span style={{ width: 18 }}>{e.type === 'folder' ? '📁' : '📄'}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
            {e.type === 'file' && <span style={st.size}>{formatSize(e.size_bytes)}</span>}
          </div>
        ))}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
        Overwrite if a file with this name already exists
      </label>
    </div>
  );
}

function describe(e: unknown): string {
  return e instanceof VfsApiError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e);
}
function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

const st: Record<string, React.CSSProperties> = {
  breadcrumb: { flex: 1, fontSize: 13, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  crumb: { cursor: 'pointer', color: 'var(--accent)' },
  list: { border: '1px solid var(--border)', borderRadius: 6, height: 240, overflowY: 'auto', background: 'var(--bg)' },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderBottom: '1px solid var(--border)', cursor: 'pointer', fontSize: 13 },
  size: { fontSize: 11, color: 'var(--text-dim)' },
  empty: { padding: '20px 12px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 },
  error: { padding: '8px 10px', borderRadius: 6, background: 'rgba(211,83,79,0.12)', color: 'var(--danger, #d3534f)', fontSize: 12 },
};
