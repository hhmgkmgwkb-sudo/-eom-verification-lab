/**
 * EOM AudioEngine — analytical canon: v0.3 "Materia Lenta".
 * Audio loading canon: v0.4.2 "AudioRestore" (simple object-URL path that
 * works reliably in Safari / iPad: <audio> element + MediaElementSource).
 *
 * The engine only ANALYSES. It never renders. Metrics are published into the
 * EOMStateBus; the Canvas Engine decides how the field manifests them.
 *
 * The rigid visual mappings of v0.4 / v0.4.2 are intentionally NOT carried over.
 */

import { clamp01, type StateBus } from "./eom-state-bus";

export const ACCEPTED_AUDIO_EXTENSIONS = [
  ".wav",
  ".wave",
  ".mp3",
  ".m4a",
  ".aac",
  ".aif",
  ".aiff",
] as const;

export const AUDIO_ACCEPT_ATTR = `audio/*,${ACCEPTED_AUDIO_EXTENSIONS.join(",")}`;

export function isAcceptedAudioFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    file.type.startsWith("audio/") ||
    ACCEPTED_AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext))
  );
}

type AudioEngineOptions = {
  bus: StateBus;
  onPlayStateChange?: (playing: boolean) => void;
  onError?: (message: string) => void;
};

export function createAudioEngine({ bus, onPlayStateChange, onError }: AudioEngineOptions) {
  const el = new Audio();
  el.crossOrigin = "anonymous";
  el.preload = "auto";
  el.loop = true;
  // iPad Safari: inline playback, no fullscreen takeover
  el.setAttribute("playsinline", "");

  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: MediaElementAudioSourceNode | null = null;
  let freq = new Uint8Array(new ArrayBuffer(0));
  let time = new Float32Array(new ArrayBuffer(0));
  let prevSpectrum: Float32Array = new Float32Array(0);
  let objectUrl: string | null = null;
  let raf = 0;
  let disposed = false;

  // v0.3 multiscale memory + field smoothing state
  let fast = 0;
  let medium = 0;
  let slow = 0;
  let smoothField = 0;
  let prevRms = 0;

  const ensureContext = () => {
    if (ctx) return ctx;
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    source = ctx.createMediaElementSource(el);
    source.connect(analyser);
    analyser.connect(ctx.destination);
    freq = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    time = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    prevSpectrum = new Float32Array(analyser.frequencyBinCount);
    return ctx;
  };

  const bandAverage = (loHz: number, hiHz: number, nyquist: number) => {
    const bins = freq.length;
    const lo = Math.max(0, Math.floor((loHz / nyquist) * bins));
    const hi = Math.min(bins - 1, Math.ceil((hiHz / nyquist) * bins));
    if (hi <= lo) return 0;
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += freq[i]! / 255;
    return sum / (hi - lo + 1);
  };

  const analyse = () => {
    if (disposed) return;
    raf = requestAnimationFrame(analyse);
    if (!analyser || !ctx) return;
    if (el.paused) return;

    analyser.getByteFrequencyData(freq);
    analyser.getFloatTimeDomainData(time);

    const nyquist = ctx.sampleRate / 2;

    // energy = logarithmically normalised RMS
    let sq = 0;
    for (let i = 0; i < time.length; i++) sq += time[i]! * time[i]!;
    const rms = Math.sqrt(sq / time.length);
    const energy = clamp01(Math.log10(1 + rms * 9) / Math.log10(10));

    const sub = bandAverage(20, 80, nyquist);
    const bass = bandAverage(80, 250, nyquist);
    const mid = bandAverage(250, 2000, nyquist);
    const presence = bandAverage(2000, 6000, nyquist);
    const air = bandAverage(6000, Math.min(18000, nyquist), nyquist);

    // spectral centroid, normalised against 7000 Hz
    let wsum = 0;
    let msum = 0;
    for (let i = 0; i < freq.length; i++) {
      const mag = freq[i]! / 255;
      wsum += mag * ((i / freq.length) * nyquist);
      msum += mag;
    }
    const centroidHz = msum > 1e-6 ? wsum / msum : 0;
    const centroid = clamp01(centroidHz / 7000);

    // spectral flux: sum of positive spectral increments, normalised
    let fluxSum = 0;
    for (let i = 0; i < freq.length; i++) {
      const mag = freq[i]! / 255;
      const d = mag - prevSpectrum[i]!;
      if (d > 0) fluxSum += d;
      prevSpectrum[i] = mag;
    }
    const flux = clamp01(fluxSum / (freq.length * 0.12));

    const relRmsChange = clamp01(Math.abs(rms - prevRms) / Math.max(prevRms, 0.02));
    prevRms = rms;

    const transient = Math.max(flux * 0.78, relRmsChange * 0.22);

    const bands = [sub, bass, mid, presence, air];
    const above = bands.filter((b) => b > 0.18).length / bands.length;
    const bandsMean = bands.reduce((a, b) => a + b, 0) / bands.length;
    const density = clamp01(0.58 * above + 0.42 * bandsMean);

    const stability = 1 - clamp01(flux * 0.65 + transient * 0.25 + relRmsChange * 0.1);

    // perceptual candidate (per) feeds the multiscale memory
    const per = clamp01(
      energy * 0.3 +
        stability * 0.24 +
        density * 0.16 +
        (1 - Math.abs(centroid - 0.38)) * 0.12 +
        bass * 0.08 +
        mid * 0.1,
    );

    fast = fast * 0.82 + per * 0.18;
    medium = medium * 0.965 + per * 0.035;
    slow = slow * 0.993 + per * 0.007;
    const memory = clamp01(fast * 0.28 + medium * 0.42 + slow * 0.3);

    const balance = clamp01(
      1 - Math.abs(centroid - 0.38) * 1.15 - Math.max(air - 0.72, 0) * 0.2,
    );

    const candidate = clamp01(
      energy * 0.2 +
        stability * 0.23 +
        density * 0.13 +
        balance * 0.14 +
        memory * 0.22 +
        (1 - transient) * 0.08,
    );

    const rawField = Math.max((candidate - 0.34) / 0.66, 0);
    smoothField = smoothField * 0.92 + rawField * 0.08;
    const field = clamp01(smoothField);

    // SPACE: PROVISIONAL PROXY ONLY. This is not reverberation / room analysis;
    // it is a heuristic openness estimate to be replaced by real spatial analysis.
    const space = clamp01(
      stability * 0.42 + (1 - transient) * 0.22 + (1 - centroid) * 0.14 + memory * 0.22,
    );

    bus.publish({
      energy,
      sub,
      bass,
      mid,
      presence,
      air,
      centroid,
      flux,
      transient,
      density,
      stability,
      memory,
      field,
      space,
      // internos del análisis v0.3, ahora publicados como lectura (sin ruteo)
      balance,
      mFast: fast,
      mMedium: medium,
      mSlow: slow,
    });
  };

  el.addEventListener("play", () => {
    bus.setActive(true);
    onPlayStateChange?.(true);
  });
  el.addEventListener("pause", () => {
    bus.setActive(false);
    onPlayStateChange?.(false);
  });
  el.addEventListener("ended", () => {
    bus.setActive(false);
    onPlayStateChange?.(false);
  });
  el.addEventListener("error", () => onError?.("No se pudo decodificar el audio."));

  raf = requestAnimationFrame(analyse);

  return {
    element: el,
    async load(file: File) {
      if (!isAcceptedAudioFile(file)) {
        onError?.("Formato no admitido.");
        return false;
      }
      // v0.4.2 canon: plain object URL — the path that survives Safari/iPad.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(file);
      el.src = objectUrl;
      el.load();
      ensureContext();
      return true;
    },
    async toggle() {
      const c = ensureContext();
      if (c.state === "suspended") await c.resume();
      if (el.paused) {
        try {
          await el.play();
        } catch {
          onError?.("Toca de nuevo para iniciar el audio.");
        }
      } else {
        el.pause();
      }
    },
    get playing() {
      return !el.paused;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      el.pause();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      try {
        source?.disconnect();
        analyser?.disconnect();
        void ctx?.close();
      } catch {
        /* noop */
      }
    },
  };
}

export type AudioEngine = ReturnType<typeof createAudioEngine>;