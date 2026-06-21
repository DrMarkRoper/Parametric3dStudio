/**
 * VfsOpenBrowserModal — the File ▸ Open browser. Lists the current project's
 * VFS roots, lets the user navigate folders, and shows only `.json` files. The
 * button bar's Open (vfsOpenModal:open) loads the selected file via the
 * caller-supplied onPick callback (closesModal: 'on-success').
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModalState } from '../../types';
import { actionRegistry } from '../../utils/actionRegistry';
import { listRoots, browse, type PublicRoot, type VfsEntry } from '../../vfs/vfsApi';
import { VfsApiError } from '../../vfs/vfsAdmin';

interface PickArg { rootId: string; rootName: string; filePath: string; name: string; configKey: string }
interface BrowserProps {
  configKey: string;
  onPick: (sel: PickArg) => Promise<void>;
}

function isJson(name: string): boolean {
  return /\.json$/i.test(name); // matches .json and .cad.json
}

export function VfsOpenBrowserModal({ modal }: { modal: ModalState; onClose: () => void }) {
  const props = (modal.props ?? {}) as unknown as BrowserProps;
  const configKey = props.configKey;

  const [roots, setRoots] = useState<PublicRoot[]>([]);
  const [rootId, setRootId] = useState<string>('');
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<VfsEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // selected file name
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Load roots once.
  useEffect(() => {
    setError(null);
    listRoots(configKey)
      .then((rs) => {
        setRoots(rs);
        setRootId((prev) => (prev && rs.some((r) => r.id === prev) ? prev : rs[0]?.id ?? ''));
      })
      .catch((e) => setError(describe(e)));
  }, [configKey]);

  // Browse whenever root or path changes.
  useEffect(() => {
    if (!rootId) { setEntries([]); return; }
    setLoading(true);
    setError(null);
    setSelected(null);
    browse(rootId, path, configKey)
      .then((r) => setEntries(r.entries))
      .catch((e) => { setEntries([]); setError(describe(e)); })
      .finally(() => setLoading(false));
  }, [rootId, path, configKey]);

  const rootsRef = useRef(roots);
  useEffect(() => { rootsRef.current = roots; }, [roots]);
  const selectedRef = useRef<{ rootId: string; path: string; name: string } | null>(null);
  useEffect(() => {
    selectedRef.current = selected ? { rootId, path, name: selected } : null;
  }, [selected, rootId, path]);

  // Register the Open handler (button bar). Returns a promise so 'on-success'
  // closes the modal only when the load resolves.
  useEffect(() => {
    actionRegistry.register('vfsOpenModal:open', async () => {
      const s = selectedRef.current;
      if (!s) { setError('Select a .json file to open.'); throw new Error('no-selection'); }
      const filePath = s.path ? `${s.path}/${s.name}` : s.name;
      const rootName = rootsRef.current.find((r) => r.id === s.rootId)?.virtual_name ?? '';
      setError(null);
      try {
        await props.onPick({ rootId: s.rootId, rootName, filePath, name: s.name, configKey });
      } catch (e) {
        setError(describe(e));
        throw e; // keep the modal open
      }
    });
    return () => actionRegistry.unregister('vfsOpenModal:open');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goUp = useCallback(() => setPath((p) => p.split('/').slice(0, -1).join('/')), []);
  const open = (e: VfsEntry) => {
    if (e.type === 'folder') setPath(path ? `${path}/${e.name}` : e.name);
    else if (isJson(e.name)) setSelected(e.name);
  };

  const crumbs = path ? path.split('/') : [];
  const visible = entries.filter((e) => e.type === 'folder' || isJson(e.name));

  return (
    <div className="modal-content-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Toolbar: root selector + breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <select
          className="dialog-input"
          style={{ width: 'auto', flex: '0 0 auto' }}
          value={rootId}
          onChange={(e) => { setRootId(e.target.value); setPath(''); }}
        >
          {roots.length === 0 && <option value="">(no roots)</option>}
          {roots.map((r) => <option key={r.id} value={r.id}>Application: {r.virtual_name}</option>)}
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
          <div style={st.empty}>No roots in this project. Add one in File ▸ Project Details ▸ VFS Roots.</div>
        )}
        {!loading && roots.length > 0 && visible.length === 0 && (
          <div style={st.empty}>No folders or .json files here.</div>
        )}
        {!loading && visible.map((e) => (
          <div
            key={e.name}
            style={{ ...st.row, ...(e.type === 'file' && selected === e.name ? st.rowActive : {}) }}
            onClick={() => open(e)}
            onDoubleClick={() => { if (e.type === 'file' && isJson(e.name)) { setSelected(e.name); actionRegistry.invoke('vfsOpenModal:open'); } }}
            title={e.name}
          >
            <span style={{ width: 18 }}>{e.type === 'folder' ? '📁' : '📄'}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
            {e.type === 'file' && <span style={st.size}>{formatSize(e.size_bytes)}</span>}
          </div>
        ))}
      </div>
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
  list: { border: '1px solid var(--border)', borderRadius: 6, height: 300, overflowY: 'auto', background: 'var(--bg)' },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderBottom: '1px solid var(--border)', cursor: 'pointer', fontSize: 13 },
  rowActive: { background: 'rgba(91,141,239,0.18)' },
  size: { fontSize: 11, color: 'var(--text-dim)' },
  empty: { padding: '20px 12px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 },
  error: { padding: '8px 10px', borderRadius: 6, background: 'rgba(211,83,79,0.12)', color: 'var(--danger, #d3534f)', fontSize: 12 },
};
