import * as THREE from "three";
import { SplatMesh, SparkRenderer } from "@sparkjsdev/spark";
import { setupEffects } from "./effects.js";
import { createGlowDust } from "./glow.js";
import { createOrb } from "./orb.js";
import { createWristMenu } from "./wristMenu.js";
import { SessionTimeline } from "./session.js";
import { AudioManager } from "./audio.js";
import { VoiceRecorder } from "./voice.js";
import { createThreshold } from "./threshold.js";
import { initConsoleClient } from "./consoleClient.js";

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
window._rig = rig;                 // debug: read .position at each wall to measure ROOM_BOUNDS

// Desktop eye height: local-floor XR provides real eye height automatically,
// so we drop the rig to the lift offset on session start and restore desktop
// height on session end. The lift raises the viewpoint slightly above true
// standing height — the room reads more open that way (headset feedback).
const DESKTOP_EYE_HEIGHT = 1.6;
const XR_RIG_LIFT = num("lift", 0.26);
rig.position.y = DESKTOP_EYE_HEIGHT;

// The first frames of an XR session can draw the splat with stale shader
// state — seen on-device (2026-07) as a full-screen flash while the session
// starts, consistent with one frame of the fully-revealed room (uReveal's
// shader default is 1). The room is a black void at that moment anyway, so
// the splat sits out the transition; the loop hands it back shortly after.
let splatGuard = 0;

renderer.xr.addEventListener("sessionstart", () => {
  rig.position.y = XR_RIG_LIFT;
  splat.visible = false;
  splatGuard = 0.5;   // seconds of session time before the splat returns
});
renderer.xr.addEventListener("sessionend", () => {
  rig.position.y = DESKTOP_EYE_HEIGHT;
  splatGuard = 0;
  splat.visible = true;
});

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

// ---------- Room registry ----------
// rooms.json is the single source of truth per pre-generated world: splat
// file + alignment, the room profile the persona speaks from, and the
// walkable bounds. ?room=<id> selects (researcher console sets it); the
// lavender bedroom stays the default.
const ROOMS = (await fetch("./rooms.json").then((r) => r.json())).rooms;
const ROOM = ROOMS.find((r) => r.id === num("room", 3)) ?? ROOMS[0];

const splat = new SplatMesh({ url: ROOM.file });
splat.position.y = ROOM.offsetY;
splat.rotation.y = ROOM.rotationY;
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
// Researcher console link (?ctl=1 + local dev-server only; dormant elsewhere).
initConsoleClient({ room: ROOM, effects, camera, timeline });

// ---------- Hold-to-talk input edge ----------
// Desktop: hold the pointer anywhere on the canvas (design.md: the forgiving
// hit target — holding the screen counts as holding the orb). VR: controller
// trigger hold. session.js polls voice.heldDown() and ignores taps < 350 ms,
// so the ?debug click that re-acquires pointer lock never triggers a turn.
renderer.domElement.addEventListener("pointerdown", () => {
  if (!renderer.xr.isPresenting) voice.press();
});
// Release on window, not canvas: the pointer may leave the canvas mid-hold.
// pointercancel too — Quest Browser ends a long press with cancel (not up)
// when it reads the hold as a selection/context gesture, and a missed release
// left the recorder running until the next stray tap (on-device 2026-07).
window.addEventListener("pointerup", () => voice.release());
window.addEventListener("pointercancel", () => voice.release());
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

// VR locomotion tunables. Slower than the desktop 3.0 m/s: smooth translation
// is pure vection in-headset, and 1.5 m/s is the comfortable end of it.
// URL-overridable like the render knobs (?vspeed=2) for in-headset tuning.
const VR_MOVE_SPEED = num("vspeed", 1.5);
const STICK_DEADZONE = 0.15;   // resting sticks report small nonzero values

// ---------- Desktop first-person controls (default, not debug-gated) ----------
// The web build is the freely explorable version of the room (decision
// 2026-07), so mouse look + WASD are the default desktop experience:
//   Mouse drag  — look around (after clicking the canvas to acquire lock)
//   W/A/S/D     — walk (clamped to ROOM_BOUNDS like the VR thumbstick)
// Exploration unlocks only once the room is THERE (timeline settled): during
// the check-in void and the reveal the view stays on the composed framing —
// the orb is the subject until the world has finished condensing. ?debug is
// exempt so alignment/measuring workflows keep working pre-reveal.
// All handlers early-return when renderer.xr.isPresenting — the headset owns
// look and locomotion in VR. No global keyboard suppression: isTyping keeps
// WASD letters typable in the threshold's name / mood fields.

const keys = new Set();  // currently held WASD keys

// Key handlers must never eat keystrokes meant for the threshold's
// name / mood text fields.
const isTyping = (e) => /^(INPUT|TEXTAREA)$/.test(e.target?.tagName ?? "");

// The room is explorable once the world has condensed (or always in ?debug).
const canExplore = () => DEBUG || timeline.state === "settled";

const { PointerLockControls } =
  await import("three/addons/controls/PointerLockControls.js");

const fpControls = new PointerLockControls(camera, renderer.domElement);

// The click that acquires pointer lock also fires voice.press() — harmless:
// session.js ignores taps under 350 ms, so a look-around click never starts
// a conversation turn.
renderer.domElement.addEventListener("click", () => {
  if (!renderer.xr.isPresenting && canExplore()) fpControls.lock();
});

