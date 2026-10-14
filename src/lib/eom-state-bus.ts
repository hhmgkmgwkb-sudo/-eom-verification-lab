/**
 * EOMStateBus — the single shared state surface of EOM.
 *
 * Acoustic analysis (AudioEngine) writes into `targetState`.
 * Perceptual manifestation (Canvas Engine) reads `effectiveState`,
 * a smoothed version of the target. Keeping the two separated means
 * the analysis stays honest (fast, raw) while the manifestation stays
 * continuous (no fragmentation, no beat=flash).
 *
 * NOTE: `space` is still a PROVISIONAL PROXY derived from stability /
 * transient / centroid / memory. It is NOT real reverberation or room
 * analysis. Replace it when true spatial analysis lands.
 */

export type EOMState = {
  energy: number;
  sub: number;
  bass: number;
  mid: number;
  presence: number;
  air: number;
  centroid: number;
  flux: number;
  transient: number;
  density: number;
  stability: number;
  memory: number;
  field: number;
  /** provisional proxy — not real reverberation analysis */
  space: number;
  /** equilibrio espectral interno del análisis v0.3 (no rutea al campo) */
  balance: number;
  /** memoria multiescala interna: horizontes corto / medio / largo */
  mFast: number;
  mMedium: number;
  mSlow: number;
};

export const EOM_STATE_KEYS: (keyof EOMState)[] = [
  "energy",
  "sub",
  "bass",
  "mid",
  "presence",
  "air",
  "centroid",
  "flux",
  "transient",
  "density",
  "stability",
  "memory",
  "field",
  "space",
  "balance",
  "mFast",
  "mMedium",
  "mSlow",
];

const zero = (): EOMState => ({
  energy: 0,
  sub: 0,
  bass: 0,
  mid: 0,
  presence: 0,
  air: 0,
  centroid: 0,
  flux: 0,
  transient: 0,
  density: 0,
  stability: 0,
  memory: 0,
  field: 0,
  space: 0,
  balance: 0,
  mFast: 0,
  mMedium: 0,
  mSlow: 0,
});

/** per-metric smoothing towards the target (0..1 per 60fps frame) */
const SMOOTH: Partial<Record<keyof EOMState, number>> = {
  energy: 0.16,
  sub: 0.07,
  bass: 0.08,
  mid: 0.12,
  presence: 0.14,
  air: 0.14,
  centroid: 0.1,
  flux: 0.3,
  transient: 0.38,
  density: 0.08,
  stability: 0.06,
  memory: 0.03,
  field: 0.04,
  space: 0.05,
  balance: 0.06,
  mFast: 0.18,
  mMedium: 0.05,
  mSlow: 0.02,
};
const DEFAULT_SMOOTH = 0.1;

export type Listener = (s: EOMState) => void;

export function createStateBus() {
  const targetState = zero();
  const effectiveState = zero();
  let active = false;
  const listeners = new Set<Listener>();

  return {
    targetState,
    effectiveState,
    get active() {
      return active;
    },
    setActive(next: boolean) {
      active = next;
      if (!next) {
        for (const k of EOM_STATE_KEYS) targetState[k] = 0;
      }
    },
    /** called by the AudioEngine with freshly analysed acoustic metrics */
    publish(partial: Partial<EOMState>) {
      for (const k of EOM_STATE_KEYS) {
        const v = partial[k];
        if (typeof v === "number" && Number.isFinite(v)) targetState[k] = v;
      }
    },
    /** called once per rendered frame by the consumer (Canvas Engine) */
    integrate(dt: number) {
      const step = Math.min(1, Math.max(dt, 0) * 60);
      for (const k of EOM_STATE_KEYS) {
        const rate = SMOOTH[k] ?? DEFAULT_SMOOTH;
        effectiveState[k] += (targetState[k] - effectiveState[k]) * Math.min(1, rate * step);
      }
      return effectiveState;
    },
    subscribe(fn: Listener) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit() {
      for (const fn of listeners) fn(effectiveState);
    },
  };
}

export type StateBus = ReturnType<typeof createStateBus>;

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);