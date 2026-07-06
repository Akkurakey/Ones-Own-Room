// The threshold — a voice-guided check-in that replaces any conventional
// start menu (design.md Step 5). Same-page DOM overlay, never a separate
// page: the AudioContext unlocked at "touch to begin" must survive into VR,
// and a navigation would destroy it.
//
// The overlay is transparent on purpose. What the user is looking at the
// whole time is the REAL metal orb rendering in the canvas behind it — she
// is the same presence from the first second of the title screen. DOM only
// carries type and inputs.
//
// Everything here is a sequence of "you may give less" choices:
//   name     — "I don't need a name here"
//   scales   — quick pictorial picks, no words
//   mood     — "not today" skips it; typing replaces speaking
// The ENTER pill only condenses once every step is RESOLVED (answered or
// explicitly declined) — it is earned, not waited for.

const GUIDE = {
  welcome: "./resources/audio/guide_welcome.mp3",
  name: "./resources/audio/guide_name.mp3",
  valence: "./resources/audio/guide_valence.mp3",
  arousal: "./resources/audio/guide_arousal.mp3",
  mood: "./resources/audio/guide_mood.mp3",
};

export function createThreshold({ audio, orb, voice, onEnter, onFirstTouch }) {
  const root = document.getElementById("threshold");

  // With the threshold shown as a WebXR dom-overlay, a controller trigger
  // aimed at it must act as a DOM pointer only — preventDefault here stops
  // the same squeeze from also firing the session's XR select (which main.js
  // maps to voice.press for in-room turns).
  root.addEventListener("beforexrselect", (e) => e.preventDefault());
  const veil = document.getElementById("t-veil");
  const screens = {
    title: document.getElementById("t-title"),
    name: document.getElementById("t-name"),
    valence: document.getElementById("t-valence"),
    arousal: document.getElementById("t-arousal"),
    mood: document.getElementById("t-mood"),
    enter: document.getElementById("t-enter"),
  };

  // The check-in record. null name / null moodText are legitimate answers,
  // not missing data — the whole threshold is built around that distinction.
  const inputs = { name: null, valence: null, arousal: null, moodText: null, lang: null };
  let unlocked = false;
  let done = false;

  // The threshold owns the page from the first frame: title fades in over
  // the void where only the metal orb hangs. rAF so the browser paints the
  // opacity-0 state first — otherwise the 1.4 s condense-in never animates.
  requestAnimationFrame(() => show("title"));

  function show(name) {
    for (const [k, el] of Object.entries(screens)) {
      el.classList.toggle("active", k === name);
    }
    // The orb steps back behind a veil only while the scales are up.
    veil.classList.toggle("on", name === "valence" || name === "arousal");
  }

  // Guide lines play through the same playVoice path as her AI speech —
  // same ducking, same speaking pulse. She is one person throughout.
  async function speak(url) {
    orb.setSpeaking(true);
    try {
      await audio.playVoice(url);
    } finally {
      orb.setSpeaking(false);
    }
  }

  // ---------- Screen 0: title ----------
  // The tap is load-bearing: browsers allow no sound before a gesture, so
  // this is where the AudioContext unlocks (Enter's gesture stays light).
  screens.title.addEventListener("click", async () => {
    if (unlocked) return;
    unlocked = true;
    // Immersive threshold: the session request must ride THIS gesture, so it
    // fires before any await; audio unlock shares the same activation.
    // When it succeeds the system keyboard can no longer appear, so the
    // .immersive class hides the typing affordances (voice/skip remain).
    Promise.resolve(onFirstTouch?.()).then((ok) => {
      if (ok) root.classList.add("immersive");
    });
    await audio.unlock();
    await speak(GUIDE.welcome);
    show("name");
    speak(GUIDE.name);
  });

  // ---------- Screen 1: name ----------
  const nameInput = document.getElementById("t-name-input");
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && nameInput.value.trim()) {
      inputs.name = nameInput.value.trim();
      toScales();
    }
  });
  document.getElementById("t-noname").addEventListener("click", () => {
    inputs.name = null;
    toScales();
  });

  function toScales() {
    nameInput.blur();
    show("valence");
    // The manikins carry no text labels, so her question IS the explanation.
    speak(GUIDE.valence);
  }

  // ---------- Screen 2: SAM scales ----------
  // Redrawn line manikins (SAM semantics, project visual language): valence
  // runs frown → smile, arousal runs still → vibrating. No text labels —
  // the figures carry the meaning (design.md Step 5.5).
  buildRow("t-valence-row", samValence, (v) => {
    inputs.valence = v;
    setTimeout(() => {
      show("arousal");
      speak(GUIDE.arousal);
    }, 450);   // let the pick's glow register
  });
  buildRow("t-arousal-row", samArousal, (v) => {
    inputs.arousal = v;
    setTimeout(() => {
      show("mood");
      speak(GUIDE.mood);
    }, 450);
  });

  function buildRow(id, drawFn, onPick) {
    const row = document.getElementById(id);
    for (let i = 1; i <= 5; i++) {
      const opt = document.createElement("div");
      opt.className = "sam-opt";
      opt.innerHTML = drawFn(i);
      opt.addEventListener("click", () => {
        for (const sib of row.children) sib.classList.remove("picked");
        opt.classList.add("picked");
        onPick(i);
      });
      row.appendChild(opt);
    }
  }

  // ---------- Screen 3: mood ----------
  // Hold-to-speak, identical to the in-room gesture — the user learns the
  // room's one and only interaction before they enter it. Mic permission is
  // requested inside this first hold (the permission dialog interrupts the
  // hold, so the hint asks for a fresh one afterwards).
  const moodScreen = screens.mood;
  const moodHint = document.getElementById("t-mood-hint");
  let micReady = false;
  let recording = false;

  moodScreen.addEventListener("pointerdown", async (e) => {
    // Buttons and the textarea keep their own meanings.
    if (e.target.closest("button, textarea")) return;
    if (moodScreen.classList.contains("typing") || done) return;

    if (!micReady) {
      moodHint.textContent = "the room would like to hear you…";
      try {
        await voice.init(audio.ctx);
        micReady = true;
        moodHint.textContent = "now — press and hold, speak, let go";
      } catch (err) {
        console.warn("threshold: mic denied — falling back to typing", err);
        toTyping();
      }
      return;   // permission dialog ate this hold; ask for a fresh one
    }

    if (recording) return;
    recording = true;
    voice.press();
    orb.setRecording(true);
    moodHint.textContent = "…";
    let clip = null;
    try {
      clip = await voice.recordWhileHeld();   // resolves when they let go
    } finally {
      orb.setRecording(false);
      recording = false;
    }
    if (!clip || clip.ms < 350) {
      moodHint.textContent = "press and hold anywhere, speak, let go";
      return;
    }

    moodHint.textContent = "the room is listening back…";
    orb.setWaiting(true);
    try {
      inputs.moodText = await voice.transcribe(clip.blob);
      // The language they spoke at the door decides the opening's language
      // outright — more deterministic than re-guessing from the transcript.
      inputs.lang = voice.lastLang ?? null;
    } finally {
      orb.setWaiting(false);
    }
    toEnter();
  });

  // "not today" — skipping the mood is a first-class answer; the opening
  // becomes the context-free version.
  document.getElementById("t-nottoday").addEventListener("click", () => {
    inputs.moodText = null;
    toEnter();
  });

  // Keyboard escape hatch.
  const moodText = document.getElementById("t-mood-text");
  document.getElementById("t-keyboard").addEventListener("click", toTyping);
  function toTyping() {
    moodScreen.classList.add("typing");
    moodHint.textContent = "";
    moodText.focus();
  }
  document.getElementById("t-mood-done").addEventListener("click", () => {
    inputs.moodText = moodText.value.trim() || null;
    toEnter();
  });

  // ---------- Screen 4: automatic entry ----------
  // The ENTER pill was cut after headset testing — once the check-in is
  // resolved, the extra tap added nothing, so entry is automatic. The pill
  // survives in the DOM as a lifeboat only: requestSession/getUserMedia need
  // transient user activation, and on the spoken path the transcription
  // round-trip can outlive that window. If onEnter throws, un-fade and
  // surface the pill to collect one fresh gesture, then retry.
  async function toEnter() {
    if (done) return;
    done = true;
    root.classList.add("gone");
    try {
      await onEnter({ ...inputs });
      // Overlay dissolves into the same void the world will bloom out of.
      // display:none (not remove) — when the threshold ran as a WebXR
      // dom-overlay the session keeps referencing the root element.
      setTimeout(() => { root.style.display = "none"; }, 1600);
    } catch (e) {
      console.warn("threshold: auto-enter failed — surfacing ENTER for a fresh gesture", e);
      done = false;
      root.classList.remove("gone");
      show("enter");
    }
  }

  document.getElementById("t-enter-btn").addEventListener("click", () => toEnter());

  // Dev shortcut (wired to a key in main.js under ?debug): fill everything
  // and go straight in — the threshold is a one-time flow, and room-side
  // work shouldn't cost a full check-in per reload.
  async function skip(moodText = "just tired today, I want somewhere quiet") {
    if (done) return;
    done = true;
    if (!unlocked) {
      unlocked = true;
      await audio.unlock();
    }
    Object.assign(inputs, { name: null, valence: 3, arousal: 3, moodText });
    root.classList.add("gone");
    setTimeout(() => { root.style.display = "none"; }, 1600);
    await onEnter({ ...inputs });
  }

  return { inputs, skip };
}

