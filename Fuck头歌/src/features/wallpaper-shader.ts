/**
 * Noctalia 12 种壁纸过渡的 WebGL2 移植。
 *
 * 设计：
 * - 一张全屏 canvas 同时采样旧/新两张纹理，片元着色器按 u_effect 走不同分支；
 * - 只在 `fit === "cover"` 且两张媒体都就绪时启用，其余情况返回 null 由调用方走 CSS/WAAPI；
 * - 图片只在开始时上传一次；视频每帧 texImage2D 一次（过渡最长 1.5s）；
 * - 所有效果公式与 Noctalia `wallpaper_program.cpp` 保持一致（smoothstep 柔边、
 *   disc/honeycomb 的 aspect 校正、CRT 的预乘混合等）。
 */

import type { Wallpaper } from "../shared/types";

export type TransitionEffect =
  | "fade"
  | "wipe"
  | "disc"
  | "stripes"
  | "zoom"
  | "honeycomb"
  | "vortex"
  | "pixel"
  | "diamond"
  | "golden"
  | "melt"
  | "crt";

export const TRANSITION_EFFECTS: readonly TransitionEffect[] = [
  "fade",
  "wipe",
  "disc",
  "stripes",
  "zoom",
  "honeycomb",
  "vortex",
  "pixel",
  "diamond",
  "golden",
  "melt",
  "crt",
];

const EFFECT_INDEX: Record<TransitionEffect, number> = {
  fade: 0,
  wipe: 1,
  disc: 2,
  stripes: 3,
  zoom: 4,
  honeycomb: 5,
  vortex: 6,
  pixel: 7,
  diamond: 8,
  golden: 9,
  melt: 10,
  crt: 11,
};

export interface CoverTransform {
  scale: [number, number];
  offset: [number, number];
}

/**
 * 复刻 CSS `object-fit: cover` + 裁剪区的 UV 仿射变换。
 * 返回 null 表示尺寸无效。
 */
export function coverTransform(
  wp: Pick<Wallpaper, "width" | "height"> & Partial<Pick<Wallpaper, "crop">>,
  source: { width: number; height: number },
  viewport: { width: number; height: number },
): CoverTransform | null {
  const nw = wp.width || source.width || 0;
  const nh = wp.height || source.height || 0;
  if (!nw || !nh || !viewport.width || !viewport.height) return null;
  const crop = wp.crop || { x: 0, y: 0, w: 1, h: 1 };
  const cw = Math.max(1, crop.w * nw);
  const ch = Math.max(1, crop.h * nh);
  const s = Math.max(viewport.width / cw, viewport.height / ch);
  const sx = s;
  const sy = s;
  const left = (viewport.width - cw * sx) / 2 - crop.x * nw * sx;
  const top = (viewport.height - ch * sy) / 2 - crop.y * nh * sy;
  return {
    scale: [viewport.width / (sx * nw), viewport.height / (sy * nh)],
    offset: [-left / (sx * nw), -top / (sy * nh)],
  };
}

export interface EffectParams {
  direction: number;
  centerX: number;
  centerY: number;
  stripeCount: number;
  angle: number;
  cellSize: number;
  smoothness: number;
}

