/**
 * Vehicle sound, procedurally generated with the Web Audio API (no
 * external audio files, same policy as render/textures.ts).
 *
 * Design ref: 02_design.md section 6.11. No `three` or `sim/` imports --
 * main.ts computes every value passed into update() (design 6.1).
 */

export interface VehicleAudioState {
  speed: number; // [m/s]
  // sim/shiftModel.ts's updateGear() result (design 6.16/P17). idleRpm/
  // redlineRpm are passed alongside as plain numbers (not a `ShiftParams`
  // import) so this module keeps zero sim/ runtime dependency (design 6.1).
  rpm: number;
  idleRpm: number;
  redlineRpm: number;
  throttle: number; // [0, 1]
  brake: number; // [0, 1]
  // sim/vehicle.ts's stepVehicle() gripRatio (design 6.3.2/6.11): the
  // demanded lateral acceleration over the grip limit (1.0 = at the limit).
  // Drives the tire squeal's level continuously instead of P12's on/off
  // `gripExceeded` (P23).
  gripRatio: number;
  // Off-course surface (design 6.13, P13 follow-up). Plain booleans rather
  // than sim/surface.ts's SurfaceKind -- this module has no sim/ import
  // (design 6.1), so main.ts derives these from surfaceAt()'s result.
  onCurb: boolean;
  onGrass: boolean;
  wallContact: boolean;
}

const NOISE_BUFFER_SECONDS = 2;
const PARAM_SMOOTHING_S = 0.05; // avoids clicks from per-frame AudioParam updates
const BRAKE_SOUND_MIN_SPEED = 3; // [m/s] (~11 km/h); brake sound fades to 0 below this

// Engine pitch range (design 6.16/P17): the real RPM values from
// `tools fit-shift` (design 4.10) are whatever this season's telemetry
// happens to use, not a scale meant to be played back as literal Hz --
// idleRpm/redlineRpm are normalized to [0, 1] and mapped onto this
// audible range instead, feel-tuned like the rest of this module's
// pitch/gain constants (not a measured value).
const ENGINE_IDLE_HZ = 80;
const ENGINE_REDLINE_HZ = 280;

// Curb rumble (design 6.13/6.11, P13 follow-up): a periodic thump rather
// than steady noise, since a real curb is a row of raised stripes, not a
// continuous surface. The LFO's period is tied to speed so the thump rate
// matches how fast the stripes actually pass under the car; the 4 m period
// matches render/circuitScenery.ts's CURB_TILE_M (kept as a separate
// constant here -- design 6.1 keeps audio/ independent of render/, so this
// is a second copy, not a shared import).
const CURB_BUMP_PERIOD_M = 4;
const CURB_BASE_LEVEL = 0.08;
const CURB_LFO_DEPTH = 0.08;
const GRASS_BASE_LEVEL = 0.08;
const GRASS_SPEED_LEVEL = 0.12; // additional level at high speed
const GRASS_SPEED_REF = 30; // [m/s] speed at which the speed-dependent term saturates
const WALL_LEVEL = 0.3;

// Cornering tire squeal (design 6.11, P23): a moderate-Q noise band plus a
// quiet triangle-wave overtone, both rising with speed -- a rough, noisy
// "kin-kin", a different timbre from the brake's broadband highpass hiss. All values are
// by-ear placeholders, tuned through real-play confirmation (not measured).
const SQUEAL_SPEED_REF = 60; // [m/s] speed at which the pitch saturates
const SQUEAL_MIN_HZ = 1100; // noise band centre at standstill
const SQUEAL_MAX_HZ = 2400; // noise band centre at SQUEAL_SPEED_REF
const SQUEAL_OVERTONE_RATIO = 0.5; // overtone frequency relative to the noise band
const SQUEAL_NOISE_LEVEL = 0.3;
const SQUEAL_TONE_LEVEL = 0.03;
// Squeal begins slightly before the grip limit and saturates a bit beyond it:
// real tires start singing just under the limit, and a step at exactly 1.0
// would click.
const SQUEAL_RATIO_START = 0.9;
const SQUEAL_RATIO_FULL = 1.1;

function createNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * NOISE_BUFFER_SECONDS);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

function createNoiseLoop(ctx: AudioContext, buffer: AudioBuffer): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

/**
 * Engine/brake/cornering-squeal sound. Nodes are created once in `start()`;
 * `update()` only rewrites existing `AudioParam`s (design 6.11) -- no
 * per-frame node creation/teardown.
 */