const MOVE_KEYS = new Set(["w", "a", "s", "d"]);
window.addEventListener("keydown", (e) => {
  if (renderer.xr.isPresenting || isTyping(e) || !canExplore()) return;
  if (MOVE_KEYS.has(e.key.toLowerCase())) keys.add(e.key.toLowerCase());
});
window.addEventListener("keyup", (e) => {
  if (renderer.xr.isPresenting) return;
  keys.delete(e.key.toLowerCase());
});

// XR session: release lock and park the desktop handlers.
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

// ---------- DEBUG-only tools ----------
// Arrow keys align the splat; number keys drive orb states; key 0 (wired
// further down) skips the check-in.
if (DEBUG) {
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
  //   5 — force-show the wrist menu at a fixed desktop pose (visual tuning)
  let orbSpeaking = false;
  let orbWaiting = false;
  let wristShown = false;
  window.addEventListener("keydown", (e) => {
    if (renderer.xr.isPresenting || isTyping(e)) return;
    if (e.key === "1") orbStateTarget = 0;
    else if (e.key === "2") { orbSpeaking = !orbSpeaking; orb.setSpeaking(orbSpeaking); }
    else if (e.key === "3") orbStateTarget = 1;
    else if (e.key === "4") { orbWaiting = !orbWaiting; orb.setWaiting(orbWaiting); }
    else if (e.key === "5") { wristShown = !wristShown; wristMenu.forceShow(wristShown); }
  });
}

// ---------- Ambient toggle (bottom-right) + VR wrist menu ----------
// One handler serves both surfaces (DOM button and wrist menu), so their
// icons can never drift out of sync across an enter/exit-VR round trip.
const ambientBtn = document.getElementById("ambient-toggle");
function applyAmbient(on) {
  ambientBtn.textContent = on ? "\u{1F50A}" : "\u{1F507}";
  wristMenu.setAmbientOn(on);
}
ambientBtn.onclick = () => applyAmbient(audio.toggleAmbient());

// Hold a controller's squeeze (grip) button and two icon beads appear above
// that hand: A/X mutes the ambient bed, B/Y leaves the room. Release to hide.
const wristMenu = createWristMenu({
  renderer, rig, camera,
  onAmbientToggle: () => applyAmbient(audio.toggleAmbient()),
  // sessionend listeners already restore desktop eye height / controls.
  onExit: () => renderer.xr.getSession()?.end(),
});
window._wrist = wristMenu;         // desktop dev: _wrist.press(0); headset tuning is URL-only (?wmaxis, ?wmdebug=1)

// ---------- Threshold → session handoff ----------
// One sentence about THIS pre-generated world's light and character, fed to
// the persona as context (design.md Step 10). In the demo the visuals never
// follow the user's mood, so her words must describe what is actually there
// (caught on-device 2026-07: a stale profile had her speak of pool water
// while the splat showed a bedroom). Lives in rooms.json with the rest of
// the per-room facts — one file to edit when a world changes.
const ROOM_PROFILE = ROOM.profile;

// Walkable interior of THIS world — world-space metres for the rig's x/z,
// clamped in the main loop. Values live in rooms.json (measured by walking
// to each wall under ?debug and reading _rig.position; env_3 measured
// 2026-07, others are placeholders).
const ROOM_BOUNDS = { ...ROOM.bounds };
window._bounds = ROOM_BOUNDS;      // live tuning: _bounds.maxZ = 3

// Keeps every movement source (desktop WASD, VR thumbstick) inside the room.
// Clamps x/z only: desktop y is a fixed eye height, and in XR y belongs to
// local-floor. Physical walking moves the camera, not the rig, so it is out
// of scope here — the Quest Guardian bounds it in the real room.
function clampRigToBounds() {
  rig.position.x = THREE.MathUtils.clamp(rig.position.x, ROOM_BOUNDS.minX, ROOM_BOUNDS.maxX);
  rig.position.z = THREE.MathUtils.clamp(rig.position.z, ROOM_BOUNDS.minZ, ROOM_BOUNDS.maxZ);
}

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
    clampRigToBounds();
  }

  // VR thumbstick locomotion: translate the rig along the head's horizontal
  // heading. Translation only — no rotation component (comfort constraint) —
  // and always the rig, never the camera (the headset owns its transform).
  // Sticks are independent of the trigger, so hold-to-talk is unaffected.
  if (renderer.xr.isPresenting) {
    let sx = 0, sy = 0;
    for (const source of renderer.xr.getSession().inputSources) {
      const axes = source.gamepad?.axes;
      if (!axes) continue;
      // xr-standard mapping puts the thumbstick on axes[2]/[3] (Quest Touch);
      // two-axis devices (touchpad-only) fall back to [0]/[1].
      sx += (axes.length > 2 ? axes[2] : axes[0]) || 0;
      sy += (axes.length > 3 ? axes[3] : axes[1]) || 0;
    }
    const mag = Math.hypot(sx, sy);
    if (mag > STICK_DEADZONE) {
      // Both hands sum (usually only one stick is pushed); cap at unit deflection.
      if (mag > 1) { sx /= mag; sy /= mag; }
      camera.getWorldDirection(_forward);
      _forward.y = 0;
      _forward.normalize();
      _right.crossVectors(_forward, _worldUp).normalize();
      // Stick-up reads as negative y in xr-standard, hence the flip to forward.
      rig.position.addScaledVector(_forward, -sy * VR_MOVE_SPEED * dt);
      rig.position.addScaledVector(_right, sx * VR_MOVE_SPEED * dt);
      clampRigToBounds();
    }
  }

  // Hand the splat back once the XR transition has safely passed.
  if (splatGuard > 0) {
    splatGuard -= dt;
    if (splatGuard <= 0) splat.visible = true;
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
  wristMenu.update(dt);

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
