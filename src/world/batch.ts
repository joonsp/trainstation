import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Kit } from './kit';

/**
 * GLOBAL CHUNKED BATCHER (v2). Same API as Kit, but every added primitive is binned by
 * material × chunk (by the centre of its world bounding box) × shadow flag, so static scenery merges into
 * one mesh per material per area and whole areas frustum-cull. The chunk grid is offset so the default
 * iso view (centred near the forecourt) falls mostly inside one chunk.
 *
 * `cast` / `detail` are sticky flags callers flip around groups of primitives:
 *   cast   — mesh casts shadows (tier permitting: see World shadow policy)
 *   detail — tiny props hidden below knobs.detailZoom (flowers, headstones, fence rails)
 */
export const CHUNK = 340;
/** the centre chunk is centred on the forecourt, so the default view draws (almost) one chunk per material */
export const CHUNK_X0 = -124;
export const CHUNK_Z0 = -188;

export function chunkOf(x: number, z: number): string {
  return `${Math.floor((x - CHUNK_X0) / CHUNK)},${Math.floor((z - CHUNK_Z0) / CHUNK)}`;
}

interface Bin { mat: THREE.Material; cast: boolean; detail: boolean; chunk: string; geos: THREE.BufferGeometry[] }

/**
 * Shadow policy per tier: 'major' (low) lets only the big masonry/roof materials cast; otherwise any bin with a
 * cast-flagged primitive casts. (Cast and non-cast primitives of one material share a bin — one draw, not two.)
 */
export type CastPolicy = (mat: THREE.Material) => boolean;

export class Batch extends Kit {
  cast = false;
  detail = false;
  castPolicy: CastPolicy = () => true;

  private bins = new Map<string, Bin>();
  private bb = new THREE.Box3();
  private c = new THREE.Vector3();

  protected override sink(material: THREE.Material, geo: THREE.BufferGeometry): void {
    geo.computeBoundingBox();
    this.bb.copy(geo.boundingBox!).getCenter(this.c);
    const chunk = chunkOf(this.c.x, this.c.z);
    const transparent = (material as THREE.MeshStandardMaterial).transparent;
    const cast = this.cast && !transparent;
    const key = `${material.uuid}|${chunk}|${this.detail ? 1 : 0}`;
    let b = this.bins.get(key);
    if (!b) { b = { mat: material, cast: false, detail: this.detail, chunk, geos: [] }; this.bins.set(key, b); }
    if (cast) b.cast = true;
    b.geos.push(geo);
  }

  override get empty(): boolean { return this.bins.size === 0; }

  /** merge everything; returns the group plus the tiny-detail meshes (for zoom-based hiding) */
  buildChunks(name: string): { group: THREE.Group; detail: THREE.Mesh[] } {
    const group = new THREE.Group();
    group.name = name;
    const detail: THREE.Mesh[] = [];
    for (const b of this.bins.values()) {
      const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
      for (const g of b.geos) if (g !== merged) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, b.mat);
      mesh.name = `${name}:${b.mat.name || 'mat'}:${b.chunk}${b.detail ? ':d' : ''}`;
      mesh.castShadow = b.cast && !b.detail && this.castPolicy(b.mat);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      if (b.detail) detail.push(mesh);
    }
    this.bins.clear();
    group.matrixAutoUpdate = false;
    return { group, detail };
  }
}

/** split a list of instance matrices (+ optional colours) into per-chunk InstancedMeshes */
export function chunkedInstances(
  geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], cols: THREE.Color[] | null, name: string,
  opts: { cast?: boolean; receive?: boolean; depth?: THREE.Material | null; attrs?: Record<string, { size: number; data: number[] }> } = {},
): THREE.InstancedMesh[] {
  const bins = new Map<string, number[]>();
  const p = new THREE.Vector3();
  mats.forEach((m, i) => {
    p.setFromMatrixPosition(m);
    const k = chunkOf(p.x, p.z);
    let a = bins.get(k);
    if (!a) { a = []; bins.set(k, a); }
    a.push(i);
  });
  const out: THREE.InstancedMesh[] = [];
  for (const [k, idx] of bins) {
    let g = geo;
    if (opts.attrs) {
      g = geo.clone();
      for (const [an, a] of Object.entries(opts.attrs)) {
        const arr = new Float32Array(idx.length * a.size);
        idx.forEach((ii, j) => { for (let c = 0; c < a.size; c++) arr[j * a.size + c] = a.data[ii * a.size + c]; });
        g.setAttribute(an, new THREE.InstancedBufferAttribute(arr, a.size));
      }
    }
    const im = new THREE.InstancedMesh(g, mat, idx.length);
    idx.forEach((ii, j) => { im.setMatrixAt(j, mats[ii]); if (cols) im.setColorAt(j, cols[ii]); });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = !!opts.cast;
    im.receiveShadow = opts.receive ?? true;
    if (opts.depth) im.customDepthMaterial = opts.depth;
    im.name = `${name}:${k}`;
    im.computeBoundingSphere();
    im.computeBoundingBox();
    out.push(im);
  }
  return out;
}

const PROXY_MAT = new THREE.MeshBasicMaterial({ visible: false });
PROXY_MAT.name = 'w_pickProxy';
/**
 * Invisible pick proxies for station parts that were merged into the static batch (raycasts ignore visibility,
 * the renderer skips them): one box per rect, all carrying userData.pick.
 */
export function pickProxy(name: string, pick: { kind: string; id: string }, boxes: { center: THREE.Vector3; size: THREE.Vector3; yaw: number; y0?: number }[]): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.userData.pick = pick;
  for (const b of boxes) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(b.size.x, b.size.y, b.size.z), PROXY_MAT);
    m.position.set(b.center.x, (b.y0 ?? 0) + b.size.y / 2, b.center.z);
    m.rotation.y = b.yaw;
    m.visible = false;
    m.userData.pick = pick;
    m.updateMatrix();
    m.updateMatrixWorld();
    g.add(m);
  }
  return g;
}
