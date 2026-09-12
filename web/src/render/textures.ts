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

/**
 * Race-number decal for the car's nose sides (design 6.8.1) -- a plain
 * white disc with a dark numeral, not any real team's number-plate style.
 */
export function createNumberDecalTexture(digits: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  ctx.clearRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  ctx.fillStyle = "#f2f2f2";
  ctx.beginPath();
  ctx.arc(TEXTURE_SIZE / 2, TEXTURE_SIZE / 2, TEXTURE_SIZE * 0.46, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#1a1a1a";
  ctx.font = `bold ${TEXTURE_SIZE * 0.55}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(digits, TEXTURE_SIZE / 2, TEXTURE_SIZE * 0.54);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Window-grid building facade, used by render/cityScenery.ts for Monaco's
 * skyline (design 6.12). A shared base texture is cloned per building so
 * each can set its own `.repeat` without affecting the others.
 */
export function createWindowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  // Background (design 6.12.1, P18 follow-up): was a medium blue-grey
  // (#4a4a52) that, multiplied against `material.color` (MeshStandardMaterial
  // combines `color` and `map` by multiplying them), neutralized whatever
  // palette color a building was given -- the first palette attempt still
  // rendered as a muddy grey-brown regardless of the actual color chosen,
  // since this background plus the mostly-dark window cells below covered
  // nearly the whole facade. Lightened further (from an intermediate
  // #cfc6b0 stone tone to this near-white) for the second, paler
  // white/beige-only palette (cityScenery.ts's BUILDING_PALETTE) -- the
  // in-between stone tone still muddied the near-white wall colors when
  // multiplied.
  ctx.fillStyle = "#efe8da";
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  const cols = 8;
  const rows = 12;
  const cellW = TEXTURE_SIZE / cols;
  const cellH = TEXTURE_SIZE / rows;
  const marginW = cellW * 0.18;
  const marginH = cellH * 0.18;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Unlit window color softened from near-black (#26262c) to a dark
      // warm brown, for the same reason as the background above -- windows
      // cover most of the facade area, so a near-black fill dominated the
      // final look regardless of the wall color.
      ctx.fillStyle = Math.random() < 0.35 ? "#f7e9b8" : "#4a4038";
      ctx.fillRect(c * cellW + marginW, r * cellH + marginH, cellW - marginW * 2, cellH - marginH * 2);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Alternating red/white curb stripe, used by render/circuitScenery.ts for
 * Suzuka (design 6.12). Tiles along the strip's length via `.repeat.y`
 * (set by the caller, same convention as the asphalt texture's `v = s/10`).
 */
export function createCurbTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  ctx.fillStyle = "#c81e2c";
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  ctx.fillStyle = "#e8e8e0";
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
