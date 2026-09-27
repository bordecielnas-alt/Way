import type { Category } from '@way/shared';

// Click sounds by category, synthesized with Web Audio: no files to host or
// license, a few milliseconds of CPU each. Turned on or off in the Réglages page.

export type SoundKind = Category | 'territory';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let volume = 0.6;

export function configureSounds(opts: { sounds: boolean; volume: number }): void {
  enabled = opts.sounds;
  volume = opts.volume;
  if (master) master.gain.value = volume * 0.5;
}

/** Loads the shared preference; failures keep the defaults. */
export async function loadSoundSettings(): Promise<void> {
  try {
    const r = await fetch('/api/ui');
    if (r.ok) configureSounds((await r.json()) as { sounds: boolean; volume: number });
  } catch {
    /* offline: defaults */
  }
}

function audio(): { ac: AudioContext; out: GainNode } | null {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume * 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return { ac: ctx, out: master! };
}

/** One enveloped oscillator. */
function tone(
  ac: AudioContext, out: AudioNode, t: number,
  { type = 'sine', freq, to, dur, gain = 0.5, attack = 0.005 }:
  { type?: OscillatorType; freq: number; to?: number; dur: number; gain?: number; attack?: number },
): void {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** Filtered noise burst (clash, rumble, thud). */
function noise(
  ac: AudioContext, out: AudioNode, t: number,
  { dur, gain = 0.4, filter = 'bandpass', freq = 1000, q = 1 }:
  { dur: number; gain?: number; filter?: BiquadFilterType; freq?: number; q?: number },
): void {
  const len = Math.ceil(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t);
}

const NOTES = (base: number, steps: number[]) => steps.map((s) => base * 2 ** (s / 12));

const SOUNDS: Record<SoundKind, (ac: AudioContext, out: AudioNode, t: number) => void> = {
  battle: (ac, out, t) => {
    // Sword clash: metallic hit and ring.
    noise(ac, out, t, { dur: 0.12, gain: 0.5, freq: 3500, q: 0.8 });
    tone(ac, out, t, { type: 'triangle', freq: 2350, dur: 0.45, gain: 0.18 });
    tone(ac, out, t, { type: 'sine', freq: 3170, dur: 0.35, gain: 0.12 });
    tone(ac, out, t + 0.07, { type: 'triangle', freq: 1870, dur: 0.3, gain: 0.08 });
  },
  polity: (ac, out, t) => {
    // Short brass fanfare.
    NOTES(392, [0, 5, 9]).forEach((f, i) =>
      tone(ac, out, t + i * 0.09, { type: 'sawtooth', freq: f, dur: i === 2 ? 0.45 : 0.14, gain: 0.09, attack: 0.02 }));
  },
  territory: (ac, out, t) => {
    // Unrolled map: soft rustle and a low horn.
    noise(ac, out, t, { dur: 0.25, gain: 0.12, filter: 'highpass', freq: 2500 });
    tone(ac, out, t + 0.05, { type: 'sawtooth', freq: 196, dur: 0.5, gain: 0.06, attack: 0.06 });
    tone(ac, out, t + 0.05, { type: 'sine', freq: 294, dur: 0.5, gain: 0.08, attack: 0.06 });
  },
  city: (ac, out, t) => {
    // Town chime.
    tone(ac, out, t, { freq: 880, dur: 0.6, gain: 0.2 });
    tone(ac, out, t + 0.1, { freq: 1318.5, dur: 0.7, gain: 0.14 });
  },
  monument: (ac, out, t) => {
    // Stone thud.
    tone(ac, out, t, { freq: 140, to: 70, dur: 0.3, gain: 0.45 });
    noise(ac, out, t, { dur: 0.18, gain: 0.25, filter: 'lowpass', freq: 500 });
  },
  religion: (ac, out, t) => {
    // Bell: inharmonic partials, long decay.
    for (const [ratio, g] of [[1, 0.22], [2.0, 0.1], [2.4, 0.08], [3.0, 0.05], [4.2, 0.03]] as const) {
      tone(ac, out, t, { freq: 440 * ratio, dur: 1.6, gain: g, attack: 0.003 });
    }
  },
  person: (ac, out, t) => {
    // Lute pluck.
    tone(ac, out, t, { type: 'triangle', freq: 392, dur: 0.4, gain: 0.25 });
    tone(ac, out, t + 0.06, { type: 'triangle', freq: 587.3, dur: 0.45, gain: 0.18 });
  },
  event: (ac, out, t) => {
    // Drum.
    tone(ac, out, t, { freq: 180, to: 80, dur: 0.28, gain: 0.5 });
    noise(ac, out, t, { dur: 0.06, gain: 0.15, filter: 'lowpass', freq: 1200 });
  },
  discovery: (ac, out, t) => {
    // Rising arpeggio.
    NOTES(1046.5, [0, 4, 7, 12]).forEach((f, i) => tone(ac, out, t + i * 0.06, { freq: f, dur: 0.3, gain: 0.12 }));
  },
  disaster: (ac, out, t) => {
    // Rumble.
    noise(ac, out, t, { dur: 0.9, gain: 0.5, filter: 'lowpass', freq: 180 });
    tone(ac, out, t, { freq: 55, to: 40, dur: 0.9, gain: 0.3, attack: 0.05 });
  },
  trade: (ac, out, t) => {
    // Coins.
    [0, 0.07, 0.15].forEach((d, i) => {
      tone(ac, out, t + d, { freq: 3100 + i * 380, dur: 0.12, gain: 0.1 });
      tone(ac, out, t + d, { freq: 4700 + i * 250, dur: 0.08, gain: 0.05 });
    });
  },
  art: (ac, out, t) => {
    // Harp glissando (pentatonic).
    NOTES(523.3, [0, 2, 4, 7, 9, 12]).forEach((f, i) =>
      tone(ac, out, t + i * 0.045, { type: 'triangle', freq: f, dur: 0.5, gain: 0.1 }));
  },
  science: (ac, out, t) => {
    // Glass ping.
    tone(ac, out, t, { freq: 1760, dur: 0.6, gain: 0.14 });
    tone(ac, out, t, { freq: 2637, dur: 0.4, gain: 0.07 });
  },
  nature: (ac, out, t) => {
    // Bird chirps.
    tone(ac, out, t, { freq: 2200, to: 3400, dur: 0.09, gain: 0.12 });
    tone(ac, out, t + 0.13, { freq: 2400, to: 3700, dur: 0.09, gain: 0.1 });
  },
  place: (ac, out, t) => tone(ac, out, t, { freq: 660, dur: 0.12, gain: 0.15 }),
};

export function playSound(kind: SoundKind, { force = false } = {}): void {
  if (!enabled && !force) return;
  const a = audio();
  if (!a) return;
  SOUNDS[kind](a.ac, a.out, a.ac.currentTime + 0.01);
}
