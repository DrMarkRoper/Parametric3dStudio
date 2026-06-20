import { useCallback, useRef, useState } from 'react';
import type { DocumentPanelState, DocumentContainerState } from '../types';
import { useAppState } from '../contexts/AppStateContext';
import { DocumentPanel } from './DocumentPanel';

// ── Default minimum dimensions (overridden per-doc by floatMinWidth/Height) ──

const DEFAULT_MIN_W = 220;
const DEFAULT_MIN_H = 120;
const TITLEBAR_H    = 28;

// ── Stub container for floating panels ───────────────────────────────────
// Passed to DocumentPanel/DummyPanel in lieu of a real container.

function makeFloatingStub(doc: DocumentPanelState): DocumentContainerState {
  return {
    id: 'floating',
    instanceId: 'floating',
    widthPercent: 100,
    collapsed: false,
    visible: true,
    killed: false,
    allowTabs: false,
    allowClose: false,
    allowDragMove: false,
    forbidDropBefore: false,
    forbidDropAfter: false,
    forceCloseOnEmpty: false,
    killOnClose: false,
    resizable: false,
    defaultWidth: 400,
    defaultTitle: doc.title,
    prefixTitle: false,
    restrictTabToTypes: [],
    activeDocumentId: doc.instanceId,
    documentIds: [doc.instanceId],
    rowId: 'row-top',
    rowIndex: -1,
  };
}

// ── Resize handle directions ──────────────────────────────────────────────

const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type ResizeDir = typeof RESIZE_DIRS[number];

// ── FloatingPanel ─────────────────────────────────────────────────────────

interface Props {
  doc: DocumentPanelState;
}

