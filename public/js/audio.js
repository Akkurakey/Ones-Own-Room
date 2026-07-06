// Audio manager: unlock, ambient bed, AI-voice playback with ducking.
//
// Everything routes through Web Audio GainNodes — never HTMLAudio.volume.
// GainNode ramps are sample-accurate slopes; HTMLAudio volume changes are
// steps, and in a quiet therapeutic scene a step is an audible "tick".
//
// All asset loads degrade gracefully: a missing file warns and the session
// flows on. The audio layer must never be the thing that stalls the state
// machine.

const AMBIENT_LEVEL = 0.35;  // ambient bed when nothing else is happening
const DUCKED_LEVEL  = 0.15;  // ambient while the AI voice speaks
const VOICE_LEVEL   = 0.85;

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.ambientGain = null;
    this.ambientEnabled = true;
  }

  // UI mute toggle. Returns the new state. While disabled, every ambient ramp
  // (including ducking restores) is forced to zero inside _rampAmbient, so
  // there is exactly one place that decides what the bed is allowed to do.
  toggleAmbient() {
    this.ambientEnabled = !this.ambientEnabled;
    this._rampAmbient(AMBIENT_LEVEL, 0.6);
    return this.ambientEnabled;
  }

  // Must run inside the user-gesture call stack (the enter-VR click).
  // Deliberately does NOT await any network fetch: the same gesture still has
  // to pay for getUserMedia and requestSession afterwards, and a long await
  // here can void the transient activation. Ambient loading is fire-and-forget.
  async unlock() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") await this.ctx.resume();

    // Play 0.05 s of silence. On some Quest Browser builds resume() reports
    // success yet the first real playback is swallowed; actually having
    // played something inside the gesture warms the pipeline for good.
    const buf = this.ctx.createBuffer(1, 2205, 44100);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.start();

    this._startAmbient("./resources/audio/ambient_1.mp3");  // not awaited
  }

  async _startAmbient(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());

      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;

      this.ambientGain = this.ctx.createGain();
      this.ambientGain.gain.value = 0;
      src.connect(this.ambientGain).connect(this.ctx.destination);
      src.start();

      // 5 s fade-in — the bed settles under the listening/waiting phases.
      this._rampAmbient(AMBIENT_LEVEL, 5);
    } catch (e) {
      console.warn(`audio: ambient unavailable (${url}) — continuing silent`, e);
    }
  }

  // Ramp the ambient bed to a target level. cancelScheduledValues + an anchor
  // at the current value first, otherwise a ramp scheduled mid-ramp jumps.
  _rampAmbient(target, seconds) {
    if (!this.ambientGain) return;
    if (!this.ambientEnabled) target = 0;
    const g = this.ambientGain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(target, now + seconds);
  }

  // Synthesize the three voice slots in one go (slot1 first — it plays
  // mid-reveal and matters most). Returns playable blob URLs.
  async synthesizeAll(scripts, lang) {
    return Promise.all(scripts.map((text) =>
      fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, lang }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(`tts ${r.status}`);
          return r.blob();
        })
        .then((b) => URL.createObjectURL(b)),
    ));
  }

  // Single-turn fallback: "I didn't quite catch that" as a local file, played
  // when one conversation turn's pipeline (STT/Claude/TTS) fails. Same
  // ElevenLabs voice as everything else, generated offline — so even failure
  // stays in character with zero network dependency.
  oneFallback() {
    return "./resources/audio/one_fallback.mp3";
  }

  // English fallback when the AI pipeline fails — static pre-recorded files,
  // no network dependency. playVoice() warns and skips any that are missing.
  async synthesizeFallback() {
    return [
      "./resources/audio/fallback_1.mp3",
      "./resources/audio/fallback_2.mp3",
      "./resources/audio/fallback_3.mp3",
    ];
  }

  // Play one voice slot. Resolves when playback finishes (session.js uses
  // this to bracket the orb's speaking pulse), and resolves immediately on
  // any failure so the state machine can never hang on a missing file.
  async playVoice(url) {
    if (!url || !this.ctx) return;

    this._rampAmbient(DUCKED_LEVEL, 1.0);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());

      await new Promise((resolve) => {
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const g = this.ctx.createGain();
        g.gain.value = VOICE_LEVEL;
        src.connect(g).connect(this.ctx.destination);
        src.onended = resolve;
        src.start();
      });
    } catch (e) {
      console.warn(`audio: voice unavailable (${url}) — skipping`, e);
    } finally {
      this._rampAmbient(AMBIENT_LEVEL, 2.0);  // bed swells back after speech
    }
  }
}
