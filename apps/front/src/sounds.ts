import type { Category } from '@way/shared';

// Click sounds by category, in the spirit of strategy games (war drums,
// fanfares, horns, choirs), synthesized with Web Audio: no files to host or
// license. A shared hall reverb gives them room. Turned on or off in the
// Réglages page, where the owner can also import their own sound files
// for any kind (they then replace the synthesized one).

export type SoundKind = Category | 'territory' | 'army';

export interface UiPrefs { sounds: boolean; volume: number; hoverOpen: boolean; meanwhileMaxSpan: number }

let enabled = true;
let volume = 0.6;

interface Rig { ac: AudioContext; master: GainNode; dry: AudioNode; wet: AudioNode }
let rig: Rig | null = null;

export function configureSounds(opts: { sounds: boolean; volume: number }): void {
  enabled = opts.sounds;
  volume = opts.volume;
  if (rig) rig.master.gain.value = volume * 0.7;
}

/** Imported sounds: kind -> version. */
let custom: Record<string, string> = {};
const decoded = new Map<string, Promise<AudioBuffer | null>>();

/** Reads which kinds have an imported sound (the files are fetched on first play). */
export async function loadCustomSounds(): Promise<Record<string, string>> {
  try {
    const r = await fetch('/api/sounds');
    if (r.ok) custom = (await r.json()) as Record<string, string>;
  } catch {
    /* synthesized sounds only */
  }
  return custom;
}

function importedBuffer(r: Rig, kind: string, version: string): Promise<AudioBuffer | null> {
  const key = `${kind}@${version}`;
  let p = decoded.get(key);
  if (!p) {
    p = fetch(`/api/sounds/${kind}?v=${version}`)
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(String(res.status)))))
      .then((data) => r.ac.decodeAudioData(data))
      .catch(() => null);
    decoded.set(key, p);
  }
  return p;
}

/** Loads the shared interface preferences and applies the sound ones; null when unreachable. */
export async function loadUiSettings(): Promise<UiPrefs | null> {
  void loadCustomSounds();
  try {
    const r = await fetch('/api/ui');
    if (!r.ok) return null;
    const ui = (await r.json()) as UiPrefs;
    configureSounds(ui);
    return ui;
  } catch {
    return null; // offline: defaults
  }
}

/** Stereo impulse response of a stone hall: decaying noise, darker as it fades. */
function hallImpulse(ac: AudioContext, seconds = 2.4): AudioBuffer {
  const len = Math.ceil(ac.sampleRate * seconds);
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += (Math.random() * 2 - 1 - lp) * (0.6 - 0.45 * t); // one-pole lowpass closing over time
      d[i] = lp * (1 - t) ** 2.6;
    }
  }
  return buf;
}

function audio(): Rig | null {
  if (!rig) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ac = new AC();
    const master = ac.createGain();
    master.gain.value = volume * 0.7;
    // A compressor keeps layered hits (drums + brass + choir) from clipping.
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master.connect(comp).connect(ac.destination);
    const reverb = ac.createConvolver();
    reverb.buffer = hallImpulse(ac);
    const wet = ac.createGain();
    wet.gain.value = 0.9;
    wet.connect(reverb).connect(master);
    rig = { ac, master, dry: master, wet };
  }
  if (rig.ac.state === 'suspended') void rig.ac.resume();
  return rig;
}

/** Sends a node to the mix, `space` of it into the hall. */
function route(r: Rig, node: AudioNode, space: number): void {
  node.connect(r.dry);
  if (space > 0) {
    const s = r.ac.createGain();
    s.gain.value = space;
    node.connect(s).connect(r.wet);
  }
}

function env(r: Rig, t: number, peak: number, attack: number, dur: number, space = 0.3): GainNode {
  const g = r.ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  route(r, g, space);
  return g;
}

