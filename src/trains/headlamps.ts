import * as THREE from 'three';
import type { Ctx } from '../core/types';

/**
 * Locomotive head lamps at night. Tier-aware (ctx.quality.knobs.spotLights):
 *  • spotLights > 0: a fixed pool of SpotLights (count never changes → no shader recompiles) for the nearest trains;
 *  • always: a soft additive beam cone (one InstancedMesh) so every lamp reads even with no real light, and a pooled
 *    point-light claim (ctx.lights) at the lamp for the nearest two engines so the track ahead glows.
 */
const MAX_CONES = 6;
const BEAM_LEN = 16;

export class Headlamps {
  readonly group = new THREE.Group();
  private spots: THREE.SpotLight[] = [];
  private cones: THREE.InstancedMesh;
  private coneMat: THREE.MeshBasicMaterial;
  private n = 0;
  private night = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private dir = new THREE.Vector3();
  private p = new THREE.Vector3();

  constructor(private ctx: Ctx, spotCount: number) {
    this.group.name = 'trainHeadlamps';
    for (let i = 0; i < Math.max(0, Math.min(2, spotCount)); i++) {
      const sp = new THREE.SpotLight(0xffe6b0, 0, 70, 0.42, 0.7, 1.2);
      sp.castShadow = false;
      sp.name = 'trainHeadlamp';
      this.group.add(sp, sp.target);
      this.spots.push(sp);
    }
    // beam: an open cone lying along +y (apex at the lamp), rotated onto the track direction per instance
    const geo = new THREE.ConeGeometry(2.2, BEAM_LEN, 12, 1, true);
    geo.translate(0, -BEAM_LEN / 2, 0);
    geo.rotateX(Math.PI); // apex at origin, opening toward +y
    // fade toward the far end through vertex colours
    const pos = geo.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const k = 1 - Math.min(1, Math.max(0, pos.getY(i) / BEAM_LEN));
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k * k;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.coneMat = new THREE.MeshBasicMaterial({
      color: 0xffe2a8, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: true,
    });
    this.coneMat.name = 'trainBeam';
    this.cones = new THREE.InstancedMesh(geo, this.coneMat, MAX_CONES);
    this.cones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cones.count = 0;
    this.cones.frustumCulled = false;
    this.cones.castShadow = false;
    this.cones.receiveShadow = false;
    this.cones.renderOrder = 5;
    this.cones.name = 'trainBeams';
    this.group.add(this.cones);
  }

  begin(night: number): void {
    this.n = 0;
    this.night = night;
  }

  /** lamp at `pos`, pointing along unit `tangent` (travel direction) */
  add(key: string, pos: THREE.Vector3, tangent: THREE.Vector3): void {
    const k = Math.min(1, (this.night - 0.2) / 0.4);
    if (k <= 0) return;
    const i = this.n++;
    // real spot light (tier permitting)
    if (i < this.spots.length) {
      const sp = this.spots[i];
      sp.position.set(pos.x + tangent.x * 0.3, pos.y + 0.3, pos.z + tangent.z * 0.3);
      sp.target.position.set(pos.x + tangent.x * 28, 0.2, pos.z + tangent.z * 28);
      sp.target.updateMatrixWorld();
      sp.intensity = 90 * k;
    }
    // pooled point light just ahead of the buffer beam (only the nearest couple of engines)
    if (i < 2) {
      this.p.set(pos.x + tangent.x * 3, pos.y + 0.2, pos.z + tangent.z * 3);
      this.ctx.lights?.claim(`train:lamp:${key}`, this.p, 0xffe0a0, 14 * k, 22, 0.7);
    }
    if (i < MAX_CONES) {
      this.dir.set(tangent.x, -0.12, tangent.z).normalize();
      this.q.setFromUnitVectors(this.up, this.dir);
      this.m.compose(this.p.set(pos.x + tangent.x * 0.25, pos.y, pos.z + tangent.z * 0.25), this.q, this.s);
      this.cones.setMatrixAt(i, this.m);
    }
  }

  end(): void {
    for (let i = this.n; i < this.spots.length; i++) this.spots[i].intensity = 0;
    const k = Math.min(1, Math.max(0, (this.night - 0.2) / 0.4));
    this.cones.count = Math.min(this.n, MAX_CONES);
    this.cones.visible = this.cones.count > 0 && k > 0;
    this.coneMat.opacity = 0.16 * k;
    if (this.cones.count) this.cones.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.cones.geometry.dispose();
    this.coneMat.dispose();
    for (const sp of this.spots) this.group.remove(sp, sp.target);
  }
}
