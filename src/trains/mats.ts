import * as THREE from 'three';
import type { Materials } from '../core/materials';

/** Shared materials owned by the trains subsystem (never cloned per car). */
export interface TrainMats {
  /** vertex-coloured flat paint: every livery lives in vertex colours so one material serves all cars */
  paint: THREE.MeshStandardMaterial;
  /** translucent spectral material for the ghost train (used for every bucket) */
  ghost: THREE.MeshStandardMaterial;
  headLamp: THREE.MeshStandardMaterial;
  tailLamp: THREE.MeshStandardMaterial;
  /** firebox glow in the cab — warm, a little visible even by day */
  fire: THREE.MeshStandardMaterial;
  wheel: THREE.MeshStandardMaterial;
  rod: THREE.MeshStandardMaterial;
  window: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  plate(name: string): THREE.MeshStandardMaterial;
  setNight(n: number): void;
  setWeather(snow: number, rain: number): void;
}

export function createTrainMats(m: Materials): TrainMats {
  const paint = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55, metalness: 0.08 });
  paint.name = 'trainPaint';
  // snow settles on up-facing faces (roofs, boiler tops, coal) — one uniform, no per-car work
  const uSnow = { value: 0 };
  paint.onBeforeCompile = (sh) => {
    sh.uniforms.uSnow = uSnow;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSnow;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 fnV = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
          float up = (vec4(fnV, 0.0) * viewMatrix).y;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.97), uSnow * smoothstep(0.55, 0.9, up));
        }`);
  };
  paint.customProgramCacheKey = () => 'trainPaintSnow';
  const ghost = new THREE.MeshStandardMaterial({
    color: 0xcfe6ee, emissive: 0x6a9cb0, emissiveIntensity: 0.35, flatShading: true,
    transparent: true, opacity: 0.3, depthWrite: false, roughness: 0.3,
  });
  ghost.name = 'trainGhost';
  const headLamp = new THREE.MeshStandardMaterial({ color: 0xf4ecd8, emissive: 0xfff0c8, emissiveIntensity: 0.3, flatShading: true, roughness: 0.3 });
  const tailLamp = new THREE.MeshStandardMaterial({ color: 0x8a1e18, emissive: 0xff3a22, emissiveIntensity: 0.25, flatShading: true, roughness: 0.3 });
  const fire = new THREE.MeshStandardMaterial({ color: 0x3a1a0a, emissive: 0xff7a2a, emissiveIntensity: 0.6, flatShading: true });
  const wheel = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5, metalness: 0.35 });
  const rod = new THREE.MeshStandardMaterial({ color: 0x9a9ea2, flatShading: true, roughness: 0.3, metalness: 0.8 });

  const plates = new Map<string, THREE.MeshStandardMaterial>();
  function plate(name: string): THREE.MeshStandardMaterial {
    let mat = plates.get(name);
    if (mat) return mat;
    const c = document.createElement('canvas');
    c.width = 512; c.height = 96;
    const g = c.getContext('2d');
    if (g) {
      const grd = g.createLinearGradient(0, 0, 0, 96);
      grd.addColorStop(0, '#e6c56a'); grd.addColorStop(0.5, '#c9a24a'); grd.addColorStop(1, '#9a7a30');
      g.fillStyle = grd; g.fillRect(0, 0, 512, 96);
      g.fillStyle = '#1e1a16'; g.fillRect(10, 10, 492, 76);
      g.fillStyle = '#e8cf7e';
      g.font = 'bold 50px Georgia, "Times New Roman", serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(name.toUpperCase(), 256, 51, 470);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, metalness: 0.35 });
    plates.set(name, mat);
    return mat;
  }

  return {
    paint, ghost, headLamp, tailLamp, fire, wheel, rod,
    window: m.windowLit, brass: m.brass,
    plate,
    setNight(n: number) {
      headLamp.emissiveIntensity = 0.3 + 4.2 * n;
      tailLamp.emissiveIntensity = 0.25 + 3.0 * n;
      fire.emissiveIntensity = 0.6 + 2.4 * n;
      ghost.emissiveIntensity = 0.3 + 0.25 * n;
      ghost.opacity = 0.28 + 0.06 * n;
    },
    setWeather(snow: number, rain: number) {
      uSnow.value = Math.min(1, Math.max(0, snow)) * 0.9;
      paint.roughness = 0.55 - 0.25 * Math.min(1, Math.max(0, rain));
    },
  };
}
