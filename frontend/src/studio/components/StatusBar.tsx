import { create } from 'zustand';
import { useStore } from '../state/store';
import type { SnapMode } from '../types';
import type { DynamicOp } from '../state/store';
import { formatNum } from './SidePanel';

/** High-frequency cursor readout kept in its own store so only the status bar re-renders. */
export const useCursorStore = create<{ pos: { x: number; y: number } | null; set: (p: { x: number; y: number } | null) => void }>(
  (set) => ({ pos: null, set: (pos) => set({ pos }) })
);

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

export function StatusBar({
  errors,
  paramErrors,
}: {
  errors: { featureId: string; message: string }[];
  paramErrors: Record<string, string>;
}) {
  const mode = useStore((s) => s.mode);
  const tool = useStore((s) => s.tool);
  const facePick = useStore((s) => s.facePick);
  const gridSize = useStore((s) => s.doc.gridSize);
  const snap = useStore((s) => s.doc.snap);
  const setGrid = useStore((s) => s.setGrid);
  const setSnap = useStore((s) => s.setSnap);
  const cursor = useCursorStore((s) => s.pos);

  const mergePick = useStore((s) => s.mergePick);
  const dynamicOp = useStore((s) => s.dynamicOp) as DynamicOp | null;
  const dynHint = (op: DynamicOp): string => {
    if (op.kind === 'move') {
      return op.grabPt === null
        ? 'Dynamic Move: click a grab point on the canvas — entities will follow your mouse'
        : 'Dynamic Move: move mouse to position, click to confirm · Esc cancels';
    }
    return op.grabPt === null
      ? 'Dynamic Rotate: click the rotation origin on the canvas'
      : 'Dynamic Rotate: move mouse to rotate · click to confirm · type a number for exact angle · Esc cancels';
  };
  const hint = dynamicOp
    ? dynHint(dynamicOp)
    : facePick
    ? 'Click inside a closed region to select/deselect it · Accept creates the extrude (set its distance in the right panel) · Esc cancels'
    : mergePick
      ? mergePick.secondId
        ? 'Choose the merge operation in the toolbar (cut / fuse / intersect) — or click a different second object'
        : 'Click the second object in the viewport to merge with'
      : HINTS[`${mode}:${tool}`] ?? HINTS['model:select'];
  const allErrors = [
    ...Object.entries(paramErrors).map(([n, m]) => `${n}: ${m}`),
    ...errors.map((e) => e.message),
  ];

  return (
    <div className="statusbar">
      <span className="hint">{hint}</span>
      {allErrors.length > 0 && (
        <span className="errors" title={allErrors.join('\n')}>
          ⚠ {allErrors[0]}
          {allErrors.length > 1 ? ` (+${allErrors.length - 1} more)` : ''}
        </span>
      )}
      <span className="coords">
        {mode === 'sketch' && cursor ? `x ${formatNum(cursor.x)}  y ${formatNum(cursor.y)}` : ''}
      </span>
      <span className="grid-ctl">
        Grid
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
