import type { Layout } from '../core/layout';

/**
 * Tunnel containment (v2, no pop-in): the ground now reaches ±420, so "outside the ground box" no longer means
 * invisible. Trains appear and vanish ONLY inside a tunnel (under the hill, past the portal). A car is hidden when
 * both of its ends are inside a tunnel (or beyond the ground edge).
 */
export interface TunnelTest {
  /** metres inside the deepest tunnel containing (x, z); ≤ 0 = in the open */
  depth(x: number, z: number): number;
  /** true when (x, z) is out of sight: inside a tunnel by more than `inset` metres, or off the ground */
  hidden(x: number, z: number, inset?: number): boolean;
}

export function makeTunnelTest(layout: Layout): TunnelTest {
  const tunnels = layout.tunnels ?? [];
  const half = layout.terrain?.half ?? 420;
  const depth = (x: number, z: number) => {
    let best = -Infinity;
    for (const t of tunnels) {
      const rx = x - t.x, rz = z - t.z;
      const uu = rx * t.dx + rz * t.dz;
      const vv = Math.abs(-rx * t.dz + rz * t.dx);
      if (vv > t.width / 2 + 3) continue;
      if (uu > best) best = uu;
    }
    return best;
  };
  return {
    depth,
    hidden(x, z, inset = 0.6) {
      if (Math.max(Math.abs(x), Math.abs(z)) > half - 4) return true;
      return depth(x, z) > inset;
    },
  };
}
