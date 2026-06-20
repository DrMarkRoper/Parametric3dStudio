import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { Edges, GizmoHelper, GizmoViewport, Grid, Html, Line, OrbitControls, OrthographicCamera, PerspectiveCamera, TransformControls } from '@react-three/drei';
import type { CogProfile, CornerMod, DimensionAnchor, DimensionEntity, Doc, Feature, ImageEntity, ImportFeature, Joint, PrimitiveFeature, SketchEntity, SketchFeature, Vec2 } from '../types';
import { uid } from '../types';
import { planeBasis, sketchMatrix, type BodyOut } from '../core/buildGeometry';
import { bodyDeltaMatrix } from '../core/assembly';
import { tryEval, type Params } from '../core/expressions';
import {
  applyCornerMods,
  circleSegs,
  cogPoly,
  cogRadii,
  computeRegions,
  cornerCandidates,
  cornerModVisuals,
  dist2d,
  edgeSnapPoints,
  entitiesBounds,
  entityInBox,
  findDimAnchorAt,
  modColor,
  modsForEntity,
  pickEntity,
  rectCorners,
  regionContains,
  resolveDimAnchor,
  snapPoints,
  rotateEntitiesInSketch,
  translateEntitiesInSketch,
} from '../core/sketchGeometry';
import { nextName, useStore } from '../state/store';
import { useCursorStore } from './StatusBar';

type Pt3 = [number, number, number];

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/** Sensible default tooth count for a cog of outer radius `r`. Small cogs get
 *  fewer teeth so they're still readable; large cogs cap out so the perimeter
 *  doesn't turn into a circle. */
function defaultCogTeeth(r: number): number {
  return Math.max(8, Math.min(24, Math.round(r / 2.5)));
}
/** Default inner (root) radius: leaves a tooth height ~25% of the outer radius. */
function defaultCogInner(r: number): number {
  return r * 0.75;
}
/** Default tooth profile for newly-drawn cogs — pointy reads as "cog" at a
 *  glance; users can switch to square / trapezoid in the Info panel. */
const DEFAULT_COG_PROFILE: CogProfile = 'pointy';

/* ================= Theme palette ================= */

/** Subscribe to `data-theme` on <html> so Three.js render colours can follow
 *  the MDI light/dark toggle without importing AppStateContext into studio/. */
function useDocumentTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light')
      ? 'light' : 'dark',
  );
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTheme(root.dataset.theme === 'light' ? 'light' : 'dark');
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Centralised palette so sketch lines, grids and axes stay consistent across
 *  the active-sketch editor, the inactive-sketch overlays, and the 3D viewport. */
interface CanvasPalette {
  canvasBg:        string;
  gridCell:        string;
  gridSection:     string;
  sketchGridCell:  string;
  sketchGridSec:   string;
  axisX:           string;
  axisY:           string;
  edgeColor:       string;
  sketchActive:    string;
  sketchFaint:     string;
  sketchConstr:    string;
  labelColor:      string;
  ambient:         number;
  keyLight:        number;
  fillLight:       number;
  /** Background pill colour for Html overlay labels (dim, measure). */
  htmlLabelBg:     string;
  /** Foreground text colour for the same labels (when not highlighted). */
  htmlLabelFg:     string;
}

const PALETTES: Record<'dark' | 'light', CanvasPalette> = {
  dark: {
    canvasBg:       '#16181d',
    gridCell:       '#262a33',
    gridSection:    '#343a46',
    sketchGridCell: '#262a33',
    sketchGridSec:  '#3a4150',
    axisX:          '#52404a',
    axisY:          '#3f4a52',
    edgeColor:      '#10131a',
    sketchActive:   '#dde2ec',
    sketchFaint:    '#5b6478',
    sketchConstr:   '#7a8198',
    labelColor:     '#d6dae2',
    ambient:        0.45,
    keyLight:       1.1,
    fillLight:      0.35,
    htmlLabelBg:    'rgba(15,18,25,0.72)',
    htmlLabelFg:    '#e8eaf0',
  },
  light: {
    canvasBg:       '#dde2ec',
    gridCell:       '#a8b0bc',
    gridSection:    '#7a8294',
    sketchGridCell: '#a8b0bc',
    sketchGridSec:  '#7a8294',
    axisX:          '#b04b58',
    axisY:          '#5b80a4',
    edgeColor:      '#3a4150',
    sketchActive:   '#1a1f2c',
    sketchFaint:    '#6b7484',
    sketchConstr:   '#8089a0',
    labelColor:     '#1a1e28',
    ambient:        0.7,
    keyLight:       0.85,
    fillLight:      0.3,
    htmlLabelBg:    'rgba(255,255,255,0.88)',
    htmlLabelFg:    '#1a1f2c',
  },
};

function usePalette(): CanvasPalette {
  const theme = useDocumentTheme();
  return PALETTES[theme];
}

/* ================= Entity rendering ================= */

function circlePts(center: Vec2, r: number, z: number, segs?: number): Pt3[] {
  const n = segs ?? circleSegs(r);
  const pts: Pt3[] = [];
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * Math.PI * 2;
    pts.push([center.x + r * Math.cos(t), center.y + r * Math.sin(t), z]);
  }
  return pts;
}

/** Arc polyline points — takes the shorter of the two possible arcs between
 *  startDeg and endDeg, matching `arcPoly` in sketchGeometry.ts. */
function arcPts(center: Vec2, r: number, startDeg: number, endDeg: number, z: number, segs?: number): Pt3[] {
  let diff = endDeg - startDeg;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  const n = segs ?? Math.max(12, Math.ceil((Math.abs(diff) / 180) * Math.PI * r / 2) + 4);
  const s = (startDeg * Math.PI) / 180;
  const d = (diff * Math.PI) / 180;
  const pts: Pt3[] = [];
  for (let k = 0; k <= n; k++) {
    const t = s + d * (k / n);
    pts.push([center.x + r * Math.cos(t), center.y + r * Math.sin(t), z]);
  }
  return pts;
}

/** Closed cog polyline at z — wraps `cogPoly` and appends the first point so
 *  drei's `<Line />` renders a sealed loop. */
function cogPts(
  center: Vec2,
  outerR: number,
  innerR: number,
  teeth: number,
  z: number,
  rotation = 0,
  profile?: CogProfile,
): Pt3[] {
  const poly = cogPoly(center, outerR, innerR, teeth, rotation, profile);
  if (!poly.length) return [];
  const pts: Pt3[] = poly.map((p) => [p.x, p.y, z] as Pt3);
  pts.push([poly[0].x, poly[0].y, z]);
  return pts;
}

function ellipsePts(center: Vec2, rx: number, ry: number, z: number, rotation = 0, segs?: number): Pt3[] {
  if (rx === ry && !rotation) return circlePts(center, rx, z, segs);
  const n = segs ?? circleSegs(Math.max(rx, ry));
  // CW-positive rotation, matching rectCorners / rotatePoint so the
  // static-rotate UI's positive-angle input rotates ovals consistently.
  const a = (rotation * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const pts: Pt3[] = [];
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * Math.PI * 2;
    const lx = rx * Math.cos(t);
    const ly = ry * Math.sin(t);
    pts.push([center.x + lx * c + ly * s, center.y - lx * s + ly * c, z]);
  }
  return pts;
}

/** Render a dimension entity's text label. A custom `label` string is shown
 *  verbatim, except that any `{}` placeholder is substituted with the live
 *  measured distance — so e.g. `"width = {} mm"` becomes `"width = 42 mm"`. */
export function formatDimLabel(template: string | undefined, value: number): string {
  if (template === undefined || template === '') return value.toFixed(2);
  if (!template.includes('{}')) return template;
  return template.split('{}').join(value.toFixed(2));
}

/** Per-entity offset for the Offset tool. Returns new entities AND any new
 *  corner mods (fillets / chamfers) the offset should carry over.
 *
 *   • line   → parallel line shifted along its perpendicular (left = +d)
 *   • circle → concentric circle / ellipse with rx, ry each increased by d
 *   • rect   → rectangle whose corner expands outward by d on all four sides
 *              (positive d = outer offset; negative d = inner). Existing
 *              corner mods at the rect's corners are duplicated at the offset
 *              corners, with sizes scaled for the new geometry:
 *                – fillet (radius r) → r + d
 *                – chamfer (setback s, 90° corner) → s + d·(2 − √2)
 *              Mods that shrink to ≤ 0 (e.g. inward offset large enough to
 *              annihilate the chamfer) are dropped. Inter-entity trimming
 *              between offset lines / circles is still future work.            */
function computeOffsetEntity(
  e: SketchEntity,
  d: number,
  params: Params,
  existingCorners: CornerMod[] = [],
): { entities: SketchEntity[]; corners: CornerMod[] } {
  if (e.kind === 'line') {
    const dx = e.p2.x - e.p1.x;
    const dy = e.p2.y - e.p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return { entities: [], corners: [] };
    const nx = (-dy / len) * d;
    const ny = (dx / len) * d;
    return {
      entities: [{
        id: uid(),
        kind: 'line',
        construction: e.construction,
        p1: { x: e.p1.x + nx, y: e.p1.y + ny },
        p2: { x: e.p2.x + nx, y: e.p2.y + ny },
      }],
      corners: [],
    };
  }
  if (e.kind === 'circle') {
    const rx = tryEval(e.radius, params);
    const ry = e.radiusY ? tryEval(e.radiusY, params) : rx;
    if (!rx || !ry) return { entities: [], corners: [] };
    const nrx = rx + d;
    const nry = ry + d;
    if (nrx <= 0 || nry <= 0) return { entities: [], corners: [] };
    const newE: SketchEntity = {
      id: uid(),
      kind: 'circle',
      construction: e.construction,
      center: { ...e.center },
      radius: fmt(nrx),
    };
    if (e.radiusY !== undefined) (newE as { radiusY?: string }).radiusY = fmt(nry);
    if (e.rotation) (newE as { rotation?: number }).rotation = e.rotation;
    return { entities: [newE], corners: [] };
  }
  if (e.kind === 'rect') {
    const w = tryEval(e.width, params);
    const h = tryEval(e.height, params);
    if (!w || !h) return { entities: [], corners: [] };
    const nw = w + 2 * d;
    const nh = h + 2 * d;
    if (nw <= 0 || nh <= 0) return { entities: [], corners: [] };
    const newCornerAnchor = { x: e.corner.x - d, y: e.corner.y - d };
    const newRect: SketchEntity = {
      id: uid(),
      kind: 'rect',
      construction: e.construction,
      corner: newCornerAnchor,
      width: fmt(nw),
      height: fmt(nh),
    };
    if (e.rotation) (newRect as { rotation?: number }).rotation = e.rotation;

    // Carry over corner mods that sit on the original rect's corners.
    const origCorners = rectCorners(e.corner, w, h, e.rotation);
    const offsetCorners = rectCorners(newCornerAnchor, nw, nh, e.rotation);
    const CHAMFER_FACTOR = 2 - Math.SQRT2; // (2 − √2) for a 90° corner
    const newCorners: CornerMod[] = [];
    for (let i = 0; i < 4; i++) {
      const mod = existingCorners.find((c) => Math.hypot(c.at.x - origCorners[i].x, c.at.y - origCorners[i].y) < 0.05);
      if (!mod) continue;
      const origSize = tryEval(mod.size, params);
      if (origSize === null) continue;
      const newSize = mod.kind === 'fillet'
        ? origSize + d
        : origSize + d * CHAMFER_FACTOR;
      if (newSize <= 0) continue;
      newCorners.push({
        id: uid(),
        at: { ...offsetCorners[i] },
        kind: mod.kind,
        size: fmt(newSize),
      });
    }

    return { entities: [newRect], corners: newCorners };
  }
  return { entities: [], corners: [] };
}

