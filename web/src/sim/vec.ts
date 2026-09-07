/**
 * Minimal 3D vector type and operations, with no Three.js dependency.
 *
 * Design ref: 02_design.md section 6.1 -- `sim/` must stay engine-agnostic
 * so its algorithms can be ported to another runtime (Unity, a Python
 * visualizer, ...) by reading this file's math alone.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export const ZERO: Vec3 = vec3(0, 0, 0);

export function add(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x + b.x, a.y + b.y, a.z + b.z);
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function scale(a: Vec3, s: number): Vec3 {
  return vec3(a.x * s, a.y * s, a.z * s);
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return vec3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-12) return ZERO;
  return scale(a, 1 / len);
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

/**
 * Rotate `v` by `angle` radians around unit axis `axis` (Rodrigues' formula).
 * Used to apply bank/cant roll to the track's "up" vector (design 6.2).
 * Currently a no-op in practice since bank is always 0 (design 4.6), but
 * kept as a real implementation so a future non-zero bank source needs no
 * changes here.
 */
export function rotateAroundAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const k = axis;
  const kCrossV = cross(k, v);
  const kDotV = dot(k, v);
  return add(
    add(scale(v, cos), scale(kCrossV, sin)),
    scale(k, kDotV * (1 - cos)),
  );
}
