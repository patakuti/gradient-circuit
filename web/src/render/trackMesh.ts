/**
 * Road-surface mesh generation from a Track.
 *
 * Design ref: 02_design.md section 6.7. A triangle strip: for each sample,
 * a left/right edge point offset from the centerline by widthLeft/
 * widthRight along the (horizontal) normal; two triangles connect each
 * pair of adjacent samples, with the loop closed back to sample 0.
 */

import * as THREE from "three";
import type { Track } from "../sim/track";
import { createAsphaltTexture } from "./textures";

const TEXTURE_TILE_LENGTH_M = 10.0; // design 6.7: v = s / 10.0

export function buildTrackMesh(track: Track): THREE.Mesh {
  const n = track.count;
  const positions = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);

  for (let i = 0; i < n; i++) {
    const s = i * track.ds;
    const sample = track.sampleAt(s);
    const left = {
      x: sample.position.x + sample.normal.x * sample.widthLeft,
      y: sample.position.y + sample.normal.y * sample.widthLeft,
      z: sample.position.z + sample.normal.z * sample.widthLeft,
    };
    const right = {
      x: sample.position.x - sample.normal.x * sample.widthRight,
      y: sample.position.y - sample.normal.y * sample.widthRight,
      z: sample.position.z - sample.normal.z * sample.widthRight,
    };

    const li = i * 2; // left vertex index
    const ri = i * 2 + 1; // right vertex index

    positions[li * 3] = left.x;
    positions[li * 3 + 1] = left.y;
    positions[li * 3 + 2] = left.z;
    positions[ri * 3] = right.x;
    positions[ri * 3 + 1] = right.y;
    positions[ri * 3 + 2] = right.z;

    const v = s / TEXTURE_TILE_LENGTH_M;
    uvs[li * 2] = 1; // left edge -> u=1
    uvs[li * 2 + 1] = v;
    uvs[ri * 2] = 0; // right edge -> u=0
    uvs[ri * 2 + 1] = v;
  }

  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const l0 = i * 2, r0 = i * 2 + 1;
    const l1 = j * 2, r1 = j * 2 + 1;
    // two triangles per segment, both wound so the normal faces "up"
    // given left/right vertex order and increasing s direction.
    indices.push(l0, r0, l1);
    indices.push(r0, r1, l1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals(); // area-weighted average, per design 6.7

  const texture = createAsphaltTexture();
  texture.repeat.set(1, 1);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.9,
    metalness: 0.0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "trackSurface";
  return mesh;
}