// ---------- SAM manikins ----------
// Minimal line figures on a 64x88 viewBox: circle head, hairline body.
// Valence: the mouth curve walks from frown to smile (5-point semantics
// faithful to Bradley & Lang; the drawing style is ours).
function samValence(i) {
  const k = (i - 3) / 2;                       // -1 … 1
  const mouthY = 27.5;
  const mouth = `M 26.5 ${mouthY} Q 32 ${mouthY + 5 * k} 37.5 ${mouthY}`;
  return `
  <svg viewBox="0 0 64 88" xmlns="http://www.w3.org/2000/svg">
    <circle cx="32" cy="24" r="11"/>
    <line x1="27.5" y1="21" x2="27.5" y2="22.5"/>
    <line x1="36.5" y1="21" x2="36.5" y2="22.5"/>
    <path d="${mouth}"/>
    <line x1="32" y1="35" x2="32" y2="60"/>
    <path d="M 32 42 L 22 52"/>
    <path d="M 32 42 L 42 52"/>
    <path d="M 32 60 L 25 74"/>
    <path d="M 32 60 L 39 74"/>
  </svg>`;
}

// Arousal: same neutral figure; energy shows as vibration arcs closing in
// around it — none at rest, a charged field at full stir.
function samArousal(i) {
  const arcs = [];
  for (let a = 1; a < i; a++) {
    const r = 14 + a * 5.5;
    const sweep = 0.55 + a * 0.1;              // arcs widen as energy rises
    const y = 30;
    const x1 = 32 - Math.sin(sweep) * r, y1 = y - Math.cos(sweep) * r * 0.4;
    const x2 = 32 - Math.sin(sweep) * r, y2 = y + Math.cos(sweep) * r * 0.4;
    arcs.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${(32 - r * 1.15).toFixed(1)} ${y} ${x2.toFixed(1)} ${y2.toFixed(1)}"/>`);
    arcs.push(`<path d="M ${(64 - x1).toFixed(1)} ${y1.toFixed(1)} Q ${(32 + r * 1.15).toFixed(1)} ${y} ${(64 - x2).toFixed(1)} ${y2.toFixed(1)}"/>`);
  }
  return `
  <svg viewBox="0 0 64 88" xmlns="http://www.w3.org/2000/svg">
    <circle cx="32" cy="24" r="11"/>
    <line x1="27.5" y1="21" x2="27.5" y2="22.5"/>
    <line x1="36.5" y1="21" x2="36.5" y2="22.5"/>
    <path d="M 27 28 L 37 28"/>
    <line x1="32" y1="35" x2="32" y2="60"/>
    <path d="M 32 42 L 22 52"/>
    <path d="M 32 42 L 42 52"/>
    <path d="M 32 60 L 25 74"/>
    <path d="M 32 60 L 39 74"/>
    ${arcs.join("\n    ")}
  </svg>`;
}
