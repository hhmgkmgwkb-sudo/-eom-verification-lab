import {
  getCanvasParams,
  isCanvasMode,
  sculptCanvas,
} from "@/lib/eom-canvas-state";
import {
  effectiveCanvasParams,
  getAmbientVeilBias,
  tickAmbient,
} from "@/lib/eom-ambient-drive";
import { getFieldRouting, isDeepFieldEnabled } from "@/lib/eom-controls";
import { getInteractionMode } from "@/lib/eom-interaction";
import {
  getPinchDebug,
  publishPinchDebug,
  resetPinchDebug,
} from "@/lib/eom-pinch-debug";
import {
  exciteElastic,
  exciteEnergy,
  exciteFine,
  exciteImpulse,
  exciteLow,
  exciteMass,
  exciteStability,
  exciteVeilBias,
  excitedCanvasParams,
  tickExcitation,
} from "@/lib/eom-excitation";
import { macroCanvas, macroElastic, macroMass, macroVeilBias } from "@/lib/eom-macro";
import { applyLifeToCanvas, lifeToFieldBias } from "@/lib/eom-field-adapter";
import { applySpacetimeMantle } from "@/lib/eom-spacetime-field";

import { tickLifeState } from "@/lib/eom-life-state";
import { tickPerception } from "@/lib/eom-perception";


import type { ShapeInstance } from "@/lib/eom-shape-library";
import { getScene, getShape, selectInstance, updateInstance } from "@/lib/eom-shape-library";
import {
  SWIRL_GRID,
  SWIRL_TRI_COUNT,
  SwirlMesh,
  decodeRest,
  encodeRest,
} from "@/lib/eom-swirl-mesh";

import type { StateBus } from "@/lib/eom-state-bus";

/**
 * EOM Canvas Engine — PRUEBA CONTROLADA.
 *
 * El campo continuo validado (membrana fina y tensa, multitouch, memoria breve,
 * recuperación gradual, sin snap-back) sigue siendo exactamente el mismo motor:
 * estados físicos en framebuffers flotantes ping-pong
 *   R = altura, G = velocidad, B = memoria espacial breve.
 *
 * DIFERENCIA ÚNICA DE ESTA FASE: el haz luminoso deja de renderizarse. El fondo
 * es grafito plano (#303236) y la ÚNICA manifestación visual del campo es una
 * forma real (asset canónico) cuya malla se desplaza muestreando ese mismo
 * campo: stretch, bend, squash, warp local, pliegue suave y retorno con memoria.
 * No existe una segunda física para la forma.
 */

const QUAD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const SIM_FS = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 outState;

uniform sampler2D uState;
uniform vec2 uTexel;      // 1 / simulation resolution
uniform vec2 uAspect;     // aspect correction for isotropic distances
uniform float uDt;
uniform float uTime;
uniform int uCount;
uniform vec4 uTouch[10];     // xy = current uv, zw = previous uv
uniform vec2 uTouchMeta[10]; // x = strength (0..1), y = radius scale

// --- audio-derived field modulation (EOMStateBus effectiveState) ---
uniform float uAEnergy;
uniform float uALow;
uniform float uAFine;
uniform float uAImpulse;
uniform float uAStability;
uniform float uAMemory;
uniform float uADensity;
uniform float uASpace;

const int MAX_T = 10;

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = (p - a) * uAspect;
  vec2 ba = (b - a) * uAspect;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-7), 0.0, 1.0);
  return length(pa - ba * h);
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0 - 1.0;
}

void main() {
  vec4 s = texture(uState, vUv);
  float h = s.r;
  float v = s.g;
  float mem = s.b;

  // --- Laplacian (9-point, isotropic -> no axis-aligned artefacts) ---
  float l = texture(uState, vUv + vec2(-uTexel.x, 0.0)).r;
  float r = texture(uState, vUv + vec2( uTexel.x, 0.0)).r;
  float d = texture(uState, vUv + vec2(0.0, -uTexel.y)).r;
  float u = texture(uState, vUv + vec2(0.0,  uTexel.y)).r;
  float ll = texture(uState, vUv + vec2(-uTexel.x, -uTexel.y)).r;
  float lr = texture(uState, vUv + vec2( uTexel.x, -uTexel.y)).r;
  float ul = texture(uState, vUv + vec2(-uTexel.x,  uTexel.y)).r;
  float ur = texture(uState, vUv + vec2( uTexel.x,  uTexel.y)).r;
  float lap = 0.5 * (l + r + u + d) + 0.25 * (ll + lr + ul + ur) - 3.0 * h;

  // --- very thin, very taut sheet: energy travels far, little local storage ---
  float tension = 0.95 + uAFine * 0.14;
  float restore = 1.45 - uAMemory * 0.30;
  float damping = 2.30 - (uAStability - 0.5) * 0.55;

  float acc = tension * lap - restore * h - damping * v;
  v += acc * uDt;

  // --- touch forcing: a spatial perturbation, never a fingerprint ---
  float press = 0.0;
  for (int i = 0; i < MAX_T; i++) {
    if (i >= uCount) break;
    vec4 t = uTouch[i];
    vec2 meta = uTouchMeta[i];
    float dist = segDist(vUv, t.zw, t.xy);
    float rad = 0.34 * meta.y * (1.0 + uASpace * 0.55);
    float q = dist / rad;
    float near = 1.0 / (1.0 + q * q * (1.0 + 0.55 * q));
    float qf = dist / (rad * 3.1);
    float far = 1.0 / (1.0 + qf * qf);
    press += (near * 0.52 + far * 0.48) * meta.x;
  }
  press *= 1.0 + uAEnergy * 0.55;
  v -= press * 0.95 * uDt;
  h -= press * 0.22 * uDt;

  // --- latent life of the field ---
  vec2 np = vUv * uAspect * 1.45;
  float n = vnoise(np + vec2(uTime * 0.045, -uTime * 0.031))
          + 0.5 * vnoise(np * 2.3 - vec2(uTime * 0.027, uTime * 0.019));
  v += n * (0.0038 + uADensity * 0.0075) * uDt;

  // --- audio: slow broad pressure from sub/bass ---
  vec2 lp = vUv * uAspect * (0.55 + uASpace * 0.25);
  float lowN = vnoise(lp + vec2(uTime * 0.021, uTime * 0.017));
  v -= (0.055 + lowN * 0.035) * uALow * uDt;

  // --- audio: brief impulses distributed across the field ---
  vec2 ip = vUv * uAspect * (2.1 + uAFine * 2.6);
  float imp = vnoise(ip + vec2(uTime * 0.63, -uTime * 0.51));
  v += imp * uAImpulse * 0.085 * uDt;

  h += v * uDt;

  // --- short spatial memory of the perturbation (fades cleanly) ---
  // la huella conserva la INTENSIDAD del gesto (cada dedo su propia inercia)
  // sin saturar en 1.0: así dos contactos distintos no dejan la misma memoria
  mem = max(mem * (1.0 - 1.6 * uDt), clamp(-h * 3.2, 0.0, 1.0));

  outState = vec4(h, v, mem, 1.0);
}`;

/**
 * LEY 0 — EL LIENZO COMO ESTADO GENERATIVO.
 *
 * La materia del lienzo se genera aquí dentro, íntegramente desde los
 * parámetros del Canvas State (grano, fibra, niebla, densidad, variación tonal,
 * tensión, irregularidad, difusión, profundidad, respuesta lumínica). No hay
 * bitmaps, ni skins, ni texturas externas: cambiar de estado cambia la
 * configuración paramétrica de esta materia. El campo sigue invisible.
 */
const RENDER_FS = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;

uniform float uGrain, uFiber, uMist, uDensity, uTonal, uTension;
uniform float uIrreg, uDiff, uDepth, uLumin, uTemp, uLift;

float rhash(vec2 p) {
  p = fract(p * vec2(127.13, 311.7));
  p += dot(p, p + 41.17);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = rhash(i);
  float b = rhash(i + vec2(1.0, 0.0));
  float c = rhash(i + vec2(0.0, 1.0));
  float d = rhash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) - 0.5;
}

float fbm(vec2 p, float oct) {
  float s = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    if (float(i) >= oct) break;
    s += vnoise(p) * amp;
    p *= 2.03;
    amp *= 0.52;
  }
  return s;
}

void main() {
  vec2 q = (vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);

  // grafito canónico como ancla: los parámetros modulan, nunca sustituyen
  vec3 base = vec3(0.1286, 0.1340, 0.1447);
  base += uLift * 0.085;
  // temperatura mineral: frío azulado <-> cálido ocre, siempre sobrio
  base += vec3(0.020, 0.005, -0.017) * uTemp;

  // la irregularidad rompe la regularidad del patrón antes de generarlo
  vec2 warp = vec2(fbm(q * 2.6 + 11.0, 3.0), fbm(q * 2.6 - 4.0, 3.0));
  vec2 p = q + warp * uIrreg * 0.22;

  // la tensión superficial aprieta la escala de la estructura
  float scale = mix(3.4, 9.5, uTension);

  // variación tonal de gran escala: el soporte nunca es un plano uniforme
  float tonal = fbm(p * 0.9, 3.0) * uTonal * 0.145;

  // niebla / velo de baja frecuencia, lentísimo
  float mist = fbm(p * 1.7 + vec2(uTime * 0.008, -uTime * 0.006), 4.0) * uMist * 0.155;

  // fibra direccional del soporte
  float fiber = vnoise(vec2(p.x * scale * 26.0, p.y * scale * 1.15)) * 0.55
              + vnoise(vec2(p.x * scale * 9.0 + 3.1, p.y * scale * 0.7)) * 0.45;
  fiber *= uFiber * 0.10;

  // estructura mineral: la densidad es cuerpo de materia, no oscurecimiento
  float body = fbm(p * scale, 4.0) * (0.5 + uDensity) * 0.105;

  // difusión: suaviza la estructura fina hacia su componente ancha
  float wide = fbm(p * 1.25, 2.0) * 0.10;
  float matter = mix(body + fiber, wide + fiber * 0.35, uDiff);

  vec3 col = base * (1.0 + tonal + mist + matter);

  // respuesta lumínica sutil: el soporte devuelve luz, no la emite
  float lum = 1.0 - dot(q, q) * 0.9;
  col += base * max(lum, 0.0) * uLumin * 0.075;

  // profundidad aparente: volumen amplio, jamás un panel con borde
  col *= 1.0 - dot(q, q) * (0.02 + uDepth * 0.085);

  // grano mineral estático, sub-visual (sin parpadeo)
  float grain = rhash(gl_FragCoord.xy * 0.75) - 0.5;
  grain += (rhash(gl_FragCoord.xy * 0.21 + 7.3) - 0.5) * 0.6;
  col += base * grain * (0.02 + uGrain * 0.075);

  // dithering estable -> cero banding
  float dith = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 17.13, vec2(12.9898, 78.233))) * 43758.5453);
  col += (dith - 0.5) * (1.7 / 255.0);

  fragColor = vec4(col, 1.0);
}`;


