import * as THREE from 'three';
import type { Rng } from '../core/rng';

const MAX_PTS = 64;

/** A jagged, camera-facing ribbon bolt with one or two branches. One geometry, rebuilt per strike. */
export class LightningBolt {
  readonly mesh: THREE.Mesh;
  private pos = new Float32Array(MAX_PTS * 2 * 3 * 3);
  private geo = new THREE.BufferGeometry();
  private mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(3.2, 3.5, 4.5), transparent: true, opacity: 1, depthWrite: false, fog: false, side: THREE.DoubleSide,
  });
  private life = 0;
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private side = new THREE.Vector3();
  private dir = new THREE.Vector3();

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 70;
    this.mesh.visible = false;
    this.mesh.name = 'lightningBolt';
  }

  strike(ground: THREE.Vector3, camForward: THREE.Vector3, rng: Rng): void {
    let n = 0; // vertex count
    const addSeg = (p: THREE.Vector3, q: THREE.Vector3, w: number) => {
      if (n + 6 > this.pos.length / 3) return;
      this.dir.subVectors(q, p);
      this.side.crossVectors(this.dir, camForward).normalize().multiplyScalar(w);
      const P = this.pos;
      const put = (v: THREE.Vector3, s: number) => { P[n * 3] = v.x + this.side.x * s; P[n * 3 + 1] = v.y + this.side.y * s; P[n * 3 + 2] = v.z + this.side.z * s; n++; };
      put(p, -1); put(p, 1); put(q, -1);
      put(p, 1); put(q, 1); put(q, -1);
    };
    const bolt = (start: THREE.Vector3, end: THREE.Vector3, segs: number, w: number, jitter: number, branches: number) => {
      const prev = this.a.copy(start);
      const cur = new THREE.Vector3();
      for (let i = 1; i <= segs; i++) {
        const f = i / segs;
        cur.lerpVectors(start, end, f);
        if (i < segs) { cur.x += rng.range(-jitter, jitter); cur.z += rng.range(-jitter, jitter); cur.y += rng.range(-2, 2); }
        addSeg(prev, cur, w * (1 - f * 0.5));
        if (branches > 0 && i > 2 && i < segs - 2 && rng.chance(0.25)) {
          branches--;
          const bEnd = this.b.copy(cur).add(new THREE.Vector3(rng.range(-25, 25), -rng.range(15, 35), rng.range(-25, 25)));
          const save = prev.clone();
          bolt(cur.clone(), bEnd.clone(), 5, w * 0.5, jitter * 0.7, 0);
          prev.copy(save);
        }
        prev.copy(cur);
      }
    };
    const top = new THREE.Vector3(ground.x + rng.range(-20, 20), 120, ground.z + rng.range(-20, 20));
    bolt(top, ground, 14, 0.65, 6, 2);
    this.geo.setDrawRange(0, n);
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.life = 0.32;
    this.mesh.visible = true;
  }

  update(dt: number): void {
    if (!this.mesh.visible) return;
    this.life -= dt;
    // flicker: on / dim / on
    this.mat.opacity = this.life > 0.22 ? 1 : this.life > 0.15 ? 0.25 : this.life > 0.05 ? 0.9 : Math.max(0, this.life / 0.05);
    if (this.life <= 0) this.mesh.visible = false;
  }

  dispose(): void { this.geo.dispose(); this.mat.dispose(); }
}