function entityPolyline(
  e: SketchEntity,
  params: Params,
  z: number,
  sketch: SketchFeature,
  trims: Map<string, { p1?: Vec2; p2?: Vec2 }>
): Pt3[] | null {
  if (e.kind === 'image') return null; // rendered separately as SketchImage
  if (e.kind === 'dimension') return null; // rendered separately as DimensionOverlay
  if (e.kind === 'line') {
    const t = trims.get(e.id);
    const p1 = t?.p1 ?? e.p1;
    const p2 = t?.p2 ?? e.p2;
    return [[p1.x, p1.y, z], [p2.x, p2.y, z]];
  }
  if (e.kind === 'circle') {
    const rx = tryEval(e.radius, params);
    const ry = e.radiusY ? tryEval(e.radiusY, params) : rx;
    if (!rx || !ry || rx <= 0 || ry <= 0) return null;
    return ellipsePts(e.center, rx, ry, z, e.rotation ?? 0);
  }
  if (e.kind === 'arc') {
    const r = tryEval(e.radius, params);
    const sa = tryEval(e.startAngle, params);
    const ea = tryEval(e.endAngle, params);
    if (!r || r <= 0 || sa === null || ea === null) return null;
    return arcPts(e.center, r, sa, ea, z);
  }
  if (e.kind === 'cog') {
    const rs = cogRadii(e, params);
    if (!rs || rs.outer <= 0 || rs.inner <= 0 || e.teeth < 1) return null;
    return cogPts(e.center, rs.outer, rs.inner, e.teeth, z, e.rotation ?? 0, e.profile);
  }
  const w = tryEval(e.width, params);
  const h = tryEval(e.height, params);
  if (!w || !h || w <= 0 || h <= 0) return null;
  const c = applyCornerMods(rectCorners(e.corner, w, h, (e as { rotation?: number }).rotation), sketch.corners, params);
  return [...c, c[0]].map((p) => [p.x, p.y, z] as Pt3);
}

function SketchLines({
  sketch,
  params,
  faint,
  selectedEntityIds,
}: {
  sketch: SketchFeature;
  params: Params;
  faint?: boolean;
  selectedEntityIds?: Set<string>;
}) {
  const visuals = useMemo(() => cornerModVisuals(sketch, params), [sketch, params]);
  const palette = usePalette();
  const showConstruction = useStore((s) => s.showConstruction);
  const baseColor = faint ? palette.sketchFaint : palette.sketchActive;
  return (
    <>
      {sketch.entities.map((e) => {
        // Construction-line toggle. Image entities have no `construction` flag
        // (they're always shown); dimension's flag is unused but tolerated.
        const isConstruction = 'construction' in e
          ? (e as { construction?: boolean }).construction === true
          : false;
        if (isConstruction && !showConstruction) return null;
        const pts = entityPolyline(e, params, 0.05, sketch, visuals.trims);
        if (!pts || e.kind === 'image') return null;
        const selected = selectedEntityIds?.has(e.id) ?? false;
        return (
          <Line
            key={e.id}
            points={pts}
            color={selected ? '#ffaa33' : e.construction ? palette.sketchConstr : baseColor}
            lineWidth={selected ? 2.5 : 1.5}
            dashed={e.construction}
            dashSize={3}
            gapSize={2}
            transparent
            opacity={faint ? 0.5 : 1}
          />
        );
      })}
      {visuals.decorations.map((d, i) => (
        <Line
          key={`dec${i}`}
          points={d.map((p) => [p.x, p.y, 0.05] as Pt3)}
          color={baseColor}
          lineWidth={1.5}
          transparent
          opacity={faint ? 0.5 : 1}
        />
      ))}
    </>
  );
}

/* ================= Image entity renderer ================= */

function SketchImage({
  ent,
  params,
  selected,
}: {
  ent: ImageEntity;
  params: Params;
  selected: boolean;
}) {
  const [tex, setTex] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    const texture = new THREE.Texture();
    const img = new Image();
    img.onload = () => {
      texture.image = img;
      texture.needsUpdate = true;
      setTex(texture);
    };
    img.src = ent.src;
    return () => {
      texture.dispose();
      setTex(null);
    };
  }, [ent.src]);

  const w = tryEval(ent.width, params) ?? 0;
  const h = tryEval(ent.height, params) ?? 0;
  if (w <= 0 || h <= 0) return null;

  const { x: ox, y: oy } = ent.corner;
  const anchor = ent.cropAnchor ?? 'center';

  // Mesh dimensions and centre (may be smaller than rect in crop mode when image < rect)
  let meshW = w, meshH = h;
  let meshCX = ox + w / 2, meshCY = oy + h / 2;
  // UV repeat and offset into the image texture
  let repeatX = 1, repeatY = 1, offsetX = 0, offsetY = 0;

  if (ent.fit === 'crop' && ent.naturalWidth > 0 && ent.naturalHeight > 0) {
    const imgAR = ent.naturalWidth / ent.naturalHeight;
    // cropScale = full image width in sketch units (zoom level, independent of rect)
    const imgW = ent.cropScale ?? Math.max(w, h * imgAR);
    const imgH = imgW / imgAR;

    // Clamp mesh to actual displayed image area (prevents edge-pixel stretching)
    meshW = Math.min(w, imgW);
    meshH = Math.min(h, imgH);

    // UV: which portion of the image the mesh shows
    repeatX = meshW / imgW;
    repeatY = meshH / imgH;

    // UV offset selects which region of the image to show (anchor = image region shown)
    // With THREE.js default flipY=true: offsetY=0 → image bottom, offsetY=1-repeat → image top
    switch (anchor) {
      case 'top-left':    offsetX = 0;            offsetY = 1 - repeatY; break;
      case 'top-right':   offsetX = 1 - repeatX;  offsetY = 1 - repeatY; break;
      case 'bottom-left': offsetX = 0;            offsetY = 0;           break;
      case 'bottom-right':offsetX = 1 - repeatX;  offsetY = 0;           break;
      default:            offsetX = (1-repeatX)/2; offsetY = (1-repeatY)/2; // center
    }

    // Mesh position within the rect (anchor = where image sits in rect when smaller)
    switch (anchor) {
      case 'top-left':
        meshCX = ox + meshW / 2;          meshCY = oy + h - meshH / 2;    break;
      case 'top-right':
        meshCX = ox + w - meshW / 2;      meshCY = oy + h - meshH / 2;    break;
      case 'bottom-left':
        meshCX = ox + meshW / 2;          meshCY = oy + meshH / 2;        break;
      case 'bottom-right':
        meshCX = ox + w - meshW / 2;      meshCY = oy + meshH / 2;        break;
      default: // center
        meshCX = ox + w / 2;              meshCY = oy + h / 2;            break;
    }
  }

  if (tex) {
    tex.repeat.set(repeatX, repeatY);
    tex.offset.set(offsetX, offsetY);
    tex.needsUpdate = true;
  }

  // Rotation around corner (ox, oy): place group at corner, children in local coords
  // Positive rotation = clockwise; Three.js is CCW so negate
  const rotRad = -((ent.rotation ?? 0) * Math.PI) / 180;
  // meshCX/meshCY are in world coords; convert to local (relative to corner)
  const lMeshCX = meshCX - ox;
  const lMeshCY = meshCY - oy;

  return (
    <group position={[ox, oy, 0]} rotation={[0, 0, rotRad]}>
      {/* Black fill behind image in crop mode */}
      {ent.fit === 'crop' && (
        <mesh position={[w / 2, h / 2, 0.009]} raycast={() => {}}>
          <planeGeometry args={[w, h]} />
          <meshBasicMaterial color="#000000" depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      {/* Image plane */}
      <mesh position={[lMeshCX, lMeshCY, 0.01]} raycast={() => {}}>
        <planeGeometry args={[meshW, meshH]} />
        <meshBasicMaterial
          map={tex ?? undefined}
          transparent
          opacity={ent.opacity}
          color={tex ? '#ffffff' : '#444455'}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Border outline (local coords) */}
      <Line
        points={[[0, 0, 0.03], [w, 0, 0.03], [w, h, 0.03], [0, h, 0.03], [0, 0, 0.03]] as Pt3[]}
        color={selected ? '#4f8cff' : '#55607a'}
        lineWidth={selected ? 2 : 1}
        transparent
        opacity={selected ? 1 : 0.6}
      />
    </group>
  );
}

/* ================= Active sketch editor ================= */

