// Event-driven session orchestration — the heart of the experience.
//
// A state machine, not a timeline: idle → listening → waiting → revealing →
// settled. The reveal is gated on the "AI response ready" EVENT — never on a
// timer. Between the user giving their mood and the world condensing sits an
// unpredictable 3–10 s pipeline (STT → Claude → TTS), and the orb's waiting
// loop covers exactly that gap, however long it takes.
//
// settled is the resting state, and she never speaks unprompted from it.
// Holding the orb starts a turn (record → STT → Claude → TTS → she replies);
// leaving it alone is solitude. Each turn is an independent LLM call — her
// forgetting is deliberate (design.md Step 11).
//
// All timing accumulates dt from the render loop, so taking the headset off
// (or backgrounding the tab) pauses the whole session instead of skipping
// ahead.
export class SessionTimeline {
  constructor({ scene, camera, splat, audio, effects, orb, voice }) {
    this.audio = audio;
    this.effects = effects;
    this.orb = orb;
    this.voice = voice;

    this.state = "idle";
    this.running = false;
    this.elapsed = 0;

    this.inputs = null;
    this.audioUrls = [];
    this.responseReady = false;
    this.stubWait = null;     // { t, target } while simulating AI latency
    this.orbRampT = null;     // 0..1 during the fast A→B transform

    this._turnBusy = false;   // one conversation turn at a time
    this._speaking = false;   // her voice is playing — holding the orb waits

    // Researcher session record (design.md Step 14) — the OTHER data line,
    // separate from what the model sees. Transcripts only, never audio.
    this.log = [];
  }

  // Called from the enter-VR gesture. The world withdraws to black the moment
  // the session owns it; only the orb (and the ambient bed) remain.
  start(inputs = {}) {
    this.inputs = inputs;
    this.running = true;
    this.state = "listening";
    this.effects.uniforms.uReveal.value = 0;
    this.orb.setState(0);
    // Coming from the threshold, the pipeline always runs — "not today"
    // (moodText: null) still gets an opening, just the context-free version.
    // A bare start() (dev console flow) stays in listening until submitMood.
    if ("moodText" in inputs) this.submitMood(inputs.moodText ?? "");
  }

  // The single entry point for mood input, whatever the source: threshold
  // overlay text, voice transcription, or the console during dev.
  submitMood(text) {
    if (this.state !== "listening") return;
    this.state = "waiting";
    this.orb.setWaiting(true);
    this._runPipeline(text);
  }

  // One function, two paths with identical shape: the real pipeline when the
  // serverless endpoints are reachable (deployed / dev-server), and fallback
  // scripts plus a simulated wait when they're not (plain npx serve).
  // Deploying changes behaviour, not code.
  async _runPipeline(moodText) {
    try {
      const r = await this._generate({ need: moodText, opening: true });
      this.audioUrls = await this.audio.synthesizeAll(r.scripts, r.lang);
      this.responseReady = true;   // consumed by update() — the ignition event
    } catch (e) {
      console.warn("session: AI pipeline unavailable — fallback + simulated latency", e);
      this.audioUrls = await this.audio.synthesizeFallback();
      // The stub wait ticks in update(dt) rather than setTimeout, so the
      // fake latency pauses with the headset exactly like the real session.
      this.stubWait = { t: 0, target: 3 + Math.random() * 5 };
    }
  }

  // Shared request shape for opening and turns. valence/arousal/roomProfile
  // ride along as context for the persona (they drive no visuals in the demo).
  async _generate({ need, opening }) {
    const r = await fetch("/api/generate-script", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: this.inputs.name ?? "",
        need,
        valence: this.inputs.valence ?? null,
        arousal: this.inputs.arousal ?? null,
        roomProfile: this.inputs.roomProfile ?? "",
        opening,
      }),
    });
    if (!r.ok) throw new Error(`generate-script ${r.status}`);
    return r.json();
  }

  // The "response ready" ignition: orb melts into glass (~2 s, driven in
  // update) while the world condenses outward from it — one motion, two faces.
  _ignite() {
    this.responseReady = false;
    this.stubWait = null;
    this.state = "revealing";
    this.orb.setWaiting(false);
    this.orbRampT = 0;
    this.effects.playReveal().then(() => {
      this.state = "settled";
      this._speak(this.audioUrls[0]);   // entry voice lands as the world finishes forming
    });
  }

  // One conversation turn: hold the orb to record → release → STT → Claude →
  // TTS → she replies. Turns are mutually exclusive (_turnBusy), and settled
  // is permanent — not holding the orb is simply solitude.
  async _turn() {
    this._turnBusy = true;
    this.orb.setRecording(true);
    let clip = null;
    try {
      // update() saw heldDown() already true, so recordWhileHeld starts from
      // the in-progress press rather than waiting for a new one.
      clip = await this.voice.recordWhileHeld();
    } catch (e) {
      console.warn("session: recording unavailable", e);
    } finally {
      this.orb.setRecording(false);
    }

    // A tap, not a hold (e.g. the click that re-acquires pointer lock in
    // ?debug) — quietly not a turn. She only answers when spoken to.
    if (!clip || clip.ms < 350) {
      this._turnBusy = false;
      return;
    }

    this.orb.setWaiting(true);           // "received — thinking about it"
    let text = "";
    let replyUrl;
    try {
      text = await this.voice.transcribe(clip.blob);
      const r = await this._generate({ need: text, opening: false });
      replyUrl = (await this.audio.synthesizeAll([r.scripts[0]], r.lang))[0];
    } catch (e) {
      // In-character recovery: a local pre-recorded "I didn't quite catch
      // that" — she never surfaces an error tone.
      console.warn("session: turn pipeline failed — oneFallback", e);
      replyUrl = this.audio.oneFallback();
    }
    this.orb.setWaiting(false);
    await this._speak(replyUrl);

    this._logTurn(text);
    this._turnBusy = false;
  }

  // Play one voice clip bracketed by the orb's speaking pulse. playVoice
  // resolves on playback end (or immediately on failure), so the pulse can
  // never be left running.
  async _speak(url) {
    if (!url) return;
    this._speaking = true;
    this.orb.setSpeaking(true);
    try {
      await this.audio.playVoice(url);
    } finally {
      this.orb.setSpeaking(false);
      this._speaking = false;
    }
  }

  // Researcher record: transcript only — the audio clip is already gone by
  // the time this runs (design.md Step 14: never store voice).
  _logTurn(text) {
    this.log.push({ t: Math.round(this.elapsed), need: text });
  }

  update(dt) {
    if (!this.running) return;
    this.elapsed += dt;

    if (this.state === "waiting") {
      if (this.stubWait) {
        this.stubWait.t += dt;
        if (this.stubWait.t >= this.stubWait.target) this._ignite();
      } else if (this.responseReady) {
        this._ignite();
      }
    }

    // Fast A→B transform: ~2 s quadratic ease-out. Deliberately quicker than
    // the reveal — the orb turns to light first, the world follows from it.
    if (this.orbRampT !== null) {
      this.orbRampT = Math.min(this.orbRampT + dt / 2.0, 1);
      this.orb.setState(this.orbRampT * (2 - this.orbRampT));
      if (this.orbRampT >= 1) this.orbRampT = null;
    }

    // The turn trigger: user is holding the orb while the room is settled and
    // she is neither mid-turn nor mid-sentence. Polled here (not event-driven)
    // so the same gate works for desktop pointer and VR trigger alike.
    if (
      this.state === "settled" &&
      !this._turnBusy &&
      !this._speaking &&
      this.voice?.heldDown()
    ) {
      this._turn();
    }
  }
}
