import { useEffect } from 'react';
import { useAppState } from '../contexts/AppStateContext';

export function StatusBar() {
  const { state, dispatch } = useAppState();
  const { visible, allowClose, text, interruptText, interruptDuration } = state.statusBar;

  // Auto-clear the interrupt after its duration expires.
  // If a new interrupt arrives while one is running, the old timer is cancelled
  // automatically by the effect cleanup and a fresh timer starts.
  useEffect(() => {
    if (!interruptText || !interruptDuration) return;
    const timer = setTimeout(
      () => dispatch({ type: 'CLEAR_STATUS_INTERRUPT' }),
      interruptDuration,
    );
    return () => clearTimeout(timer);
  }, [interruptText, interruptDuration, dispatch]);

  // Show interrupt text while active, fall back to the permanent message.
  const displayText = interruptText ?? text;

  return (
    <div className="statusbar">
      {visible && <span className="statusbar-text">{displayText || ' '}</span>}
      {visible && allowClose && (
        <button
          className="statusbar-close"
          title="Hide status bar (restore from View menu)"
          onClick={() => dispatch({ type: 'TOGGLE_STATUS_BAR' })}
        >
          ×
        </button>
      )}
    </div>
  );
}
