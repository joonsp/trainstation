import * as THREE from 'three';
import type { Ctx } from '../core/types';

/**
 * DEV ONLY: `?tcam=x,z,halfH[,azDeg[,elevDeg]]` or `?tcam=T2,halfH[,az[,elev]]` (follow a train) — a close-up
 * orthographic camera used by the trains builder for screenshots. Inactive unless the param is present.
 */
export function createDebugCam(ctx: Ctx): ((dt: number) => void) | null {
  const raw = ctx.params.raw.get('tcam');
  if (!raw) return null;
  const parts = raw.split(',');
  const followId = /^T\d+$/.test(parts[0]) ? parts[0] : null;
  const nums = parts.map(Number);
  const cx = followId ? 0 : nums[0] || 0;
  const cz = followId ? 0 : nums[1] || 0;
  const halfH = (followId ? nums[1] : nums[2]) || 20;
  const az = ((followId ? nums[2] : nums[3]) ?? 45) * Math.PI / 180;
  const el = ((followId ? nums[3] : nums[4]) ?? 32) * Math.PI / 180;
  const aspect = window.innerWidth / window.innerHeight;
  const cam = new THREE.OrthographicCamera(-halfH * aspect, halfH * aspect, halfH, -halfH, 1, 3000);
  const target = new THREE.Vector3(cx, 1.5, cz);
  const place = () => {
    const d = 400;
    cam.position.set(target.x + Math.cos(el) * Math.cos(az) * d, target.y + Math.sin(el) * d, target.z + Math.cos(el) * Math.sin(az) * d);
    cam.lookAt(target);
    cam.updateMatrixWorld();
  };
  place();
  ctx.bus.on('ready', () => { ctx.camera.current = cam; });
  return () => {
    if (ctx.camera.current !== cam) ctx.camera.current = cam;
    if (followId) {
      const t = ctx.reg.trains.get(followId);
      if (t) { target.copy(t.position); target.y = 1.5; }
    }
    place();
  };
}
