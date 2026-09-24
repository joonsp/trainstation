import * as THREE from 'three';
import type { CarType } from '../core/apis';
import { SPECS, carGeometry, smallWheelGeometry, driverWheelGeometry, rodGeometry, plateGeometry, type CarSpec } from './cars';
import type { CarPlan } from './consist';
import type { TrainMats } from './mats';
import type { Bucket } from './geom';
import type { Route } from './route';

export interface Car {
  plan: CarPlan;
  spec: CarSpec;
  len: number;
  flipped: boolean;
  group: THREE.Group;
  /** distance from the train's lead point to this car's leading end */
  offset: number;
  /** accumulated rolling distance in the car's local +x sense */
  spin: number;
  rods: THREE.Mesh[];
  /** emits smoke (live locomotive) */
  working: boolean;
  isLoco: boolean;
  swayPhase: number;
  ghost: boolean;
}

const MAX_SMALL = 1600;
const MAX_DRIVER = 160;
const BASE_SMALL_R = 0.5;

/**
 * Builds car Object3Ds from cached merged geometry and places whole trains along their routes.
 * Wheels of every car are drawn by two global InstancedMeshes (one draw call each).
 */
export class TrainVisuals {
  readonly root = new THREE.Group();
  private smallWheels: THREE.InstancedMesh;
  private driverWheels: THREE.InstancedMesh;
  private rodGeoms = new Map<number, THREE.BufferGeometry>();
  private plateGeoms = new Map<number, THREE.BufferGeometry>();
  private tailGeo = new THREE.BoxGeometry(0.2, 0.26, 0.2);
  private nSmall = 0;
  private nDriver = 0;

  private mA = new THREE.Matrix4();
  private mB = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();
  private zAxis = new THREE.Vector3(0, 0, 1);
  private pF = new THREE.Vector3();
  private pR = new THREE.Vector3();

  private pA = new THREE.Vector3();
  private pB = new THREE.Vector3();

  /** `hidden(x, z)`: true when a point is out of sight (inside a tunnel / off the ground) — cars vanish only there */
  constructor(private tm: TrainMats, private hidden: (x: number, z: number) => boolean) {
    this.root.name = 'trains';
    this.smallWheels = new THREE.InstancedMesh(smallWheelGeometry(), tm.wheel, MAX_SMALL);
    this.driverWheels = new THREE.InstancedMesh(driverWheelGeometry(), tm.wheel, MAX_DRIVER);
    for (const m of [this.smallWheels, this.driverWheels]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      this.root.add(m);
    }
    this.smallWheels.name = 'trainWheels';
    this.driverWheels.name = 'trainDrivers';
  }

  makeCar(plan: CarPlan, trainId: string, locoName: string | null, ghost: boolean): Car {
    const spec = SPECS[plan.type];
    const group = new THREE.Group();
    group.name = `car:${plan.type}`;
    group.userData.pick = { kind: 'train', id: trainId };
    group.rotation.order = 'YXZ';
    const geoms = carGeometry(plan.type, plan.livery, plan.variant);
    const tm = this.tm;
    const matFor: Record<Bucket, THREE.Material> = ghost
      ? { paint: tm.ghost, window: tm.ghost, brass: tm.ghost, lamp: tm.ghost, fire: tm.ghost }
      : { paint: tm.paint, window: tm.window, brass: tm.brass, lamp: tm.headLamp, fire: tm.fire };
    for (const b of Object.keys(geoms) as Bucket[]) {
      const g = geoms[b];
      if (!g) continue;
      const mesh = new THREE.Mesh(g, matFor[b]);
      mesh.matrixAutoUpdate = false;
      if (b === 'paint' && !ghost) mesh.castShadow = true;
      group.add(mesh);
    }
    const rods: THREE.Mesh[] = [];
    if (spec.rods) {
      const len = Math.abs(spec.rods.x1 - spec.rods.x0);
      let rg = this.rodGeoms.get(len);
      if (!rg) { rg = rodGeometry(len); this.rodGeoms.set(len, rg); }
      for (const side of [1, -1]) {
        const rod = new THREE.Mesh(rg, ghost ? tm.ghost : tm.rod);
        rod.position.set((spec.rods.x0 + spec.rods.x1) / 2, spec.rods.y, side * spec.rods.z);
        rod.userData.side = side;
        group.add(rod);
        rods.push(rod);
      }
    }
    if (spec.plate && locoName && !ghost) {
      let pg = this.plateGeoms.get(spec.plate.w);
      if (!pg) { pg = plateGeometry(spec.plate.w); this.plateGeoms.set(spec.plate.w, pg); }
      const mat = tm.plate(locoName);
      for (const side of [1, -1]) {
        const p = new THREE.Mesh(pg, mat);
        p.position.set(spec.plate.x, spec.plate.y, side * spec.plate.z);
        if (side < 0) p.rotation.y = Math.PI;
        p.updateMatrix();
        p.matrixAutoUpdate = false;
        group.add(p);
      }
    }
    group.visible = false;
    this.root.add(group);
    return {
      plan, spec, len: spec.len, flipped: !!plan.flipped, group, offset: 0, spin: Math.random() * 10, rods,
      working: !!spec.loco, isLoco: !!spec.loco, swayPhase: Math.random() * 6.28, ghost,
    };
  }