function ActiveSketchEditor({ sketch, params }: { sketch: SketchFeature; params: Params }) {
  const s = useStore();
  const setCursorStatus = useCursorStore((st) => st.set);
  const palette = usePalette();

  const matrix = useMemo(
    () => sketchMatrix(sketch, params),
    // customPlane is set once at creation; plane/offset cover standard sketches
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sketch.plane, sketch.offset, sketch.customPlane, params],
  );
  const inv = useMemo(() => matrix.clone().invert(), [matrix]);

  const selectedEntityIds = useStore((st) => st.selectedEntityIds);

  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [chainStart, setChainStart] = useState<Vec2 | null>(null);
  const [chainOrigin, setChainOrigin] = useState<Vec2 | null>(null);
  const [centerPt, setCenterPt] = useState<Vec2 | null>(null); // circle
  const [cornerPt, setCornerPt] = useState<Vec2 | null>(null); // rect
  // Arc tool: 3-click flow (centre → start → end). When `arcStart` is set the
  // radius is locked at dist(center, start) and click 3 picks the end angle.
  const [arcCenter, setArcCenter] = useState<Vec2 | null>(null);
  const [arcStart, setArcStart] = useState<Vec2 | null>(null);
  const [snapIndicator, setSnapIndicator] = useState<Vec2 | null>(null); // active edge-snap point
  const [snapIsCorner, setSnapIsCorner] = useState(false); // true = corner/endpoint → blue, false = midpoint/intersection → green
  // Selection box: start (raw) + current end, used for rendering
  const [selBox, setSelBox] = useState<{ start: Vec2; end: Vec2 } | null>(null);
  // Tracks active selection-box drag (separate from entity drag)
  const selBoxRef = useRef<{ start: Vec2 } | null>(null);

  const lastScreen = useRef({ x: 100, y: 100 });
  const dragRef = useRef<{ ids: string[]; last: Vec2; startDoc: Doc; moved: boolean } | null>(null);
  /** Dimension-tool: anchor captured at the first click, applied on the second. */
  const dimDraftAnchorRef = useRef<{ p1?: DimensionAnchor } | null>(null);
  /** Active drag of a dimension label (moves the dim line perpendicular to p1→p2). */
  const dimDragRef = useRef<{ id: string; startDoc: Doc; moved: boolean } | null>(null);
  const ref = useRef({ cursor, chainStart, chainOrigin, centerPt, cornerPt, params, sketch });
  ref.current = { cursor, chainStart, chainOrigin, centerPt, cornerPt, params, sketch };

  const pendingImage = s.pendingImage;
  const grid = s.doc.gridSize;
  const snapMode = s.doc.snap; // 'none' | 'grid' | 'edge'
  // snapTargets (line endpoints, circle centres, rect corners) — used for grid extent regardless of mode
  const snapTargets = useMemo(() => snapPoints(sketch, params), [sketch, params]);
  // edgeTargets — richer set for edge-snap mode (midpoints, quadrants, intersections)
  const edgeTargets = useMemo(
    () => (snapMode === 'edge' ? edgeSnapPoints(sketch, params) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sketch, params, snapMode],
  );
  const facePick = s.facePick && s.facePick.sketchId === sketch.id ? s.facePick : null;

  const clearDrafts = () => {
    setChainStart(null);
    setChainOrigin(null);
    setCenterPt(null);
    setCornerPt(null);
    setArcCenter(null);
    setArcStart(null);
  };

  // Switching tools (or entering face-pick) cancels any in-progress drawing / selection box.
  useEffect(() => {
    clearDrafts();
    dragRef.current = null;
    selBoxRef.current = null;
    setSelBox(null);
  }, [s.tool, facePick !== null]);

  const gridSnap = (p: Vec2): Vec2 =>
    snapMode === 'grid'
      ? { x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid }
      : p;

  const snapPt = (p: Vec2): Vec2 => {
    if (snapMode === 'none') return p;
    if (snapMode === 'grid') return gridSnap(p);
    // edge mode: snap to nearest geometric point; cap tolerance so a large grid doesn't pull from far away
    const tol = Math.min(Math.max(grid * 1.5, 5), 15);
    let best: Vec2 | null = null;
    let bestD = tol;
    for (const t of edgeTargets) {
      const d = dist2d(p, t);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best ? { ...best } : p; // no grid fallback in edge mode
  };

  const addEntity = (e: SketchEntity) =>
    useStore.getState().updateFeature(sketch.id, (f) => ({ ...f, entities: [...(f as SketchFeature).entities, e] }) as Feature);

  const commitLine = (p1: Vec2, p2: Vec2, lengthExpr?: string) => {
    if (dist2d(p1, p2) < 1e-6) return;
    addEntity({ id: uid(), kind: 'line', p1, p2, construction: useStore.getState().construction, length: lengthExpr });
  };

  const openPrompt = (label: string, initial: string, onCommit: (text: string) => void, onCancel?: () => void) => {
    s.setDimPrompt({ x: lastScreen.current.x, y: lastScreen.current.y, label, initial, onCommit, onCancel });
  };

  /** Shift any dependent extrude's `regionPts` that sit inside the moved
   *  entities' (pre-move) bounding box by the same delta, so the extruded face
   *  travels with the geometry instead of the auto-heal (`chooseRegions`)
   *  snapping to a different region after the move. `srcDoc` supplies the
   *  pre-move geometry for the bounds test; `features` is the already-translated
   *  feature list to patch. Points outside the moved bbox are left alone so
   *  unrelated regions in the same sketch are unaffected. */
  const followRegionPts = (features: Feature[], movedIds: string[], d: Vec2, srcDoc: Doc): Feature[] => {
    const srcSketch = srcDoc.features.find((f) => f.id === sketch.id && f.type === 'sketch') as
      | SketchFeature
      | undefined;
    if (!srcSketch) return features;
    const movedEnts = srcSketch.entities.filter((e) => movedIds.includes(e.id));
    const b = movedEnts.length ? entitiesBounds(movedEnts, ref.current.params) : null;
    if (!b) return features;
    const pad = 1e-6;
    const inside = (p: Vec2) =>
      p.x >= b.min.x - pad && p.x <= b.max.x + pad && p.y >= b.min.y - pad && p.y <= b.max.y + pad;
    return features.map((f) =>
      f.type === 'extrude' && f.sketchId === sketch.id && f.regionPts?.length
        ? { ...f, regionPts: f.regionPts.map((p) => (inside(p) ? { x: p.x + d.x, y: p.y + d.y } : p)) }
        : f
    );
  };

  /** Translate one or more entities (and their corner mods) by delta — no undo step. */
  const moveEntitiesBy = (ids: string[], d: Vec2) => {
    const st = useStore.getState();
    let features = st.doc.features.map((f) =>
      f.id === sketch.id && f.type === 'sketch'
        ? (translateEntitiesInSketch(f as SketchFeature, ids, d, ref.current.params) as Feature)
        : f
    );
    features = followRegionPts(features, ids, d, st.doc);
    st.setDoc({ ...st.doc, features }, false);
  };

  /* ---- pointer handlers (on the sketch plane) ---- */

  const localPoint = (e: ThreeEvent<PointerEvent>): Vec2 => {
    const v = new THREE.Vector3().copy(e.point).applyMatrix4(inv);
    return { x: v.x, y: v.y };
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const raw = localPoint(e);
    lastScreen.current = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };

    // Entity drag
    const drag = dragRef.current;
    if (drag) {
      const pg = snapPt(raw);
      const d = { x: pg.x - drag.last.x, y: pg.y - drag.last.y };
      if (Math.abs(d.x) > 1e-9 || Math.abs(d.y) > 1e-9) {
        moveEntitiesBy(drag.ids, d);
        drag.last = pg;
        drag.moved = true;
      }
      setCursor(pg);
      setCursorStatus(pg);
      if (snapMode === 'edge' && edgeTargets.some((t) => dist2d(t, pg) < 0.01)) {
        setSnapIndicator(pg);
        setSnapIsCorner(snapTargets.some((t) => dist2d(t, pg) < 0.01));
      } else {
        setSnapIndicator(null);
      }
      return;
    }

    // Selection box drag
    if (selBoxRef.current) {
      setSelBox({ start: selBoxRef.current.start, end: raw });
      return;
    }

    // Dynamic op live preview
    const dynOpLive = useStore.getState().dynamicOp;
    if (dynOpLive && dynOpLive.sketchId === sketch.id && dynOpLive.grabPt !== null) {
      const p = snapPt(raw);
      setCursor(p);
      setCursorStatus(p);
      if (dynOpLive.kind === 'move') {
        const delta = { x: p.x - dynOpLive.grabPt.x, y: p.y - dynOpLive.grabPt.y };
        let newFeatures = dynOpLive.startDoc.features.map((f) =>
          f.id === dynOpLive.sketchId && f.type === 'sketch'
            ? (translateEntitiesInSketch(f as SketchFeature, dynOpLive.entityIds, delta, ref.current.params) as Feature)
            : f
        );
        newFeatures = followRegionPts(newFeatures, dynOpLive.entityIds, delta, dynOpLive.startDoc);
        useStore.getState().setDoc({ ...dynOpLive.startDoc, features: newFeatures }, false);
      } else if (dynOpLive.kind === 'rotate') {
        const dx = p.x - dynOpLive.grabPt.x;
        const dy = p.y - dynOpLive.grabPt.y;
        if (Math.hypot(dx, dy) < 0.5) return;
        const currentAngleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
        let firstAngle = dynOpLive.firstAngle;
        if (firstAngle === null) {
          firstAngle = currentAngleDeg;
          useStore.getState().setDynamicOp({ ...dynOpLive, firstAngle });
        }
        const angleDeg = currentAngleDeg - firstAngle;
        // rotatePoint uses screen-CW positive while the mouse delta angle here
        // is math-CCW positive — negate so the entity follows the mouse instead
        // of mirroring it.
        const newFeatures = dynOpLive.startDoc.features.map((f) =>
          f.id === dynOpLive.sketchId && f.type === 'sketch'
            ? rotateEntitiesInSketch(f as SketchFeature, dynOpLive.entityIds, dynOpLive.grabPt!, -angleDeg, ref.current.params)
            : f
        );
        useStore.getState().setDoc({ ...dynOpLive.startDoc, features: newFeatures }, false);
      }
      // Snap indicator during dynamic op — only fire for static (non-moving) entity points
      if (snapMode === 'edge') {
        const movingIdSet = new Set(dynOpLive.entityIds);
        const baseSketch = dynOpLive.startDoc.features.find(
          (f) => f.id === dynOpLive.sketchId && f.type === 'sketch'
        ) as SketchFeature | undefined;
        const staticSketch = baseSketch
          ? { ...baseSketch, entities: baseSketch.entities.filter((e) => !movingIdSet.has(e.id)) }
          : null;
        const staticEdge = staticSketch ? edgeSnapPoints(staticSketch, ref.current.params) : [];
        if (staticEdge.some((t) => dist2d(t, p) < 0.01)) {
          setSnapIndicator(p);
          const staticSnap = staticSketch ? snapPoints(staticSketch, ref.current.params) : [];
          setSnapIsCorner(staticSnap.some((t) => dist2d(t, p) < 0.01));
        } else {
          setSnapIndicator(null);
        }
      } else {
        setSnapIndicator(null);
      }
      return;
    }

    const p = snapPt(raw);
    setCursor(p);
    setCursorStatus(p);
    // show a snap indicator ring when edge-snapped to a geometric point
    if (snapMode === 'edge') {
      const tol = Math.min(Math.max(grid * 1.5, 5), 15);
      const hit = edgeTargets.find((t) => dist2d(t, p) < 0.01);
      if (dist2d(raw, p) < tol && hit) {
        setSnapIndicator(p);
        setSnapIsCorner(snapTargets.some((t) => dist2d(t, p) < 0.01));
      } else {
        setSnapIndicator(null);
      }
    } else {
      setSnapIndicator(null);
    }
  };

  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    const rel = () =>
      (e.target as unknown as { releasePointerCapture?: (id: number) => void }).releasePointerCapture?.(e.pointerId);

    // Entity drag ended
    const drag = dragRef.current;
    if (drag) {
      rel();
      if (drag.moved) useStore.getState().endTransient(drag.startDoc);
      dragRef.current = null;
      return;
    }

    // Selection box ended
    if (selBoxRef.current) {
      rel();
      const start = selBoxRef.current.start;
      const end = localPoint(e);
      selBoxRef.current = null;
      setSelBox(null);

      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      if (w < 2 && h < 2) {
        // trivially small → treat as a deselect click on empty space
        useStore.getState().selectEntities(sketch.id, []);
        return;
      }

      const crossing = end.x > start.x; // left-to-right = crossing (intersect)
      const boxMin = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y) };
      const boxMax = { x: Math.max(start.x, end.x), y: Math.max(start.y, end.y) };
      const mode = crossing ? 'crossing' : 'window';
      const ids = ref.current.sketch.entities
        .filter((ent) => entityInBox(ent, ref.current.params, boxMin, boxMax, mode))
        .map((ent) => ent.id);
      useStore.getState().selectEntities(sketch.id, ids);
    }
  };

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.nativeEvent.button !== 0) return;
    if (useStore.getState().dimPrompt) {
      s.setDimPrompt(null);
      return;
    }
    const raw = localPoint(e);
    const p = snapPt(raw);

    /* Dynamic op: grab-point phase or confirm */
    const dynOpDown = useStore.getState().dynamicOp;
    if (dynOpDown && dynOpDown.sketchId === sketch.id) {
      if (dynOpDown.grabPt === null) {
        // First click: set grab point / rotation origin
        useStore.getState().setDynamicOp({ ...dynOpDown, grabPt: p });
      } else {
        // Second click: confirm — push one undo step
        useStore.getState().endTransient(dynOpDown.startDoc);
        useStore.getState().setDynamicOp(null);
      }
      return;
    }

    /* face-pick mode: toggle the closed region under the cursor */
    if (facePick) {
      const region = regions.find((r) => regionContains(r, raw));
      if (region) {
        const inRegion = (q: Vec2) => regionContains(region, q);
        const pts = facePick.pts.some(inRegion)
          ? facePick.pts.filter((q) => !inRegion(q))
          : [...facePick.pts, raw];
        s.setFacePickPts(pts);
      }
      return;
    }

    const tool = s.tool;

    if (tool === 'line') {
      if (!chainStart) {
        setChainStart(p);
        setChainOrigin(p);
      } else {
        commitLine(chainStart, p);
        if (chainOrigin && dist2d(p, chainOrigin) < 1e-6) clearDrafts();
        else setChainStart(p);
      }
    } else if (tool === 'circle') {
      if (!centerPt) {
        setCenterPt(p);
      } else {
        const r = dist2d(centerPt, p);
        if (r > 1e-6)
          addEntity({ id: uid(), kind: 'circle', center: centerPt, radius: fmt(r), construction: s.construction });
        setCenterPt(null);
      }
    } else if (tool === 'cog') {
      // Same two-click flow as Circle: click 1 = centre, click 2 = outer radius.
      // Tooth count and inner radius default off the outer radius — the user
      // tweaks them in the Info panel after the cog lands.
      if (!centerPt) {
        setCenterPt(p);
      } else {
        const r = dist2d(centerPt, p);
        if (r > 1e-6) {
          const teeth = defaultCogTeeth(r);
          addEntity({
            id: uid(),
            kind: 'cog',
            center: centerPt,
            outerRadius: fmt(r),
            innerRadius: fmt(defaultCogInner(r)),
            teeth,
            profile: DEFAULT_COG_PROFILE,
            construction: s.construction,
          });
        }
        setCenterPt(null);
      }
    } else if (tool === 'arc') {
      // 3-click flow: centre → start (defines radius + startAngle) → end (endAngle).
      if (!arcCenter) {
        setArcCenter(p);
      } else if (!arcStart) {
        if (dist2d(arcCenter, p) > 1e-6) setArcStart(p);
      } else {
        const r = dist2d(arcCenter, arcStart);
        if (r > 1e-6) {
          const startDeg = (Math.atan2(arcStart.y - arcCenter.y, arcStart.x - arcCenter.x) * 180) / Math.PI;
          const endDeg   = (Math.atan2(p.y - arcCenter.y, p.x - arcCenter.x) * 180) / Math.PI;
          addEntity({
            id: uid(),
            kind: 'arc',
            center: arcCenter,
            radius: fmt(r),
            startAngle: fmt(startDeg),
            endAngle: fmt(endDeg),
            construction: s.construction,
          });
        }
        setArcCenter(null);
        setArcStart(null);
      }
    } else if (tool === 'rect') {
      if (!cornerPt) {
        setCornerPt(p);
      } else {
        const w = Math.abs(p.x - cornerPt.x);
        const h = Math.abs(p.y - cornerPt.y);
        if (w > 1e-6 && h > 1e-6) {
          addEntity({
            id: uid(),
            kind: 'rect',
            corner: { x: Math.min(cornerPt.x, p.x), y: Math.min(cornerPt.y, p.y) },
            width: fmt(w),
            height: fmt(h),
            construction: s.construction,
          });
        }
        setCornerPt(null);
      }
    } else if (tool === 'image') {
      const img = useStore.getState().pendingImage;
      if (!img) return;
      if (!cornerPt) {
        setCornerPt(p);
      } else {
        const dw = Math.abs(p.x - cornerPt.x);
        const dh = Math.abs(p.y - cornerPt.y);
        const ar = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1;
        // If the user barely moved, use a sensible default size
        const fw = dw > 1e-6 ? dw : 100;
        const fh = dh > 1e-6 ? dh : fw / ar;
        addEntity({
          id: uid(),
          kind: 'image',
          corner: { x: Math.min(cornerPt.x, p.x), y: Math.min(cornerPt.y, p.y) },
          width: fmt(fw),
          height: fmt(fh),
          src: img.src,
          fileName: img.fileName,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          fit: 'scale',
          maintainAspect: true,
          opacity: 1,
        } as SketchEntity);
        setCornerPt(null);
        s.setTool('select');
      }
    } else if (tool === 'fillet' || tool === 'chamfer') {
      const candidates = cornerCandidates(sketch, params);
      let best: Vec2 | null = null;
      let bestD = Math.min(Math.max(grid * 0.8, 2), 8);
      for (const c of candidates) {
        const d = dist2d(c, raw);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best) {
        const at = best;
        const kind = tool;
        openPrompt(kind === 'fillet' ? 'Fillet radius' : 'Chamfer distance', '', (text) => {
          const v = tryEval(text, ref.current.params);
          if (v === null || v <= 0) return;
          useStore.getState().updateFeature(sketch.id, (f) => ({
            ...f,
            corners: [...(f as SketchFeature).corners, { id: uid(), at, kind, size: text }],
          }) as Feature);
        });
      }
    } else if (tool === 'measure') {
      // Pick two points and read the distance off in the canvas + InfoPanel.
      // Third click resets — the user is starting a new measurement.
      const ms = useStore.getState().measureState;
      if (!ms.p1 || (ms.p1 && ms.p2)) {
        useStore.getState().setMeasure({ p1: p, p2: null });
      } else {
        useStore.getState().setMeasure({ p1: ms.p1, p2: p });
      }
    } else if (tool === 'dimension') {
      // Two-click flow with feature-anchor capture: if the click lands on an
      // entity endpoint / midpoint / circle centre / rect corner / edge mid,
      // store the anchor reference so the dimension follows the entity when it
      // moves. Free-space clicks fall back to an absolute pick.
      const dd = useStore.getState().dimensionDraft;
      const anchorTol = Math.max(grid * 1.4, 5);
      const hit = findDimAnchorAt(raw, sketch, params, anchorTol);
      const pickPos = hit ? hit.pos : p;
      const pickAnchor = hit ? hit.anchor : undefined;
      if (!dd.p1) {
        useStore.getState().setDimensionDraft({ p1: pickPos, p2: null });
        dimDraftAnchorRef.current = { p1: pickAnchor };
      } else {
        if (Math.hypot(pickPos.x - dd.p1.x, pickPos.y - dd.p1.y) > 1e-6) {
          const defaultOffset = Math.max(grid * 2, 8);
          const newDim: DimensionEntity = {
            id: uid(),
            kind: 'dimension',
            p1: dd.p1,
            p2: pickPos,
            offset: defaultOffset,
          };
          const anchors = dimDraftAnchorRef.current;
          if (anchors?.p1) newDim.p1Anchor = anchors.p1;
          if (pickAnchor) newDim.p2Anchor = pickAnchor;
          addEntity(newDim as SketchEntity);
        }
        useStore.getState().setDimensionDraft({ p1: null, p2: null });
        dimDraftAnchorRef.current = null;
      }
    } else if (tool === 'offset') {
      // Pick an entity → prompt for distance → spawn an offset copy plus any
      // corner mods the offset should carry over (rect with fillets/chamfers).
      const hit = pickEntity(sketch, params, raw, Math.max(grid * 0.8, 2));
      if (!hit) return;
      const target = sketch.entities.find((x) => x.id === hit);
      if (!target) return;
      if (target.kind !== 'line' && target.kind !== 'circle' && target.kind !== 'rect') return;
      const captured = target;
      openPrompt('Offset distance', '', (text) => {
        const v = tryEval(text, ref.current.params);
        if (v === null || v === 0) return;
        const sketchNow = useStore.getState().doc.features.find(
          (f) => f.id === sketch.id && f.type === 'sketch',
        ) as SketchFeature | undefined;
        const result = computeOffsetEntity(
          captured,
          v,
          ref.current.params,
          sketchNow?.corners ?? [],
        );
        if (!result.entities.length) return;
        useStore.getState().updateFeature(sketch.id, (f) => ({
          ...f,
          entities: [...(f as SketchFeature).entities, ...result.entities],
          corners: [...(f as SketchFeature).corners, ...result.corners],
        }) as Feature);
      });
    } else if (tool === 'select') {
      const hit = pickEntity(sketch, params, raw, Math.max(grid * 0.6, 1.5));
      const cap = () =>
        (e.target as unknown as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId);

      if (hit) {
        // If hit is already in the multi-selection, drag all; otherwise single-select and drag
        const curIds = useStore.getState().selectedEntityIds;
        const idsToUse = curIds.includes(hit) ? curIds : [hit];
        useStore.getState().selectEntities(sketch.id, idsToUse);
        dragRef.current = { ids: idsToUse, last: snapPt(raw), startDoc: useStore.getState().doc, moved: false };
        cap();
      } else {
        // Clicked empty space — begin selection box
        selBoxRef.current = { start: raw };
        setSelBox({ start: raw, end: raw });
        cap();
      }
    }
  };

  /* ---- keyboard: dimensions while drawing, esc/enter/delete ---- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const st = useStore.getState();
      if (st.dimPrompt) return;
      const r = ref.current;

      // Exact angle entry for dynamic rotate
      if (/^[0-9.\-]$/.test(e.key) && st.dynamicOp?.kind === 'rotate' && st.dynamicOp.grabPt !== null) {
        e.preventDefault();
        const dynOpRot = st.dynamicOp;
        openPrompt('Rotation angle °', e.key, (text) => {
          const v = tryEval(text, ref.current.params);
          if (v === null) return;
          // Convention: positive typed angle = clockwise rotation. rotatePoint
          // already uses CW-positive, so pass the value through unchanged.
          const newFeatures = dynOpRot.startDoc.features.map((f) =>
            f.id === dynOpRot.sketchId && f.type === 'sketch'
              ? rotateEntitiesInSketch(f as SketchFeature, dynOpRot.entityIds, dynOpRot.grabPt!, v, ref.current.params)
              : f
          );
          useStore.getState().setDoc({ ...dynOpRot.startDoc, features: newFeatures }, false);
          useStore.getState().endTransient(dynOpRot.startDoc);
          useStore.getState().setDynamicOp(null);
        }, () => {
          useStore.getState().setDoc(dynOpRot.startDoc, false);
          useStore.getState().setDynamicOp(null);
        });
        return;
      }

      if (/^[0-9.]$/.test(e.key)) {
        const open = (label: string, onCommit: (t: string) => void) =>
          st.setDimPrompt({ x: lastScreen.current.x, y: lastScreen.current.y, label, initial: e.key, onCommit });

        if (st.tool === 'line' && r.chainStart) {
          e.preventDefault();
          open('Length', (text) => {
            const len = tryEval(text, ref.current.params);
            const start = ref.current.chainStart;
            if (len === null || len <= 0 || !start) return;
            const c = ref.current.cursor ?? { x: start.x + 1, y: start.y };
            let dx = c.x - start.x;
            let dy = c.y - start.y;
            const d = Math.hypot(dx, dy);
            if (d < 1e-9) {
              dx = 1;
              dy = 0;
            } else {
              dx /= d;
              dy /= d;
            }
            const p2 = { x: start.x + dx * len, y: start.y + dy * len };
            commitLine(start, p2, text);
            setChainStart(p2);
          });
        } else if (st.tool === 'circle' && r.centerPt) {
          e.preventDefault();
          open('Radius', (text) => {
            const v = tryEval(text, ref.current.params);
            const c = ref.current.centerPt;
            if (v === null || v <= 0 || !c) return;
            addEntity({ id: uid(), kind: 'circle', center: c, radius: text, construction: st.construction });
            setCenterPt(null);
          });
        } else if (st.tool === 'cog' && r.centerPt) {
          e.preventDefault();
          open('Outer radius', (text) => {
            const v = tryEval(text, ref.current.params);
            const c = ref.current.centerPt;
            if (v === null || v <= 0 || !c) return;
            const teeth = defaultCogTeeth(v);
            addEntity({
              id: uid(),
              kind: 'cog',
              center: c,
              outerRadius: text,
              innerRadius: fmt(defaultCogInner(v)),
              teeth,
              profile: DEFAULT_COG_PROFILE,
              construction: st.construction,
            });
            setCenterPt(null);
          });
        } else if (st.tool === 'rect' && r.cornerPt) {
          e.preventDefault();
          open('Width , Height', (text) => {
            const parts = text.split(/[,xX*]/).map((t) => t.trim()).filter(Boolean);
            const c1 = ref.current.cornerPt;
            if (!c1 || !parts.length) return;
            const wExpr = parts[0];
            const hExpr = parts[1] ?? parts[0];
            const w = tryEval(wExpr, ref.current.params);
            const h = tryEval(hExpr, ref.current.params);
            if (w === null || h === null || w <= 0 || h <= 0) return;
            const cur = ref.current.cursor ?? { x: c1.x + 1, y: c1.y + 1 };
            const ax = cur.x >= c1.x ? c1.x : c1.x - w;
            const ay = cur.y >= c1.y ? c1.y : c1.y - h;
            addEntity({
              id: uid(),
              kind: 'rect',
              corner: { x: ax, y: ay },
              width: wExpr,
              height: hExpr,
              construction: st.construction,
            });
            setCornerPt(null);
          });
        }
      } else if (e.key === 'Escape') {
        if (st.dynamicOp) {
          st.setDoc(st.dynamicOp.startDoc, false);
          st.setDynamicOp(null);
        } else if (st.facePick) st.cancelFacePick();
        else if (r.chainStart || r.centerPt || r.cornerPt || arcCenter || arcStart) clearDrafts();
        else if (st.tool === 'measure' && (st.measureState.p1 || st.measureState.p2)) {
          st.setMeasure({ p1: null, p2: null });
        } else if (st.tool === 'dimension' && (st.dimensionDraft.p1 || st.dimensionDraft.p2)) {
          st.setDimensionDraft({ p1: null, p2: null });
        }
        // No in-progress draft → drop any selection AND, if we're parked on a
        // drawing tool (not select), snap back to Select so the user can move /
        // pick without re-aiming the toolbar.
        else if (st.tool !== 'select') {
          st.select(sketch.id, null);
          st.setTool('select');
        }
        else st.select(sketch.id, null);
      } else if (e.key === 'Enter') {
        clearDrafts();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && st.selectedEntityIds.length) {
        const toDelete = new Set(st.selectedEntityIds);
        st.updateFeature(sketch.id, (f) => ({
          ...f,
          entities: (f as SketchFeature).entities.filter((x) => !toDelete.has(x.id)),
        }) as Feature);
        st.selectEntities(sketch.id, []);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sketch.id]);

  useEffect(() => () => setCursorStatus(null), [setCursorStatus]);

  /* ---- visuals ---- */

  const regions = useMemo(() => {
    try {
      return computeRegions(sketch, params);
    } catch {
      return [];
    }
  }, [sketch, params]);

  // Visual circle radius: scales up for tiny grids so circles stay visible,
  // but capped so a large grid doesn't make them enormous.
  const vr = (frac: number, minR: number) => Math.min(Math.max(grid * frac, minR), Math.max(10 * frac, minR));

  // Grid: at least 1000x1000, and always extends 1000 beyond the furthest sketch point.
  const { gridSize, gridDivisions } = useMemo(() => {
    let extent = 0;
    for (const p of snapTargets) extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
    let half = Math.max(500, extent + 1000);
    let step = grid;
    while ((half * 2) / step > 800) step *= 2; // cap line count for huge grids / tiny grid sizes
    half = Math.ceil(half / step) * step;
    return { gridSize: half * 2, gridDivisions: Math.round((half * 2) / step) };
  }, [snapTargets, grid]);

  // Bottom-left of the combined bounding box for multi-select — used for origin indicator
  const selOrigin = useMemo(() => {
    if (selectedEntityIds.length < 2) return null;
    const ents = sketch.entities.filter((e) => selectedEntityIds.includes(e.id));
    return entitiesBounds(ents, params);
  }, [sketch, selectedEntityIds, params]);

  const faceFills = useMemo(() => {
    if (!facePick) return null;
    return regions.map((r, i) => ({
      geometry: new THREE.ShapeGeometry(r.shape, 4),
      selected: facePick.pts.some((p) => regionContains(r, p)),
      key: i,
    }));
  }, [facePick, regions]);

  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <gridHelper args={[gridSize, gridDivisions, palette.sketchGridSec, palette.sketchGridCell]} rotation={[Math.PI / 2, 0, 0]} />
      <Line points={[[-gridSize / 2, 0, 0.02], [gridSize / 2, 0, 0.02]]} color={palette.axisX} lineWidth={1} />
      <Line points={[[0, -gridSize / 2, 0.02], [0, gridSize / 2, 0.02]]} color={palette.axisY} lineWidth={1} />

      {/* interaction plane */}
      <mesh
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        position={[0, 0, -0.01]}
      >
        <planeGeometry args={[100000, 100000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>

      {/* Image reference overlays — rendered below sketch lines */}
      {sketch.entities.filter((e): e is ImageEntity => e.kind === 'image').map((e) => (
        <SketchImage
          key={e.id}
          ent={e}
          params={params}
          selected={selectedEntityIds.includes(e.id)}
        />
      ))}

      <SketchLines
        sketch={sketch}
        params={params}
        selectedEntityIds={selectedEntityIds.length ? new Set(selectedEntityIds) : undefined}
      />

      {/* closed profile preview */}
      {regions.flatMap((r, i) =>
        [r.outer, ...r.holes].map((loop, j) => (
          <Line
            key={`prof${i}_${j}`}
            points={[...loop, loop[0]].map((p) => [p.x, p.y, 0.06] as Pt3)}
            color="#5fb878"
            lineWidth={2}
            transparent
            opacity={0.8}
          />
        ))
      )}

      {/* face-pick fills */}
      {faceFills?.map((f) => (
        <mesh key={f.key} geometry={f.geometry} position={[0, 0, 0.03]}>
          <meshBasicMaterial
            color={f.selected ? '#4f8cff' : '#5b6478'}
            transparent
            opacity={f.selected ? 0.4 : 0.12}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}

      {/* Multi-select origin indicator — green ring at bottom-left of combined bounding box */}
      {selOrigin && (
        <Line
          points={circlePts(selOrigin.min, vr(0.5, 2.5), 0.1, 20)}
          color="#5fb878"
          lineWidth={2.5}
        />
      )}

      {/* Selection box (window = solid blue, crossing = dashed green) */}
      {selBox && (() => {
        const { start, end } = selBox;
        const crossing = end.x > start.x; // left-to-right = crossing
        const col = crossing ? '#5fb878' : '#4f8cff';
        const bx = (start.x + end.x) / 2;
        const by = (start.y + end.y) / 2;
        const bw = Math.abs(end.x - start.x);
        const bh = Math.abs(end.y - start.y);
        return (
          <>
            <Line
              points={[
                [start.x, start.y, 0.08],
                [end.x, start.y, 0.08],
                [end.x, end.y, 0.08],
                [start.x, end.y, 0.08],
                [start.x, start.y, 0.08],
              ] as Pt3[]}
              color={col}
              lineWidth={1.5}
              dashed={crossing}
              dashSize={4}
              gapSize={3}
            />
            <mesh position={[bx, by, 0.04]}>
              <planeGeometry args={[bw, bh]} />
              <meshBasicMaterial color={col} transparent opacity={0.07} depthWrite={false} side={THREE.DoubleSide} />
            </mesh>
          </>
        );
      })()}

      {/* corner mod markers — shown for the selected entity only (null when multi-selected), color-matched to the info panel */}
      {s.selectedEntityId &&
        modsForEntity(sketch, s.selectedEntityId, params).map((c) => (
          <Line
            key={c.id}
            points={circlePts(c.at, vr(0.3, 1.2), 0.07, 24)}
            color={modColor(sketch, c.id)}
            lineWidth={2.5}
          />
        ))}

      {/* drafts */}
      {!facePick && chainStart && cursor && dist2d(chainStart, cursor) > 1e-6 && (
        <Line points={[[chainStart.x, chainStart.y, 0.08], [cursor.x, cursor.y, 0.08]]} color="#4f8cff" lineWidth={2} />
      )}
      {!facePick && centerPt && cursor && dist2d(centerPt, cursor) > 1e-6 && (() => {
        const radius = dist2d(centerPt, cursor);
        if (s.tool === 'cog') {
          const teeth = defaultCogTeeth(radius);
          const inner = defaultCogInner(radius);
          return (
            <>
              <Line points={circlePts(centerPt, radius, 0.07)} color="#4f8cff" lineWidth={1} dashed dashSize={2} gapSize={2} transparent opacity={0.4} />
              <Line points={cogPts(centerPt, radius, inner, teeth, 0.08, 0, DEFAULT_COG_PROFILE)} color="#4f8cff" lineWidth={2} />
            </>
          );
        }
        return <Line points={circlePts(centerPt, radius, 0.08)} color="#4f8cff" lineWidth={2} />;
      })()}
      {/* Arc draft — three phases. After click 1 (centre): ghost circle through
          cursor. After click 2 (start): orange arc from start to cursor at the
          locked radius. */}
      {!facePick && s.tool === 'arc' && arcCenter && !arcStart && cursor && dist2d(arcCenter, cursor) > 1e-6 && (
        <>
          <Line points={circlePts(arcCenter, dist2d(arcCenter, cursor), 0.08)} color="#4f8cff" lineWidth={1.5} dashed dashSize={3} gapSize={2} />
          <Line points={circlePts(arcCenter, vr(0.3, 1.5), 0.09, 16)} color="#4f8cff" lineWidth={2} />
        </>
      )}
      {!facePick && s.tool === 'arc' && arcCenter && arcStart && cursor && (() => {
        const r = dist2d(arcCenter, arcStart);
        if (r < 1e-6) return null;
        const startDeg = (Math.atan2(arcStart.y - arcCenter.y, arcStart.x - arcCenter.x) * 180) / Math.PI;
        const endDeg   = (Math.atan2(cursor.y - arcCenter.y, cursor.x - arcCenter.x) * 180) / Math.PI;
        return (
          <>
            <Line points={circlePts(arcCenter, r, 0.07)} color="#4f8cff" lineWidth={1} dashed dashSize={2} gapSize={2} transparent opacity={0.4} />
            <Line points={arcPts(arcCenter, r, startDeg, endDeg, 0.09)} color="#ff8c00" lineWidth={2.5} />
            <Line points={circlePts(arcCenter, vr(0.3, 1.5), 0.09, 16)} color="#ff8c00" lineWidth={2} />
            <Line points={circlePts(arcStart,  vr(0.3, 1.5), 0.09, 16)} color="#ff8c00" lineWidth={2} />
          </>
        );
      })()}
      {!facePick && cornerPt && cursor && s.tool !== 'image' && (
        <Line
          points={[
            [cornerPt.x, cornerPt.y, 0.08],
            [cursor.x, cornerPt.y, 0.08],
            [cursor.x, cursor.y, 0.08],
            [cornerPt.x, cursor.y, 0.08],
            [cornerPt.x, cornerPt.y, 0.08],
          ]}
          color="#4f8cff"
          lineWidth={2}
        />
      )}
      {/* Image placement draft */}
      {!facePick && s.tool === 'image' && cornerPt && cursor && pendingImage && (() => {
        const ar = pendingImage.naturalWidth > 0 && pendingImage.naturalHeight > 0
          ? pendingImage.naturalWidth / pendingImage.naturalHeight : 1;
        const dw = Math.abs(cursor.x - cornerPt.x);
        const dh = Math.abs(cursor.y - cornerPt.y);
        const fw = dw > 1e-6 ? dw : 100;
        const fh = dh > 1e-6 ? dh : fw / ar;
        const mnx = Math.min(cornerPt.x, cursor.x);
        const mny = Math.min(cornerPt.y, cursor.y);
        return (
          <Line
            points={[
              [mnx, mny, 0.08], [mnx + fw, mny, 0.08],
              [mnx + fw, mny + fh, 0.08], [mnx, mny + fh, 0.08],
              [mnx, mny, 0.08],
            ] as Pt3[]}
            color="#e6a23c"
            lineWidth={2}
            dashed
            dashSize={4}
            gapSize={3}
          />
        );
      })()}
      {/* Image tool waiting for first click */}
      {s.tool === 'image' && !cornerPt && cursor && pendingImage && (
        <Line
          points={circlePts(cursor, vr(0.4, 2), 0.08, 20)}
          color="#e6a23c"
          lineWidth={2}
        />
      )}

      {/* Dynamic Move visuals */}
      {s.dynamicOp?.kind === 'move' && s.dynamicOp.sketchId === sketch.id && cursor && (
        s.dynamicOp.grabPt === null ? (
          // Waiting for grab point: orange ring at cursor
          <Line points={circlePts(cursor, vr(0.5, 2.5), 0.12, 20)} color="#ff8c00" lineWidth={2} />
        ) : (
          // Active: dashed line + circles at grab point and cursor
          <>
            <Line
              points={[[s.dynamicOp.grabPt.x, s.dynamicOp.grabPt.y, 0.12], [cursor.x, cursor.y, 0.12]]}
              color="#ff8c00"
              lineWidth={2}
              dashed
              dashSize={4}
              gapSize={3}
            />
            <Line points={circlePts(s.dynamicOp.grabPt, vr(0.4, 2), 0.12, 20)} color="#ff8c00" lineWidth={2} />
            <Line points={circlePts(cursor, vr(0.4, 2), 0.12, 20)} color="#ff8c00" lineWidth={2} />
          </>
        )
      )}

      {/* Dynamic Rotate visuals */}
      {s.dynamicOp?.kind === 'rotate' && s.dynamicOp.sketchId === sketch.id && cursor && (
        s.dynamicOp.grabPt === null ? (
          // Waiting for rotation origin: purple ring at cursor
          <Line points={circlePts(cursor, vr(0.5, 2.5), 0.12, 20)} color="#a855f7" lineWidth={2} />
        ) : (
          // Active: dashed line from origin to cursor + angle label
          <>
            <Line
              points={[[s.dynamicOp.grabPt.x, s.dynamicOp.grabPt.y, 0.12], [cursor.x, cursor.y, 0.12]]}
              color="#a855f7"
              lineWidth={2}
              dashed
              dashSize={4}
              gapSize={3}
            />
            <Line points={circlePts(s.dynamicOp.grabPt, vr(0.4, 2), 0.12, 20)} color="#a855f7" lineWidth={2} />
            {s.dynamicOp.firstAngle !== null && (() => {
              const dx = cursor.x - s.dynamicOp!.grabPt!.x;
              const dy = cursor.y - s.dynamicOp!.grabPt!.y;
              // atan2 returns math-CCW positive; negate so the readout matches
              // the screen-CW positive convention the rest of the rotate UI
              // uses (positive typed angle = clockwise rotation).
              const angle = -((Math.atan2(dy, dx) * 180) / Math.PI - s.dynamicOp!.firstAngle!);
              return (
                <Html position={[cursor.x + 4, cursor.y + 4, 0.12]} style={{ pointerEvents: 'none' }}>
                  <div style={{ color: '#c084fc', fontSize: 12, background: 'rgba(0,0,0,0.65)', padding: '2px 6px', borderRadius: 3, whiteSpace: 'nowrap' }}>
                    {angle.toFixed(1)}°
                  </div>
                </Html>
              );
            })()}
          </>
        )
      )}

      {/* edge-snap indicator: bright blue = corner/endpoint, soft blue = midpoint/intersection */}
      {snapIndicator && (
        <Line
          points={circlePts(snapIndicator, vr(0.6, 3.5), 0.1, 20)}
          color={snapIsCorner ? '#4f8cff' : '#93c5fd'}
          lineWidth={3}
        />
      )}

      {/* Measure tool overlay: line + circles at each picked point + label */}
      {s.tool === 'measure' && (() => {
        const a = s.measureState.p1;
        const b = s.measureState.p2 ?? cursor;
        if (!a || !b) return null;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        return (
          <>
            <Line points={[[a.x, a.y, 0.11], [b.x, b.y, 0.11]]} color="#5b8def" lineWidth={2} dashed dashSize={3} gapSize={2} />
            <Line points={circlePts(a, vr(0.4, 2.5), 0.13, 24)} color="#5b8def" lineWidth={2} />
            <Line points={circlePts(b, vr(0.4, 2.5), 0.13, 24)} color="#5b8def" lineWidth={2} />
            <Html position={[(a.x + b.x) / 2, (a.y + b.y) / 2, 0.13]} style={{ pointerEvents: 'none' }} center>
              <div style={{ color: '#fff', fontSize: 11, background: 'rgba(91,141,239,0.9)', padding: '2px 6px', borderRadius: 3, whiteSpace: 'nowrap', fontWeight: 600 }}>
                {len.toFixed(2)}
              </div>
            </Html>
          </>
        );
      })()}

      {/* Dimension tool: waiting for second click — show p1 marker + draft line */}
      {s.tool === 'dimension' && s.dimensionDraft.p1 && cursor && (
        <>
          <Line
            points={[[s.dimensionDraft.p1.x, s.dimensionDraft.p1.y, 0.11], [cursor.x, cursor.y, 0.11]]}
            color="#a855f7"
            lineWidth={2}
            dashed
            dashSize={3}
            gapSize={2}
          />
          <Line points={circlePts(s.dimensionDraft.p1, vr(0.4, 2.5), 0.13, 24)} color="#a855f7" lineWidth={2} />
        </>
      )}

      {/* Persistent dimension entities — extension lines + dim line + label.
          p1/p2 are resolved live from anchors when present, so the dim tracks
          its host entities. The label is wrapped in a small invisible mesh
          that acts as a click + drag handle (select / move the dim line). */}
      {sketch.entities
        .filter((e): e is DimensionEntity => e.kind === 'dimension')
        .map((dim) => {
          const ep1 = (dim.p1Anchor && resolveDimAnchor(dim.p1Anchor, sketch, params)) ?? dim.p1;
          const ep2 = (dim.p2Anchor && resolveDimAnchor(dim.p2Anchor, sketch, params)) ?? dim.p2;
          const dx = ep2.x - ep1.x;
          const dy = ep2.y - ep1.y;
          const len = Math.hypot(dx, dy);
          if (len < 1e-6) return null;
          // Perpendicular unit vector (positive offset = left of p1→p2)
          const nx = -dy / len;
          const ny = dx / len;
          const o = dim.offset;
          const da = { x: ep1.x + nx * o, y: ep1.y + ny * o };
          const db = { x: ep2.x + nx * o, y: ep2.y + ny * o };
          const mid = { x: (da.x + db.x) / 2, y: (da.y + db.y) / 2 };
          const isSelected = s.selectedEntityId === dim.id;
          const col = isSelected ? '#ffaa33' : palette.sketchActive;
          const handleR = Math.max(grid * 0.75, 4);
          return (
            <group key={dim.id}>
              <Line points={[[ep1.x, ep1.y, 0.09], [da.x, da.y, 0.09]]} color={col} lineWidth={1} />
              <Line points={[[ep2.x, ep2.y, 0.09], [db.x, db.y, 0.09]]} color={col} lineWidth={1} />
              <Line points={[[da.x, da.y, 0.09], [db.x, db.y, 0.09]]} color={col} lineWidth={1.5} />
              {/* Invisible-ish drag handle behind the label. Bigger than the
                  label so the user can grab and drag the dim line away from
                  the anchor segment. Pointer events on the Html label are
                  disabled so this mesh always receives the click. */}
              <mesh
                position={[mid.x, mid.y, 0.105]}
                onPointerDown={(e) => {
                  if (e.nativeEvent.button !== 0) return;
                  e.stopPropagation();
                  (e.target as unknown as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId);
                  useStore.getState().select(sketch.id, dim.id);
                  dimDragRef.current = { id: dim.id, startDoc: useStore.getState().doc, moved: false };
                }}
                onPointerMove={(e) => {
                  const drag = dimDragRef.current;
                  if (!drag || drag.id !== dim.id) return;
                  e.stopPropagation();
                  const cur = localPoint(e);
                  // Recompute perpendicular from the *current* anchor positions
                  // so dragging stays accurate even if the host entity has moved.
                  const a1 = (dim.p1Anchor && resolveDimAnchor(dim.p1Anchor, sketch, params)) ?? dim.p1;
                  const a2 = (dim.p2Anchor && resolveDimAnchor(dim.p2Anchor, sketch, params)) ?? dim.p2;
                  const ddx = a2.x - a1.x;
                  const ddy = a2.y - a1.y;
                  const dlen = Math.hypot(ddx, ddy);
                  if (dlen < 1e-6) return;
                  const pnx = -ddy / dlen;
                  const pny = ddx / dlen;
                  const pmid = { x: (a1.x + a2.x) / 2, y: (a1.y + a2.y) / 2 };
                  const newOffset = (cur.x - pmid.x) * pnx + (cur.y - pmid.y) * pny;
                  useStore.getState().updateFeature(
                    sketch.id,
                    (f) => ({
                      ...f,
                      entities: (f as SketchFeature).entities.map((x) =>
                        x.id === drag.id ? { ...x, offset: newOffset } : x,
                      ),
                    }) as Feature,
                    false,
                  );
                  drag.moved = true;
                }}
                onPointerUp={(e) => {
                  const drag = dimDragRef.current;
                  if (!drag) return;
                  e.stopPropagation();
                  (e.target as unknown as { releasePointerCapture?: (id: number) => void }).releasePointerCapture?.(e.pointerId);
                  if (drag.moved) useStore.getState().endTransient(drag.startDoc);
                  dimDragRef.current = null;
                }}
              >
                <circleGeometry args={[handleR, 20]} />
                <meshBasicMaterial
                  color={isSelected ? '#5b8def' : '#888888'}
                  transparent
                  opacity={isSelected ? 0.22 : 0.001}
                  depthWrite={false}
                  side={THREE.DoubleSide}
                />
              </mesh>
              <Html position={[mid.x, mid.y, 0.11]} style={{ pointerEvents: 'none' }} center>
                <div style={{
                  color: isSelected ? '#ffaa33' : palette.htmlLabelFg,
                  fontSize: 11,
                  background: palette.htmlLabelBg,
                  padding: '1px 5px',
                  borderRadius: 3,
                  whiteSpace: 'nowrap',
                  fontWeight: 500,
                }}>
                  {formatDimLabel(dim.label, len)}
                </div>
              </Html>
            </group>
          );
        })}

      {/* cursor crosshair */}
      {cursor && (
        <>
          <Line points={[[cursor.x - 2, cursor.y, 0.09], [cursor.x + 2, cursor.y, 0.09]]} color="#ffffff" lineWidth={1} />
          <Line points={[[cursor.x, cursor.y - 2, 0.09], [cursor.x, cursor.y + 2, 0.09]]} color="#ffffff" lineWidth={1} />
        </>
      )}
    </group>
  );
}

/* ================= Camera rig for sketch mode ================= */

function SketchCameraRig({ sketch, params }: { sketch: SketchFeature | null; params: Params }) {
  const camera = useThree((st) => st.camera);
  const controls = useThree((st) => st.controls) as { target: THREE.Vector3; enableRotate: boolean; update: () => void } | null;

  useEffect(() => {
    if (!sketch || !controls) return;
    const m = sketchMatrix(sketch, params);
    const n = new THREE.Vector3().setFromMatrixColumn(m, 2).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
    const center = new THREE.Vector3().setFromMatrixPosition(m);
    const dist = Math.max(camera.position.distanceTo(center), 150);
    camera.up.copy(up);
    camera.position.copy(center).addScaledVector(n, dist);
    controls.target.copy(center);
    controls.enableRotate = false;
    controls.update();
    return () => {
      controls.enableRotate = true;
      camera.up.set(0, 1, 0);
      controls.update();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sketch?.id, sketch?.plane, controls]);

  return null;
}

/* ================= Move / rotate gizmo ================= */

function TransformGizmo({
  feature,
  params,
  mode,
}: {
  feature: PrimitiveFeature | ImportFeature;
  params: Params;
  mode: 'translate' | 'rotate';
}) {
  const snapMode = useStore((st) => st.doc.snap);
  const grid = useStore((st) => st.doc.gridSize);
  const grpRef = useRef<THREE.Group>(null!);

  const pos: Pt3 =
    feature.type === 'primitive'
      ? [
          tryEval(feature.position[0], params) ?? 0,
          tryEval(feature.position[1], params) ?? 0,
          tryEval(feature.position[2], params) ?? 0,
        ]
      : feature.position;

  const rotDeg: Pt3 =
    feature.type === 'primitive'
      ? [
          tryEval(feature.rotation[0], params) ?? 0,
          tryEval(feature.rotation[1], params) ?? 0,
          tryEval(feature.rotation[2], params) ?? 0,
        ]
      : feature.rotation;

  const dragRef = useRef<{ startDoc: Doc; lastWrite: number } | null>(null);

  useEffect(() => {
    if (dragRef.current) return; // don't fight the gizmo mid-drag
    grpRef.current?.position.set(pos[0], pos[1], pos[2]);
    grpRef.current?.rotation.set(
      (rotDeg[0] * Math.PI) / 180,
      (rotDeg[1] * Math.PI) / 180,
      (rotDeg[2] * Math.PI) / 180,
      'XYZ'
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos[0], pos[1], pos[2], rotDeg[0], rotDeg[1], rotDeg[2]]);

  const writeValues = (undoable: boolean) => {
    const g = grpRef.current;
    const p = g.position;
    const degs: Pt3 = [
      Math.round(((g.rotation.x * 180) / Math.PI) * 100) / 100,
      Math.round(((g.rotation.y * 180) / Math.PI) * 100) / 100,
      Math.round(((g.rotation.z * 180) / Math.PI) * 100) / 100,
    ];
    if (feature.type === 'primitive') {
      useStore.getState().updateFeature(
        feature.id,
        (f) =>
          mode === 'translate'
            ? ({ ...f, position: [fmt(p.x), fmt(p.y), fmt(p.z)] } as Feature)
            : ({ ...f, rotation: [String(degs[0]), String(degs[1]), String(degs[2])] } as Feature),
        undoable
      );
    } else {
      useStore.getState().updateFeature(
        feature.id,
        (f) =>
          mode === 'translate'
            ? ({
                ...f,
                position: [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000, Math.round(p.z * 1000) / 1000],
              } as Feature)
            : ({ ...f, rotation: degs } as Feature),
        undoable
      );
    }
  };

  return (
    <>
      <group ref={grpRef} position={pos} />
      <TransformControls
        object={grpRef}
        mode={mode}
        onMouseDown={() => {
          dragRef.current = { startDoc: useStore.getState().doc, lastWrite: 0 };
        }}
        onObjectChange={() => {
          const d = dragRef.current;
          if (!d) return;
          // live preview, throttled (every update re-runs the regen incl. CSG)
          const now = performance.now();
          if (now - d.lastWrite > 50) {
            d.lastWrite = now;
            writeValues(false);
          }
        }}
        onMouseUp={() => {
          const d = dragRef.current;
          dragRef.current = null;
          writeValues(false);
          if (d) useStore.getState().endTransient(d.startDoc);
        }}
        translationSnap={snapMode === 'grid' ? grid : undefined}
        rotationSnap={snapMode === 'grid' ? (5 * Math.PI) / 180 : undefined}
      />
    </>
  );
}

/* ================= Assembly drive handle ================= */

/**
 * A DOF-constrained drag handle for the selected joint in Assembly mode.
 * Revolute → an amber ring around the joint axis; dragging sweeps an angle.
 * Prismatic → an arrow along the joint axis; dragging slides a distance.
 * Both feed `setJointValue`, which clamps to the resolved range and propagates
 * across links. The handle sits at the joint origin (fixed) — only the body
 * moves under the drive.
 */
function AssemblyDriveHandle({
  joints,
  selectedJointId,
  jointValues,
  bodies,
}: {
  joints: Joint[];
  selectedJointId: string | null;
  jointValues: Record<string, number>;
  bodies: BodyOut[];
}) {
  const { camera, gl, controls } = useThree();
  const dragRef = useRef<{ startValue: number; startParam: number } | null>(null);
  const joint = joints.find((j) => j.id === selectedJointId) ?? null;

  const radius = useMemo(() => {
    if (!joint) return 20;
    const box = new THREE.Box3();
    for (const b of bodies) {
      if (b.featureId !== joint.featureId) continue;
      b.geometry.computeBoundingBox();
      if (b.geometry.boundingBox) box.union(b.geometry.boundingBox);
    }
    if (box.isEmpty()) return 20;
    const s = box.getSize(new THREE.Vector3());
    return Math.max(10, 0.62 * Math.max(s.x, s.y, s.z));
  }, [joint, bodies]);

  if (!joint) return null;

  const O = new THREE.Vector3(joint.origin[0], joint.origin[1], joint.origin[2]);
  const A = new THREE.Vector3(joint.axis[0], joint.axis[1], joint.axis[2]);
  if (A.lengthSq() < 1e-9) A.set(0, 1, 0);
  A.normalize();
  const value = jointValues[joint.id] ?? 0;
  const raycaster = new THREE.Raycaster();

  const toNdc = (e: PointerEvent) => {
    const rect = gl.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  };

  // Revolute: signed angle (deg) of the pointer about the axis, in the plane
  // through O perpendicular to A.
  const angleAt = (e: PointerEvent): number | null => {
    raycaster.setFromCamera(toNdc(e), camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(A, O);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    const v = hit.sub(O);
    const ref = new THREE.Vector3(1, 0, 0);
    if (Math.abs(A.dot(ref)) > 0.9) ref.set(0, 0, 1);
    const x = ref.clone().sub(A.clone().multiplyScalar(A.dot(ref))).normalize();
    const y = new THREE.Vector3().crossVectors(A, x).normalize();
    return (Math.atan2(v.dot(y), v.dot(x)) * 180) / Math.PI;
  };

  // Prismatic: parameter along the axis at the point on it closest to the
  // pointer ray.
  const paramAt = (e: PointerEvent): number | null => {
    raycaster.setFromCamera(toNdc(e), camera);
    const ro = raycaster.ray.origin;
    const rd = raycaster.ray.direction;
    const w0 = new THREE.Vector3().subVectors(O, ro);
    const a = A.dot(A), b = A.dot(rd), c = rd.dot(rd), d = A.dot(w0), eC = rd.dot(w0);
    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-9) return null;
    return (b * eC - c * d) / denom;
  };

  const setControls = (enabled: boolean) => {
    if (controls) (controls as unknown as { enabled: boolean }).enabled = enabled;
  };

  const onMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (joint.type === 'revolute') {
      const cur = angleAt(e);
      if (cur === null) return;
      let delta = cur - d.startParam;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      useStore.getState().setJointValue(joint.id, d.startValue + delta);
    } else {
      const cur = paramAt(e);
      if (cur === null) return;
      useStore.getState().setJointValue(joint.id, d.startValue + (cur - d.startParam));
    }
  };
  const onUp = () => {
    dragRef.current = null;
    setControls(true);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  const onDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setControls(false);
    const start = joint.type === 'revolute' ? angleAt(e.nativeEvent) : paramAt(e.nativeEvent);
    dragRef.current = { startValue: value, startParam: start ?? 0 };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const HANDLE = '#f5a623';
  if (joint.type === 'revolute') {
    // Torus hole-axis is +Z by default → align Z to A.
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), A);
    return (
      <group position={O} quaternion={quat}>
        <mesh onPointerDown={onDown} onClick={(e) => e.stopPropagation()}>
          <torusGeometry args={[radius, Math.max(0.5, radius * 0.05), 12, 48]} />
          <meshBasicMaterial color={HANDLE} transparent opacity={0.85} depthTest={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[Math.max(1, radius * 0.08), 16, 16]} />
          <meshBasicMaterial color={HANDLE} depthTest={false} />
        </mesh>
      </group>
    );
  }
  // Prismatic arrow — default geometry along +Y → align Y to A.
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), A);
  const len = radius;
  return (
    <group position={O} quaternion={quat}>
      <mesh position={[0, len / 2, 0]} onPointerDown={onDown} onClick={(e) => e.stopPropagation()}>
        <cylinderGeometry args={[Math.max(0.4, radius * 0.035), Math.max(0.4, radius * 0.035), len, 12]} />
        <meshBasicMaterial color={HANDLE} depthTest={false} />
      </mesh>
      <mesh position={[0, len, 0]} onPointerDown={onDown} onClick={(e) => e.stopPropagation()}>
        <coneGeometry args={[Math.max(1, radius * 0.09), Math.max(2, radius * 0.18), 16]} />
        <meshBasicMaterial color={HANDLE} depthTest={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[Math.max(1, radius * 0.08), 16, 16]} />
        <meshBasicMaterial color={HANDLE} depthTest={false} />
      </mesh>
    </group>
  );
}