/**
 * La forma real. Una malla finamente subdividida sobre el asset, cuyos vértices
 * se desplazan muestreando el MISMO campo físico: hereda su continuidad,
 * propagación, memoria y recuperación gradual. El dedo perturba el campo; la
 * materia se estira, se dobla y se pliega — nunca es repelida como un sprite.
 */
const SHAPE_VS = `#version 300 es
precision highp float;
precision highp sampler2D;

layout(location = 0) in vec2 aGrid;   // lattice original 0..1 (pigmento)
// SWIRL: geometría de reposo persistente de la malla 48×48 (mecanismo real del
// prototipo de referencia). Sin swirl, aRest == aGrid y nada cambia.
layout(location = 1) in vec2 aRest;


uniform sampler2D uField;
uniform vec2 uTexel;
uniform vec2 uCenter;
uniform vec2 uExtent;   // half-extent en unidades cuadradas (proporción del asset)
uniform float uRot;     // giro de la instancia (rad)
uniform float uAspect;  // ancho/alto del viewport
uniform vec4 uBbox;

// MATERIAL + MOTION por instancia: el campo es UNO, pero cada materia lo
// interpreta distinto. Nada de física propia: solo lectura propia del campo.
uniform float uMass;     // 0 leve (lee el detalle fino) · 1 densa (solo el pliegue ancho)
uniform float uElastic;  // cuánto cede la materia ante el mismo flujo
uniform float uThresh;   // umbral: por debajo, la materia ignora la perturbación
uniform float uInertia;  // 0 instantánea · 1 arrastra la memoria del campo
// MEMORIA RESIDUAL POR INSTANCIA: lo que queda de su propia transformación.
// No es física propia: es la huella retenida del gesto sobre esta materia.
uniform vec2 uResid;
// PLASTICIDAD: deformación morfológica retenida. xy = eje del gesto,
// z = magnitud conservada. No es un offset: estira, aplasta y pliega la malla.
uniform vec3 uPlast;
// El dedo que sostiene esta materia amplifica su cesión ante el mismo campo.

uniform float uDrive;



out vec2 vTex;
out vec2 vScreen;
out float vH;
out float vMem;

vec2 gradAt(vec2 uv, float e) {
  return vec2(
    texture(uField, clamp(uv + vec2(uTexel.x * e, 0.0), 0.0, 1.0)).r -
      texture(uField, clamp(uv - vec2(uTexel.x * e, 0.0), 0.0, 1.0)).r,
    texture(uField, clamp(uv + vec2(0.0, uTexel.y * e), 0.0, 1.0)).r -
      texture(uField, clamp(uv - vec2(0.0, uTexel.y * e), 0.0, 1.0)).r);
}

void main() {
  // geometría desde el reposo persistente de la malla; el pigmento se lee con
  // el lattice original (aGrid), así el asset no se pixela al deformarse.
  vec2 r = (aRest - 0.5) * 2.0;

  // giro rígido del asset: la proporción no se altera, solo su orientación
  float cr = cos(uRot);
  float sr = sin(uRot);
  vec2 rr = vec2(cr * r.x - sr * r.y, sr * r.x + cr * r.y);
  // half-extent llevado a uv de pantalla (x corregido por aspecto)
  vec2 ex = vec2(uExtent.x / uAspect, uExtent.y);
  vec2 uv = uCenter + rr * ex;

  vec4 f = texture(uField, clamp(uv, 0.0, 1.0));
  float mem = f.b;
  // inercia: la materia densa arrastra la huella del campo en vez de su estado
  float h = mix(f.r, -abs(mem) * 0.85, uInertia);

  // gradiente multiescala: la materia sigue el FLUJO del campo entero.
  // la masa decide qué escala escucha: densa = pliegue global, leve = warp fino
  float wWide = 0.6 + uMass * 0.7;
  float wFine = 1.0 - uMass * 0.85;
  vec2 flow = gradAt(uv, 12.0) * 3.6 * wWide + gradAt(uv, 4.0) * 2.4 * wFine;
  float fl = length(flow);
  // umbral propio: la perturbación débil no mueve esta materia
  flow *= smoothstep(uThresh, uThresh + 0.035, fl);
  // techo suave: la materia se dobla y se pliega, nunca se rompe ni se dispara
  flow *= 1.0 / (1.0 + fl * (14.0 + uMass * 18.0));
  uv -= flow * 0.9 * uElastic * uDrive;

  // squash / stretch local donde la membrana se hunde
  uv += rr * ex * clamp(h * 1.35 * uElastic * uDrive, -0.22, 0.22);
  // bend: la memoria del campo mantiene la deformación un instante más
  uv += rr.yx * ex * clamp(mem, 0.0, 1.0) * 0.035 * uElastic * uDrive;

  // memoria residual propia: la forma no vuelve exactamente a su geometría
  float along = 0.5 + 0.5 * dot(normalize(rr + 1e-4), normalize(uResid + 1e-4));
  uv += uResid * (0.45 + 0.55 * along);

  // PLASTICIDAD RETENIDA: la materia conserva la morfología conquistada.
  // estiramiento sobre el eje del gesto, cesión transversal y pliegue suave.
  float pa = uPlast.z;
  vec2 grid = aGrid;
  if (pa > 0.0005) {
    vec2 ax = normalize(uPlast.xy + vec2(1e-5, 1e-5));
    vec2 pr = vec2(-ax.y, ax.x);
    float pAlong = dot(rr, ax);
    float pAcross = dot(rr, pr);
    vec2 d = ax * pAlong * pa * 1.25
      - pr * pAcross * pa * 0.62
      + pr * (pAlong * pAlong - 0.33) * pa * 0.95;
    uv += d * ex;
    // las coordenadas de textura siguen la mayor parte de la deformación
    // persistente: el pigmento canónico no se estira localmente (sin pixelado).
    vec2 dg = vec2(cr * d.x + sr * d.y, -sr * d.x + cr * d.y);
    grid = aGrid + dg * 0.5 * 0.85;
  }

  // SWIRL: no hay fórmula de swirl. La deformación pictórica ya vive en la
  // geometría de reposo aRest de la malla (mecanismo del prototipo), y el
  // campo compartido de arriba la sigue moviendo.









  vTex = mix(uBbox.xy, uBbox.zw, vec2(grid.x, 1.0 - grid.y));
  vScreen = uv;
  vH = h;
  vMem = mem;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * TRANSPARENCIA VIVA (etapa 3 del canon).
 *
 * El alfa interno del asset no se aplana nunca: el velo multiplica lo que el
 * PNG ya trae (pigmento, papel, grano, densidad interna). Cada forma respira su
 * propio velo (uVeil, independiente por instancia).
 *
 * SUPERPOSICIÓN: uCoverage es el mapa de cobertura acumulada de toda la pila
 * (pase previo, aditivo). Donde otra materia ya está presente, el solape no
 * acumula recortes: produce una TERCERA LECTURA — la materia se densifica, se
 * mineraliza levemente y cede algo de velo para que lo de debajo siga leyéndose.
 */
const SHAPE_FS = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vTex;
in vec2 vScreen;
in float vH;
in float vMem;
out vec4 fragColor;

uniform sampler2D uShape;
uniform sampler2D uCoverage;
uniform float uOpacity;
uniform float uVeil;     // respiración propia de esta materia
uniform float uPass;     // 0 = cobertura · 1 = materia
uniform float uSolid;    // acentos: pueden leerse más sólidos

void main() {
  vec4 t = texture(uShape, vTex);
  // veladura: el campo modula el VELO, jamás el pigmento
  float veil = uVeil
    + clamp(-vH * 2.0, -0.30, 0.40) * 0.14
    + clamp(vMem, 0.0, 1.0) * 0.04;
  float a = uOpacity * veil;

  if (uPass < 0.5) {
    // pase de cobertura: solo cuánta materia hay aquí
    fragColor = vec4(t.a * a);
    return;
  }

  // solape ajeno = cobertura total menos la propia contribución
  float cov = texture(uCoverage, vScreen).r;
  float ov = clamp(cov - t.a * a, 0.0, 1.4) * (1.0 - uSolid);

  vec4 c = t * a;
  vec3 pig = c.rgb / max(c.a, 1e-4);
  // tercera lectura: densidad mineral, no acumulación de recortes
  pig *= 1.0 - 0.17 * min(ov, 1.0);
  pig = mix(pig, pig * vec3(0.95, 0.98, 1.03), 0.55 * min(ov, 1.0));
  // el solape cede velo: nunca ocluye lo que hay debajo
  float alpha = c.a * (1.0 - 0.12 * min(ov, 1.0));
  fragColor = vec4(pig * alpha, alpha);
}`;

