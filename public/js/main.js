import * as THREE from "three";
import { SplatMesh, SparkRenderer } from "@sparkjsdev/spark";
import { setupEffects } from "./effects.js";
import { createGlowDust } from "./glow.js";
import { createOrb } from "./orb.js";
import { SessionTimeline } from "./session.js";
import { AudioManager } from "./audio.js";
import { VoiceRecorder } from "./voice.js";
import { createThreshold } from "./threshold.js";

// Append ?debug to the URL to enable first-person controls and splat-repositioning keys.
const qp = new URLSearchParams(location.search);
const DEBUG = qp.has("debug");

// Numeric URL overrides for render/comfort tunables (?lift=0.4&glow=0&sort32=1…).
// Always active, not ?debug-gated: absent params fall through to the shipped
// defaults, and in-headset A/B iteration must not require code redeploys.
const num = (k, d) => {
  const v = parseFloat(qp.get(k));
  return Number.isFinite(v) ? v : d;
};
const JIGGLE = num("jiggle", 0) > 0;

// ---------- Renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setFoveation(1.0);   // edge foveation saves ~15–25% fill-rate on Quest
// 0.85² ≈ 28% fewer pixels per eye. Splats are soft gaussians, so the
// resolution loss is near-invisible while the fill-rate saving is not.
// Must be set before the session starts — it is baked into the XR layer.
renderer.xr.setFramebufferScaleFactor(num("fb", 0.85));
document.body.appendChild(renderer.domElement);

// ---------- Scene + camera rig ----------
const scene = new THREE.Scene();
// Matches the UI token --room-bg so the threshold overlay dissolves
// seamlessly into the pre-reveal void.
scene.background = new THREE.Color(0x0b0b14);

const camera = new THREE.PerspectiveCamera(
  70, window.innerWidth / window.innerHeight, 0.05, 1000
);

// The rig is the object we move to reposition the user in the world.
// In VR the headset owns the camera transform each frame, so camera must never
// be moved directly — always move the rig instead.
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

// Desktop eye height: local-floor XR provides real eye height automatically,
// so we drop the rig to the lift offset on session start and restore desktop
// height on session end. The lift raises the viewpoint slightly above true
// standing height — the room reads more open that way (headset feedback).
const DESKTOP_EYE_HEIGHT = 1.6;
const XR_RIG_LIFT = num("lift", 0.26);
rig.position.y = DESKTOP_EYE_HEIGHT;
renderer.xr.addEventListener("sessionstart", () => { rig.position.y = XR_RIG_LIFT; });
renderer.xr.addEventListener("sessionend", () => { rig.position.y = DESKTOP_EYE_HEIGHT; });

// ---------- Splat ----------
// Explicit SparkRenderer instead of Spark's auto-created default, so the
// splat cost knobs can sit below their defaults (maxStdDev √8, radius 512).
// Splats are drawn as alpha-blended quads: shrinking each quad's footprint
// attacks overdraw, the dominant cost on Quest.
const spark = new SparkRenderer({
  renderer,
  maxStdDev: Math.sqrt(num("std", 5)),   // quad area ≈ -37% vs default √8; tails are invisible anyway
  maxPixelRadius: num("mpr", 256),       // cap the screen footprint of huge near-camera splats
  minAlpha: num("ma", 2) / 255,          // skip fragments that cannot survive 8-bit output
  // Diagnostic (?sort32=1): 32-bit sort precision vs packed 16-bit pairs.
  // Tried as a fix for the VR texture flicker (2026-07) — did not resolve it,
  // so it stays off by default; the flicker investigation is paused.
  sort32: num("sort32", 0) > 0,
});
scene.add(spark);

const splat = new SplatMesh({ url: "./resources/worlds/env_3.spz" });
splat.position.y = 0.4;
splat.rotation.y = 0;
scene.add(splat);

