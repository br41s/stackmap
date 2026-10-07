// Where the neighbours of a focused node go: what it uses on an arc to the right, what uses
// it on an arc to the left, so direction reads at a glance. Pure math, tested in Node.

export const MIN_GAP = 74;     // px along the arc between neighbours, room for a label
export const MIN_RADIUS = 210;
const ARC = (150 * Math.PI) / 180;  // each side spans 150°, leaving the poles clear
const RING_STEP = 1.32;             // outer ring radius when one ring is not enough
const MAX_PER_RING = 14;

function arcPositions(center, ids, side, radius) {
  const out = new Map();
  if (!ids.length) return out;
  // Split a crowded side over two rings, alternating, so neighbours stagger.
  const rings = ids.length > MAX_PER_RING ? 2 : 1;
  ids.forEach((id, i) => {
    const ring = rings === 2 ? i % 2 : 0;
    const slot = rings === 2 ? Math.floor(i / 2) : i;
    const perRing = rings === 2 ? Math.ceil(ids.length / 2) : ids.length;
    const t = perRing === 1 ? 0.5 : slot / (perRing - 1);
    // Right side sweeps top→bottom around 0°, left side around 180°.
    const angle = (side === "right" ? 0 : Math.PI) + (t - 0.5) * ARC * (side === "right" ? 1 : -1);
    const r = radius * (ring ? RING_STEP : 1);
    out.set(id, { x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle) });
  });
  return out;
}

// Radius that keeps MIN_GAP between neighbours on the busier side.
export function orbitRadius(outCount, inCount) {
  const perRing = Math.min(Math.max(outCount, inCount), MAX_PER_RING);
  return Math.max(MIN_RADIUS, (perRing * MIN_GAP) / ARC);
}

// A node related both ways is drawn once, on the outgoing side.
export function orbitPositions(center, outIds, inIds) {
  const outs = [...new Set(outIds)];
  const ins = [...new Set(inIds)].filter((id) => !outs.includes(id));
  const radius = orbitRadius(outs.length, ins.length);
  return new Map([...arcPositions(center, outs, "right", radius), ...arcPositions(center, ins, "left", radius)]);
}
