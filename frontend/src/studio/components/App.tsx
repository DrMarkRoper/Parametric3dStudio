import { useEffect, useMemo, useRef } from 'react';
import { regenerate } from '../core/buildGeometry';
import { confirmDeleteFeature, importCache, useStore } from '../state/store';
import { Toolbar } from './Toolbar';
import { SidePanel } from './SidePanel';
import { PropertiesPanel } from './PropertiesPanel';
import { Viewport } from './Viewport';
import { StatusBar } from './StatusBar';

export function App() {
  const doc = useStore((s) => s.doc);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const mode = useStore((s) => s.mode);
  const selectedFeatureId = useStore((s) => s.selectedFeatureId);
  const deleteFeature = useStore((s) => s.deleteFeature);

  const revRef = useRef(0);
  const { regen, rev } = useMemo(() => {
    revRef.current += 1;
    return { regen: regenerate(doc, importCache), rev: revRef.current };
  }, [doc]);

  // Global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && mode === 'model' && selectedFeatureId) {
        e.preventDefault();
        confirmDeleteFeature(selectedFeatureId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, mode, selectedFeatureId, deleteFeature]);

  return (
    <div className="app">
      <Toolbar bodies={regen.bodies} />
      <div className="main">
        <SidePanel params={regen.params} paramErrors={regen.paramErrors} featureErrors={regen.errors} />
        <div className="viewport-wrap">
          <Viewport bodies={regen.bodies} rev={rev} params={regen.params} />
        </div>
        <PropertiesPanel params={regen.params} bodies={regen.bodies} />
      </div>
      <StatusBar errors={regen.errors} paramErrors={regen.paramErrors} />
    </div>
  );
}
