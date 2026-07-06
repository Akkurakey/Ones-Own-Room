// Hold-to-record voice input: mic permission + MediaRecorder + per-frame
// level for the orb, plus STT via /api/stt.
//
// Layering: press()/release() are the INPUT edge — main.js wires them to
// desktop pointer events and VR controller triggers. session.js polls
// heldDown() in its update loop and, when a turn may begin, calls
// recordWhileHeld(), which starts recording from the already-in-progress
// press and resolves when the user lets go. The recorder never decides
// whether a turn happens — the session state machine does.
//
// Quest spike items still to verify on device (design.md Phase 6):
//   1. getUserMedia survives into an immersive-vr session
//   2. MediaRecorder: which MIME types are actually supported
//   3. mic-in-use indicator behaviour with the stream held across the session

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

export class VoiceRecorder {
  constructor() {
    this.ctx      = null;   // shared AudioContext from audio.js — never a second one
    this.stream   = null;
    this.analyser = null;
    this.recorder = null;
    this.mimeType = "";
    this._held    = false;
    this._levelBuf = null;  // reused every frame — no per-frame allocation
  }

  // Call after audio.unlock() so both share the same AudioContext.
  // Mic permission is requested here, inside the enter gesture, so the dialog
  // fires before the VR session starts — not mid-experience.
  async init(ctx) {
    this.ctx    = ctx;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    // AnalyserNode on the live stream for per-frame mic level (orb pulse).
    // Connected to analyser only — NOT to destination, so there is no feedback.
    const src     = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this._levelBuf = new Uint8Array(this.analyser.frequencyBinCount);
    src.connect(this.analyser);

    // Log which format this browser actually records — Quest may differ.
    this.mimeType = MIME_CANDIDATES.find(t => MediaRecorder.isTypeSupported(t)) ?? "";
    console.log("[voice] mimeType:", this.mimeType || "(browser default)");
  }

  // Input edge, wired by main.js (pointer down/up, XR selectstart/selectend).
  press()   { this._held = true; }
  release() {
    this._held = false;
    if (this.recorder?.state === "recording") this.recorder.stop();
  }

  heldDown() { return this._held; }

  // Returns mic amplitude 0..1. Call every frame; feed result to orb.setMicLevel().
  getMicLevel() {
    if (!this.analyser) return 0;
    this.analyser.getByteFrequencyData(this._levelBuf);
    let sum = 0;
    for (let i = 0; i < this._levelBuf.length; i++) sum += this._levelBuf[i] * this._levelBuf[i];
    const rms = Math.sqrt(sum / this._levelBuf.length);
    return Math.min(rms / 80, 1);   // 80 ≈ typical speech peak in the 0–255 range
  }

  // Start recording the in-progress press; resolves with { blob, ms } when the
  // user releases. ms lets the session tell a held utterance from a stray tap.
  recordWhileHeld() {
    if (!this.stream) return Promise.reject(new Error("voice: mic not initialised"));
    return new Promise((resolve, reject) => {
      const chunks = [];
      const t0 = performance.now();
      const opts = this.mimeType ? { mimeType: this.mimeType } : {};
      this.recorder = new MediaRecorder(this.stream, opts);
      this.recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      this.recorder.onstop = () => resolve({
        blob: new Blob(chunks, { type: this.recorder.mimeType }),
        ms: performance.now() - t0,
      });
      this.recorder.onerror = e => reject(e.error);
      this.recorder.start();
      // The press may have ended between the session's heldDown() poll and the
      // recorder actually starting — stop immediately so the promise settles.
      if (!this._held) this.recorder.stop();
    });
  }

  // STT via /api/stt (ElevenLabs scribe — detects language server-side).
  // The blob is sent RAW, not as FormData: the serverless function reads bytes
  // and builds its own multipart request, so no multipart parser is needed there.
  // On local `npx serve` (no backend) this falls back to placeholder text so
  // the rest of the pipeline still runs end-to-end.
  async transcribe(blob) {
    console.log("[voice] clip size:", blob.size, "type:", blob.type);
    try {
      const r = await fetch("/api/stt", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      if (!r.ok) throw new Error(`stt ${r.status}`);
      const { text, lang } = await r.json();
      // Detected language is kept on the side (return type stays string for
      // existing callers). The threshold reads it so the language spoken at
      // the door deterministically drives the opening's language.
      this.lastLang = lang || null;
      console.log("[voice] transcript:", text, "lang:", lang);
      return text;
    } catch {
      this.lastLang = null;
      return "I need some quiet today";   // stub: pipeline runs without a backend
    }
  }
}