// ---------- Modules ----------
const audio = new AudioManager();
window._audio = audio;             // live testing: _audio.playVoice("./resources/audio/x.mp3")
const effects = setupEffects(splat);
window._fx = effects;              // live tuning: _fx.uniforms.uScale.value = 1.7
// The threshold is the entry now, so the page opens on the pre-reveal void:
// black nothing + the metal orb. (uReveal's shader default of 1 exists for
// bare-scene tuning; force it back to 1 from the console when needed.)
effects.uniforms.uReveal.value = 0;
// ?glow=0 kills the glow layer's scale boost — the prime suspect for the
// "dark details shimmer" artifact (bright neighbours swelling with the drift
// wave alternately cover and uncover small dark features like door handles).
effects.uniforms.uGlow.value *= num("glow", 1);
// ?bump=1: updateVersion every frame instead of every other — diagnostic for
// whether the 36 Hz stepping of the glow's colour drift reads as flicker in VR.
effects.bumpEveryFrame = num("bump", 0) > 0;
// ?skel=0 restores the classic pure-black void (skeleton premonition off).
effects.uniforms.uSkeleton.value = num("skel", 1);
// 120 (down from the 180 default): additive sprites are pure fill-rate, and
// a third fewer is indistinguishable in-headset while buying frame budget.
const dust = createGlowDust(scene, num("dust", 120));
const orb = createOrb(scene);
window._orb = orb;                 // live tuning: _orb.setState(1), _orb.setThinking(true)
const voice = new VoiceRecorder();
window._voice = voice;             // dev: _voice.getMicLevel(), _voice.heldDown()
const timeline = new SessionTimeline({ scene, camera, splat, audio, effects, orb, voice });
window._session = timeline;        // dev mood input: _session.submitMood("...")

// ---------- Hold-to-talk input edge ----------
// Desktop: hold the pointer anywhere on the canvas (design.md: the forgiving
// hit target — holding the screen counts as holding the orb). VR: controller
// trigger hold. session.js polls voice.heldDown() and ignores taps < 350 ms,
// so the ?debug click that re-acquires pointer lock never triggers a turn.
renderer.domElement.addEventListener("pointerdown", () => {
  if (!renderer.xr.isPresenting) voice.press();
});
// Release on window, not canvas: the pointer may leave the canvas mid-hold.
window.addEventListener("pointerup", () => voice.release());
for (const i of [0, 1]) {
  const controller = renderer.xr.getController(i);
  controller.addEventListener("selectstart", () => voice.press());
  controller.addEventListener("selectend", () => voice.release());
  rig.add(controller);   // controllers ride the rig like the camera does
}

// Debug-key state target: the orb's A→B crossfade is meant to be driven with
// an eased ramp by session.js; for desktop testing the loop lerps toward this.
let orbStateTarget = null;
let orbState = 0;

// ---------- Reusable movement vectors — module scope, never allocated per frame ----------
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);

// ---------- DEBUG: first-person controls (desktop only) ----------
// PointerLockControls handles mouse look (yaw + pitch) on the camera.
// WASD movement translates the rig so VR positioning stays correct.
// Arrow keys adjust splat offset/rotation for scene alignment.
//
// Key map (no Shift required for anything):
//   Mouse drag  — look around (after clicking canvas to acquire lock)
//   W / S       — move forward / backward
//   A / D       — strafe left / right
//   ↑ / ↓       — splat Y offset (align floor)
//   ← / →       — splat rotation Y (align orientation)
//
// All handlers early-return when renderer.xr.isPresenting — the headset
// owns input in XR. No global keyboard suppression so text input stays
// possible for future features.

const keys = new Set();  // currently held WASD keys

// Debug key handlers must never eat keystrokes meant for the threshold's
// name / mood text fields.
const isTyping = (e) => /^(INPUT|TEXTAREA)$/.test(e.target?.tagName ?? "");