  /** attach the red tail lamp to the rear of the last car */
  setTailLamp(cars: Car[], ghost: boolean): void {
    for (const c of cars) {
      const old = c.group.getObjectByName('tailLamp');
      if (old) c.group.remove(old);
    }
    const last = cars[cars.length - 1];
    if (!last || ghost) return;
    const lamp = new THREE.Mesh(this.tailGeo, this.tm.tailLamp);
    lamp.name = 'tailLamp';
    const t = last.spec.tail;
    lamp.position.set(last.flipped ? -t.x : t.x, t.y, t.z);
    last.group.add(lamp);
  }

  removeCar(c: Car): void {
    this.root.remove(c.group);
    // geometries/materials are shared & cached — nothing to dispose per car
  }

  beginFrame(): void { this.nSmall = 0; this.nDriver = 0; }

  /** place every car of a train along its route; writes wheel instances */
  placeTrain(cars: Car[], route: Route, s: number, speed: number, hideWheels: boolean): void {
    for (const c of cars) {
      const front = s - c.offset;
      route.pointAt(front, this.pA);
      route.pointAt(front - c.len, this.pB);
      // no pop-in: a car is only ever hidden while BOTH of its ends are inside a tunnel
      const vis = !(this.hidden(this.pA.x, this.pA.z) && this.hidden(this.pB.x, this.pB.z));
      c.group.visible = vis;
      if (!vis) continue;
      route.pointAt(front - c.len * 0.2, this.pF);
      route.pointAt(front - c.len * 0.8, this.pR);
      const x = (this.pF.x + this.pR.x) / 2, z = (this.pF.z + this.pR.z) / 2;
      let yaw = Math.atan2(-(this.pF.z - this.pR.z), this.pF.x - this.pR.x);
      if (c.flipped) yaw += Math.PI;
      const sway = Math.min(1, speed / 12);
      const roll = Math.sin(c.spin * 0.21 + c.swayPhase) * 0.012 * sway;
      const bob = Math.sin(c.spin * 0.9 + c.swayPhase) * 0.012 * sway;
      c.group.position.set(x, (this.pF.y + this.pR.y) / 2 + bob, z);
      c.group.rotation.set(roll, yaw, 0);
      c.group.updateMatrix();
      c.group.matrixWorld.copy(c.group.matrix); // root is identity
      // rods
      if (c.rods.length && c.spec.rods) {
        const r = c.spec.rods;
        const drv = c.spec.axles.find((a) => a.kind === 'driver');
        const phi = -c.spin / (drv ? drv.r : 1);
        for (const rod of c.rods) {
          const side = rod.userData.side as number;
          const a = phi + (side < 0 ? Math.PI / 2 : 0);
          rod.position.x = (r.x0 + r.x1) / 2 + r.r * Math.cos(a);
          rod.position.y = r.y + r.r * Math.sin(a);
        }
      }
      if (hideWheels) continue;
      for (const ax of c.spec.axles) {
        const driver = ax.kind === 'driver';
        const phi = -c.spin / ax.r;
        for (const side of [1, -1]) {
          if (driver ? this.nDriver >= MAX_DRIVER : this.nSmall >= MAX_SMALL) continue;
          const zz = side * (driver ? 0.76 : 0.75);
          const ang = phi + (driver && side < 0 ? Math.PI / 2 : 0);
          this.q.setFromAxisAngle(this.zAxis, ang);
          const k = driver ? ax.r : ax.r / BASE_SMALL_R;
          this.mA.compose(this.v.set(ax.x, ax.r, zz), this.q, this.sc.set(k, k, driver ? 1 : 1));
          this.mB.multiplyMatrices(c.group.matrix, this.mA);
          if (driver) this.driverWheels.setMatrixAt(this.nDriver++, this.mB);
          else this.smallWheels.setMatrixAt(this.nSmall++, this.mB);
        }
      }
    }
  }

  endFrame(): void {
    this.smallWheels.count = this.nSmall;
    this.driverWheels.count = this.nDriver;
    this.smallWheels.instanceMatrix.needsUpdate = true;
    this.driverWheels.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.smallWheels.geometry.dispose();
    this.driverWheels.geometry.dispose();
    for (const g of this.rodGeoms.values()) g.dispose();
    for (const g of this.plateGeoms.values()) g.dispose();
    this.tailGeo.dispose();
  }
}

export function isPassengerCar(t: CarType): boolean {
  return t === 'coach_first' || t === 'coach_second' || t === 'coach_third' || t === 'dining' || t === 'royal_saloon';
}
