/**
 * StudioStatusBar — replaces the framework's generic MDI StatusBar in this app.
 * Renders the modelling-context status (mode/tool hint, errors, cursor coords,
 * grid step, snap mode) inside the framework status-bar slot so the canvas
 * panel no longer needs its own bottom strip. Also surfaces the MDI
 * SET_STATUS_INTERRUPT toast text (with auto-clear) in place of the hint while
 * an interrupt is active. The framework "× hide" button is intentionally
 * omitted — the status bar is always visible here.
 */
import { useEffect } from 'react';
import { useAppState } from '../contexts/AppStateContext';
import { useStore, type DynamicOp } from '../studio/state/store';
import { useCursorStore } from '../studio/components/StatusBar';
import { useRegen } from '../studio/studioBridge';
import { formatNum } from '../studio/components/SidePanel';
import type { SnapMode } from '../studio/types';

const HINTS: Record<string, string> = {
  'model:select': 'Click a body to select · double-click a sketch in the tree to edit it · Del deletes the selected feature',
  'sketch:select': 'Click an entity to select it (drag to move) · edit values in the right panel · Del deletes it',
  'sketch:line': 'Click to place points (chains) · type a number for exact length · Enter/Esc ends the chain · close the loop to make a profile',
  'sketch:rect': 'Click two corners · or click once and type width,height',
  'sketch:circle': 'Click center, then radius · or type the radius',
  'sketch:fillet': 'Click a corner (two joined lines or a rectangle corner), then enter the radius',
  'sketch:chamfer': 'Click a corner, then enter the chamfer distance',
  'sketch:image': 'Click to set one corner, then click (or drag) to set the opposite corner — edit size/fit in the right panel',
};

function describeDynamicOp(op: DynamicOp): string {
  if (op.kind === 'move') {
    return op.grabPt === null
      ? 'Dynamic Move: click a grab point on the canvas — entities will follow your mouse'
      : 'Dynamic Move: move mouse to position, click to confirm · Esc cancels';
  }
  return op.grabPt === null
    ? 'Dynamic Rotate: click the rotation origin on the canvas'
    : 'Dynamic Rotate: move mouse to rotate · click to confirm · type a number for exact angle · Esc cancels';
}

export function StudioStatusBar() {
  const { state, dispatch } = useAppState();
  const { visible, interruptText, interruptDuration } = state.statusBar;

  // Auto-clear interrupt text after its duration expires.
  useEffect(() => {
    if (!interruptText || !interruptDuration) return;
    const timer = setTimeout(
      () => dispatch({ type: 'CLEAR_STATUS_INTERRUPT' }),
      interruptDuration,
    );
    return () => clearTimeout(timer);
  }, [interruptText, interruptDuration, dispatch]);

  // Studio state for hints and controls
  const mode      = useStore((s) => s.mode);
  const tool      = useStore((s) => s.tool);
  const facePick  = useStore((s) => s.facePick);
  const mergePick = useStore((s) => s.mergePick);
  const dynamicOp = useStore((s) => s.dynamicOp) as DynamicOp | null;
  const gridSize  = useStore((s) => s.doc.gridSize);
  const snap      = useStore((s) => s.doc.snap);
  const setGrid   = useStore((s) => s.setGrid);
  const setSnap   = useStore((s) => s.setSnap);
  const cursor    = useCursorStore((s) => s.pos);
  const warnings  = useStore((s) => s.assembly.warnings);
  const { regen } = useRegen();

  if (!visible) return null;

  const hint = interruptText
    ? interruptText
    : dynamicOp
      ? describeDynamicOp(dynamicOp)
      : facePick
        ? 'Click inside a closed region to select/deselect it · Accept creates the extrude (set its distance in the right panel) · Esc cancels'
        : mergePick
          ? mergePick.secondId
            ? 'Choose the merge operation in the toolbar (cut / fuse / intersect) — or click a different second object'
            : 'Click the second object in the viewport to merge with'
          : mode === 'assembly'
            ? 'Assembly mode — click a body then add a joint · drag a joint handle to drive it · link joints to couple them · changes here are non-permanent'
            : HINTS[`${mode}:${tool}`] ?? HINTS['model:select'];

  const allErrors = [
    ...warnings,
    ...Object.entries(regen.paramErrors).map(([n, m]) => `${n}: ${m}`),
    ...regen.errors.map((e) => e.message),
  ];

  return (
    <div className="statusbar studio-statusbar">
      <span className="studio-statusbar-hint">{hint}</span>
      {allErrors.length > 0 && (
        <span className="studio-statusbar-errors" title={allErrors.join('\n')}>
          ⚠ {allErrors[0]}
          {allErrors.length > 1 ? ` (+${allErrors.length - 1} more)` : ''}
        </span>
      )}
      <span className="studio-statusbar-coords">
        {mode === 'sketch' && cursor ? `x ${formatNum(cursor.x)}  y ${formatNum(cursor.y)}` : ''}
      </span>
      <span className="studio-statusbar-grid">
        <label>Grid</label>
        <input
          type="number"
          min={0.1}
          step={1}
          value={gridSize}
          onChange={(e) => setGrid(parseFloat(e.target.value) || gridSize)}
        />
        <select
          value={snap}
          title="Snap mode: None, Grid (align to grid), Edge (snap to geometric points)"
          onChange={(e) => setSnap(e.target.value as SnapMode)}
        >
          <option value="none">No snap</option>
          <option value="grid">Grid snap</option>
          <option value="edge">Edge snap</option>
        </select>
      </span>
    </div>
  );
}