if (DEBUG) {
  const { PointerLockControls } =
    await import("three/addons/controls/PointerLockControls.js");

  const fpControls = new PointerLockControls(camera, renderer.domElement);

  renderer.domElement.addEventListener("click", () => {
    if (!renderer.xr.isPresenting) fpControls.lock();
  });

  // WASD: track key state, XR-gated.
  const MOVE_KEYS = new Set(["w", "a", "s", "d"]);
  window.addEventListener("keydown", (e) => {
    if (renderer.xr.isPresenting || isTyping(e)) return;
    if (MOVE_KEYS.has(e.key.toLowerCase())) keys.add(e.key.toLowerCase());
  });
  window.addEventListener("keyup", (e) => {
    if (renderer.xr.isPresenting) return;
    keys.delete(e.key.toLowerCase());
  });

  // Arrow keys: splat repositioning, XR-gated.
  // X-axis offset removed: WASD walking covers horizontal placement.
  window.addEventListener("keydown", (e) => {
    if (renderer.xr.isPresenting || isTyping(e)) return;
    if (e.key === "ArrowUp") splat.position.y -= 0.1;
    else if (e.key === "ArrowDown") splat.position.y += 0.1;
    else if (e.key === "ArrowLeft") splat.rotation.y -= Math.PI / 12;
    else if (e.key === "ArrowRight") splat.rotation.y += Math.PI / 12;
    else return;
  });

  // Orb state testing (temporary until session.js owns the state machine):
  //   1 — listening (metal)      2 — toggle speaking pulse
  //   3 — companion (fast ~2 s)  4 — toggle waiting loop
  let orbSpeaking = false;
  let orbWaiting = false;
  window.addEventListener("keydown", (e) => {
    if (renderer.xr.isPresenting || isTyping(e)) return;
    if (e.key === "1") orbStateTarget = 0;
    else if (e.key === "2") { orbSpeaking = !orbSpeaking; orb.setSpeaking(orbSpeaking); }
    else if (e.key === "3") orbStateTarget = 1;
    else if (e.key === "4") { orbWaiting = !orbWaiting; orb.setWaiting(orbWaiting); }
  });

  // XR session: release lock and disable desktop input handlers.
  // keys.clear() prevents stuck-key drift when returning to desktop.
  renderer.xr.addEventListener("sessionstart", () => {
    document.exitPointerLock();
    fpControls.enabled = false;
    keys.clear();
  });
  renderer.xr.addEventListener("sessionend", () => {
    fpControls.enabled = true;
    rig.position.y = DESKTOP_EYE_HEIGHT;
  });
}

// ---------- Ambient toggle (bottom-right) ----------
const ambientBtn = document.getElementById("ambient-toggle");
ambientBtn.onclick = () => {
  const on = audio.toggleAmbient();
  ambientBtn.textContent = on ? "\u{1F50A}" : "\u{1F507}";
};

// ---------- Threshold → session handoff ----------
// One sentence about THIS pre-generated world's light and character, fed to
// the persona as context (design.md Step 10). In the demo the visuals never
// follow the user's mood, so her words must describe what is actually there.
// MUST be re-written whenever env_*.spz is swapped — a stale profile makes
// her describe a room the user cannot see (caught on-device 2026-07: she
// spoke of pool water while the splat showed this bedroom).
const ROOM_PROFILE =
  "A quiet bedroom in soft lavender dusk: a tall double door, a small lamp glowing warm beside the bed, every edge softened by haze, nothing stirring.";

// navigator.xr is absent on some older browsers; ?? coalesces to a resolved
// false so the threshold always works rather than silently throwing.
(navigator.xr?.isSessionSupported("immersive-vr") ?? Promise.resolve(false))
  .then((vrOk) => {
    // Immersive threshold (dom-overlay spike): requested at "touch to begin",
    // inside that first gesture, so the whole check-in floats in the black
    // void + orb + skeleton instead of a browser window in the Quest home.
    // If the browser grants the session but not the overlay, the DOM would be
    // invisible in-headset and the user stranded — end it and stay 2D; the
    // classic enter-VR-at-the-end path below still works unchanged.
    async function startImmersiveThreshold() {
      // Spike verdict (2026-07, Quest 3): Meta Quest Browser does not
      // implement dom-overlay for immersive sessions (the spec and desktop
      // Chrome do; even Meta's own emulator does). Requesting anyway costs a
      // permission prompt that then visibly does nothing, so the attempt is
      // gated behind ?imth=1 until Phase B (3D-built threshold) replaces it.
      if (!vrOk || !(num("imth", 0) > 0)) return false;
      try {
        const session = await navigator.xr.requestSession("immersive-vr", {
          optionalFeatures: ["local-floor", "bounded-floor", "dom-overlay"],
          domOverlay: { root: document.getElementById("threshold") },
        });
        if (!session.domOverlayState) {
          console.warn("threshold: no dom-overlay support — staying on the 2D page");
          await session.end();
          return false;
        }
        renderer.xr.setSession(session);
        console.log("threshold: immersive dom-overlay active,",
          session.domOverlayState.type);
        return true;
      } catch (e) {
        console.warn("threshold: immersive threshold unavailable", e);
        return false;
      }
    }

    const threshold = createThreshold({
      audio,
      orb,
      voice,
      onFirstTouch: startImmersiveThreshold,
      onEnter: async (inputs) => {
        // Mic may still be unrequested (typed / "not today" paths skipped the
        // hold) — ask now, inside the ENTER gesture, before the VR session
        // starts so the dialog never appears mid-immersion. Denial is not
        // fatal: holding the orb just does nothing (solitude by default).
        if (!voice.stream) {
          try {
            await voice.init(audio.ctx);
          } catch (e) {
            console.warn("mic unavailable — conversation turns disabled", e);
          }
        }

        // Already presenting when the dom-overlay threshold succeeded — the
        // same session carries straight into the room, no second transition.
        if (vrOk && !renderer.xr.isPresenting) {
          const session = await navigator.xr.requestSession("immersive-vr", {
            optionalFeatures: ["local-floor", "bounded-floor"],
          });
          renderer.xr.setSession(session);
        }

        timeline.start({ ...inputs, roomProfile: ROOM_PROFILE });
      },
    });
    window._threshold = threshold;   // dev: _threshold.skip("mood text")

    // Debug shortcut: key 0 fills the whole check-in and enters immediately —
    // room-side iteration shouldn't cost a full threshold walk per reload.
    // (keydown counts as a user gesture, so audio can unlock from it.)
    if (DEBUG) {
      window.addEventListener("keydown", (e) => {
        if (e.key === "0" && !isTyping(e)) threshold.skip();
      });
    }
  });

