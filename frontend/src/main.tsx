import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './studio/studio.css';
import { App } from './App';
import { AppStateProvider, useAppState } from './contexts/AppStateContext';
import { DocumentPanel } from './components/DocumentPanel';
import { loadInitialState } from './utils/layoutSerializer';
import type { AppState, DocumentContainerState } from './types';

// ── Popout window ─────────────────────────────────────────────────────────
// When main.tsx is loaded with URL hash "#popout=<instanceId>", render only
// the target panel in full-screen (no MDI shell).

function PopoutInner({ docId }: { docId: string }) {
  const { state } = useAppState();
  const doc = state.documents[docId];

  // Stub container for the floating panel host
  const stub: DocumentContainerState = {
    id: 'popout', instanceId: 'popout',
    widthPercent: 100, collapsed: false, visible: true, killed: false,
    allowTabs: false, allowClose: false, allowDragMove: false,
    forbidDropBefore: false, forbidDropAfter: false,
    forceCloseOnEmpty: false, killOnClose: false,
    resizable: false, defaultWidth: 800,
    defaultTitle: doc?.title ?? 'Panel', prefixTitle: false,
    restrictTabToTypes: [],
    activeDocumentId: docId, documentIds: [docId],
    rowId: 'row-top', rowIndex: 0,
  };

  // Signal main window when this popout is about to close
  useEffect(() => {
    const signal = () => {
      localStorage.setItem(`mdi:popout-closed:${docId}`, Date.now().toString());
    };
    window.addEventListener('beforeunload', signal);
    // Also listen for state updates from the main window (via localStorage)
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'mdi:layout') {
        // Main window persisted a new state; could reload, but skip for v1
        // (the panel just keeps its initial state from when the window opened)
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('beforeunload', signal);
      window.removeEventListener('storage', handleStorage);
    };
  }, [docId]);

  if (!doc) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: '#888', fontSize: 13, fontFamily: 'Segoe UI, sans-serif',
      }}>
        Panel not found (id: {docId})
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)', overflow: 'hidden',
    }}>
      {/* Minimal title bar */}
      <div className="container-titlebar" style={{ flexShrink: 0 }}>
        <span className="container-titlebar-title">{doc.title}</span>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 8 }}>— Pop Out</span>
      </div>
      {/* Panel content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <DocumentPanel doc={doc} container={stub} />
      </div>
    </div>
  );
}

function PopoutApp({ docId }: { docId: string }) {
  const [appState, setAppState] = useState<AppState | null>(null);

  useEffect(() => {
    // Apply theme before render
    const theme = (localStorage.getItem('mdi:theme') as 'dark' | 'light') ?? 'dark';
    document.documentElement.dataset.theme = theme;

    loadInitialState().then(setAppState).catch(console.error);
  }, []);

  if (!appState) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: '#f5a623', fontFamily: 'Segoe UI, sans-serif',
        background: '#1c1c1e', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ fontSize: 32 }}>🗂</div>
        <div style={{ fontSize: 14 }}>Loading…</div>
      </div>
    );
  }

  return (
    <AppStateProvider initialState={appState}>
      <PopoutInner docId={docId} />
    </AppStateProvider>
  );
}

// ── Entry point ───────────────────────────────────────────────────────────

const hashMatch = window.location.hash.match(/^#popout=(.+)$/);
const popoutDocId = hashMatch ? decodeURIComponent(hashMatch[1]) : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {popoutDocId ? <PopoutApp docId={popoutDocId} /> : <App />}
  </StrictMode>
);
