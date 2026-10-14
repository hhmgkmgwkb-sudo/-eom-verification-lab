/**
 * EOM runtime — process-wide singletons so navigating between Studio and Live
 * never restarts the perceptual field or the acoustic analysis.
 *
 * The Canvas Engine, Audio Engine and State Bus are NOT re-created per route.
 */

import { createStateBus, type EOMState } from "@/lib/eom-state-bus";
import { createAudioEngine, type AudioEngine } from "@/lib/audio-engine";
import { createFieldEngine } from "@/components/field-engine";
import {
  restoreScene,
  snapshotScene,
  type ShapeInstance,
} from "@/lib/eom-shape-library";
import {
  restoreCanvas,
  snapshotCanvas,
  subscribeCanvas,
  type CanvasParams,
  type CanvasState,
} from "@/lib/eom-canvas-state";
import { subscribeScene } from "@/lib/eom-shape-library";
import { resetHistory, startHistory } from "@/lib/eom-history";
import { startCanvasDismiss } from "@/lib/eom-ui";

export const bus = createStateBus();

type FieldEngine = ReturnType<typeof createFieldEngine>;
let field: FieldEngine | null = null;

export function attachField(canvas: HTMLCanvasElement) {
  field?.dispose();
  field = createFieldEngine(canvas, bus);
  return field;
}
export function resetField() {
  field?.reset();
}


/* ---------------- audio ---------------- */

let audio: AudioEngine | null = null;
const audioListeners = new Set<() => void>();

export type AudioStatus = {
  playing: boolean;
  trackName: string | null;
  error: string | null;
};
const audioStatus: AudioStatus = { playing: false, trackName: null, error: null };

const notifyAudio = () => {
  for (const fn of audioListeners) fn();
};

export function getAudio() {
  if (typeof window === "undefined") return null;
  if (!audio) {
    audio = createAudioEngine({
      bus,
      onPlayStateChange: (p) => {
        audioStatus.playing = p;
        bus.setActive(p);
        notifyAudio();
      },
      onError: (e) => {
        audioStatus.error = e;
        notifyAudio();
      },
    });
  }
  return audio;
}

export async function loadTrack(file: File) {
  audioStatus.error = null;
  const ok = await getAudio()?.load(file);
  if (ok) audioStatus.trackName = file.name;
  notifyAudio();
  return ok;
}

export async function toggleTrack() {
  await getAudio()?.toggle();
  notifyAudio();
}

export function subscribeAudio(fn: () => void) {
  audioListeners.add(fn);
  return () => audioListeners.delete(fn);
}
export function getAudioStatus() {
  return audioStatus;
}

/* ---------------- permanence / captures ---------------- */

export type CaptureKind = "still" | "loop" | "seed";

export type CaptureCanvas = { stateId: string; params: CanvasParams; states?: CanvasState[] };

export type Capture = {
  id: string;
  kind: CaptureKind;
  label: string;
  createdAt: number;
  /** origin context of the capture */
  origin: "build" | "sample" | "perform" | "live";
  /** state of the organism at capture time */
  state: EOMState;
  /** composición viva en el momento de la captura */
  scene: ShapeInstance[];
  /** entorno paramétrico del lienzo en ese momento */
  canvas: CaptureCanvas;
  /** imagen del organismo (evocación, no la fuente de verdad) */
  thumb: string | null;
  /** id of the capture this one descends from, if any */
  parentId: string | null;
};

const CAPTURE_LIMIT = 16;
const CAPTURES_KEY = "eom.captures.v1";
const captures: Capture[] = [];
let captureTimer = 0;

function queueCaptureSave() {
  if (typeof window === "undefined") return;
  window.clearTimeout(captureTimer);
  captureTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(CAPTURES_KEY, JSON.stringify(captures.slice(0, CAPTURE_LIMIT)));
    } catch {
      /* sin espacio: la permanencia se queda en esta sesión */
    }
  }, 500);
}
const captureListeners = new Set<() => void>();
const notifyCaptures = () => {
  for (const fn of captureListeners) fn();
};

export function listCaptures() {
  return captures;
}

