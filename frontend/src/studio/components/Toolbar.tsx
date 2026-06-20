import { useRef } from 'react';
import {
  BODY_COLORS,
  PRIMITIVE_DEFAULTS,
  uid,
  type BooleanFeature,
  type ExtrudeFeature,
  type ImportFeature,
  type MergeOp,
  type PlaneId,
  type PrimitiveFeature,
  type PrimitiveShape,
  type SketchFeature,
} from '../types';
import { importCache, nextName, useStore, type PendingImage } from '../state/store';
import { exportSTL, loadProject, saveProject } from '../io/exporters';
import { IMPORT_EXTENSIONS, importModelFile } from '../io/importers';
import type { BodyOut } from '../core/buildGeometry';

let colorIdx = 0;
const nextColor = () => BODY_COLORS[colorIdx++ % BODY_COLORS.length];

export function Toolbar({ bodies }: { bodies: BodyOut[] }) {
  const s = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const projRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);

  const onPickImage = async (files: FileList | null) => {
    if (!files?.[0]) return;
    const file = files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      const img = new Image();
      img.onload = () => {
        const pending: PendingImage = {
          src,
          fileName: file.name,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        };
        s.setPendingImage(pending);
        s.setTool('image');
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
    if (imgRef.current) imgRef.current.value = '';
  };

  const newSketch = (plane: PlaneId) => {
    const f: SketchFeature = {
      id: uid(),
      type: 'sketch',
      name: nextName(s.doc, 'Sketch'),
      visible: true,
      plane,
      offset: '0',
      entities: [],
      corners: [],
    };
    s.addFeature(f);
    s.enterSketch(f.id);
  };

  const addPrimitive = (shape: PrimitiveShape) => {
    const def = PRIMITIVE_DEFAULTS[shape];
    const f: PrimitiveFeature = {
      id: uid(),
      type: 'primitive',
      name: nextName(s.doc, shape[0].toUpperCase() + shape.slice(1)),
      visible: true,
      shape,
      dims: { ...def.dims },
      position: ['0', def.y, '0'],
      rotation: ['0', '0', '0'],
      op: 'new',
      color: nextColor(),
    };
    s.addFeature(f);
  };

  const selected = s.doc.features.find((f) => f.id === s.selectedFeatureId);
  const sketchForExtrude =
    s.mode === 'sketch'
      ? s.activeSketchId
      : selected?.type === 'sketch'
        ? selected.id
        : null;

  /** Start face selection for extrude (entering the sketch first if needed). */
  const startExtrude = () => {
    if (!sketchForExtrude) return;
    if (s.mode !== 'sketch') s.enterSketch(sketchForExtrude);
    s.startFacePick(sketchForExtrude);
  };

  /** Create the extrude feature from the picked faces (none picked = all profiles). */
  const acceptExtrude = () => {
    const fp = s.facePick;
    if (!fp) return;
    const f: ExtrudeFeature = {
      id: uid(),
      type: 'extrude',
      name: nextName(s.doc, 'Extrude'),
      visible: true,
      sketchId: fp.sketchId,
      distance: '20',
      op: 'new',
      color: nextColor(),
      regionPts: fp.pts.length ? fp.pts : undefined,
    };
    s.cancelFacePick();
    s.exitSketch();
    s.addFeature(f);
  };

  const onImport = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      try {
        const res = await importModelFile(file);
        const id = uid();
        importCache.set(id, res.geometry);
        const f: ImportFeature = {
          id,
          type: 'import',
          name: file.name,
          visible: true,
          fileName: file.name,
          position: [0, res.groundY, 0],
          rotation: [0, 0, 0],
          scale: 1,
          color: res.color ?? nextColor(),
        };
        s.addFeature(f);
      } catch (e) {
        alert(`Import failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const onOpenProject = async (files: FileList | null) => {
    if (!files?.[0]) return;
    try {
      // Clear the cache BEFORE loading — loadProject re-populates it with any
      // embedded geometries restored from the project file.
      importCache.clear();
      const { doc } = await loadProject(files[0]);
      s.setDoc(doc);
      s.select(null);
      // Only warn about non-embedded imports — embedded bodies (Detach / baked merges)
      // are restored from the project file itself.
      const missing = doc.features.filter(
        (f) => f.type === 'import' && !(f as ImportFeature).embedded && !importCache.has(f.id)
      );
      if (missing.length) {
        alert(
          `Note: ${missing.length} imported mesh file${missing.length > 1 ? 's are' : ' is'} not stored in project files — re-import.`
        );
      }
    } catch (e) {
      alert(`Open failed: ${e instanceof Error ? e.message : e}`);
    }
    if (projRef.current) projRef.current.value = '';
  };

  /* face-sketch-mode: waiting for user to click a face */
  if (s.faceSketchMode) {
    return (
      <div className="toolbar">
        <span className="group-label">Sketch on Face — click any face to create a new sketch aligned to it</span>
        <div className="sep" />
        <button onClick={() => s.cancelFaceSketchMode()}>✕ Cancel</button>
      </div>
    );
  }

  /* merge-pick session (model mode) */
  if (s.mergePick) {
    const A = s.doc.features.find((f) => f.id === s.mergePick!.firstId);
    const B = s.mergePick.secondId ? s.doc.features.find((f) => f.id === s.mergePick!.secondId) : undefined;
    const createMerge = (op: MergeOp, swap = false) => {
      if (!A || !B) return;
      const f: BooleanFeature = {
        id: uid(),
        type: 'boolean',
        name: nextName(s.doc, 'Merge'),
        visible: true,
        op,
        targetId: swap ? B.id : A.id,
        toolId: swap ? A.id : B.id,
        color: 'color' in A ? (A.color as string) : nextColor(),
        opacity: 'opacity' in A ? A.opacity : undefined,
      };
      s.cancelMergePick();
      s.addFeature(f);
    };
    return (
      <div className="toolbar">
        {!B ? (
          <span className="group-label">Merge: "{A?.name}" selected — now click the second object in the viewport</span>
        ) : (
          <>
            <span className="group-label">
              A = "{A?.name}", B = "{B.name}":
            </span>
            <button onClick={() => createMerge('cut')}>Cut A − B</button>
            <button onClick={() => createMerge('cut', true)}>Cut B − A</button>
            <button onClick={() => createMerge('fuse')}>Fuse A + B</button>
            <button onClick={() => createMerge('intersect')}>Intersect A ∩ B</button>
          </>
        )}
        <div className="sep" />
        <button onClick={() => s.cancelMergePick()}>✕ Cancel</button>
      </div>
    );
  }

  if (s.mode === 'sketch') {
    if (s.facePick) {
      return (
        <div className="toolbar">
          <span className="group-label">
            Extrude — click inside closed regions to select them ({s.facePick.pts.length} selected, none = all)
          </span>
          <div className="sep" />
          <button className="active" onClick={acceptExtrude}>
            ✓ Accept{s.facePick.pts.length ? ` (${s.facePick.pts.length})` : ' (all)'}
          </button>
          <button onClick={() => s.cancelFacePick()}>✕ Cancel</button>
        </div>
      );
    }
    const tools = [
      ['select', 'Select'],
      ['line', 'Line'],
      ['rect', 'Rectangle'],
      ['circle', 'Circle'],
      ['fillet', 'Fillet'],
      ['chamfer', 'Chamfer'],
    ] as const;
    return (
      <div className="toolbar">
        {tools.map(([t, label]) => (
          <button key={t} className={s.tool === t ? 'active' : ''} onClick={() => s.setTool(t)}>
            {label}
          </button>
        ))}
        <button
          className={s.tool === 'image' ? 'active' : ''}
          title="Import an image as a reference overlay in the sketch"
          onClick={() => imgRef.current?.click()}
        >
          Image…
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={s.construction}
            onChange={(e) => s.setConstruction(e.target.checked)}
          />
          Construction
        </label>
        <div className="sep" />
        <button onClick={startExtrude} disabled={!sketchForExtrude}>
          Extrude…
        </button>
        <div className="sep" />
        <button className="active" onClick={() => s.exitSketch()}>
          ✓ Finish Sketch
        </button>
        <input
          ref={imgRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => onPickImage(e.target.files)}
        />
      </div>
    );
  }

  return (
    <div className="toolbar">
      <button onClick={() => { if (confirm('Start a new project? Unsaved changes are lost.')) s.newProject(); }}>New</button>
      <button onClick={() => projRef.current?.click()}>Open</button>
      <button onClick={() => saveProject(s.doc)}>Save</button>
      <div className="sep" />
      <button onClick={s.undo} disabled={!s.past.length}>↩ Undo</button>
      <button onClick={s.redo} disabled={!s.future.length}>↪ Redo</button>
      <div className="sep" />
      <span className="group-label">Sketch:</span>
      <button onClick={() => newSketch('XZ')}>Top</button>
      <button onClick={() => newSketch('XY')}>Front</button>
      <button onClick={() => newSketch('YZ')}>Right</button>
      <button
        onClick={() => s.startFaceSketchMode()}
        title="Click a face on any 3D body to create a new sketch aligned to that face"
      >
        On Face…
      </button>
      <div className="sep" />
      <span className="group-label">Add:</span>
      <button onClick={() => addPrimitive('box')}>Box</button>
      <button onClick={() => addPrimitive('sphere')}>Sphere</button>
      <button onClick={() => addPrimitive('cylinder')}>Cylinder</button>
      <button onClick={() => addPrimitive('cone')}>Cone</button>
      <button onClick={() => addPrimitive('torus')}>Torus</button>
      <div className="sep" />
      <button onClick={startExtrude} disabled={!sketchForExtrude} title="Select a sketch first">
        Extrude
      </button>
      <button
        className={s.gizmoMode === 'translate' ? 'active' : ''}
        disabled={!selected || (selected.type !== 'primitive' && selected.type !== 'import')}
        onClick={() => s.setGizmoMode(s.gizmoMode === 'translate' ? null : 'translate')}
        title="Drag the selected primitive/import with a gizmo"
      >
        Move
      </button>
      <button
        className={s.gizmoMode === 'rotate' ? 'active' : ''}
        disabled={!selected || (selected.type !== 'primitive' && selected.type !== 'import')}
        onClick={() => s.setGizmoMode(s.gizmoMode === 'rotate' ? null : 'rotate')}
        title="Rotate the selected primitive/import around any axis"
      >
        Rotate
      </button>
      <button
        disabled={!selected || selected.type === 'sketch'}
        onClick={() => selected && s.startMergePick(selected.id)}
        title="Combine the selected object with another: cut, fuse, or intersect"
      >
        Merge…
      </button>
      <div className="sep" />
      <button onClick={() => fileRef.current?.click()}>Import</button>
      <button
        onClick={() => {
          try {
            exportSTL(bodies);
          } catch (e) {
            alert(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        Export STL
      </button>
      <input
        ref={fileRef}
        type="file"
        accept={IMPORT_EXTENSIONS.join(',')}
        multiple
        style={{ display: 'none' }}
        onChange={(e) => onImport(e.target.files)}
      />
      <input
        ref={projRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={(e) => onOpenProject(e.target.files)}
      />
    </div>
  );
}
