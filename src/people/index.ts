import type { Ctx, System } from '../core/types';
import { PeopleSystem } from './system';

/**
 * People (v2): every human on the map. Passengers (origin-based trip planner, honest lead times, boarding at
 * predicted doors, waiting room, rebooking), alighting crowds and their sinks, station staff on shifts from their
 * doors, townsfolk & trades (town.ts), lamplighters, riders on vehicles/boats, and the actor API for events.
 * NO POP-IN: everyone enters/leaves through a legitimate origin (door, portal, train door, stopped vehicle,
 * moored boat) and every spawn/despawn is audited via ctx.origins.audit.
 * Rendering is fully instanced (render.ts); limbs, idle gestures and door fades run in the vertex shader.
 */
export function createPeople(ctx: Ctx): System {
  const sys = new PeopleSystem(ctx);
  ctx.reg.people = sys.api;
  return {
    name: 'people',
    update(dt, clock) {
      sys.update(dt, clock.dtMotion, clock.dtSim);
    },
    dispose() { sys.dispose(); },
  };
}
