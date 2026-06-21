/**
 * ProjectDetailsModal — the File ▸ Project Details… dialog.
 *
 * Two tabs:
 *   • General   — project id (read-only UUID), name, description, dates.
 *                 Saved into projectMeta in place (no file write); marks dirty.
 *   • VFS Roots — the VFS roots for this project (config key = project id) on
 *                 the connected server/application. Disabled until both a server
 *                 URL and a project name are set.
 *
 * The button bar's Save (projectDetailsModal:save) commits the General tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModalState } from '../../types';
import { actionRegistry } from '../../utils/actionRegistry';
import { useStore } from '../../studio/state/store';
import { loadVfsConfig } from '../../vfs/vfsClient';
import {
  listProjectRoots,
  VfsApiError,
  type AdminRoot,
} from '../../vfs/vfsAdmin';

type Tab = 'general' | 'roots';

/** The application-level VFS config key (shared roots, not project-specific). */
const APP_CONFIG_KEY = 'config';

/** A Default-Folder dropdown option (a root under a specific config). */
interface RootOption { config: string; id: string; name: string; value: string; label: string }

export function ProjectDetailsModal({ onClose }: { modal: ModalState; onClose: () => void }) {
  const meta = useStore((s) => s.projectMeta);
  const conn = loadVfsConfig();

  const [tab, setTab] = useState<Tab>('general');
  const [name, setName] = useState(meta.name ?? '');
  const [description, setDescription] = useState(meta.description ?? '');

  const formRef = useRef({ name, description });
  useEffect(() => { formRef.current = { name, description }; });

  // Commit General-tab edits to projectMeta on Save (button bar invokes this).
  useEffect(() => {
    actionRegistry.register('projectDetailsModal:save', () => {
      const cur = useStore.getState().projectMeta;
      useStore.getState().setProjectMeta({
        ...cur,
        name: formRef.current.name.trim() || null,
        description: formRef.current.description,
      });
      useStore.setState({ dirty: true });
    });
    return () => actionRegistry.unregister('projectDetailsModal:save');
    // onClose stable for the modal's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const serverSet = Boolean(conn.serverUrl.trim());
  const nameSet = Boolean(name.trim());
  const rootsEnabled = serverSet && nameSet;

  // If the VFS tab becomes disabled (name cleared), fall back to General.
  useEffect(() => { if (!rootsEnabled && tab === 'roots') setTab('general'); }, [rootsEnabled, tab]);

  const fmtDate = (iso: string | null) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const rootsDisabledReason = !serverSet
    ? 'Set a VFS server in File ▸ Application Settings to manage roots.'
    : !nameSet
    ? 'Give the project a name to manage its VFS roots.'
    : '';

  return (
    <div className="modal-content-pad" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Tab strip */}
      <div style={st.tabBar}>
        <TabButton label="General" active={tab === 'general'} onClick={() => setTab('general')} />
        <TabButton
          label="VFS Roots"
          active={tab === 'roots'}
          disabled={!rootsEnabled}
          title={rootsEnabled ? undefined : rootsDisabledReason}
          onClick={() => rootsEnabled && setTab('roots')}
        />
      </div>

      {tab === 'general' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 14 }}>
          <div className="dialog-field" style={{ marginTop: 0 }}>
            <label className="dialog-field-label">Project ID</label>
            <input
              className="dialog-input"
              value={meta.projectId}
              readOnly
              onFocus={(e) => e.target.select()}
              style={{ fontFamily: 'monospace', color: 'var(--text-dim)' }}
            />
          </div>

          <div className="dialog-field" style={{ marginTop: 0 }}>
            <label className="dialog-field-label">Project name</label>
            <input
              className="dialog-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Parametric Project"
              autoFocus
            />
          </div>

          <div className="dialog-field" style={{ marginTop: 0 }}>
            <label className="dialog-field-label">Description</label>
            <textarea
              className="dialog-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this project is for…"
              style={{ resize: 'vertical', minHeight: 64, fontFamily: 'inherit' }}
            />
          </div>

          {meta.defaultFilePath && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              File location: {meta.defaultRootConfig === APP_CONFIG_KEY ? 'Application' : 'Project'}: {meta.defaultRootName ?? '—'}/{meta.defaultFilePath}
            </div>
          )}

          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            Created: {fmtDate(meta.createdAt)} · Modified: {fmtDate(meta.modifiedAt)}
          </div>
        </div>
      )}

      {tab === 'roots' && (
        <div style={{ paddingTop: 14 }}>
          <VfsRootsPanel
            projectId={meta.projectId}
            projectName={name.trim()}
            description={description}
          />
        </div>
      )}
    </div>
  );
}

function TabButton({
  label, active, disabled, title, onClick,
}: {
  label: string; active: boolean; disabled?: boolean; title?: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...st.tab,
        ...(active ? st.tabActive : {}),
        ...(disabled ? st.tabDisabled : {}),
      }}
    >
      {label}
    </button>
  );
}

// ── VFS Roots panel ──────────────────────────────────────────────────────────