// ---------- Main loop ----------
// Must use setAnimationLoop — requestAnimationFrame does not fire inside a
// WebXR session (the headset drives its own frame cadence at 72/90 Hz).
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  // ?jiggle=1 (desktop only): synthetic head micro-motion — millimetre sway +
  // sub-degree yaw at incommensurate frequencies. In VR the head never stops
  // moving, which keeps Spark re-sorting every frame; a static desktop camera
  // never triggers that machinery, so VR-only artifacts (sort popping) hide
  // from desktop testing. This reproduces the modulator so temporal frame
  // diffs can measure the flicker without a headset.
  if (!renderer.xr.isPresenting && JIGGLE) {
    rig.position.x = Math.sin(elapsed * 5.1) * 0.015;
    rig.position.z = Math.sin(elapsed * 4.3) * 0.012;
    rig.rotation.y = Math.sin(elapsed * 3.7) * 0.02;
  }

  // First-person rig movement — desktop only.
  // renderer.xr.isPresenting is the authoritative guard; the key handlers
  // also gate on it, but checking here too means a race between sessionstart
  // and a keydown can never produce a rogue rig translation in XR.
  if (!renderer.xr.isPresenting && keys.size > 0) {
    camera.getWorldDirection(_forward);
    _forward.y = 0;
    _forward.normalize();
    _right.crossVectors(_forward, _worldUp).normalize();

    const speed = 3.0;  // m/s
    if (keys.has("w")) rig.position.addScaledVector(_forward, speed * dt);
    if (keys.has("s")) rig.position.addScaledVector(_forward, -speed * dt);
    if (keys.has("a")) rig.position.addScaledVector(_right, -speed * dt);
    if (keys.has("d")) rig.position.addScaledVector(_right, speed * dt);
  }

  effects.update(elapsed);
  // Dust visibility rides the reveal: none in the pre-reveal black, fading
  // in as the world condenses. (uReveal defaults to 1 for desktop tuning.)
  dust.update(elapsed, 0, effects.uniforms.uReveal.value);

  // Smooth A→B ramp for the debug keys — rate 1.5/s reaches ~95% in 2 s,
  // matching the fast transform session.js drives on "response ready".
  // Disabled while a session runs so the keys can't fight the state machine.
  if (orbStateTarget !== null && !timeline.running) {
    orbState += (orbStateTarget - orbState) * Math.min(dt * 1.5, 1);
    orb.setState(orbState);
  }
  // The orb's recording glow rides the live mic level; outside a hold the
  // level is forced to zero so ambient room noise never makes it shimmer.
  orb.setMicLevel(voice.heldDown() ? voice.getMicLevel() : 0);
  orb.update(dt);

  timeline.update(dt);

  // The explicit SparkRenderer above handles sorting + updating splats
  // automatically — no manual updateGenerator() needed.
  renderer.render(scene, camera);
});

// ---------- Resize (desktop only; VR resolution is headset-controlled) ----------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
