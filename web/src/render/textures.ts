/**
 * Procedurally generated road textures (Canvas-based, no external assets).
 *
 * Design ref: 02_design.md section 6.7.
 */

import * as THREE from "three";

const TEXTURE_SIZE = 512;
const LINE_WIDTH_FRACTION = 0.035; // white line width as a fraction of road width

/**
 * Asphalt texture with white edge lines. u (texture x) spans the road
 * width [0,1]; v (texture y) spans one longitudinal tile (design: 10 m
 * per tile, set via repeat on the returned texture's `.repeat`).
 */
export function createAsphaltTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  // Base asphalt: dark grey with subtle per-pixel noise for texture.
  ctx.fillStyle = "#3a3a3d";
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  const imageData = ctx.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 18;
    data[i] = clampByte(data[i] + noise);
    data[i + 1] = clampByte(data[i + 1] + noise);
    data[i + 2] = clampByte(data[i + 2] + noise);
  }
  ctx.putImageData(imageData, 0, 0);

  // White edge lines.
  const lineWidthPx = TEXTURE_SIZE * LINE_WIDTH_FRACTION;
  ctx.fillStyle = "#e8e8e0";
  ctx.fillRect(0, 0, lineWidthPx, TEXTURE_SIZE);
  ctx.fillRect(TEXTURE_SIZE - lineWidthPx, 0, lineWidthPx, TEXTURE_SIZE);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, v));
}
