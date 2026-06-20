import { createPortal } from 'react-dom';
import { useAppState } from '../contexts/AppStateContext';
import { FloatingPanel } from './FloatingPanel';

/**
 * Renders all currently-floating (non-null doc.floating) document panels
 * into a fixed layer above the MDI workspace, portalled into document.body.
 */
export function FloatingPanelManager() {
  const { state } = useAppState();

  const floatingDocs = Object.values(state.documents).filter(
    doc => doc.floating !== null && doc.visible && !doc.poppedOut,
  );

  if (floatingDocs.length === 0) return null;

  return createPortal(
    <div className="floating-panel-layer">
      {floatingDocs.map(doc => (
        <FloatingPanel key={doc.instanceId} doc={doc} />
      ))}
    </div>,
    document.body,
  );
}