/** 与 Noctalia 默认参数对齐；中心/角度额外随机，避免每次切换一模一样。 */
export function effectParams(effect: TransitionEffect, rand: () => number = Math.random): EffectParams {
  const centered = (): number => 0.32 + rand() * 0.36;
  return {
    direction: Math.floor(rand() * 4),
    centerX: effect === "disc" || effect === "honeycomb" ? centered() : 0.5,
    centerY: effect === "disc" || effect === "honeycomb" ? centered() : 0.5,
    stripeCount: 12,
    angle: effect === "stripes" ? rand() * 180 : rand() * 360,
    cellSize: effect === "pixel" ? 0.04 : effect === "diamond" ? 0.07 : 0.05,
    smoothness: 0.3,
  };
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_texcoord;
void main() {
  v_texcoord = a_pos;
  gl_Position = vec4(a_pos.x * 2.0 - 1.0, 1.0 - a_pos.y * 2.0, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_texcoord;
out vec4 outColor;

uniform sampler2D u_source1;
uniform sampler2D u_source2;
uniform vec2 u_scale1;
uniform vec2 u_offset1;
uniform vec2 u_scale2;
uniform vec2 u_offset2;
uniform float u_progress;
uniform int u_effect;
uniform float u_aspect;
uniform float u_direction;
uniform float u_centerX;
uniform float u_centerY;
uniform float u_smoothness;
uniform float u_cellSize;
uniform float u_stripeCount;
uniform float u_angle;

vec4 s1(vec2 uv) { return texture(u_source1, clamp(uv * u_scale1 + u_offset1, 0.0, 1.0)); }
vec4 s2(vec2 uv) { return texture(u_source2, clamp(uv * u_scale2 + u_offset2, 0.0, 1.0)); }

vec2 hexRound(float q, float r) {
  float x = q;
  float z = r;
  float y = -x - z;
  float rx = floor(x + 0.5);
  float ry = floor(y + 0.5);
  float rz = floor(z + 0.5);
  float dx = abs(rx - x);
  float dy = abs(ry - y);
  float dz = abs(rz - z);
  if (dx > dy && dx > dz) {
    rx = -ry - rz;
  } else if (dy > dz) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  return vec2(rx, rz);
}

float mapSmooth(float s) { return mix(0.001, 0.5, s * s); }

void main() {
  vec2 uv = v_texcoord;
  float p = u_progress;
  float smooth5 = mapSmooth(u_smoothness);
  vec4 color1 = s1(uv);
  vec4 color2 = s2(uv);

  if (u_effect == 0) {
    // fade
    outColor = mix(color1, color2, p);
    return;
  }

  if (u_effect == 1) {
    // wipe: 0=left, 1=right, 2=up, 3=down
    float edge;
    float factor;
    float ep = p * (1.0 + 2.0 * smooth5) - smooth5;
    if (u_direction < 0.5) {
      edge = 1.0 - ep;
      factor = smoothstep(edge - smooth5, edge + smooth5, uv.x);
      outColor = mix(color1, color2, factor);
    } else if (u_direction < 1.5) {
      edge = ep;
      factor = smoothstep(edge - smooth5, edge + smooth5, uv.x);
      outColor = mix(color2, color1, factor);
    } else if (u_direction < 2.5) {
      edge = 1.0 - ep;
      factor = smoothstep(edge - smooth5, edge + smooth5, uv.y);
      outColor = mix(color1, color2, factor);
    } else {
      edge = ep;
      factor = smoothstep(edge - smooth5, edge + smooth5, uv.y);
      outColor = mix(color2, color1, factor);
    }
    return;
  }

  if (u_effect == 2) {
    // disc
    vec2 center = vec2(u_centerX, u_centerY);
    vec2 aspectUV = vec2(uv.x * u_aspect, uv.y);
    vec2 aspectCenter = vec2(center.x * u_aspect, center.y);
    float dist = distance(aspectUV, aspectCenter);
    float maxDist = 0.0;
    maxDist = max(maxDist, distance(aspectCenter, vec2(0.0, 0.0)));
    maxDist = max(maxDist, distance(aspectCenter, vec2(u_aspect, 0.0)));
    maxDist = max(maxDist, distance(aspectCenter, vec2(0.0, 1.0)));
    maxDist = max(maxDist, distance(aspectCenter, vec2(u_aspect, 1.0)));
    float radius = p * (maxDist + 2.0 * smooth5) - smooth5;
    float factor = smoothstep(radius - smooth5, radius + smooth5, dist);
    outColor = mix(color2, color1, factor);
    return;
  }

  if (u_effect == 3) {
    // stripes
    float mapped = mix(0.001, 0.3, u_smoothness * u_smoothness);
    float rad = radians(u_angle);
    float cosA = cos(rad);
    float sinA = sin(rad);
    vec2 aspectUV = vec2(uv.x * u_aspect, uv.y);
    float stripeCoord = aspectUV.x * cosA + aspectUV.y * sinA;
    float perpCoord = -aspectUV.x * sinA + aspectUV.y * cosA;
    float totalStripes = max(u_stripeCount, 2.0);
    float maxStripeCoord = u_aspect * abs(cosA) + abs(sinA);
    float stripeWidth = maxStripeCoord / totalStripes;
    float stripePos = stripeCoord / max(stripeWidth, 0.0001);
    float stripeIndex = floor(stripePos);
    float isOdd = mod(stripeIndex, 2.0);
    float maxPerp = u_aspect * abs(sinA) + abs(cosA);
    float normalizedPerp = perpCoord / max(maxPerp, 0.0001);
    float delay = abs(normalizedPerp) * 0.3;
    float localProgress = clamp((p - delay) / max(1.0 - delay, 0.0001), 0.0, 1.0);
    float localFrac = fract(stripePos);
    float edge;
    float factor;
    if (isOdd > 0.5) {
      edge = mix(1.0 + mapped, -mapped, localProgress);
      factor = smoothstep(edge - mapped, edge + mapped, localFrac);
      outColor = mix(color1, color2, factor);
    } else {
      edge = mix(-mapped, 1.0 + mapped, localProgress);
      factor = smoothstep(edge - mapped, edge + mapped, localFrac);
      outColor = mix(color2, color1, factor);
    }
    return;
  }

  if (u_effect == 4) {
    // zoom
    float zoom = 0.15;
    float scale1 = 1.0 + zoom * p;
    vec2 uv1 = (uv - 0.5) / scale1 + 0.5;
    float scale2 = 1.0 + zoom * (1.0 - p);
    vec2 uv2 = (uv - 0.5) / scale2 + 0.5;
    outColor = mix(s1(uv1), s2(uv2), p);
    return;
  }

  if (u_effect == 5) {
    // honeycomb
    float size = max(u_cellSize, 0.005);
    vec2 aspectUV = vec2(uv.x * u_aspect, uv.y);
    float q = (aspectUV.x * (2.0 / 3.0)) / size;
    float r = ((-aspectUV.x / 3.0) + (sqrt(3.0) / 3.0) * aspectUV.y) / size;
    vec2 hexCoord = hexRound(q, r);
    float cellCenterX = (hexCoord.x * 1.5) * size;
    float cellCenterY = (hexCoord.x * sqrt(3.0) / 2.0 + hexCoord.y * sqrt(3.0)) * size;
    vec2 cellCenter = vec2(cellCenterX, cellCenterY);
    vec2 waveOrigin = vec2(u_centerX * u_aspect, u_centerY);
    float dist = distance(cellCenter, waveOrigin);
    float maxDist = 0.0;
    maxDist = max(maxDist, distance(waveOrigin, vec2(0.0, 0.0)));
    maxDist = max(maxDist, distance(waveOrigin, vec2(u_aspect, 0.0)));
    maxDist = max(maxDist, distance(waveOrigin, vec2(0.0, 1.0)));
    maxDist = max(maxDist, distance(waveOrigin, vec2(u_aspect, 1.0)));
    float radius = p * (maxDist + 2.0 * smooth5) - smooth5;
    float factor = smoothstep(radius - smooth5, radius + smooth5, dist);
    outColor = mix(color2, color1, factor);
    return;
  }

  if (u_effect == 6) {
    // vortex
    float feather = max(0.015, smooth5 * 1.5);
    vec2 center = vec2(u_centerX * u_aspect, u_centerY);
    vec2 aspectUV = vec2(uv.x * u_aspect, uv.y);
    vec2 delta = aspectUV - center;
    float dist = length(delta);
    float angle = atan(delta.y, delta.x) + (1.0 - p) * 3.14159265;
    float normAngle = (angle + 3.14159265) / 6.2831853;
    float arms = 3.0;
    float spiral = dist + fract(normAngle * arms) * 0.25;
    float maxDist = length(max(center, vec2(u_aspect, 1.0) - center));
    float edge = p * (maxDist + 0.25 + 2.0 * feather) - feather;
    float factor = smoothstep(edge - feather, edge + feather, spiral);
    outColor = mix(color2, color1, factor);
    return;
  }

  if (u_effect == 7) {
    // pixel
    float feather = max(0.02, smooth5 * 1.5);
    vec2 center = vec2(u_centerX * u_aspect, u_centerY);
    vec2 aspectUV = vec2(uv.x * u_aspect, uv.y);
    float size = max(u_cellSize * 0.75, 0.02);
    vec2 cell = floor(aspectUV / size);
    float noise = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
    float maxDist = length(max(center, vec2(u_aspect, 1.0) - center));
    float distNorm = distance(aspectUV, center) / max(maxDist, 0.001);
    float threshold = mix(distNorm, noise, 0.35);
    float edge = p * (1.0 + 2.0 * feather) - feather;
    float factor = smoothstep(edge - feather, edge + feather, threshold);
    outColor = mix(color2, color1, factor);
    return;
  }

  if (u_effect == 8) {
    // diamond
    float feather = max(0.05, smooth5 * 2.5);
    vec2 center = vec2(u_centerX * u_aspect, u_centerY);
    vec2 aspectUV = vec2(uv.x * u_aspect, uv.y);
    float size = max(u_cellSize * 1.15, 0.0345);
    vec2 cellIndex = floor(aspectUV / size);
    vec2 cellCenter = (cellIndex + 0.5) * size;
    vec2 inCell = abs(aspectUV - cellCenter) / (size * 0.5);
    float diamondMetric = inCell.x + inCell.y;
    float maxDist = length(max(center, vec2(u_aspect, 1.0) - center));
    float delay = (distance(cellCenter, center) / max(maxDist, 0.001)) * 0.4;
    float localProgress = clamp((p - delay) / max(1.0 - delay, 0.0001), 0.0, 1.0);
    float radius = localProgress * (2.0 + 2.0 * feather) - feather;
    float factor = smoothstep(radius - feather, radius + feather, diamondMetric);
    outColor = mix(color2, color1, factor);
    return;
  }

  if (u_effect == 9) {
    // golden spiral
    float feather = max(0.02, smooth5 * 1.6);
    vec2 center = vec2(u_centerX * u_aspect, u_centerY);
    vec2 aspectUV = vec2(uv.x * u_aspect, uv.y);
    vec2 delta = aspectUV - center;
    float dist = length(delta);
    float angle = atan(delta.y, delta.x);
    float maxDist = length(max(center, vec2(u_aspect, 1.0) - center));
    float b = 0.306349;
    float phase = radians(u_angle) + p * 6.2831853;
    float deltaTheta = mod(angle - phase, 6.2831853);
    float goldenDist = (dist / max(maxDist, 0.001)) * exp(-b * deltaTheta);
    float edge = p * (1.0 + 2.0 * feather) - feather;
    float factor = smoothstep(edge - feather, edge + feather, goldenDist);
    outColor = mix(color2, color1, factor);
    return;
  }

  if (u_effect == 10) {
    // melt
    float feather = max(0.02, smooth5 * 1.5);
    float wave = sin(uv.x * 14.0 + radians(u_angle)) * 0.05
               + sin(uv.x * 32.0 - radians(u_angle) * 1.5) * 0.025
               + cos(uv.x * 7.0 + 1.2) * 0.04;
    float drip = uv.y + wave;
    float waveAmplitude = 0.115;
    float sweepSpan = 1.0 + 2.0 * waveAmplitude;
    float edge = p * (sweepSpan + 2.0 * feather) - waveAmplitude - feather;
    float factor = smoothstep(edge - feather, edge + feather, drip);
    outColor = mix(color2, color1, factor);
    return;
  }

  // crt
  float edge = mix(0.0015, 0.02, u_smoothness * u_smoothness);
  float squash = smoothstep(0.0, 0.55, p);
  float pinch = smoothstep(0.5, 0.85, p);
  float whiten = smoothstep(0.2, 0.55, p);
  float dotFade = 1.0 - smoothstep(0.85, 1.0, p);
  float thickness = 0.004;
  float scaleY = mix(1.0, thickness, squash);
  float scaleX = max(mix(1.0, 0.0, pinch), thickness / max(u_aspect, 0.0001));
  vec2 point = vec2((uv.x - 0.5) * u_aspect, uv.y - 0.5);
  vec2 halfSize = vec2(scaleX * u_aspect, scaleY) * 0.5;
  float corner = min(halfSize.x, halfSize.y) * pinch;
  vec2 q = abs(point) - halfSize + corner;
  float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
  float mask = 1.0 - smoothstep(-edge, edge, dist);
  vec2 sampleUV = clamp((uv - 0.5) / vec2(max(scaleX, 0.0001), max(scaleY, 0.0001)) + 0.5, 0.0, 1.0);
  vec4 texel = s1(sampleUV);
  vec3 color = mix(texel.rgb, vec3(1.0), whiten);
  float content = mask * dotFade;
  float glow = exp(-max(dist, 0.0) * 90.0) * whiten * dotFade * 0.6;
  float alpha = clamp(content + glow, 0.0, 1.0);
  vec3 rgb = min(color * content + vec3(glow), vec3(alpha));
  outColor = vec4(rgb + color2.rgb * (1.0 - alpha), 1.0);
}`;

type Media = HTMLImageElement | HTMLVideoElement;

const isReady = (media: Media): boolean => {
  if (media instanceof HTMLVideoElement) return media.readyState >= 2 && media.videoWidth > 0;
  return media.complete && media.naturalWidth > 0;
};

const waitReady = (media: Media, timeout: number): Promise<boolean> => {
  if (isReady(media)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      media.removeEventListener("load", onReady);
      media.removeEventListener("loadeddata", onReady);
      resolve(ok);
    };
    const onReady = (): void => finish(isReady(media));
    const timer = window.setTimeout(() => finish(false), timeout);
    media.addEventListener("load", onReady);
    media.addEventListener("loadeddata", onReady);
  });
};

const compile = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null => {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
};

const createTexture = (gl: WebGL2RenderingContext): WebGLTexture | null => {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
};

const mediaSize = (media: Media): [number, number] =>
  media instanceof HTMLVideoElement
    ? [media.videoWidth, media.videoHeight]
    : [media.naturalWidth, media.naturalHeight];

const upload = (gl: WebGL2RenderingContext, tex: WebGLTexture, media: Media): boolean => {
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.getError(); // 清掉旧错误，下面的 getError 只反映这次上传
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, media);
    return gl.getError() === gl.NO_ERROR;
  } catch (e) {
    return false;
  }
};


export interface ShaderTransitionOptions {
  oldMedia: Media;
  newMedia: Media;
  oldWallpaper: Wallpaper;
  newWallpaper: Wallpaper;
  effect: TransitionEffect;
  duration: number;
  /** 异步等待媒体期间，调用方可能已经开始了下一次切换 */
  isCurrent?: () => boolean;
}

export interface ShaderTransitionHandle {
  canvas: HTMLCanvasElement;
  done: Promise<void>;
  cancel(): void;
}

const SHADER_CANVAS_ID = "ft-bg-shader";

interface Uniforms {
  scale1: WebGLUniformLocation | null;
  offset1: WebGLUniformLocation | null;
  scale2: WebGLUniformLocation | null;
  offset2: WebGLUniformLocation | null;
  effect: WebGLUniformLocation | null;
  aspect: WebGLUniformLocation | null;
  direction: WebGLUniformLocation | null;
  centerX: WebGLUniformLocation | null;
  centerY: WebGLUniformLocation | null;
  smoothness: WebGLUniformLocation | null;
  cellSize: WebGLUniformLocation | null;
  stripeCount: WebGLUniformLocation | null;
  angle: WebGLUniformLocation | null;
  progress: WebGLUniformLocation | null;
}

interface ShaderRenderer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  tex1: WebGLTexture;
  tex2: WebGLTexture;
  posLoc: number;
  uniforms: Uniforms;
}

let cachedRenderer: ShaderRenderer | null = null;

/** 关闭背景/卸载时释放 GPU 资源；正常切换之间复用 program/纹理。 */
export function releaseShaderRenderer(): void {
  const r = cachedRenderer;
  cachedRenderer = null;
  if (!r) return;
  try {
    r.gl.deleteProgram(r.program);
    r.gl.deleteBuffer(r.buffer);
    r.gl.deleteTexture(r.tex1);
    r.gl.deleteTexture(r.tex2);
    r.gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch (e) {}
  try {
    r.canvas.remove();
  } catch (e) {}
}

const createRenderer = (): ShaderRenderer | null => {
  const canvas = document.createElement("canvas");
  canvas.id = SHADER_CANVAS_ID;
  canvas.setAttribute("aria-hidden", "true");
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const buffer = gl.createBuffer();
  const tex1 = createTexture(gl);
  const tex2 = createTexture(gl);
  if (!buffer || !tex1 || !tex2) {
    gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    if (tex1) gl.deleteTexture(tex1);
    if (tex2) gl.deleteTexture(tex2);
    return null;
  }

  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, "u_source1"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "u_source2"), 1);

  const uniforms: Uniforms = {
    scale1: gl.getUniformLocation(program, "u_scale1"),
    offset1: gl.getUniformLocation(program, "u_offset1"),
    scale2: gl.getUniformLocation(program, "u_scale2"),
    offset2: gl.getUniformLocation(program, "u_offset2"),
    effect: gl.getUniformLocation(program, "u_effect"),
    aspect: gl.getUniformLocation(program, "u_aspect"),
    direction: gl.getUniformLocation(program, "u_direction"),
    centerX: gl.getUniformLocation(program, "u_centerX"),
    centerY: gl.getUniformLocation(program, "u_centerY"),
    smoothness: gl.getUniformLocation(program, "u_smoothness"),
    cellSize: gl.getUniformLocation(program, "u_cellSize"),
    stripeCount: gl.getUniformLocation(program, "u_stripeCount"),
    angle: gl.getUniformLocation(program, "u_angle"),
    progress: gl.getUniformLocation(program, "u_progress"),
  };

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  return { canvas, gl, program, buffer, tex1, tex2, posLoc, uniforms };
};

const getRenderer = (): ShaderRenderer | null => {
  if (cachedRenderer && !cachedRenderer.gl.isContextLost()) return cachedRenderer;
  releaseShaderRenderer();
  cachedRenderer = createRenderer();
  return cachedRenderer;
};

/**
 * 启动一次 GPU 过渡。返回 null 表示环境不支持/媒体未就绪，调用方应回退 CSS。
 * 注意：调用方负责把 canvas 插入 DOM；`cancel()` 后 canvas 由调用方移除。
 */
export async function startShaderTransition(
  opts: ShaderTransitionOptions,
): Promise<ShaderTransitionHandle | null> {
  if (typeof document === "undefined") return null;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return null;
  if (!isReady(opts.oldMedia)) return null;
  if (!(await waitReady(opts.newMedia, 600))) return null;
  if (opts.isCurrent && !opts.isCurrent()) return null;

  const renderer = getRenderer();
  if (!renderer) return null;
  const { canvas, gl, program, buffer, tex1, tex2, uniforms } = renderer;

  const width = window.innerWidth || 1;
  const height = window.innerHeight || 1;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const cap = Math.min(1, 1600 / width, 900 / height);
  const rw = Math.max(1, Math.round(width * dpr * cap));
  const rh = Math.max(1, Math.round(height * dpr * cap));
  canvas.width = rw;
  canvas.height = rh;
  canvas.dataset.effect = opts.effect;
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.zIndex = "-1";
  canvas.style.pointerEvents = "none";
  canvas.style.opacity = "1";
  canvas.style.willChange = "opacity";

  const [oldW, oldH] = mediaSize(opts.oldMedia);
  const [newW, newH] = mediaSize(opts.newMedia);
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const oldT = coverTransform(opts.oldWallpaper, { width: oldW, height: oldH }, { width, height });
  const newT = coverTransform(opts.newWallpaper, { width: newW, height: newH }, { width, height });
  if (
    !oldT || !newT ||
    oldW > maxTex || oldH > maxTex || newW > maxTex || newH > maxTex ||
    !upload(gl, tex1, opts.oldMedia) || !upload(gl, tex2, opts.newMedia)
  ) {
    return null;
  }

  const params = effectParams(opts.effect);
  const aspect = width / height;
  gl.useProgram(program);
  gl.uniform2f(uniforms.scale1, oldT.scale[0], oldT.scale[1]);
  gl.uniform2f(uniforms.offset1, oldT.offset[0], oldT.offset[1]);
  gl.uniform2f(uniforms.scale2, newT.scale[0], newT.scale[1]);
  gl.uniform2f(uniforms.offset2, newT.offset[0], newT.offset[1]);
  gl.uniform1i(uniforms.effect, EFFECT_INDEX[opts.effect]);
  gl.uniform1f(uniforms.aspect, aspect);
  gl.uniform1f(uniforms.direction, params.direction);
  gl.uniform1f(uniforms.centerX, params.centerX);
  gl.uniform1f(uniforms.centerY, params.centerY);
  gl.uniform1f(uniforms.smoothness, params.smoothness);
  gl.uniform1f(uniforms.cellSize, params.cellSize);
  gl.uniform1f(uniforms.stripeCount, params.stripeCount);
  gl.uniform1f(uniforms.angle, params.angle);

  gl.viewport(0, 0, rw, rh);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(renderer.posLoc);
  gl.vertexAttribPointer(renderer.posLoc, 2, gl.FLOAT, false, 0, 0);

  // 视频需要持续播放并每帧上传，否则纹理停在第一帧
  if (opts.newMedia instanceof HTMLVideoElement) opts.newMedia.play?.().catch(() => {});
  if (opts.oldMedia instanceof HTMLVideoElement) opts.oldMedia.play?.().catch(() => {});

  let cancelled = false;
  let raf = 0;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const draw = (now: number): void => {
    if (cancelled) return;
    const progress = Math.min(1, Math.max(0, (now - start) / opts.duration));
    if (opts.oldMedia instanceof HTMLVideoElement && isReady(opts.oldMedia)) upload(gl, tex1, opts.oldMedia);
    if (opts.newMedia instanceof HTMLVideoElement && isReady(opts.newMedia)) upload(gl, tex2, opts.newMedia);
    gl.uniform1f(uniforms.progress, progress);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex2);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (progress >= 1) {
      finish();
      return;
    }
    raf = requestAnimationFrame(draw);
  };

  const finish = (): void => {
    if (cancelled) return;
    cancelled = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    resolveDone();
  };

  const start = performance.now();
  raf = requestAnimationFrame(draw);

  return {
    canvas,
    done,
    cancel(): void {
      finish();
    },
  };
}