type Pointer = {
  x: number;
  y: number;
  px: number;
  py: number;
  strength: number;
  target: number;
  radius: number;
};

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) ?? "shader error");
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, fs: string, vs: string = QUAD_VS) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  }
  return p;
}

const MAX_T = 10;
const NEUTRAL_STABILITY = 0.5;

export function createFieldEngine(canvas: HTMLCanvasElement, bus?: StateBus) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error("WebGL2 unavailable");

  const has32 = !!gl.getExtension("EXT_color_buffer_float");
  const hasLinear32 = !!gl.getExtension("OES_texture_float_linear");
  const has16 = has32 || !!gl.getExtension("EXT_color_buffer_half_float");
  const internalFormat = has32 && hasLinear32 ? gl.RGBA32F : has16 ? gl.RGBA16F : gl.RGBA8;
  const texType =
    internalFormat === gl.RGBA32F
      ? gl.FLOAT
      : internalFormat === gl.RGBA16F
        ? gl.HALF_FLOAT
        : gl.UNSIGNED_BYTE;

  const simProg = program(gl, SIM_FS);
  const renderProg = program(gl, RENDER_FS);
  const shapeProg = program(gl, SHAPE_FS, SHAPE_VS);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // --- malla finamente subdividida: sin facetas ni fragmentación visible ---
  const GRID = 48;
  const gridVerts: number[] = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const x0 = x / GRID;
      const x1 = (x + 1) / GRID;
      const y0 = y / GRID;
      const y1 = (y + 1) / GRID;
      gridVerts.push(x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1);
    }
  }
  const gridCount = gridVerts.length / 2;
  const gridVao = gl.createVertexArray();
  gl.bindVertexArray(gridVao);
  const gridVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, gridVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridVerts), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  // sin swirl, el reposo de la malla ES el lattice original: mismo buffer.
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);


  // --- assets canónicos reales, tal cual (alfa vivo, premultiplicado) ---
  const shapeTextures = new Map<string, WebGLTexture | "loading">();

  const textureFor = (url: string): WebGLTexture | null => {
    const cached = shapeTextures.get(url);
    if (cached && cached !== "loading") return cached;
    if (cached === "loading") return null;
    shapeTextures.set(url, "loading");
    const img = new Image();
    img.decoding = "async";
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (disposed) return;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      shapeTextures.set(url, tex);
    };
    img.onerror = () => shapeTextures.delete(url);
    img.src = url;
    return null;
  };

  let simW = 2;
  let simH = 2;
  let textures: WebGLTexture[] = [];
  let fbos: WebGLFramebuffer[] = [];
  let read = 0;
  let covTex: WebGLTexture | null = null;
  let covFbo: WebGLFramebuffer | null = null;

  const makeTargets = () => {
    textures.forEach((t) => gl.deleteTexture(t));
    fbos.forEach((f) => gl.deleteFramebuffer(f));
    textures = [];
    fbos = [];
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, simW, simH, 0, gl.RGBA, texType, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      textures.push(tex);
      fbos.push(fbo);
    }
    // cobertura de la pila (superposición viva): resolución baja y filtrada,
    // suficiente para saber DÓNDE hay otra materia, nunca para dibujarla.
    if (covTex) gl.deleteTexture(covTex);
    if (covFbo) gl.deleteFramebuffer(covFbo);
    covTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, covTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, simW, simH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    covFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, covFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, covTex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  let cssW = 1;
  let cssH = 1;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = canvas.clientWidth || window.innerWidth;
    cssH = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    const target = 480;
    const scale = target / Math.max(cssW, cssH);
    simW = Math.max(96, Math.round(cssW * scale));
    simH = Math.max(96, Math.round(cssH * scale));
    makeTargets();
  };

  resize();

  const pointers = new Map<number, Pointer>();

  /**
   * MANIPULACIÓN POR INSTANCIA. El campo sigue siendo UNO y continuo: lo que se
   * individualiza es la identidad de cada forma. Un contacto que cae sobre una
   * forma la toma a ella (y solo a ella); un contacto sobre el lienzo libre
   * perturba el campo como siempre. Dos dedos sobre dos formas distintas toman
   * dos formas distintas: cada agarre es independiente y no se fusionan.
   */
  const grabs = new Map<number, { key: string }>();
  /** Memoria residual por instancia: huella retenida de su transformación. */
  const resid = new Map<string, { x: number; y: number; fx: number; fy: number }>();
  /** Semilla desde la morfología plástica serializada de la instancia. */
  const residOf = (key: string, morph?: ShapeInstance["morph"]) => {
    let r = resid.get(key);
    if (!r) {
      r = { x: morph?.rx ?? 0, y: morph?.ry ?? 0, fx: morph?.rx ?? 0, fy: morph?.ry ?? 0 };
      resid.set(key, r);
    }
    return r;
  };
  /**
   * SWIRL POR INSTANCIA — MALLA REAL (mecanismo del prototipo de referencia).
   * Cada forma alcanzada por el gesto tiene su malla 48×48 con geometría de
   * reposo persistente `rest[]`; el gesto desplaza vértices directamente y el
   * campo compartido sigue moviéndolos. Move y Sculpt no la escriben ni la leen
   * (viven en `resid` / `plast`).
   */
  const meshes = new Map<string, SwirlMesh>();
  const meshOf = (key: string, s?: ShapeInstance["swirl"]): SwirlMesh => {
    let m = meshes.get(key);
    if (!m) {
      const rest = s?.rest && s.g === SWIRL_GRID ? decodeRest(s.rest) : null;
      m = new SwirlMesh(gl, rest);
      meshes.set(key, m);
    }
    return m;
  };
  /** instancias con malla nueva pendiente de serializar al soltar */
  const swirlDirty = new Set<string>();

  /**
   * PLASTICIDAD POR INSTANCIA. No es física propia: es la morfología que la
   * materia conserva tras haber sido trabajada (eje del gesto + magnitud
   * retenida). Se relaja lentamente hacia su suelo plástico, nunca a cero.
   */
  const plast = new Map<string, { ax: number; ay: number; amt: number; floor: number }>();
  const plastOf = (key: string, morph?: ShapeInstance["morph"]) => {
    let p = plast.get(key);
    if (!p) {
      p = {
        ax: morph?.ax ?? 1,
        ay: morph?.ay ?? 0,
        amt: morph?.amt ?? 0,
        floor: morph?.amt ?? 0,
      };
      plast.set(key, p);
    }
    return p;
  };
  /**
   * ESCALA VIVA POR INSTANCIA. El gesto comprime la materia mientras la trabaja;
   * al soltar, ese tamaño alcanzado se COMPROMETE en la instancia (inst.size) y
   * el multiplicador vuelve a 1: el nuevo reposo es el nuevo tamaño.
   */
  const liveScale = new Map<string, number>();
  const scaleOf = (key: string) => liveScale.get(key) ?? 1;

  /**
   * PINCH (dos dedos sobre la MISMA materia). No es una física nueva: es el
   * mismo agarre, leído como distancia entre dos contactos. Escala continua en
   * ambos sentidos, posición preservada (sigue el centroide) y confirmación del
   * tamaño al soltar. Límites conservadores para que nada desaparezca ni estalle.
   */
  const PINCH_MIN_SIZE = 0.06;
  const PINCH_MAX_SIZE = 1.15;
  const pinches = new Map<
    string,
    { a: number; b: number; dist0: number; scale0: number; cx: number; cy: number; ang: number }
  >();
  const uvDist = (p1: Pointer, p2: Pointer) => {
    const aspect = cssW / Math.max(cssH, 1);
    return Math.hypot((p1.x - p2.x) * aspect, p1.y - p2.y);
  };
  /** Ángulo del eje entre los dos contactos (rad) — lectura para el retorcido. */
  const uvAngle = (p1: Pointer, p2: Pointer) => {
    const aspect = cssW / Math.max(cssH, 1);
    return Math.atan2(p2.y - p1.y, (p2.x - p1.x) * aspect);
  };
  const startPinch = (key: string) => {
    if (pinches.has(key)) return;
    const ids: number[] = [];
    for (const [id, g] of grabs) if (g.key === key && pointers.has(id)) ids.push(id);
    if (ids.length < 2) return;
    const a = ids[0]!;
    const b = ids[1]!;
    const p1 = pointers.get(a)!;
    const p2 = pointers.get(b)!;
    pinches.set(key, {
      a,
      b,
      dist0: Math.max(0.015, uvDist(p1, p2)),
      scale0: scaleOf(key),
      cx: (p1.x + p2.x) * 0.5,
      cy: (p1.y + p2.y) * 0.5,
      ang: uvAngle(p1, p2),
    });
  };



  const toUv = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width,
      y: 1 - (clientY - rect.top) / rect.height,
    };
  };

  /**
   * ¿Qué forma hay bajo este punto? Dos lecturas: primero el contacto preciso
   * (la de más arriba gana), y si nada cae dentro, una zona efectiva ampliada
   * de forma invisible —pensada para dedo en iPad y para formas delgadas,
   * caladas o pequeñas— eligiendo la más cercana en proporción a su tamaño.
   */
  const hitTest = (x: number, y: number, mode: "tight" | "any" = "any"): string | null => {
    const aspect = cssW / Math.max(cssH, 1);
    const scene = getScene();
    const taken = new Set([...grabs.values()].map((g) => g.key));
    let loose: string | null = null;
    let looseScore = Infinity;
    for (let i = scene.length - 1; i >= 0; i--) {
      const inst = scene[i]!;
      if (taken.has(inst.key)) continue;
      const shape = getShape(inst.shapeId);
      if (!shape) continue;
      const halfY = inst.size * scaleOf(inst.key) * 0.5;
      const halfX = halfY * shape.aspect;
      // al espacio cuadrado de la forma (mismo que usa el vertex shader)
      const dx = (x - inst.x) * aspect;
      const dy = y - inst.y;
      const a = -(inst.rot ?? 0) * Math.PI * 2;
      const lx = Math.cos(a) * dx - Math.sin(a) * dy;
      const ly = Math.sin(a) * dx + Math.cos(a) * dy;
      const pad = 0.012;
      if (Math.abs(lx) <= halfX + pad && Math.abs(ly) <= halfY + pad) return inst.key;
      if (mode === "tight") continue;
      // zona efectiva: radio de dedo (~0.05 uv) + holgura relativa al tamaño.
      // Las formas finas ganan más holgura en su eje corto.
      const grabX = halfX + Math.max(0.052, halfX * 0.35);
      const grabY = halfY + Math.max(0.052, halfY * 0.35);
      if (Math.abs(lx) <= grabX && Math.abs(ly) <= grabY) {
        const score = Math.max(Math.abs(lx) / grabX, Math.abs(ly) / grabY);
        if (score < looseScore) {
          looseScore = score;
          loose = inst.key;
        }
      }
    }
    return loose;

  };


  /**
   * Segundo dedo sobre una materia YA tomada. En "tight" solo cuenta el contacto
   * dentro de la forma; en "loose" se amplía la zona para que el pinch nazca del
   * mismo gesto sin exigir precisión.
   */
  const hitTestHeld = (x: number, y: number, mode: "tight" | "loose"): string | null => {
    const aspect = cssW / Math.max(cssH, 1);
    const held = new Set([...grabs.values()].map((g) => g.key));
    if (held.size === 0) return null;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const inst of getScene()) {
      if (!held.has(inst.key)) continue;
      const shape = getShape(inst.shapeId);
      if (!shape) continue;
      const halfY = inst.size * scaleOf(inst.key) * 0.5;
      const halfX = halfY * shape.aspect;
      const dx = (x - inst.x) * aspect;
      const dy = y - inst.y;
      const a = -(inst.rot ?? 0) * Math.PI * 2;
      const lx = Math.cos(a) * dx - Math.sin(a) * dy;
      const ly = Math.sin(a) * dx + Math.cos(a) * dy;
      const gx = mode === "tight" ? halfX + 0.012 : halfX + Math.max(0.1, halfX * 0.7);
      const gy = mode === "tight" ? halfY + 0.012 : halfY + Math.max(0.1, halfY * 0.7);
      if (Math.abs(lx) <= gx && Math.abs(ly) <= gy) {
        const score = Math.max(Math.abs(lx) / gx, Math.abs(ly) / gy);
        if (score < bestScore) {
          bestScore = score;
          best = inst.key;
        }
      }
    }
    return best;
  };

  const onDown = (e: PointerEvent) => {
    const { x, y } = toUv(e.clientX, e.clientY);
    pointers.set(e.pointerId, {
      x,
      y,
      px: x,
      py: y,
      strength: 0,
      target: 1,
      radius: 0.85 + Math.random() * 0.3,
    });
    if (!isCanvasMode()) {
      // prioridad: un segundo dedo DENTRO de la materia ya tomada la acompaña
      // (pinch) antes de reclamar otra forma vecina.
      const key =
        hitTestHeld(x, y, "tight") ??
        hitTest(x, y, "tight") ??
        hitTestHeld(x, y, "loose") ??
        hitTest(x, y, "any");

      if (key) {
        grabs.set(e.pointerId, { key });
        selectInstance(key);
        startPinch(key);
      }
    }

    canvas.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  /**
   * SWIRL — trazo real sobre las mallas (equivalente literal al `pointermove`
   * del prototipo: `for (const s of shapes) s.sculpt(prev, now, aspect)`).
   * Todas las formas vivas reciben el segmento del gesto; cada malla decide por
   * distancia local qué vértices de su reposo se desplazan.
   */
  const swirlStroke = (prev: { x: number; y: number }, now: { x: number; y: number }) => {
    const aspect = cssW / Math.max(cssH, 1);
    for (const inst of getScene()) {
      const shape = getShape(inst.shapeId);
      if (!shape) continue;
      const halfY = inst.size * scaleOf(inst.key) * 0.5;
      const mesh = meshOf(inst.key, inst.swirl);
      const touched = mesh.sculpt(prev, now, {
        cx: inst.x,
        cy: inst.y,
        halfX: halfY * shape.aspect,
        halfY,
        rot: (inst.rot ?? 0) * Math.PI * 2,
        aspect,
      });
      if (touched) swirlDirty.add(inst.key);
    }
  };

  const onMove = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const swirlMode = getInteractionMode() === "swirl" && !isCanvasMode();
    const events = e.getCoalescedEvents?.() ?? [];
    const list = events.length ? events : [e];
    for (const ev of list) {
      const { x, y } = toUv(ev.clientX, ev.clientY);
      if (swirlMode) swirlStroke({ x: p.x, y: p.y }, { x, y });
      p.x = x;
      p.y = y;
    }
    e.preventDefault();
  };

  const onUp = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    // sin snap-back: el contacto se retira y el campo recupera gradualmente
    if (p) p.target = 0;
    const grab = grabs.get(e.pointerId);
    if (grab) {
      grabs.delete(e.pointerId);
      // el pinch termina en cuanto uno de los dos dedos se retira; el tamaño
      // alcanzado se confirma abajo (bake), así que nunca hay salto.
      const pz = pinches.get(grab.key);
      if (pz && (pz.a === e.pointerId || pz.b === e.pointerId)) pinches.delete(grab.key);
      const inst = getScene().find((s) => s.key === grab.key);

      if (inst) {
        // BAKE: posición conquistada + ESCALA alcanzada se comprometen en la
        // instancia. El multiplicador vivo se retira (queda 1) porque el nuevo
        // tamaño ya ES el tamaño de reposo de esta materia.
        const sc = scaleOf(inst.key);
        liveScale.delete(inst.key);
        const size = Math.min(1.2, Math.max(0.05, inst.size * sc));
        if (import.meta.env.DEV && pz) {
          publishPinchDebug({
            active: false,
            liveScale: 1,
            clamped: null,
            committed: { key: inst.key, from: inst.size, to: size, scale: sc, at: Date.now() },
          });
        }
        // BAKE morfológico: la morfología alcanzada ES el nuevo reposo de esta
        // materia. No cede hacia la geometría original del asset, y viaja en el
        // estado serializable de la instancia (Undo/Redo, sesión, Memory).
        const pl = plast.get(inst.key);
        if (pl) pl.floor = pl.amt;
        const r = resid.get(inst.key);
        if (r) {
          r.fx = r.x;
          r.fy = r.y;
        }
        updateInstance(inst.key, {
          x: inst.x,
          y: inst.y,
          size,
          // en MOVE no hay mapas plásticos vivos: la morfología retenida de la
          // instancia se preserva tal cual, nunca se borra al soltar.
          morph: {
            ax: pl?.ax ?? inst.morph?.ax ?? 1,
            ay: pl?.ay ?? inst.morph?.ay ?? 0,
            amt: pl?.amt ?? inst.morph?.amt ?? 0,
            rx: r?.x ?? inst.morph?.rx ?? 0,
            ry: r?.y ?? inst.morph?.ry ?? 0,
          },
        });

      }
    }
    e.preventDefault();
  };


  canvas.addEventListener("pointerdown", onDown, { passive: false });
  canvas.addEventListener("pointermove", onMove, { passive: false });
  canvas.addEventListener("pointerup", onUp, { passive: false });
  canvas.addEventListener("pointercancel", onUp, { passive: false });
  canvas.addEventListener("pointerleave", onUp, { passive: false });
  window.addEventListener("resize", resize);

  const uSim = {
    state: gl.getUniformLocation(simProg, "uState"),
    texel: gl.getUniformLocation(simProg, "uTexel"),
    aspect: gl.getUniformLocation(simProg, "uAspect"),
    dt: gl.getUniformLocation(simProg, "uDt"),
    time: gl.getUniformLocation(simProg, "uTime"),
    count: gl.getUniformLocation(simProg, "uCount"),
    touch: gl.getUniformLocation(simProg, "uTouch"),
    meta: gl.getUniformLocation(simProg, "uTouchMeta"),
    aEnergy: gl.getUniformLocation(simProg, "uAEnergy"),
    aLow: gl.getUniformLocation(simProg, "uALow"),
    aFine: gl.getUniformLocation(simProg, "uAFine"),
    aImpulse: gl.getUniformLocation(simProg, "uAImpulse"),
    aStability: gl.getUniformLocation(simProg, "uAStability"),
    aMemory: gl.getUniformLocation(simProg, "uAMemory"),
    aDensity: gl.getUniformLocation(simProg, "uADensity"),
    aSpace: gl.getUniformLocation(simProg, "uASpace"),
  };
  const uRender = {
    res: gl.getUniformLocation(renderProg, "uResolution"),
    time: gl.getUniformLocation(renderProg, "uTime"),
    grain: gl.getUniformLocation(renderProg, "uGrain"),
    fiber: gl.getUniformLocation(renderProg, "uFiber"),
    mist: gl.getUniformLocation(renderProg, "uMist"),
    density: gl.getUniformLocation(renderProg, "uDensity"),
    tonal: gl.getUniformLocation(renderProg, "uTonal"),
    tension: gl.getUniformLocation(renderProg, "uTension"),
    irreg: gl.getUniformLocation(renderProg, "uIrreg"),
    diff: gl.getUniformLocation(renderProg, "uDiff"),
    depth: gl.getUniformLocation(renderProg, "uDepth"),
    lumin: gl.getUniformLocation(renderProg, "uLumin"),
    temp: gl.getUniformLocation(renderProg, "uTemp"),
    lift: gl.getUniformLocation(renderProg, "uLift"),
  };
  const uShape = {
    field: gl.getUniformLocation(shapeProg, "uField"),
    shape: gl.getUniformLocation(shapeProg, "uShape"),
    texel: gl.getUniformLocation(shapeProg, "uTexel"),
    center: gl.getUniformLocation(shapeProg, "uCenter"),
    extent: gl.getUniformLocation(shapeProg, "uExtent"),
    rot: gl.getUniformLocation(shapeProg, "uRot"),
    aspect: gl.getUniformLocation(shapeProg, "uAspect"),
    bbox: gl.getUniformLocation(shapeProg, "uBbox"),
    opacity: gl.getUniformLocation(shapeProg, "uOpacity"),
    mass: gl.getUniformLocation(shapeProg, "uMass"),
    elastic: gl.getUniformLocation(shapeProg, "uElastic"),
    thresh: gl.getUniformLocation(shapeProg, "uThresh"),
    inertia: gl.getUniformLocation(shapeProg, "uInertia"),
    resid: gl.getUniformLocation(shapeProg, "uResid"),
    plast: gl.getUniformLocation(shapeProg, "uPlast"),
    
    drive: gl.getUniformLocation(shapeProg, "uDrive"),

    coverage: gl.getUniformLocation(shapeProg, "uCoverage"),
    veil: gl.getUniformLocation(shapeProg, "uVeil"),
    pass: gl.getUniformLocation(shapeProg, "uPass"),
    solid: gl.getUniformLocation(shapeProg, "uSolid"),
  };

  const touchData = new Float32Array(MAX_T * 4);
  const metaData = new Float32Array(MAX_T * 2);

  let raf = 0;
  let last = performance.now();
  let time = 0;
  let disposed = false;

  const frame = (now: number) => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = 1 / 60;
    dt = Math.min(dt, 1 / 20);
    time += dt;

    // INPUT decide QUÉ fuente puede perturbar este único campo.
    const routing = getFieldRouting();
    // Canvas Mode decide QUÉ estamos editando: el lienzo, no las figuras.
    const canvasMode = isCanvasMode();

    // PINCH: dos dedos sobre la misma materia. Se resuelve antes del recorrido
    // de contactos para que la escala y el centroide manden, y el bucle no
    // vuelva a arrastrar la forma dos veces.
    if (!canvasMode && routing.touch) {
      for (const [key, pz] of pinches) {
        const p1 = pointers.get(pz.a);
        const p2 = pointers.get(pz.b);
        const inst = getScene().find((s) => s.key === key);
        if (!p1 || !p2 || p1.target === 0 || p2.target === 0 || !inst) {
          pinches.delete(key);
          continue;
        }
        const d = Math.max(0.015, uvDist(p1, p2));
        const ratio = d / pz.dist0;
        const minS = PINCH_MIN_SIZE / Math.max(1e-4, inst.size);
        const maxS = PINCH_MAX_SIZE / Math.max(1e-4, inst.size);
        const raw = pz.scale0 * ratio;
        const sc = Math.min(maxS, Math.max(minS, raw));
        liveScale.set(key, sc);
        // posición preservada: la forma sigue el centroide de los dos dedos
        const cx = (p1.x + p2.x) * 0.5;
        const cy = (p1.y + p2.y) * 0.5;
        inst.x = Math.min(1.05, Math.max(-0.05, inst.x + (cx - pz.cx)));
        inst.y = Math.min(1.05, Math.max(-0.05, inst.y + (cy - pz.cy)));
        pz.cx = cx;
        pz.cy = cy;
        // SCULPT: el giro entre los dos dedos RETUERCE esta materia — el eje
        // plástico rota con la mano y la magnitud retenida crece con el trabajo.
        const ang = uvAngle(p1, p2);
        let dAng = ang - pz.ang;
        while (dAng > Math.PI) dAng -= Math.PI * 2;
        while (dAng < -Math.PI) dAng += Math.PI * 2;
        pz.ang = ang;
        if (getInteractionMode() === "sculpt") {
          const pl = plastOf(inst.key, inst.morph);
          const ca = Math.cos(dAng);
          const sa = Math.sin(dAng);
          const nax = ca * pl.ax - sa * pl.ay;
          const nay = sa * pl.ax + ca * pl.ay;
          pl.ax = nax;
          pl.ay = nay;
          const el = inst.elasticity ?? 1;
          const work = Math.abs(dAng) * 0.16 + Math.abs(ratio - 1) * 0.02;
          pl.amt = Math.min(0.34, pl.amt + work * el);
          pl.floor = Math.max(pl.floor, pl.amt * 0.92);
        }

        if (import.meta.env.DEV) {
          publishPinchDebug({
            active: true,
            key,
            cx,
            cy,
            dist0: pz.dist0,
            dist: d,
            liveScale: sc,
            minScale: minS,
            maxScale: maxS,
            size: inst.size,
            effSize: inst.size * sc,
            minSize: PINCH_MIN_SIZE,
            maxSize: PINCH_MAX_SIZE,
            clamped: raw > maxS ? "max" : raw < minS ? "min" : null,
          });
        }
      }
      if (import.meta.env.DEV && pinches.size === 0 && getPinchDebug().active) resetPinchDebug();
    } else if (pinches.size) {
      pinches.clear();
      if (import.meta.env.DEV) resetPinchDebug();
    }
    const pinched = new Set(pinches.keys());


    let count = 0;

    for (const [id, p] of pointers) {
      const rate = p.target > 0 ? 16 : 9;
      p.strength += (p.target - p.strength) * Math.min(1, rate * dt);
      if (p.target === 0 && p.strength < 0.004) {
        pointers.delete(id);
        continue;
      }
      if (canvasMode) {
        // el gesto amasa la materia del lienzo; las figuras quedan intactas
        if (routing.touch && p.target > 0) {
          const dx = p.x - p.px;
          const dy = p.y - p.py;
          if (dx !== 0 || dy !== 0) sculptCanvas(dx, dy, 0);
          else sculptCanvas(0, 0, dt);
        }
        p.px = p.x;
        p.py = p.y;
        continue;
      }
      // SWIRL: el trazo ya deformó las mallas directamente (ver `swirlStroke`,
      // llamado por evento como en el prototipo). Aquí el mismo gesto entra al
      // CAMPO COMPARTIDO con radio amplio: varias formas co-responden a la vez.
      if (getInteractionMode() === "swirl") {

        if (routing.touch && count < MAX_T) {
          touchData[count * 4 + 0] = p.x;
          touchData[count * 4 + 1] = p.y;
          touchData[count * 4 + 2] = p.px;
          touchData[count * 4 + 3] = p.py;
          metaData[count * 2 + 0] = p.strength * 1.2;
          // radio amplio: el acoplamiento global es intencional en Swirl
          metaData[count * 2 + 1] = p.radius * 1.7;
          count++;
        }
        p.px = p.x;
        p.py = p.y;
        continue;
      }
      const grab = routing.touch ? grabs.get(id) : undefined;
      if (grab) {
        // MOVE: este contacto reposiciona la materia tomada y sigue perturbando
        // el campo (radio corto). SCULPT: el gesto NO reposiciona ni entra al
        // campo compartido — trabaja la morfología de ESTA instancia y solo de
        // ella, para que las vecinas conserven su vida ambiental.
        const sculpt = getInteractionMode() === "sculpt";
        const inst = getScene().find((s) => s.key === grab.key);
        if (inst && p.target > 0 && !pinched.has(grab.key)) {
          const dx = p.x - p.px;
          const dy = p.y - p.py;
          if (!sculpt) {
            // mutación en vivo (sin re-render por frame); se confirma al soltar
            inst.x = Math.min(1.05, Math.max(-0.05, inst.x + dx));
            inst.y = Math.min(1.05, Math.max(-0.05, inst.y + dy));
          } else {
            const r = residOf(inst.key, inst.morph);
            const gain = 0.85 * (inst.elasticity ?? 1);
            r.x = Math.max(-0.05, Math.min(0.05, r.x + dx * gain));
            r.y = Math.max(-0.05, Math.min(0.05, r.y + dy * gain));
            // la huella retenida: la mayor parte de la transformación no se deshace
            r.fx = r.x * 0.92;
            r.fy = r.y * 0.92;

            // plasticidad: el gesto trabaja la morfología de ESTA materia
            const pl = plastOf(inst.key, inst.morph);
            const sp = Math.hypot(dx, dy);
            if (sp > 1e-5) {
              const k = Math.min(1, sp * 55);
              pl.ax += (dx / sp - pl.ax) * k;
              pl.ay += (dy / sp - pl.ay) * k;
            }
            const el = inst.elasticity ?? 1;
            pl.amt = Math.min(0.34, pl.amt + (sp * 4.2 + dt * 0.09) * el);
            // suelo plástico: lo que la materia ya no devuelve
            pl.floor = Math.max(pl.floor, pl.amt * 0.92);
          }
        }
        if (!sculpt && count < MAX_T) {
          touchData[count * 4 + 0] = p.x;
          touchData[count * 4 + 1] = p.y;
          touchData[count * 4 + 2] = p.px;
          touchData[count * 4 + 3] = p.py;
          metaData[count * 2 + 0] = p.strength * 1.15;
          // radio corto: la respuesta dominante es de la forma tomada; las
          // vecinas co-responden apenas, porque comparten campo.
          metaData[count * 2 + 1] = p.radius * 0.46;
          count++;
        }

        p.px = p.x;
        p.py = p.y;
        continue;
      }
      if (routing.touch && count < MAX_T) {
        touchData[count * 4 + 0] = p.x;
        touchData[count * 4 + 1] = p.y;
        touchData[count * 4 + 2] = p.px;
        touchData[count * 4 + 3] = p.py;
        metaData[count * 2 + 0] = p.strength;
        metaData[count * 2 + 1] = p.radius;
        count++;
      }
      p.px = p.x;
      p.py = p.y;
    }

    const grabbed = new Set([...grabs.values()].map((g) => g.key));

    // SWIRL: al levantar todos los dedos, lo removido se serializa en cada
    // instancia alcanzada. No hay relajación: es el nuevo reposo pictórico.
    if (swirlDirty.size > 0) {
      let active = false;
      for (const p of pointers.values()) if (p.target > 0) active = true;
      if (!active) {
        for (const key of swirlDirty) {
          const m = meshes.get(key);
          if (m) updateInstance(key, { swirl: { g: SWIRL_GRID, rest: encodeRest(m.rest) } });
        }
        swirlDirty.clear();

      }
    }

    // relajación sutil de la memoria residual: cada forma cede hacia su huella
    // retenida (nunca hacia cero), de manera gradual e independiente.
    for (const [key, r] of resid) {
      const k = Math.min(1, 1.6 * dt);
      r.x += (r.fx - r.x) * k;
      r.y += (r.fy - r.y) * k;
      if (Math.abs(r.x) < 1e-5 && Math.abs(r.fx) < 1e-5) resid.delete(key);

    }

    // plasticidad: al soltar, solo hay una pequeña relajación elástica hacia el
    // suelo plástico (≈84% de lo alcanzado). Ese suelo YA NO cede: es el nuevo
    // reposo morfológico de esta materia.
    for (const [key, pl] of plast) {
      if (grabbed.has(key)) continue;
      const k = Math.min(1, 1.1 * dt);
      pl.amt += (pl.floor - pl.amt) * k;
      if (pl.amt < 1e-4 && pl.floor < 1e-4) plast.delete(key);
    }



    // el bus siempre integra (análisis vivo); solo su aporte al campo se rutea
    const integrated = bus?.integrate(dt);
    const a = routing.audio && !canvasMode ? integrated : undefined;

    // capa rápida (Musical Excitation): envolventes suaves, nunca eventos duros
    tickExcitation(dt, routing.audio && bus?.active ? integrated : null);

    // Deep Field: acústico -> perceptual -> vida -> sesgo de campo (aditivo, acotado)
    // OFF = identidad exacta: nada de P3/P4 entra al campo ni al render.
    const df = isDeepFieldEnabled();
    const dfSrc = df && routing.audio && bus?.active ? integrated : null;
    const perceptual = tickPerception(dt, dfSrc);
    const life = tickLifeState(dt, dfSrc ? perceptual : null);
    const lb = lifeToFieldBias(dfSrc ? life : null);
    const dfLife = df && a ? life : null;


    const aEnergy = Math.min(1.6, exciteEnergy(a ? a.energy : 0) + (a ? lb.energy : 0));
    const aLow = Math.min(
      1.6,
      exciteLow(a ? Math.min(1, a.sub * 0.55 + a.bass * 0.65) : 0) + (a ? lb.low : 0),
    );
    const aFine = Math.min(
      1.6,
      exciteFine(a ? Math.min(1, a.centroid * 0.55 + a.air * 0.55 + a.presence * 0.25) : 0) +
        (a ? lb.fine : 0),
    );
    const aImpulse = Math.min(
      1.6,
      exciteImpulse(a ? Math.min(1, a.transient * 0.7 + a.flux * 0.45) : 0) + (a ? lb.impulse : 0),
    );
    const aStability = Math.max(
      0,
      Math.min(
        1.4,
        exciteStability(a && bus?.active ? a.stability : NEUTRAL_STABILITY) +
          (a ? lb.stability : 0),
      ),
    );
    const aMemory = Math.min(1.4, (a ? a.memory * 0.85 + a.field * 0.15 : 0) + (a ? lb.memory : 0));
    const aDensity = Math.max(0, Math.min(1.4, (a ? a.density : 0) + (a ? lb.density : 0)));
    const aSpace = a ? a.space : 0;
    if (bus) bus.emit();

    // reloj perceptivo lento (MUSIC long-form): medium/slow derivan el lienzo
    tickAmbient(dt, routing.audio && bus?.active ? integrated : null);





    // substeps fijos -> física estable, cero fragmentación del movimiento
    const steps = 2;
    const sdt = Math.min(dt / steps, 1 / 90);
    gl.bindVertexArray(vao);
    gl.useProgram(simProg);
    gl.uniform2f(uSim.texel, 1 / simW, 1 / simH);
    gl.uniform2f(uSim.aspect, simW / Math.min(simW, simH), simH / Math.min(simW, simH));
    gl.uniform1i(uSim.state, 0);
    gl.uniform1i(uSim.count, count);
    gl.uniform4fv(uSim.touch, touchData);
    gl.uniform2fv(uSim.meta, metaData);
    gl.uniform1f(uSim.aEnergy, aEnergy);
    gl.uniform1f(uSim.aLow, aLow);
    gl.uniform1f(uSim.aFine, aFine);
    gl.uniform1f(uSim.aImpulse, aImpulse);
    gl.uniform1f(uSim.aStability, aStability);
    gl.uniform1f(uSim.aMemory, aMemory);
    gl.uniform1f(uSim.aDensity, aDensity);
    gl.uniform1f(uSim.aSpace, aSpace);
    gl.viewport(0, 0, simW, simH);
    for (let i = 0; i < steps; i++) {
      gl.uniform1f(uSim.dt, sdt);
      gl.uniform1f(uSim.time, time + i * sdt);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textures[read]!);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[1 - read]!);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      read = 1 - read;
    }

    // --- lienzo generativo (Canvas State): el campo queda invisible ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(renderProg);
    gl.uniform2f(uRender.res, canvas.width, canvas.height);
    gl.uniform1f(uRender.time, time);
    // base autoral intacta; la deriva musical se aplica solo en la copia efectiva
    const cp = applySpacetimeMantle(
      applyLifeToCanvas(
        macroCanvas(excitedCanvasParams(effectiveCanvasParams(getCanvasParams()))),
        dfLife,
      ),
      dfLife,
    );


    const ambientVeil =
      getAmbientVeilBias() + macroVeilBias() + exciteVeilBias() + (a ? lb.veil : 0);



    gl.uniform1f(uRender.grain, cp.grain);
    gl.uniform1f(uRender.fiber, cp.fiber);
    gl.uniform1f(uRender.mist, cp.mist);
    gl.uniform1f(uRender.density, cp.density);
    gl.uniform1f(uRender.tonal, cp.tonal);
    gl.uniform1f(uRender.tension, cp.tension);
    gl.uniform1f(uRender.irreg, cp.irregularity);
    gl.uniform1f(uRender.diff, cp.diffusion);
    gl.uniform1f(uRender.depth, cp.depth);
    gl.uniform1f(uRender.lumin, cp.luminance);
    gl.uniform1f(uRender.temp, cp.temperature);
    gl.uniform1f(uRender.lift, cp.lift);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // --- las formas reales: única manifestación visual del campo ---
    // TRANSPARENCIA VIVA + SUPERPOSICIÓN: dos pases. El primero acumula la
    // cobertura de toda la pila; el segundo dibuja la materia, y donde hay
    // solape la lectura no se apila: se convierte en una tercera lectura.
    const scene = getScene();
    if (scene.length) {
      const aspect = cssW / Math.max(cssH, 1);

      const drawStack = (pass: 0 | 1) => {
        gl.uniform1f(uShape.pass, pass);
        for (const inst of scene) {
          const shape = getShape(inst.shapeId);
          if (!shape) continue;
          const tex = textureFor(shape.url);
          if (!tex) continue;
          // escala viva mientras el gesto trabaja; tras soltar ya está en size
          const halfY = inst.size * scaleOf(inst.key) * 0.5;
          const halfX = halfY * shape.aspect;
          const solid = shape.family === "accent" ? 0.75 : shape.family === "line" ? 0.4 : 0;
          // respiración propia: misma escucha, fase y sensibilidad distintas
          const seed = inst.seed ?? 0;
          const veil =
            1 +
            Math.sin(time * (0.16 + seed * 0.22) + seed * 6.283) * 0.05 * (1 - solid * 0.6) +
            aEnergy * (0.10 + seed * 0.14) +
            aFine * (0.04 + (1 - seed) * 0.06) -
            aImpulse * seed * 0.06 +
            ambientVeil * (0.7 + seed * 0.6);


          gl.uniform2f(uShape.center, inst.x, inst.y);
          gl.uniform2f(uShape.extent, halfX, halfY);
          gl.uniform1f(uShape.rot, (inst.rot ?? 0) * Math.PI * 2);
          gl.uniform1f(uShape.aspect, aspect);
          gl.uniform4f(uShape.bbox, shape.bbox[0], shape.bbox[1], shape.bbox[2], shape.bbox[3]);
          gl.uniform1f(uShape.opacity, inst.opacity);
          gl.uniform1f(uShape.veil, Math.max(0.35, Math.min(1.35, veil)));
          gl.uniform1f(uShape.solid, solid);
          gl.uniform1f(
            uShape.mass,
            Math.min(1, exciteMass(macroMass(inst.mass ?? 0.35)) + (a ? lb.mass : 0)),
          );
          gl.uniform1f(uShape.elastic, exciteElastic(macroElastic(inst.elasticity ?? 1)));
          gl.uniform1f(uShape.thresh, inst.threshold ?? 0);
          gl.uniform1f(uShape.inertia, Math.min(1, (inst.inertia ?? 0) + (a ? lb.inertia : 0)));
          const rr = resid.get(inst.key) ?? {
            x: inst.morph?.rx ?? 0,
            y: inst.morph?.ry ?? 0,
          };
          gl.uniform2f(uShape.resid, rr.x, rr.y);
          const pl = plast.get(inst.key) ?? {
            ax: inst.morph?.ax ?? 1,
            ay: inst.morph?.ay ?? 0,
            amt: inst.morph?.amt ?? 0,
          };
          gl.uniform3f(uShape.plast, pl.ax, pl.ay, pl.amt);
          // la materia sostenida cede más ante el mismo campo
          gl.uniform1f(uShape.drive, grabbed.has(inst.key) ? 1.9 : 1);


          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.activeTexture(gl.TEXTURE0);
          // SWIRL: si esta materia ya tiene malla propia (reposo persistente),
          // se dibuja con ella; si no, con el lattice compartido sin deformar.
          const mesh =
            meshes.get(inst.key) ??
            (inst.swirl?.rest && inst.swirl.g === SWIRL_GRID
              ? meshOf(inst.key, inst.swirl)
              : null);
          gl.bindVertexArray(mesh ? mesh.vao : gridVao);
          gl.drawArrays(gl.TRIANGLES, 0, mesh ? SWIRL_TRI_COUNT : gridCount);

        }
      };

      gl.useProgram(shapeProg);
      gl.bindVertexArray(gridVao);
      gl.uniform2f(uShape.texel, 1 / simW, 1 / simH);
      gl.uniform1i(uShape.field, 0);
      gl.uniform1i(uShape.shape, 1);
      gl.uniform1i(uShape.coverage, 2);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textures[read]!);

      // pase 1: cobertura acumulada (aditiva, nunca visible). La textura de
      // cobertura queda DESLIGADA aquí: es el destino, no una fuente.
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, covFbo);
      gl.viewport(0, 0, simW, simH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      drawStack(0);

      // pase 2: la materia sobre el lienzo, leyendo ya la cobertura
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, covTex);
      gl.activeTexture(gl.TEXTURE0);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      drawStack(1);

      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);
    }

    // Permanencia: si alguien pidió una imagen del organismo, se toma AQUÍ,
    // dentro del mismo frame ya dibujado (el buffer no se ha descartado aún).
    if (thumbWaiting.length > 0) {
      const url = grabThumbNow();
      for (const resolve of thumbWaiting) resolve(url);
      thumbWaiting.length = 0;
    }
  };

  const thumbWaiting: ((url: string | null) => void)[] = [];
  const grabThumbNow = (): string | null => {
    try {
      const w = 320;
      const h = Math.max(1, Math.round((w * canvas.height) / Math.max(1, canvas.width)));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0, w, h);
      return c.toDataURL("image/jpeg", 0.72);
    } catch {
      return null;
    }
  };


  raf = requestAnimationFrame(frame);

  // Sonda de verificación (solo desarrollo): permite leer el estado real del
  // campo (altura, velocidad, memoria) y el número de contactos vivos. No
  // dibuja nada ni participa del render: solo mide.
  if (import.meta.env.DEV) {
    const px = new Float32Array(4);
    (window as unknown as Record<string, unknown>)["__eomProbe"] = {
      pointers: () => pointers.size,
      grabs: () => [...grabs.values()].map((g) => g.key),
      pinches: () => [...pinches.keys()],

      shapes: () =>
        getScene().map((s) => {
          const r = resid.get(s.key);
          const p = plast.get(s.key);
          return {
            key: s.key,
            x: s.x,
            y: s.y,
            rx: r?.x ?? 0,
            ry: r?.y ?? 0,
            plast: p?.amt ?? 0,
            floor: p?.floor ?? 0,
            size: s.size,
            scale: scaleOf(s.key),
          };
        }),

      hit: (ux: number, uy: number) => hitTest(ux, uy),
      sample: (ux: number, uy: number) => {
        const x = Math.max(0, Math.min(simW - 1, Math.round(ux * simW)));
        const y = Math.max(0, Math.min(simH - 1, Math.round(uy * simH)));
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[read]!);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { h: px[0], v: px[1], mem: px[2] };
      },
    };
  }


  return {
    reset() {
      pointers.clear();
      pinches.clear();

      makeTargets();
      time = 0;
    },
    /** Imagen del organismo tal como se ve ahora (permanencia, no screenshot de UI). */
    thumbnail(): Promise<string | null> {
      if (disposed) return Promise.resolve(null);
      return new Promise((resolve) => {
        thumbWaiting.push(resolve);
        window.setTimeout(() => {
          const i = thumbWaiting.indexOf(resolve);
          if (i >= 0) {
            thumbWaiting.splice(i, 1);
            resolve(null);
          }
        }, 700);
      });
    },

    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onUp);
      window.removeEventListener("resize", resize);
      for (const m of meshes.values()) m.dispose();
      meshes.clear();
    },
  };
}