export function FloatingPanel({ doc }: Props) {
  const { dispatch } = useAppState();
  const float = doc.floating!;

  // Per-doc resize settings (with built-in fallbacks)
  const resizable = doc.floatResizable !== false;
  const minW = doc.floatMinWidth  ?? DEFAULT_MIN_W;
  const minH = doc.floatMinHeight ?? DEFAULT_MIN_H;

  // Live position while dragging the title bar (null = not dragging)
  const [livePos, setLivePos] = useState<{ x: number; y: number } | null>(null);
  const isDragging = livePos !== null;

  const displayX = livePos?.x ?? float.x;
  const displayY = livePos?.y ?? float.y;

  const containerStub = useRef(makeFloatingStub(doc)).current;

  // ── Bring to front on any interaction ─────────────────────────────────
  const bringToFront = useCallback(() => {
    dispatch({ type: 'BRING_FLOAT_TO_FRONT', docInstanceId: doc.instanceId });
  }, [doc.instanceId, dispatch]);

  // ── Title bar drag → move panel (no drop targets) ─────────────────────
  const handleTitleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    bringToFront();

    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startX = float.x;
    const startY = float.y;

    // Clamp y >= 0 so the title bar — the only grab handle — cannot be
    // dragged above the viewport top. Without this the panel becomes
    // unreachable and the user has no way to recover it.
    const onMove = (me: MouseEvent) => {
      setLivePos({
        x: startX + (me.clientX - startMouseX),
        y: Math.max(0, startY + (me.clientY - startMouseY)),
      });
    };

    const onUp = (me: MouseEvent) => {
      const finalX = startX + (me.clientX - startMouseX);
      const finalY = Math.max(0, startY + (me.clientY - startMouseY));
      setLivePos(null);
      dispatch({ type: 'SET_FLOAT_GEOMETRY', docInstanceId: doc.instanceId, x: finalX, y: finalY });
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [doc.instanceId, float.x, float.y, dispatch, bringToFront]);

  // ── Resize handle drag ────────────────────────────────────────────────
  const handleResizeMouseDown = useCallback((e: React.MouseEvent, dir: ResizeDir) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    bringToFront();

    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { x: float.x, y: float.y, w: float.width, h: float.height };

    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      let newX = orig.x, newY = orig.y, newW = orig.w, newH = orig.h;

      if (dir.includes('e')) newW = Math.max(minW, orig.w + dx);
      if (dir.includes('s')) newH = Math.max(minH, orig.h + dy);
      if (dir.includes('w')) {
        newW = Math.max(minW, orig.w - dx);
        newX = orig.x + (orig.w - newW);
      }
      if (dir.includes('n')) {
        newH = Math.max(minH, orig.h - dy);
        newY = orig.y + (orig.h - newH);
      }

      dispatch({ type: 'SET_FLOAT_GEOMETRY', docInstanceId: doc.instanceId, x: newX, y: newY, width: newW, height: newH });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };

    document.body.style.cursor = `${dir}-resize`;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [doc.instanceId, float, minW, minH, dispatch, bringToFront]);

  // ── Title bar button actions ──────────────────────────────────────────
  const handleMinimize = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'MINIMIZE_FLOAT', docInstanceId: doc.instanceId });
  }, [doc.instanceId, dispatch]);

  const handleDockBack = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'RESTORE_DOCUMENT', docInstanceId: doc.instanceId });
  }, [doc.instanceId, dispatch]);

  const handlePopOut = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!doc.closedState) return;
    // Side-effect (window.open) is handled by a useEffect in App.tsx watching poppedOut docs
    dispatch({
      type: 'POP_OUT_DOCUMENT',
      docInstanceId: doc.instanceId,
      containerInstanceId: doc.closedState.containerId,
      rowId: doc.closedState.rowId,
      containerIndex: doc.closedState.containerIndex,
    });
  }, [doc, dispatch]);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dispatch({ type: 'CLOSE_FLOATING', docInstanceId: doc.instanceId });
  }, [doc.instanceId, dispatch]);

  const panelHeight = float.minimized ? TITLEBAR_H : float.height;

  return (
    <div
      className={`floating-panel${float.minimized ? ' minimized' : ''}${isDragging ? ' moving' : ''}`}
      style={{
        position: 'absolute',
        left: displayX,
        top: displayY,
        width: float.width,
        height: panelHeight,
        zIndex: float.zIndex,
        minWidth: minW,
        minHeight: float.minimized ? TITLEBAR_H : minH,
      }}
      onMouseDown={bringToFront}
    >
      {/* ── Resize handles (hidden when minimized or resizable disabled) ── */}
      {!float.minimized && resizable && RESIZE_DIRS.map(dir => (
        <div
          key={dir}
          className={`floating-panel-resize ${dir}`}
          onMouseDown={e => handleResizeMouseDown(e, dir)}
        />
      ))}

      {/* ── Title bar ────────────────────────────────────────────── */}
      <div
        className={`floating-panel-titlebar${isDragging ? ' dragging' : ''}`}
        onMouseDown={handleTitleMouseDown}
      >
        <span className="floating-panel-title">{doc.title}</span>

        <button
          className="floating-panel-btn"
          title={float.minimized ? 'Restore' : 'Minimize'}
          onMouseDown={e => e.stopPropagation()}
          onClick={handleMinimize}
        >
          {float.minimized ? '□' : '−'}
        </button>

        <button
          className="floating-panel-btn"
          title="Dock back to MDI"
          onMouseDown={e => e.stopPropagation()}
          onClick={handleDockBack}
        >
          ⊟
        </button>

        <button
          className="floating-panel-btn"
          title="Pop out to browser window"
          onMouseDown={e => e.stopPropagation()}
          onClick={handlePopOut}
        >
          ⧉
        </button>

        <button
          className="floating-panel-btn close-btn"
          title="Close"
          onMouseDown={e => e.stopPropagation()}
          onClick={handleClose}
        >
          ×
        </button>
      </div>

      {/* ── Panel content (hidden when minimized) ────────────────── */}
      {!float.minimized && (
        <div className="floating-panel-body">
          <DocumentPanel doc={doc} container={containerStub} />
        </div>
      )}
    </div>
  );
}