function noiseBuffer(ac: AudioContext, seconds: number): AudioBuffer {
  const len = Math.ceil(ac.sampleRate * seconds);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** One enveloped oscillator. */
function tone(
  r: Rig, t: number,
  { type = 'sine', freq, to, dur, gain = 0.3, attack = 0.005, space = 0.3 }:
  { type?: OscillatorType; freq: number; to?: number; dur: number; gain?: number; attack?: number; space?: number },
): void {
  const o = r.ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.8);
  o.connect(env(r, t, gain, attack, dur, space));
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Filtered noise (clash, rustle, rumble, crowd, surf). */
function noise(
  r: Rig, t: number,
  { dur, gain = 0.3, filter = 'bandpass', freq = 1000, to, q = 1, attack = 0.003, space = 0.3 }:
  { dur: number; gain?: number; filter?: BiquadFilterType; freq?: number; to?: number; q?: number; attack?: number; space?: number },
): void {
  const src = r.ac.createBufferSource();
  src.buffer = noiseBuffer(r.ac, dur + 0.05);
  const f = r.ac.createBiquadFilter();
  f.type = filter;
  f.frequency.setValueAtTime(freq, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
  f.Q.value = q;
  src.connect(f).connect(env(r, t, gain, attack, dur, space));
  src.start(t);
}

/** War drum / timpani: a pitched thump with a skin slap. */
function drum(r: Rig, t: number, freq = 70, gain = 0.8, space = 0.35): void {
  tone(r, t, { freq: freq * 2.4, to: freq, dur: 0.55, gain, attack: 0.002, space });
  tone(r, t, { freq: freq * 1.5, to: freq * 0.8, dur: 0.3, gain: gain * 0.3, attack: 0.002, space });
  noise(r, t, { dur: 0.08, gain: gain * 0.35, filter: 'lowpass', freq: 1400, space });
}

/**
 * Brass voice: detuned saws through a lowpass that opens as the player blows,
 * with a late vibrato. `bend` starts slightly flat, like a natural horn.
 */
function brass(
  r: Rig, t: number, freq: number, dur: number,
  { gain = 0.12, bright = 2600, bend = 1, space = 0.45 }: { gain?: number; bright?: number; bend?: number; space?: number } = {},
): void {
  const out = env(r, t, gain, 0.05, dur, space);
  const f = r.ac.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 1.2;
  f.frequency.setValueAtTime(bright * 0.15, t);
  f.frequency.exponentialRampToValueAtTime(bright, t + 0.08);
  f.frequency.exponentialRampToValueAtTime(bright * 0.45, t + dur);
  f.connect(out);
  const lfo = r.ac.createOscillator();
  const depth = r.ac.createGain();
  lfo.frequency.value = 5.2;
  depth.gain.setValueAtTime(0, t);
  depth.gain.linearRampToValueAtTime(freq * 0.006, t + Math.min(0.35, dur * 0.6));
  lfo.connect(depth);
  lfo.start(t);
  lfo.stop(t + dur + 0.05);
  for (const detune of [-7, 0, 6]) {
    const o = r.ac.createOscillator();
    o.type = 'sawtooth';
    o.detune.value = detune;
    o.frequency.setValueAtTime(freq * bend, t);
    if (bend !== 1) o.frequency.exponentialRampToValueAtTime(freq, t + 0.12);
    depth.connect(o.frequency);
    o.connect(f);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

/** Choir "aah": saw voices through two vowel formants, slow swell. */
function choir(r: Rig, t: number, freqs: number[], dur: number, gain = 0.07): void {
  const out = env(r, t, gain, 0.35, dur, 0.9);
  const f1 = r.ac.createBiquadFilter();
  const f2 = r.ac.createBiquadFilter();
  f1.type = f2.type = 'bandpass';
  f1.frequency.value = 780;
  f2.frequency.value = 1180;
  f1.Q.value = f2.Q.value = 5;
  f1.connect(out);
  f2.connect(out);
  for (const freq of freqs) {
    for (const detune of [-9, 4, 11]) {
      const o = r.ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(f1);
      o.connect(f2);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }
}

/** Metallic strike: inharmonic partials (blade, anvil, bell). */
function metal(r: Rig, t: number, base: number, partials: [number, number][], dur: number, space = 0.4): void {
  for (const [ratio, g] of partials) tone(r, t, { freq: base * ratio, dur: dur * (1.1 - ratio / 12), gain: g, attack: 0.001, space });
}

/** Plucked string: bright attack that darkens quickly. */
function pluck(r: Rig, t: number, freq: number, gain = 0.16, dur = 0.9): void {
  const o = r.ac.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = freq;
  const f = r.ac.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(freq * 8, t);
  f.frequency.exponentialRampToValueAtTime(freq * 1.2, t + 0.25);
  o.connect(f).connect(env(r, t, gain, 0.003, dur, 0.4));
  o.start(t);
  o.stop(t + dur + 0.05);
}

const semis = (base: number, s: number) => base * 2 ** (s / 12);

const SOUNDS: Record<SoundKind, (r: Rig, t: number) => void> = {
  battle: (r, t) => {
    // War drums, a clash of blades, a horn call over the battlefield.
    drum(r, t, 62, 0.9);
    drum(r, t + 0.22, 58, 0.7);
    noise(r, t + 0.3, { dur: 0.18, gain: 0.45, freq: 4200, q: 0.7, space: 0.5 });
    metal(r, t + 0.3, 1850, [[1, 0.12], [1.53, 0.09], [2.11, 0.07], [2.87, 0.05]], 0.7, 0.5);
    brass(r, t + 0.42, 110, 0.9, { gain: 0.13, bright: 1400, bend: 0.93 });
    brass(r, t + 0.42, 165, 0.9, { gain: 0.08, bright: 1400, bend: 0.93 });
  },
  polity: (r, t) => {
    // Royal fanfare over a timpani roll.
    for (let i = 0; i < 6; i++) drum(r, t + i * 0.05, 82, 0.18 + i * 0.03, 0.3);
    const notes: [number, number, number][] = [[0, 0, 0.16], [0.16, 5, 0.12], [0.3, 9, 0.12], [0.44, 12, 0.9]];
    for (const [d, s, dur] of notes) {
      brass(r, t + d, semis(392, s), dur, { gain: 0.1, bright: 3200 });
      if (dur > 0.5) brass(r, t + d, semis(392, s - 5), dur, { gain: 0.07, bright: 2600 });
    }
    drum(r, t + 0.44, 70, 0.8);
  },
  territory: (r, t) => {
    // Unrolling a map on the war table, then a low horn chord.
    noise(r, t, { dur: 0.35, gain: 0.14, filter: 'highpass', freq: 2200, attack: 0.04, space: 0.15 });
    noise(r, t + 0.12, { dur: 0.25, gain: 0.1, filter: 'bandpass', freq: 3500, q: 0.5, space: 0.15 });
    drum(r, t + 0.1, 55, 0.35);
    brass(r, t + 0.15, 98, 0.9, { gain: 0.08, bright: 900 });
    brass(r, t + 0.15, 147, 0.9, { gain: 0.06, bright: 900 });
  },
  city: (r, t) => {
    // Town bells over the bustle of a market.
    noise(r, t, { dur: 0.9, gain: 0.05, filter: 'bandpass', freq: 900, q: 0.6, attack: 0.2, space: 0.2 });
    metal(r, t, 587, [[1, 0.12], [2, 0.06], [2.4, 0.05], [3, 0.03]], 1.4, 0.6);
    metal(r, t + 0.28, 440, [[1, 0.12], [2, 0.06], [2.4, 0.05], [3, 0.03]], 1.6, 0.6);
  },
  monument: (r, t) => {
    // Masons at work: hammer on stone, a heavy block set down.
    metal(r, t, 1300, [[1, 0.1], [1.7, 0.06], [2.6, 0.04]], 0.25, 0.3);
    noise(r, t, { dur: 0.1, gain: 0.3, freq: 2500, q: 0.8 });
    metal(r, t + 0.2, 1250, [[1, 0.08], [1.7, 0.05], [2.6, 0.03]], 0.22, 0.3);
    noise(r, t + 0.2, { dur: 0.08, gain: 0.22, freq: 2500, q: 0.8 });
    tone(r, t + 0.42, { freq: 120, to: 48, dur: 0.6, gain: 0.7, space: 0.4 });
    noise(r, t + 0.42, { dur: 0.45, gain: 0.3, filter: 'lowpass', freq: 400, space: 0.4 });
  },
  fortification: (r, t) => {
    // A heavy gate: chains running, then the portcullis falling.
    for (let i = 0; i < 7; i++) metal(r, t + i * 0.06, 2400 + ((i * 211) % 500), [[1, 0.05], [1.6, 0.03]], 0.12, 0.25);
    tone(r, t + 0.5, { freq: 90, to: 40, dur: 0.7, gain: 0.7, space: 0.5 });
    noise(r, t + 0.5, { dur: 0.5, gain: 0.3, filter: 'lowpass', freq: 500, space: 0.5 });
  },
  exploration: (r, t) => {
    // Wind in the sails and a ship's bell.
    noise(r, t, { dur: 1.4, gain: 0.14, filter: 'bandpass', freq: 700, to: 1100, q: 0.4, attack: 0.5, space: 0.3 });
    metal(r, t + 0.3, 880, [[1, 0.1], [2.76, 0.04], [5.4, 0.02]], 1.3, 0.6);
    metal(r, t + 0.62, 880, [[1, 0.07], [2.76, 0.03]], 1.1, 0.6);
  },
  religion: (r, t) => {
    // A choir chord under a temple bell.
    choir(r, t, [semis(220, 0), semis(220, 7), semis(220, 12), semis(220, 16)], 1.8);
    metal(r, t, 330, [[1, 0.16], [2, 0.07], [2.4, 0.06], [3, 0.04], [4.2, 0.02]], 2.2, 0.8);
  },
  person: (r, t) => {
    // A unit answering the call: lute phrase and a snare tap.
    [0, 7, 12].forEach((s, i) => pluck(r, t + i * 0.11, semis(294, s), 0.15));
    noise(r, t, { dur: 0.07, gain: 0.12, filter: 'highpass', freq: 1800 });
  },
  event: (r, t) => {
    // Drum roll ending on a horn blast: news from afar.
    for (let i = 0; i < 8; i++) drum(r, t + i * 0.045, 95, 0.12 + i * 0.03, 0.25);
    drum(r, t + 0.38, 68, 0.8);
    brass(r, t + 0.38, 147, 0.7, { gain: 0.1, bright: 1800, bend: 0.94 });
  },
  discovery: (r, t) => {
    // Surf against the hull, a ship's bell, a rising harp.
    noise(r, t, { dur: 1.3, gain: 0.12, filter: 'lowpass', freq: 400, to: 1400, attack: 0.4, space: 0.3 });
    metal(r, t + 0.1, 988, [[1, 0.09], [2.76, 0.04], [5.4, 0.02]], 1.2, 0.6);
    [0, 4, 7, 12, 16].forEach((s, i) => pluck(r, t + 0.35 + i * 0.07, semis(523, s), 0.08, 1.1));
  },
  disaster: (r, t) => {
    // Thunder and a dissonant low horn.
    noise(r, t, { dur: 1.6, gain: 0.55, filter: 'lowpass', freq: 900, to: 90, attack: 0.02, space: 0.6 });
    tone(r, t, { freq: 48, to: 34, dur: 1.5, gain: 0.35, attack: 0.08 });
    brass(r, t + 0.25, 73, 1.2, { gain: 0.08, bright: 700 });
    brass(r, t + 0.25, 78, 1.2, { gain: 0.07, bright: 700 });
  },
  trade: (r, t) => {
    // A purse of coins poured on the counter.
    [0, 0.06, 0.11, 0.19, 0.24, 0.33].forEach((d, i) => {
      const f = 2900 + ((i * 373) % 900);
      metal(r, t + d, f, [[1, 0.07], [1.47, 0.04], [2.3, 0.02]], 0.18, 0.25);
    });
    noise(r, t, { dur: 0.3, gain: 0.08, filter: 'highpass', freq: 5000 });
  },
  art: (r, t) => {
    // Harp glissando in a hall.
    [0, 2, 4, 7, 9, 12, 14, 16].forEach((s, i) => pluck(r, t + i * 0.05, semis(392, s), 0.08, 1.4));
  },
  science: (r, t) => {
    // Quill on parchment, then a crystal chime.
    noise(r, t, { dur: 0.25, gain: 0.08, filter: 'bandpass', freq: 5500, q: 3, attack: 0.03, space: 0.1 });
    metal(r, t + 0.22, 1568, [[1, 0.09], [2.01, 0.04], [3.02, 0.02]], 1.2, 0.7);
    metal(r, t + 0.34, 2349, [[1, 0.06], [2.01, 0.03]], 1.0, 0.7);
  },
  nature: (r, t) => {
    // Wind in the trees and birdsong.
    noise(r, t, { dur: 1.2, gain: 0.07, filter: 'bandpass', freq: 600, to: 1200, q: 0.8, attack: 0.4, space: 0.2 });
    [0.1, 0.24, 0.5].forEach((d, i) => tone(r, t + d, { freq: 2300 + i * 200, to: 3600, dur: 0.1, gain: 0.07, space: 0.3 }));
  },
  army: (r, t) => {
    // An army on the march: snare rolls, a bass drum, a fife tune.
    for (let i = 0; i < 8; i++) {
      const accent = i % 4 === 0;
      noise(r, t + i * 0.12, { dur: 0.07, gain: accent ? 0.32 : 0.18, freq: 2600, q: 0.9, space: 0.3 });
      if (accent) drum(r, t + i * 0.12, 60, 0.55, 0.3);
    }
    const fife: [number, number][] = [[0, 7], [0.24, 9], [0.36, 11], [0.48, 14], [0.72, 11], [0.84, 9]];
    for (const [d, st] of fife) tone(r, t + d, { type: 'triangle', freq: semis(784, st - 7), dur: 0.2, gain: 0.07, attack: 0.01, space: 0.45 });
  },
  place: (r, t) => {
    // A marker set on the map.
    drum(r, t, 110, 0.3, 0.2);
    tone(r, t + 0.03, { freq: 880, dur: 0.4, gain: 0.07, space: 0.4 });
  },
};

export function playSound(kind: SoundKind, { force = false, synth = false } = {}): void {
  if (!enabled && !force) return;
  const r = audio();
  if (!r) return;
  const version = custom[kind];
  if (version && !synth) {
    void importedBuffer(r, kind, version).then((buf) => {
      if (!buf) {
        SOUNDS[kind](r, r.ac.currentTime + 0.02);
        return;
      }
      const src = r.ac.createBufferSource();
      src.buffer = buf;
      const g = r.ac.createGain();
      g.gain.value = 1.2;
      src.connect(g).connect(r.dry); // imported sounds carry their own room
      src.start();
    });
    return;
  }
  SOUNDS[kind](r, r.ac.currentTime + 0.02);
}
