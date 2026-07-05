import * as THREE from "three";
import { makeGlowTexture } from "./glow.js";

// The floating orb — the vessel that carries mood input into the experience.
//
// Fully decoupled from voice/AI: a plain mesh subsystem with two states and a
// looping "thinking" transition, driven externally by session.js (or keyboard
// / console while tuning on desktop). It is the ONE exception to the "splats
// can't be lit" rule: the orb is a real THREE.Mesh, so real materials and a
// real envMap work on it.
//
// State A, listening (s = 0): metallic, reflecting a pre-baked dreamcore
//   cubemap (the world hasn't condensed yet, so there is nothing real to
//   reflect), slowly rotating, hovering in the void in front of you.
// State B, companion (s = 1): translucent, breathing out soft white light,
//   resting at the scene centre — the same point the world bloomed from.
//   session.js drives A→B as a FAST (~2 s) ramp the moment the AI response
//   arrives, in the same breath that ignites the world reveal.
// Waiting (loopable): quiet light-gathering while the AI generates — slow,
//   dim, rotation eases off. Masks 3–10 s of unpredictable latency.
// Speaking (loopable): brighter ~2 s pulse while the AI voice is playing —
//   the orb's "I am talking to you" vital sign.
// Recording (loopable): the light rides YOUR voice — setMicLevel() feeds the
//   live mic amplitude every frame and the glow swells and falls with it:
//   "I am being heard". No autonomous pulse at all, which is exactly what
//   tells it apart from waiting (slow sine) and speaking (fast sine) — the
//   three active states must be distinguishable at a glance (design.md
//   Step 9: the user learns "she received it" from this change alone).

// Must match REVEAL_CENTER in effects.js — but this one is WORLD space,
// while effects.js uses the splat's local space (offset by main.js's
// splat.position.y = 0.4): world (0, 1.4, -1.6) == local (0, 1.0, -1.6).
const ORB_CENTER = new THREE.Vector3(0.0, 1.4, -1.6);