/* ================= Viewport ================= */

export function Viewport({ bodies, rev, params }: { bodies: BodyOut[]; rev: number; params: Params }) {
  const mode = useStore((s) => s.mode);
  const doc = useStore((s) => s.doc);
  const palette = usePalette();
  const activeSketchId = useStore((s) => s.activeSketchId);
  const selectedFeatureId = useStore((s) => s.selectedFeatureId);
  const select = useStore((s) => s.select);
  const gizmoMode = useStore((s) => s.gizmoMode);
  const facePick = useStore((s) => s.facePick);
  const mergePick = useStore((s) => s.mergePick);
  const dimPrompt = useStore((s) => s.dimPrompt);
  const setDimPrompt = useStore((s) => s.setDimPrompt);

  const faceSketchMode = useStore((s) => s.faceSketchMode);
  const orthographic = useStore((s) => s.orthographic);

  // ── Assembly mode: joint transform overlay + drive handles ───────────────
  const joints = useStore((s) => s.doc.joints);
  const jointValues = useStore((s) => s.assembly.jointValues);
  const selectedJointId = useStore((s) => s.assembly.selectedJointId);
  const assemblyMode = mode === 'assembly';
  // Per-body delta transform from its joint(s) at the current drive value.
  const bodyMatrices = useMemo(() => {
    const map = new Map<string, THREE.Matrix4>();
    if (!assemblyMode) return map;
    for (const b of bodies) {
      if (map.has(b.featureId)) continue;
      if (joints.some((j) => j.featureId === b.featureId)) {
        map.set(b.featureId, bodyDeltaMatrix(b.featureId, joints, jointValues));
      }
    }
    return map;
  }, [assemblyMode, bodies, joints, jointValues]);

  const sketch = (doc.features.find((f) => f.id === activeSketchId && f.type === 'sketch') ?? null) as SketchFeature | null;
  const selected = doc.features.find((f) => f.id === selectedFeatureId);
  const sketches = doc.features.filter((f) => f.type === 'sketch' && f.visible) as SketchFeature[];

  // Cancel face-sketch mode on Escape
  useEffect(() => {
    if (!faceSketchMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().cancelFaceSketchMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [faceSketchMode]);

  /** Build a sketch feature whose plane matches the clicked face. */
  const createSketchOnFace = (e: import('@react-three/fiber').ThreeEvent<MouseEvent>) => {
    if (!e.face) return;
    const mesh = e.object as THREE.Mesh;
    const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;

    // Face normal (geometry transforms already baked → mesh is at identity → this is world space)
    const faceNormal = e.face.normal.clone().normalize();
    // Ensure the normal faces toward the camera (i.e. the side we clicked from)
    if (faceNormal.dot(e.ray.direction) > 0) faceNormal.negate();

    // Vertex positions of the hit triangle (world space, since mesh at identity)
    const vA = new THREE.Vector3().fromBufferAttribute(posAttr, e.face.a);
    const vB = new THREE.Vector3().fromBufferAttribute(posAttr, e.face.b);
    const vC = new THREE.Vector3().fromBufferAttribute(posAttr, e.face.c);

    // Collect all coplanar triangles to find the face centroid
    const planeD = faceNormal.dot(vA);
    const DOT_TOL = 0.9999; // ~0.8° normal tolerance
    const DIST_TOL = 0.05;  // mm plane-distance tolerance
    const triCount = posAttr.count / 3;
    let sumX = 0, sumY = 0, sumZ = 0, matched = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3(), triN = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
      a.fromBufferAttribute(posAttr, t * 3);
      b.fromBufferAttribute(posAttr, t * 3 + 1);
      c.fromBufferAttribute(posAttr, t * 3 + 2);
      edge1.subVectors(b, a);
      edge2.subVectors(c, a);
      triN.crossVectors(edge1, edge2);
      if (triN.length() < 1e-10) continue;
      triN.normalize();
      if (Math.abs(triN.dot(faceNormal)) < DOT_TOL) continue;
      if (Math.abs(faceNormal.dot(a) - planeD) > DIST_TOL) continue;
      sumX += (a.x + b.x + c.x) / 3;
      sumY += (a.y + b.y + c.y) / 3;
      sumZ += (a.z + b.z + c.z) / 3;
      matched++;
    }
    const centroid =
      matched > 0
        ? new THREE.Vector3(sumX / matched, sumY / matched, sumZ / matched)
        : new THREE.Vector3().addVectors(vA, vB).add(vC).divideScalar(3);

    // Build coordinate frame: Z = face normal, X/Y chosen to match world axes as closely as possible
    const zAxis = faceNormal;
    const worldY = new THREE.Vector3(0, 1, 0);
    let xAxis: THREE.Vector3;
    if (Math.abs(zAxis.dot(worldY)) > 0.9) {
      // Horizontal face — align X with world X
      xAxis = new THREE.Vector3(1, 0, 0);
    } else {
      // Vertical / angled face — derive X from horizontal cross product
      xAxis = new THREE.Vector3().crossVectors(worldY, zAxis).normalize();
    }
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    xAxis.crossVectors(yAxis, zAxis).normalize(); // re-orthogonalise

    const m4 = new THREE.Matrix4();
    m4.makeBasis(xAxis, yAxis, zAxis);
    m4.setPosition(centroid);

    const id = uid();
    const sf: SketchFeature = {
      id,
      type: 'sketch',
      name: nextName(useStore.getState().doc, 'Sketch'),
      visible: true,
      plane: 'XY', // unused when customPlane is set
      offset: '0',
      entities: [],
      corners: [],
      customPlane: [...m4.elements],
    };
    useStore.getState().cancelFaceSketchMode();
    useStore.getState().addFeature(sf);
    useStore.getState().enterSketch(id);
  };

  return (
    <>
      {mode === 'sketch' && sketch && (
        <div className="sketch-badge">
          {facePick
            ? `Select faces to extrude — ${facePick.pts.length} selected (none = all)`
            : `Sketch mode — ${sketch.name}${sketch.customPlane ? ' (face)' : ` (${sketch.plane})`}`}
        </div>
      )}
      {mode === 'model' && faceSketchMode && (
        <div className="sketch-badge">Click any face on a body to create a sketch on it — Esc cancels</div>
      )}
      <Canvas
        dpr={[1, 2]}
        onPointerMissed={() => {
          if (mode === 'model') {
            if (useStore.getState().faceSketchMode) {
              useStore.getState().cancelFaceSketchMode();
            } else {
              select(null);
            }
          }
        }}
      >
        {/* Projection: orthographic removes perspective parallax so parallel
            sketch planes (and their grids) line up; perspective is the 3D
            default. Swapping the makeDefault camera re-binds OrbitControls. */}
        {orthographic ? (
          <OrthographicCamera makeDefault position={[140, 110, 140]} zoom={5} near={-100000} far={100000} />
        ) : (
          <PerspectiveCamera makeDefault position={[140, 110, 140]} fov={45} near={0.1} far={50000} />
        )}
        <color attach="background" args={[palette.canvasBg]} />
        <ambientLight intensity={palette.ambient} />
        <directionalLight position={[150, 250, 120]} intensity={palette.keyLight} />
        <directionalLight position={[-120, 80, -80]} intensity={palette.fillLight} />
        <OrbitControls makeDefault />

        {(mode === 'model' || mode === 'assembly') && (
          <Grid
            position={[0, -0.02, 0]}
            args={[10, 10]}
            cellSize={doc.gridSize}
            sectionSize={doc.gridSize * 5}
            cellColor={palette.gridCell}
            sectionColor={palette.gridSection}
            fadeDistance={3000}
            infiniteGrid
          />
        )}

        {/* bodies */}
        {bodies.map((b, i) => {
          const isFirst = mergePick?.firstId === b.featureId;
          const isSecond = mergePick?.secondId === b.featureId;
          const isSel = (b.featureId === selectedFeatureId && !mergePick) || isFirst;
          // Assembly mode: bodies with a joint render under a transient delta
          // transform (the drive). matrixAutoUpdate is off so the matrix is used
          // verbatim; geometry is baked to world space, so identity = home pose.
          const deltaM = bodyMatrices.get(b.featureId);
          const mesh = (
            // Index in the key — some features (e.g. bulbScrew) emit multiple
            // bodies under one featureId; without `i` React would reuse one
            // mesh for both and stale geometry would linger across regens.
            <mesh
              key={`${b.featureId}:${i}:${rev}`}
              geometry={b.geometry}
              onClick={(e) => {
                if (mode !== 'model' && mode !== 'assembly') return;
                e.stopPropagation();
                // Assembly mode: clicking a body selects it (so a joint can be
                // attached / its joint inspected).
                if (mode === 'assembly') {
                  select(b.featureId);
                  const j = useStore.getState().doc.joints.find((jj) => jj.featureId === b.featureId);
                  if (j) useStore.getState().selectJoint(j.id);
                  return;
                }
                // Face-sketch mode: capture the clicked face to build a sketch on it
                if (useStore.getState().faceSketchMode) {
                  createSketchOnFace(e);
                  return;
                }
                const mp = useStore.getState().mergePick;
                if (mp) {
                  if (b.featureId !== mp.firstId) useStore.getState().setMergeSecond(b.featureId);
                  return;
                }
                select(b.featureId);
              }}
            >
              <meshStandardMaterial
                color={b.color}
                metalness={0.1}
                roughness={0.65}
                emissive={isSecond ? '#ffaa33' : isSel ? '#4f8cff' : '#000000'}
                emissiveIntensity={isSecond || isSel ? 0.3 : 0}
                side={THREE.DoubleSide}
                transparent={b.opacity < 1}
                opacity={b.opacity}
                depthWrite={b.opacity >= 1}
              />
              <Edges threshold={28} color={isSecond ? '#ffaa33' : isSel ? '#4f8cff' : palette.edgeColor} />
            </mesh>
          );
          return deltaM ? (
            <group key={`g:${b.featureId}:${i}:${rev}`} matrix={deltaM} matrixAutoUpdate={false}>
              {mesh}
            </group>
          ) : (
            mesh
          );
        })}

        {/* assembly drive handle for the selected joint */}
        {assemblyMode && (
          <AssemblyDriveHandle
            joints={joints}
            selectedJointId={selectedJointId}
            jointValues={jointValues}
            bodies={bodies}
          />
        )}

        {/* sketches (non-active shown faint in model mode) */}
        {sketches
          .filter((sk) => sk.id !== activeSketchId)
          .map((sk) => (
            <group key={sk.id} matrix={sketchMatrix(sk, params)} matrixAutoUpdate={false}>
              <SketchLines sketch={sk} params={params} faint />
            </group>
          ))}

        {mode === 'sketch' && sketch && <ActiveSketchEditor sketch={sketch} params={params} />}
        <SketchCameraRig sketch={mode === 'sketch' ? sketch : null} params={params} />

        {mode === 'model' && gizmoMode && selected && (selected.type === 'primitive' || selected.type === 'import') && (
          <TransformGizmo feature={selected} params={params} mode={gizmoMode} />
        )}

        <GizmoHelper alignment="bottom-right" margin={[70, 70]}>
          <GizmoViewport axisColors={['#e87c7c', '#5fb878', '#5b8def']} labelColor={palette.labelColor} />
        </GizmoHelper>
      </Canvas>

      {/* floating dimension input */}
      {dimPrompt && (
        <DimInput
          key={`${dimPrompt.x}:${dimPrompt.y}:${dimPrompt.label}`}
          prompt={dimPrompt}
          close={() => setDimPrompt(null)}
        />
      )}
    </>
  );
}

function DimInput({
  prompt,
  close,
}: {
  prompt: { x: number; y: number; label: string; initial: string; onCommit: (t: string) => void; onCancel?: () => void };
  close: () => void;
}) {
  const [text, setText] = useState(prompt.initial);
  const inputRef = useRef<HTMLInputElement>(null);

  // Robust focus: when opened by a mouse click, the click's default handling can
  // steal focus right after mount — refocus on the next frames until it sticks.
  // When opened with a pre-typed initial digit, put cursor at end (not select-all)
  // so the first character isn't wiped on the next keystroke.
  useEffect(() => {
    const focus = () => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if (prompt.initial) {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      } else {
        el.select();
      }
    };
    focus();
    const t1 = setTimeout(focus, 30);
    const t2 = setTimeout(focus, 120);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div
      className="dim-input"
      style={{ left: prompt.x + 14, top: prompt.y + 14 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="dlabel">{prompt.label}</span>
      <input
        ref={inputRef}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            prompt.onCommit(text);
            close();
          } else if (e.key === 'Escape') {
            prompt.onCancel?.();
            close();
          }
        }}
      />
    </div>
  );
}