export function subscribeCaptures(fn: () => void) {
  captureListeners.add(fn);
  return () => captureListeners.delete(fn);
}

export function capture(kind: CaptureKind, origin: Capture["origin"], parentId: string | null = null) {
  const n = captures.filter((c) => c.kind === kind).length + 1;
  const item: Capture = {
    id: `${kind}-${Date.now().toString(36)}`,
    kind,
    label: `${kind === "still" ? "Still" : kind === "loop" ? "Loop" : "Seed"} ${String(n).padStart(2, "0")}`,
    createdAt: Date.now(),
    origin,
    state: { ...bus.effectiveState },
    scene: snapshotScene(),
    canvas: snapshotCanvas(),
    thumb: null,
    parentId,
  };
  captures.unshift(item);
  if (captures.length > CAPTURE_LIMIT) captures.length = CAPTURE_LIMIT;
  notifyCaptures();
  queueCaptureSave();
  // la imagen llega un frame después: el motor la toma del propio campo
  void field?.thumbnail().then((url) => {
    if (!url) return;
    item.thumb = url;
    notifyCaptures();
    queueCaptureSave();
  });
  return item;
}

/**
 * Recall: el estado guardado vuelve al presente — composición y lienzo. El
 * original nunca se sobrescribe: recall produce una continuación, no una copia.
 */
export function recallCapture(id: string) {
  const c = captures.find((x) => x.id === id);
  if (!c) return null;
  restoreCanvas(c.canvas);
  restoreScene(c.scene);
  resetHistory();
  record("Recall", c.label);
  return c;
}


/* ---------------- history (sequence of actions) ---------------- */

export type HistoryEntry = { id: string; at: number; verb: string; detail?: string | undefined };

const history: HistoryEntry[] = [];
const historyListeners = new Set<() => void>();

export function record(verb: string, detail?: string) {
  history.unshift({ id: `h-${Date.now().toString(36)}-${history.length}`, at: Date.now(), verb, detail });
  if (history.length > 120) history.pop();
  for (const fn of historyListeners) fn();
}
export function listHistory() {
  return history;
}
export function subscribeHistory(fn: () => void) {
  historyListeners.add(fn);
  return () => historyListeners.delete(fn);
}

/* ---------------- session permanence (composición + lienzo) ---------------- */

/**
 * La sesión de trabajo no debe morir al recargar en iPad/iPhone. Se guarda
 * únicamente el estado declarativo (composición y parámetros del lienzo);
 * la física y el análisis siguen naciendo en vivo.
 */
const SESSION_KEY = "eom.session.v1";
let saveTimer = 0;

function saveSession() {
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ scene: snapshotScene(), canvas: snapshotCanvas() }),
    );
  } catch {
    /* almacenamiento no disponible: la sesión simplemente no persiste */
  }
}

const queueSave = () => {
  if (typeof window === "undefined") return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveSession, 400);
};

let sessionStarted = false;

export function startSessionPersistence() {
  if (sessionStarted || typeof window === "undefined") return;
  sessionStarted = true;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const data = JSON.parse(raw) as {
        scene?: ShapeInstance[];
        canvas?: CaptureCanvas;
      };
      if (data.canvas) restoreCanvas(data.canvas);
      if (Array.isArray(data.scene)) restoreScene(data.scene);
    }
  } catch {
    /* sesión corrupta: se empieza del estado canónico */
  }
  subscribeScene(queueSave);
  subscribeCanvas(queueSave);
  queueSave();
  // Undo/Redo arranca DESPUÉS de restaurar: la sesión recuperada es la base.
  startHistory();
  startCanvasDismiss();
  try {
    const rawCaps = localStorage.getItem(CAPTURES_KEY);
    if (rawCaps) {
      const list = JSON.parse(rawCaps) as Capture[];
      if (Array.isArray(list)) {
        captures.splice(0, captures.length, ...list.slice(0, CAPTURE_LIMIT));
        notifyCaptures();
      }
    }
  } catch {
    /* memoria corrupta: se empieza sin capturas */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* nada que limpiar */
  }
}