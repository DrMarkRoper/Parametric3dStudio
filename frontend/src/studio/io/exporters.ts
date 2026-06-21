import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import type { Doc, ImportFeature, SnapMode } from '../types';
import type { BodyOut } from '../core/buildGeometry';
import { emptyProjectMeta, newProjectId, importCache, type ProjectMeta } from '../state/store';

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function exportSTL(bodies: BodyOut[], fileName = 'model.stl') {
  if (!bodies.length) throw new Error('No bodies to export');
  const scene = new THREE.Scene();
  for (const b of bodies) {
    scene.add(new THREE.Mesh(b.geometry, new THREE.MeshStandardMaterial()));
  }
  scene.updateMatrixWorld(true);
  const data = new STLExporter().parse(scene, { binary: true }) as unknown as DataView;
  download(new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' }), fileName);
}

/* ---------- Embedded mesh serialization ----------
 * Bodies created by "Detach from sketch" or "Create independent body" have no
 * source file to re-import, so we serialize their geometry into the saved JSON
 * payload under `meshes[featureId]`. Plain JSON arrays — simple, lossless, no
 * external dependencies. Positions are required; normals/index are optional
 * (normals are recomputed on load if missing).
 */

interface SerializedMesh {
  positions: number[];
  normals?: number[];
  index?: number[];
}

function serializeGeometry(g: THREE.BufferGeometry): SerializedMesh {
  const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) throw new Error('geometry has no position attribute');
  const norm = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  return {
    positions: Array.from(pos.array as Float32Array | Float64Array, (n) => +n),
    normals: norm ? Array.from(norm.array as Float32Array | Float64Array, (n) => +n) : undefined,
    index: g.index ? Array.from(g.index.array as Uint16Array | Uint32Array, (n) => +n) : undefined,
  };
}

function deserializeGeometry(m: SerializedMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
  if (m.normals && m.normals.length === m.positions.length) {
    g.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
  }
  if (m.index) {
    const big = m.positions.length / 3 > 65535;
    g.setIndex(big ? new THREE.Uint32BufferAttribute(m.index, 1) : new THREE.Uint16BufferAttribute(m.index, 1));
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

export function saveProject(doc: Doc, fileName = 'project.cad.json', meta?: ProjectMeta) {
  // Serialize geometry for every embedded import that actually has cached mesh data.
  const meshes: Record<string, SerializedMesh> = {};
  for (const f of doc.features) {
    if (f.type !== 'import' || !(f as ImportFeature).embedded) continue;
    const g = importCache.get(f.id);
    if (!g) continue; // nothing to embed (shouldn't happen, but skip silently)
    try {
      meshes[f.id] = serializeGeometry(g);
    } catch {
      /* skip un-serializable geometries */
    }
  }
  const payload = {
    app: 'parametric-3d-studio',
    version: 2,
    meta: meta ?? emptyProjectMeta(),
    doc,
    meshes,
  };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), fileName);
}

export async function loadProject(file: File): Promise<{ doc: Doc; meta: ProjectMeta }> {
  const data = JSON.parse(await file.text());
  const doc = data?.doc ?? data;
  if (!doc || !Array.isArray(doc.features) || !Array.isArray(doc.parameters)) {
    throw new Error('Not a valid project file');
  }
  // migrate legacy primitives (rotationY -> rotation[])
  const features = doc.features.map((f: { type?: string; rotation?: unknown; rotationY?: string }) =>
    f.type === 'primitive' && !f.rotation ? { ...f, rotation: ['0', f.rotationY ?? '0', '0'] } : f
  );

  // Restore embedded geometries into the import cache.
  const meshes: Record<string, SerializedMesh> | undefined = data?.meshes;
  if (meshes && typeof meshes === 'object') {
    for (const [id, m] of Object.entries(meshes)) {
      if (!m || !Array.isArray(m.positions)) continue;
      try {
        importCache.set(id, deserializeGeometry(m));
      } catch {
        /* ignore corrupt entries */
      }
    }
  }

  const loadedDoc: Doc = {
    parameters: doc.parameters,
    features,
    gridSize: typeof doc.gridSize === 'number' ? doc.gridSize : 5,
    // migrate legacy boolean snap: true → 'grid', false → 'none'
    snap: (['none', 'grid', 'edge'] as SnapMode[]).includes(doc.snap)
      ? (doc.snap as SnapMode)
      : doc.snap === false ? 'none' : 'grid',
    // Assembly joints/links/pin-slots — absent in legacy files → empty arrays.
    joints: Array.isArray(doc.joints) ? doc.joints : [],
    links: Array.isArray(doc.links) ? doc.links : [],
    pinSlots: Array.isArray(doc.pinSlots) ? doc.pinSlots : [],
    categories: Array.isArray(doc.categories) ? doc.categories : [],
    rootOrder: Array.isArray(doc.rootOrder) ? doc.rootOrder : [],
  };

  // Project meta — older files may not have a meta field; fill with defaults
  // and use the file name (sans extension) as a fallback project name.
  const rawMeta = (data?.meta ?? {}) as Partial<ProjectMeta>;
  const fallbackName = file.name.replace(/\.(cad\.)?json$/i, '');
  const meta: ProjectMeta = {
    // Files saved before project ids existed get a fresh one, ready for the next save.
    projectId: typeof rawMeta.projectId === 'string' && rawMeta.projectId.trim()
      ? rawMeta.projectId
      : newProjectId(),
    name: typeof rawMeta.name === 'string' && rawMeta.name.trim()
      ? rawMeta.name
      : fallbackName || null,
    description: typeof rawMeta.description === 'string' ? rawMeta.description : '',
    createdAt: typeof rawMeta.createdAt === 'string' ? rawMeta.createdAt : null,
    modifiedAt: typeof rawMeta.modifiedAt === 'string' ? rawMeta.modifiedAt : null,
    defaultRootId: typeof rawMeta.defaultRootId === 'string' ? rawMeta.defaultRootId : null,
  };

  return { doc: loadedDoc, meta };
}