export class EngineAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private brakeGain: GainNode | null = null;
  private squealFilter: BiquadFilterNode | null = null;
  private squealNoiseGain: GainNode | null = null;
  private squealOsc: OscillatorNode | null = null;
  private squealToneGain: GainNode | null = null;
  private curbLfo: OscillatorNode | null = null;
  private curbToneGain: GainNode | null = null;
  private curbLfoGain: GainNode | null = null;
  private grassGain: GainNode | null = null;
  private wallGain: GainNode | null = null;
  private muted = false;

  /**
   * Builds the audio graph and starts playback. Must be called from a
   * user-gesture handler (e.g. the first keydown) -- browsers keep a fresh
   * `AudioContext` suspended until a gesture resumes it.
   */
  start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;

    const masterGain = ctx.createGain();
    masterGain.gain.value = this.muted ? 0 : 1;
    masterGain.connect(ctx.destination);
    this.masterGain = masterGain;

    // Engine: sawtooth oscillator (pitch/volume track speed/throttle) through
    // a lowpass filter to soften the raw waveform.
    const engineOsc = ctx.createOscillator();
    engineOsc.type = "sawtooth";
    engineOsc.frequency.value = 80;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = "lowpass";
    engineFilter.frequency.value = 800;
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    engineOsc.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(masterGain);
    engineOsc.start();
    this.engineOsc = engineOsc;
    this.engineGain = engineGain;

    const noiseBuffer = createNoiseBuffer(ctx);

    // Brake: noise through a highpass filter (squeal-like), gain tied to brake input.
    const brakeSource = createNoiseLoop(ctx, noiseBuffer);
    const brakeFilter = ctx.createBiquadFilter();
    brakeFilter.type = "highpass";
    brakeFilter.frequency.value = 2500;
    const brakeGain = ctx.createGain();
    brakeGain.gain.value = 0;
    brakeSource.connect(brakeFilter);
    brakeFilter.connect(brakeGain);
    brakeGain.connect(masterGain);
    brakeSource.start();
    this.brakeGain = brakeGain;

    // Cornering tire squeal: moderate-Q bandpass noise (noisy, not a pure
    // whistle) plus a quiet triangle overtone; pitch follows speed, level follows how close
    // the demanded lateral acceleration is to the grip limit (update()).
    const squealSource = createNoiseLoop(ctx, noiseBuffer);
    const squealFilter = ctx.createBiquadFilter();
    squealFilter.type = "bandpass";
    squealFilter.frequency.value = SQUEAL_MIN_HZ;
    squealFilter.Q.value = 3;
    const squealNoiseGain = ctx.createGain();
    squealNoiseGain.gain.value = 0;
    squealSource.connect(squealFilter);
    squealFilter.connect(squealNoiseGain);
    squealNoiseGain.connect(masterGain);
    squealSource.start();
    this.squealFilter = squealFilter;
    this.squealNoiseGain = squealNoiseGain;

    const squealOsc = ctx.createOscillator();
    squealOsc.type = "triangle";
    squealOsc.frequency.value = SQUEAL_MIN_HZ * SQUEAL_OVERTONE_RATIO;
    const squealToneGain = ctx.createGain();
    squealToneGain.gain.value = 0;
    squealOsc.connect(squealToneGain);
    squealToneGain.connect(masterGain);
    squealOsc.start();
    this.squealOsc = squealOsc;
    this.squealToneGain = squealToneGain;

    // Curb: filtered noise (a dull thud, not the corner scrub's bandpass
    // hiss) whose gain is tremolo'd by an LFO -- an oscillator connected
    // directly to a GainNode's `.gain` AudioParam adds its waveform to the
    // param's own value each sample, so this needs no extra scheduling.
    const curbSource = createNoiseLoop(ctx, noiseBuffer);
    const curbFilter = ctx.createBiquadFilter();
    curbFilter.type = "lowpass";
    curbFilter.frequency.value = 400;
    const curbToneGain = ctx.createGain();
    curbToneGain.gain.value = 0;
    curbSource.connect(curbFilter);
    curbFilter.connect(curbToneGain);
    curbToneGain.connect(masterGain);
    curbSource.start();
    this.curbToneGain = curbToneGain;

    const curbLfo = ctx.createOscillator();
    curbLfo.type = "sine";
    curbLfo.frequency.value = 1;
    const curbLfoGain = ctx.createGain();
    curbLfoGain.gain.value = 0;
    curbLfo.connect(curbLfoGain);
    curbLfoGain.connect(curbToneGain.gain);
    curbLfo.start();
    this.curbLfo = curbLfo;
    this.curbLfoGain = curbLfoGain;

    // Grass: steady low-passed noise, louder at speed (rolling through
    // grass gets noisier the faster the car is moving through it).
    const grassSource = createNoiseLoop(ctx, noiseBuffer);
    const grassFilter = ctx.createBiquadFilter();
    grassFilter.type = "lowpass";
    grassFilter.frequency.value = 300;
    const grassGain = ctx.createGain();
    grassGain.gain.value = 0;
    grassSource.connect(grassFilter);
    grassFilter.connect(grassGain);
    grassGain.connect(masterGain);
    grassSource.start();
    this.grassGain = grassGain;

    // Wall contact: a grittier mid-band scrape, distinct from both the
    // brake's highpass squeal and the corner scrub's bandpass hiss.
    const wallSource = createNoiseLoop(ctx, noiseBuffer);
    const wallFilter = ctx.createBiquadFilter();
    wallFilter.type = "bandpass";
    wallFilter.frequency.value = 1200;
    wallFilter.Q.value = 1.5;
    const wallGain = ctx.createGain();
    wallGain.gain.value = 0;
    wallSource.connect(wallFilter);
    wallFilter.connect(wallGain);
    wallGain.connect(masterGain);
    wallSource.start();
    this.wallGain = wallGain;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.ctx || !this.masterGain) return;
    this.masterGain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, PARAM_SMOOTHING_S);
  }

  update(state: VehicleAudioState): void {
    const ctx = this.ctx;
    if (
      !ctx ||
      !this.engineOsc ||
      !this.engineGain ||
      !this.brakeGain ||
      !this.squealFilter ||
      !this.squealNoiseGain ||
      !this.squealOsc ||
      !this.squealToneGain ||
      !this.curbLfo ||
      !this.curbToneGain ||
      !this.curbLfoGain ||
      !this.grassGain ||
      !this.wallGain
    ) {
      return;
    }
    if (ctx.state === "suspended") void ctx.resume();

    const now = ctx.currentTime;
    // design 6.16/P17: pitch tracks RPM (not speed directly) so a gear
    // change's RPM drop -- not just speed -- reads as a shift; no extra
    // "shift shock" logic is needed since updateGear()'s rpm already dips.
    const rpmRange = Math.max(1, state.redlineRpm - state.idleRpm);
    const rpmFrac = Math.min(1, Math.max(0, (state.rpm - state.idleRpm) / rpmRange));
    const engineHz = ENGINE_IDLE_HZ + rpmFrac * (ENGINE_REDLINE_HZ - ENGINE_IDLE_HZ);
    this.engineOsc.frequency.setTargetAtTime(engineHz, now, PARAM_SMOOTHING_S);
    this.engineGain.gain.setTargetAtTime(0.05 + state.throttle * 0.15, now, PARAM_SMOOTHING_S);
    // Real brakes don't squeal when the car is barely moving -- fade the
    // sound out smoothly below BRAKE_SOUND_MIN_SPEED rather than gating it
    // on/off, so there's no click as speed crosses the threshold.
    const brakeSpeedFactor = Math.min(1, state.speed / BRAKE_SOUND_MIN_SPEED);
    this.brakeGain.gain.setTargetAtTime(state.brake * 0.2 * brakeSpeedFactor, now, PARAM_SMOOTHING_S);

    const squealSpeedFrac = Math.min(1, state.speed / SQUEAL_SPEED_REF);
    const squealHz = SQUEAL_MIN_HZ + squealSpeedFrac * (SQUEAL_MAX_HZ - SQUEAL_MIN_HZ);
    const squealLevel = Math.min(
      1,
      Math.max(0, (state.gripRatio - SQUEAL_RATIO_START) / (SQUEAL_RATIO_FULL - SQUEAL_RATIO_START)),
    );
    this.squealFilter.frequency.setTargetAtTime(squealHz, now, PARAM_SMOOTHING_S);
    this.squealOsc.frequency.setTargetAtTime(squealHz * SQUEAL_OVERTONE_RATIO, now, PARAM_SMOOTHING_S);
    this.squealNoiseGain.gain.setTargetAtTime(squealLevel * SQUEAL_NOISE_LEVEL, now, PARAM_SMOOTHING_S);
    this.squealToneGain.gain.setTargetAtTime(squealLevel * SQUEAL_TONE_LEVEL, now, PARAM_SMOOTHING_S);


    this.curbLfo.frequency.setTargetAtTime(Math.max(0.5, state.speed / CURB_BUMP_PERIOD_M), now, PARAM_SMOOTHING_S);
    this.curbToneGain.gain.setTargetAtTime(state.onCurb ? CURB_BASE_LEVEL : 0, now, PARAM_SMOOTHING_S);
    this.curbLfoGain.gain.setTargetAtTime(state.onCurb ? CURB_LFO_DEPTH : 0, now, PARAM_SMOOTHING_S);

    const grassSpeedFactor = Math.min(1, state.speed / GRASS_SPEED_REF);
    this.grassGain.gain.setTargetAtTime(
      state.onGrass ? GRASS_BASE_LEVEL + GRASS_SPEED_LEVEL * grassSpeedFactor : 0,
      now,
      PARAM_SMOOTHING_S,
    );

    this.wallGain.gain.setTargetAtTime(state.wallContact ? WALL_LEVEL : 0, now, PARAM_SMOOTHING_S);
  }
}
