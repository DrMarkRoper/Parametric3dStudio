import { useAppState } from '../contexts/AppStateContext';
import { useStore } from '../studio/state/store';

export interface TitleBarProps {
  /**
   * Optional secondary label rendered after the project name.
   * Omit for the default appearance.
   */
  subtitle?: string;
}

export function TitleBar({ subtitle }: TitleBarProps = {}) {
  const { state, dispatch } = useAppState();
  const isDark = state.theme === 'dark';

  // Project name from the studio store. The em-dash always shows the project
  // name (or 'unsaved' when there is no name yet). A '*' marker appears when
  // there are unsaved changes.
  const projectName = useStore((s) => s.projectMeta.name);
  const dirty       = useStore((s) => s.dirty);
  const displayName = (projectName && projectName.trim()) ? projectName : 'unsaved';

  return (
    <div className="titlebar">
      <span className="titlebar-title">Parametric3dStudio v.0.1</span>
      <span className="titlebar-version">— {displayName}{dirty ? ' *' : ''}</span>
      {subtitle && <span className="titlebar-version">— {subtitle}</span>}
      <div className="titlebar-rhs">
        <button
          className="theme-toggle"
          onClick={() => dispatch({ type: 'SET_THEME', theme: isDark ? 'light' : 'dark' })}
          title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
          {isDark ? '☀️' : '🌙'}
        </button>
      </div>
    </div>
  );
}
