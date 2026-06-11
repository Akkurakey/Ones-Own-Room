import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import { setupEffects } from "./effects.js";
import { createGlowDust } from "./glow.js";
import { SessionTimeline } from "./session.js";
import { AudioManager } from "./audio.js";

// Append ?debug to the URL to enable first-person controls and splat-repositioning keys.
const DEBUG = new URLSearchParams(location.search).has("debug");

// ---------- Renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setFoveation(1.0);   // edge foveation saves ~15–25% fill-rate on Quest
document.body.appendChild(renderer.domElement);

// ---------- Scene + camera rig ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050510);

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
// so we zero the rig on session start and restore it on session end.
const DESKTOP_EYE_HEIGHT = 1.6;
rig.position.y = DESKTOP_EYE_HEIGHT;
renderer.xr.addEventListener("sessionstart", () => { rig.position.y = 0; });
renderer.xr.addEventListener("sessionend", () => { rig.position.y = DESKTOP_EYE_HEIGHT; });

// ---------- Splat ----------
const splat = new SplatMesh({ url: "./resources/worlds/env_3.spz" });
splat.position.y = 0.4;
splat.rotation.y = 0;
scene.add(splat);

// ---------- Modules ----------
const audio = new AudioManager();
const effects = setupEffects(splat);
window._fx = effects;              // live tuning: _fx.uniforms.uScale.value = 1.7
const dust = createGlowDust(scene);
const timeline = new SessionTimeline({ scene, camera, splat, audio, effects });

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
    if (renderer.xr.isPresenting) return;
    if (MOVE_KEYS.has(e.key.toLowerCase())) keys.add(e.key.toLowerCase());
  });
  window.addEventListener("keyup", (e) => {
    if (renderer.xr.isPresenting) return;
    keys.delete(e.key.toLowerCase());
  });

  // Arrow keys: splat repositioning, XR-gated.
  // X-axis offset removed: WASD walking covers horizontal placement.
  window.addEventListener("keydown", (e) => {
    if (renderer.xr.isPresenting) return;
    if (e.key === "ArrowUp") splat.position.y -= 0.1;
    else if (e.key === "ArrowDown") splat.position.y += 0.1;
    else if (e.key === "ArrowLeft") splat.rotation.y -= Math.PI / 12;
    else if (e.key === "ArrowRight") splat.rotation.y += Math.PI / 12;
    else return;
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

// ---------- Enter-VR button ----------
const btn = document.getElementById("vr-button");

// navigator.xr is absent on some older browsers; ?? coalesces to a resolved
// false so the button always enables rather than silently throwing.
(navigator.xr?.isSessionSupported("immersive-vr") ?? Promise.resolve(false))
  .then(async (ok) => {
    btn.disabled = false;
    btn.textContent = ok ? "Enter the Space" : "Experience in Browser";

    btn.onclick = async () => {
      // AudioContext must be created inside a user-gesture call stack.
      await audio.unlock();

      if (ok) {
        const session = await navigator.xr.requestSession("immersive-vr", {
          optionalFeatures: ["local-floor", "bounded-floor"],
        });
        renderer.xr.setSession(session);
      }

      btn.style.display = "none";
      timeline.start();
    };
  });

// ---------- Main loop ----------
// Must use setAnimationLoop — requestAnimationFrame does not fire inside a
// WebXR session (the headset drives its own frame cadence at 72/90 Hz).
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  const elapsed = clock.getElapsedTime();

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
  dust.update(elapsed, 0);
  timeline.update(dt);

  // SparkRenderer is auto-created by Spark on the first render call and handles
  // sorting + updating splats automatically — no manual updateGenerator() needed.
  renderer.render(scene, camera);
});

// ---------- Resize (desktop only; VR resolution is headset-controlled) ----------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