export function createOrb(scene) {
  // Dreamcore cubemap for the listening state's reflections. Low-res is fine:
  // it is mood, not mirror — the eye reads colour and light direction only.
  // Loaded twice (HTTP cache makes the second free) because the refraction
  // layer needs its own texture object with a different mapping mode.
  const envLoader = new THREE.CubeTextureLoader().setPath("./resources/env/");
  const envFaces = ["px.png", "nx.png", "py.png", "ny.png", "pz.png", "nz.png"];
  const envMap = envLoader.load(envFaces);
  const envRefract = envLoader.load(envFaces);
  envRefract.mapping = THREE.CubeRefractionMapping;

  // One material for both states, crossfaded by parameters — metal recedes
  // as emissive light rises, one continuous gesture: "the orb turns what you
  // just gave it into light". Swapping two objects could never look like that.
  const coreMat = new THREE.MeshStandardMaterial({
    metalness: 1.0,
    roughness: 0.08,
    envMap,
    envMapIntensity: 1.0,
    color: 0xaab0c0,
    emissive: 0xffffff,
    emissiveIntensity: 0.0,
    transparent: true,
    opacity: 1.0,
  });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.18, 48, 48), coreMat);
  core.position.copy(ORB_CENTER);  // world-anchored; never parented to camera
  // Drawn after the splat pass (same trick as the glow dust): the orb is
  // transparent, and in the default order it renders before the splats —
  // writing depth, culling everything behind it, so the glass "sees" only
  // the black background. After the splats, with no depth write, the scene
  // is already in the framebuffer and shows through the body correctly.
  core.renderOrder = 2;
  coreMat.depthWrite = false;
  scene.add(core);

  // The refraction feel of the glass state. Real refraction (transmission)
  // costs an extra render pass per eye on Quest — forbidden. Instead an inner
  // sphere samples the same dreamcore cubemap along REFRACTED rays
  // (CubeRefractionMapping): looking through the ball you see the dream bent
  // by a lens. MeshBasicMaterial because only its classic envmap path has a
  // refraction mode — the PBR (standard) path doesn't.
  const refractMat = new THREE.MeshBasicMaterial({
    envMap: envRefract,
    refractionRatio: 0.72,  // ≈ air→glass (1/1.4); lower bends harder
    transparent: true,
    opacity: 0.0,           // companion state fades it in
    depthWrite: false,
  });
  // Shares the core's geometry: identical silhouettes, so the refraction
  // layer can never show its own rim inside the shell (the "two spheres"
  // artifact a smaller inner radius produces). Neither layer writes depth and
  // renderOrder fixes the compositing order, so coplanar faces don't fight.
  const inner = new THREE.Mesh(core.geometry, refractMat);
  inner.renderOrder = 1;    // after splats, beneath the shell
  inner.position.copy(ORB_CENTER);
  scene.add(inner);

  // Companion-state soft light is faked: opacity drop + an additive halo
  // sprite. Real transmission would cost an extra render pass per eye on
  // Quest — we want the look, not the physics.
  // Unlike the core (normal depth, must occlude/be occluded by the world),
  // the halo is atmosphere: no depth write OR test, same as the glow dust,
  // so soft splat edges can never hard-clip it.
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowTexture(),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
    opacity: 0.0,
    color: 0xffffff,
  }));
  halo.renderOrder = 3;  // after splats, refraction layer and shell
  halo.position.copy(ORB_CENTER);
  halo.scale.setScalar(0.9);
  scene.add(halo);

  // Companion-state (s = 1) targets — clear glass, not a lamp: dielectric and
  // smooth so the envMap's fresnel-weighted reflection draws a dreamcore rim
  // along the edges, faintly lit inside, the scene visible through the body.
  // Tune live via _orb.params.*, then bake keepers here. (The s = 0 metal
  // endpoints stay fixed in the crossfade below.)
  const params = {
    // A pure dielectric reflects only ~4% at normal incidence — fresnel gives
    // a rim and nothing else. A touch of metalness lifts reflectance at every
    // angle, so the dream washes across the whole face like real light on a
    // crystal ball, while staying translucent.
    metalB:    0.25,
    roughB:    0.10,  // stays smooth — crisp reflections, not frosted
    envB:      1.0,   // full envMap: rim + face reflections both read
    emissiveB: 0.3,   // a faint inner light
    opacityB:  0.35,  // see-through body
    haloB:     0.15,  // a quiet presence around it
    refractB:  0.55,  // refraction layer: the dream bent through the lens
  };

  let s = 0;           // state crossfade: 0 = listening, 1 = companion
  let waiting = false;
  let speaking = false;
  let recording = false;
  let waitW = 0;       // smoothed weights — effects fade in/out, never pop
  let speakW = 0;
  let recW = 0;
  let micLevel = 0;    // raw 0..1 from voice.getMicLevel(), set every frame
  let micSmooth = 0;   // envelope-followed — fast attack, slow release
  let tAccum = 0;

  // session.js ramps this 0→1 over ~2 s when the AI response arrives.
  function setState(v) { s = THREE.MathUtils.clamp(v, 0, 1); }
  function setWaiting(b) { waiting = b; }
  function setSpeaking(b) { speaking = b; }
  function setRecording(b) { recording = b; }
  function setMicLevel(v) { micLevel = THREE.MathUtils.clamp(v, 0, 1); }

  function update(dt) {
    tAccum += dt;

    // Smoothed mode weights (~0.7 s ramps).
    waitW += ((waiting ? 1 : 0) - waitW) * Math.min(dt * 3.0, 1);
    speakW += ((speaking ? 1 : 0) - speakW) * Math.min(dt * 3.0, 1);
    recW += ((recording ? 1 : 0) - recW) * Math.min(dt * 3.0, 1);

    // Envelope follower on the mic: rises fast so the orb answers your voice
    // instantly, falls slower so syllable gaps read as glow, not flicker.
    micSmooth += (micLevel - micSmooth) *
      Math.min(dt * (micLevel > micSmooth ? 14.0 : 4.0), 1);

    // Rotation is the "alive and attentive" cue of the listening state; it
    // eases off while gathering thought and the companion barely turns.
    // A perfectly smooth metal sphere shows NO visible rotation (env
    // reflections depend on view direction and normals only, both spherically
    // symmetric), so the visible spin is the envMap sliding across the
    // surface via material.envMapRotation — the dream turning inside the orb.
    // Both waiting and recording still the spin — thought-gathering and
    // listening share the same attentive stillness.
    const rotSpeed = (0.6 * (1 - s) + 0.05) * (1 - 0.6 * Math.max(waitW, recW));
    core.rotation.y += dt * rotSpeed;          // matters if it ever gets a texture
    coreMat.envMapRotation.y -= dt * rotSpeed; // the rotation you actually see
    // Refraction image turns slightly slower than the surface reflection —
    // the parallax between the two layers is what sells "solid glass".
    refractMat.envMapRotation.y -= dt * rotSpeed * 0.6;

    // Gentle bob. 3 cm at 0.7 rad/s — present but never demanding attention.
    const bob = Math.sin(tAccum * 0.7) * 0.03;
    core.position.y = ORB_CENTER.y + bob;
    halo.position.y = core.position.y;
    inner.position.y = core.position.y;

    // Waiting: slow (~4 s), dim gathering of light — "I received it, I am
    // thinking". Speaking: brighter ~2 s pulse with a subtle swell — "I am
    // talking to you". Both loop indefinitely; session.js flips them off.
    const waitPulse  = waitW * (0.5 + 0.5 * Math.sin(tAccum * 1.5));
    const speakPulse = speakW * (0.5 + 0.5 * Math.sin(tAccum * 3.0));
    // Recording glow: a small steady base ("the mic is open") plus the mic
    // envelope — driven by the user's own voice, never by a clock.
    const recGlow = recW * (0.25 + 0.75 * micSmooth);

    // A→B crossfade: metal recedes into glass (opacity only — no
    // transmission). Speaking-pulse amplitudes are small: they sit on the
    // glass's low baseline, and the old values would turn it back into a lamp.
    coreMat.metalness         = 1.0 + (params.metalB - 1.0) * s;
    coreMat.roughness         = 0.08 + (params.roughB - 0.08) * s;
    coreMat.envMapIntensity   = 1.0 + (params.envB - 1.0) * s;
    coreMat.emissiveIntensity = params.emissiveB * s + 0.12 * waitPulse + 0.15 * speakPulse + 0.22 * recGlow;
    coreMat.opacity           = 1.0 + (params.opacityB - 1.0) * s;
    // Speaking swells on its own clock; recording swells with your voice.
    core.scale.setScalar(1.0 + 0.04 * speakPulse + 0.03 * recW * micSmooth);
    inner.scale.copy(core.scale);  // pulse together — mismatched silhouettes re-create the rim
    halo.material.opacity     = params.haloB * s + 0.08 * waitPulse + 0.12 * speakPulse + 0.15 * recGlow;
    halo.scale.setScalar(0.9 + 0.8 * s + 0.15 * speakPulse + 0.12 * recW * micSmooth);
    refractMat.opacity        = params.refractB * s;  // hidden behind the metal at s = 0
  }

  return {
    core, halo, inner, params, update,
    setState, setWaiting, setSpeaking, setRecording, setMicLevel,
    center: ORB_CENTER,
  };
}