function VfsRootsPanel({
  projectId, projectName, description,
}: {
  projectId: string; projectName: string; description: string;
}) {
  const [roots, setRoots] = useState<AdminRoot[]>([]);          // this project's roots (config = projectId)
  const [appRoots, setAppRoots] = useState<AdminRoot[]>([]);    // application default config roots ('config')
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultRootId = useStore((s) => s.projectMeta.defaultRootId);
  const defaultRootConfig = useStore((s) => s.projectMeta.defaultRootConfig);

  const setDefaultRoot = useCallback((config: string, rootId: string, rootName: string) => {
    const cur = useStore.getState().projectMeta;
    if (cur.defaultRootId === rootId && cur.defaultRootConfig === config) return;
    useStore.getState().setProjectMeta({
      ...cur, defaultRootId: rootId, defaultRootConfig: config, defaultRootName: rootName,
    });
    useStore.setState({ dirty: true });
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([listProjectRoots(projectId), listProjectRoots(APP_CONFIG_KEY)])
      .then(([proj, app]) => { setRoots(proj); setAppRoots(app); })
      .catch((e) => setError(e instanceof VfsApiError ? `${e.code}: ${e.message}` : String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => { reload(); }, [reload]);

  // Combined picker options: application 'config' roots first (prefixed), then
  // this project's own roots. value encodes the config key + root id.
  const options = useMemo<RootOption[]>(() => [
    ...appRoots.map((r): RootOption => ({
      config: APP_CONFIG_KEY, id: r.id, name: r.virtual_name, value: `${APP_CONFIG_KEY}::${r.id}`,
      label: `Application: ${r.virtual_name}`,
    })),
    ...roots.map((r): RootOption => ({
      config: projectId, id: r.id, name: r.virtual_name, value: `${projectId}::${r.id}`,
      label: r.virtual_name,
    })),
  ], [appRoots, roots, projectId]);

  // First option auto-set as default when none chosen / the current one is gone.
  useEffect(() => {
    if (options.length === 0) return;
    const cur = useStore.getState().projectMeta;
    const stillValid = options.some((o) => o.id === cur.defaultRootId && o.config === cur.defaultRootConfig);
    if (!stillValid) setDefaultRoot(options[0].config, options[0].id, options[0].name);
  }, [options, setDefaultRoot]);

  const currentValue = defaultRootId && defaultRootConfig ? `${defaultRootConfig}::${defaultRootId}` : '';

  const openAddFolder = () => {
    actionRegistry.invoke('studio:_openAddRoot', {
      props: { projectId, projectName, description, onCreated: reload },
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Roots for this project (topic <code style={{ fontFamily: 'monospace' }}>{shortId(projectId)}</code>)
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="modal-btn" onClick={reload} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button type="button" className="modal-btn" onClick={openAddFolder}>+ Add folder</button>
      </div>

      {error && <div style={st.error}>{error}</div>}

      {options.length > 0 && (
        <div style={st.defaultBox}>
          <label className="dialog-field-label" style={{ marginBottom: 4 }}>Default Folder</label>
          <select
            className="dialog-input"
            value={currentValue}
            onChange={(e) => {
              const opt = options.find((o) => o.value === e.target.value);
              if (opt) setDefaultRoot(opt.config, opt.id, opt.name);
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-dim)' }}>
            This is where the project file will be saved to.
          </p>
        </div>
      )}

      <div style={st.rootList}>
        {roots.length === 0 && !loading && !error && (
          <div style={st.empty}>No roots in this project yet.</div>
        )}
        {roots.map((r) => (
          <div key={r.id} style={st.rootRow}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {r.virtual_name}
                {!r.enabled && <span style={st.badgeOff}>disabled</span>}
              </div>
              {r.real_path && (
                <div style={st.path} title={r.real_path}>{r.real_path}</div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                {r.allow_subfolders ? 'subfolders' : 'top-level only'}
                {' · '}
                {r.allowed_file_types?.includes('*') || !r.allowed_file_types?.length
                  ? 'all file types'
                  : r.allowed_file_types.join(', ')}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

// ── styles ───────────────────────────────────────────────────────────────────

const st: Record<string, React.CSSProperties> = {
  tabBar: { display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' },
  tab: {
    padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer',
    color: 'var(--text-dim)', fontSize: 13, fontWeight: 600,
    borderBottom: '2px solid transparent', marginBottom: -1,
  },
  tabActive: { color: 'var(--text)', borderBottomColor: 'var(--accent)' },
  tabDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  defaultBox: { display: 'flex', flexDirection: 'column', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' },
  rootList: {
    border: '1px solid var(--border)', borderRadius: 6, maxHeight: 260, overflowY: 'auto',
    background: 'var(--bg)',
  },
  rootRow: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
    borderBottom: '1px solid var(--border)',
  },
  path: { fontSize: 12, color: 'var(--text-dim)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  empty: { padding: '20px 12px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 },
  error: { padding: '8px 10px', borderRadius: 6, background: 'rgba(211,83,79,0.12)', color: 'var(--danger, #d3534f)', fontSize: 12 },
  badgeOff: { marginLeft: 8, fontSize: 10, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 8, padding: '1px 6px' },
};
