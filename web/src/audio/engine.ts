/**
 * Vehicle sound, procedurally generated with the Web Audio API (no
 * external audio files, same policy as render/textures.ts).
 *
 * Design ref: 02_design.md section 6.10. No `three` or `sim/` imports --
 * main.ts computes every value passed into update() (design 6.1).
 */

export interface VehicleAudioState {
  speed: number; // [m/s]
  throttle: number; // [0, 1]
  brake: number; // [0, 1]
  cornerLimited: boolean; // sim/vehicle.ts's cornerSpeedLimit exceeded (design 6.3)
}

const NOISE_BUFFER_SECONDS = 2;
const PARAM_SMOOTHING_S = 0.05; // avoids clicks from per-frame AudioParam updates

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
 * Engine/brake/cornering-scrub sound. Nodes are created once in `start()`;
 * `update()` only rewrites existing `AudioParam`s (design 6.10) -- no
 * per-frame node creation/teardown.
 */
export class EngineAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private brakeGain: GainNode | null = null;
  private cornerGain: GainNode | null = null;
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

    // Cornering scrub: noise through a mid-band bandpass (distinct timbre from
    // the brake's highpass), gain tied to the cornering grip limit.
    const cornerSource = createNoiseLoop(ctx, noiseBuffer);
    const cornerFilter = ctx.createBiquadFilter();
    cornerFilter.type = "bandpass";
    cornerFilter.frequency.value = 600;
    cornerFilter.Q.value = 0.7;
    const cornerGain = ctx.createGain();
    cornerGain.gain.value = 0;
    cornerSource.connect(cornerFilter);
    cornerFilter.connect(cornerGain);
    cornerGain.connect(masterGain);
    cornerSource.start();
    this.cornerGain = cornerGain;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.ctx || !this.masterGain) return;
    this.masterGain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, PARAM_SMOOTHING_S);
  }

  update(state: VehicleAudioState): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineOsc || !this.engineGain || !this.brakeGain || !this.cornerGain) return;
    if (ctx.state === "suspended") void ctx.resume();

    const now = ctx.currentTime;
    this.engineOsc.frequency.setTargetAtTime(80 + state.speed * 2, now, PARAM_SMOOTHING_S);
    this.engineGain.gain.setTargetAtTime(0.05 + state.throttle * 0.15, now, PARAM_SMOOTHING_S);
    this.brakeGain.gain.setTargetAtTime(state.brake * 0.2, now, PARAM_SMOOTHING_S);
    this.cornerGain.gain.setTargetAtTime(state.cornerLimited ? 0.25 : 0, now, PARAM_SMOOTHING_S);
  }
}
