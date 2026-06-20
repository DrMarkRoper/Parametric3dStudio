import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface ImportedMesh {
  geometry: THREE.BufferGeometry;
  color?: string;
  /** suggested Y offset so the model sits on the ground */
  groundY: number;
}

function normalizeGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let c = g.index ? g.toNonIndexed() : g.clone();
  for (const name of Object.keys(c.attributes)) {
    if (name !== 'position' && name !== 'normal') c.deleteAttribute(name);
  }
  if (!c.attributes.normal) c.computeVertexNormals();
  return c;
}

function collectFromObject(root: THREE.Object3D): { geometry: THREE.BufferGeometry; color?: string } {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  let color: string | undefined;
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) {
      const mesh = node as THREE.Mesh;
      const g = normalizeGeometry(mesh.geometry);
      g.applyMatrix4(mesh.matrixWorld);
      parts.push(g);
      if (!color) {
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        const mc = (mat as THREE.MeshStandardMaterial)?.color;
        if (mc) color = `#${mc.getHexString()}`;
      }
    }
  });
  if (!parts.length) throw new Error('File contains no mesh data');
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!merged) throw new Error('Failed to merge meshes');
  return { geometry: merged, color };
}

/* ---------- STEP via occt-import-js ---------- */

let occtPromise: Promise<import('occt-import-js').OcctModule> | null = null;

async function getOcct() {
  if (!occtPromise) {
    const [{ default: init }, { default: wasmUrl }] = await Promise.all([
      import('occt-import-js'),
      import('occt-import-js/dist/occt-import-js.wasm?url'),
    ]);
    occtPromise = init({ locateFile: () => wasmUrl });
  }
  return occtPromise;
}

async function importStep(buffer: ArrayBuffer): Promise<{ geometry: THREE.BufferGeometry; color?: string }> {
  const occt = await getOcct();
  const result = occt.ReadStepFile(new Uint8Array(buffer), null);
  if (!result.success || !result.meshes.length) throw new Error('Failed to read STEP file');
  const parts: THREE.BufferGeometry[] = [];
  let color: string | undefined;
  for (const m of result.meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) {
      g.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    }
    if (m.index) g.setIndex(m.index.array);
    parts.push(normalizeGeometry(g));
    if (!color && m.color) {
      color = `#${new THREE.Color(m.color[0], m.color[1], m.color[2]).getHexString()}`;
    }
  }
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (!merged) throw new Error('Failed to merge STEP meshes');
  return { geometry: merged, color };
}

/* ---------- Entry point ---------- */

export const IMPORT_EXTENSIONS = ['.stl', '.obj', '.gltf', '.glb', '.step', '.stp'];

export async function importModelFile(file: File): Promise<ImportedMesh> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  let out: { geometry: THREE.BufferGeometry; color?: string };

  if (ext === 'stl') {
    const g = new STLLoader().parse(await file.arrayBuffer());
    out = { geometry: normalizeGeometry(g) };
  } else if (ext === 'obj') {
    const root = new OBJLoader().parse(await file.text());
    out = collectFromObject(root);
  } else if (ext === 'gltf' || ext === 'glb') {
    const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), '');
    out = collectFromObject(gltf.scene);
  } else if (ext === 'step' || ext === 'stp') {
    out = await importStep(await file.arrayBuffer());
  } else {
    throw new Error(`Unsupported file type ".${ext}"`);
  }

  out.geometry.computeBoundingBox();
  const groundY = out.geometry.boundingBox ? -out.geometry.boundingBox.min.y : 0;
  return { ...out, groundY };
}
