import * as THREE from "three";

// Hand menu — the room's only in-VR control surface.
//
// HOLD a controller's squeeze (grip) button and two translucent glass beads
// condense above that hand: mute the ambient bed, or leave the room. Release
// and they dissolve — the menu exists for exactly as long as you want to see
// it, and the room keeps its zero-HUD stillness. No text anywhere, only faint
// white icons: the beads are miniature echoes of the orb, not interface chrome.
//
// Squeeze-hold replaced an earlier wrist-flip gesture: squeeze is a
// first-class WebXR event (squeezestart/squeezeend) where the flip was a
// grip-axis heuristic that varied per device and never triggered reliably.
// It also rhymes with the room's one other verb — hold the orb to speak,
// hold the grip to see the menu.
//
// Confirmation is the SAME hand's physical keys, and the two beads sit in a
// vertical column mirroring the controller's own button stack:
//   lower bead ↔ A / X (xr-standard buttons[4]) — ambient mute (frequent,
//     reversible)
//   upper bead ↔ B / Y (xr-standard buttons[5]) — leave the room (rare,
//     consequential)
// The keys are read ONLY while the menu is faded in, so resting a thumb on
// A/B in normal use can never mute or eject anyone.

// The bead column floats ABOVE the controller in rig space (world-vertical),
// not welded to a grip-local axis: spheres look identical from every angle
// and the icons are billboarding sprites, so placement needs no knowledge of
// the controller's orientation. It also hovers calmly instead of jittering
// with every wrist tremor.
const BEAD_RADIUS = 0.017;
const LOWER_POS = new THREE.Vector3(0, 0.07, 0);   // above the fist centroid
const UPPER_POS = new THREE.Vector3(0, 0.125, 0);
// Pushed this far beyond the hand, away from the head — holding the
// controller up to look never puts the beads right at the eyes
// (headset feedback 2026-07).
const PUSH_OUT = 0.12;
// Damped follow (~dt*12): the column glides after the hand instead of being
// welded to every tremor — reads as presence, not chrome, and hides the
// pose-sampling jitter that a hard per-frame copy exposes.
const FOLLOW_RATE = 12;
// The bead is a frame, the icon is the message: reflections stay faint (dim
// tint + low opacity) so the glyph reads first (headset feedback 2026-07).
const BEAD_TINT = 0x8f8fa8;    // dampens the cubemap — lavender-grey, not mirror
const BEAD_OPACITY = 0.16;
const ICON_OPACITY = 0.85;
const BADGE_OPACITY = 0.6;     // quieter than the icon — a footnote, not a label

// ?wmdebug=1 keeps the beads visible whenever presenting — placement triage
// on-device, where there is no console (URL params are the only tuning knob).
const _qp = new URLSearchParams(location.search);
const CFG = {
  fadeRate: 6.0, // opacity ramp ≈ 0.3 s (design: everything condenses, nothing pops)
  debug: (parseFloat(_qp.get("wmdebug")) || 0) > 0,
};

// ---------- icon textures (drawn once; faint white strokes, no text) ----------
function makeIconTexture(draw) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.strokeStyle = "rgba(255, 255, 255, 0.92)";
  g.fillStyle = "rgba(255, 255, 255, 0.92)";
  g.lineWidth = 7;
  g.lineCap = g.lineJoin = "round";
  draw(g);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

function drawSpeakerBody(g) {
  // Box + cone of a speaker, centred slightly left to leave room for waves.
  g.beginPath();
  g.moveTo(30, 52); g.lineTo(46, 52); g.lineTo(64, 36);
  g.lineTo(64, 92); g.lineTo(46, 76); g.lineTo(30, 76);
  g.closePath();
  g.fill();
}

const iconSpeakerOn = () => makeIconTexture((g) => {
  drawSpeakerBody(g);
  g.beginPath(); g.arc(66, 64, 16, -Math.PI / 3, Math.PI / 3); g.stroke();
  g.beginPath(); g.arc(66, 64, 30, -Math.PI / 3, Math.PI / 3); g.stroke();
});

const iconSpeakerOff = () => makeIconTexture((g) => {
  drawSpeakerBody(g);
  g.beginPath(); g.moveTo(78, 48); g.lineTo(106, 80); g.stroke();
  g.beginPath(); g.moveTo(106, 48); g.lineTo(78, 80); g.stroke();
});

const iconLeave = () => makeIconTexture((g) => {
  // Door frame with an arrow walking out of it.
  g.beginPath();
  g.moveTo(76, 30); g.lineTo(40, 30); g.lineTo(40, 98); g.lineTo(76, 98);
  g.stroke();
  g.beginPath(); g.moveTo(58, 64); g.lineTo(100, 64); g.stroke();
  g.beginPath(); g.moveTo(84, 48); g.lineTo(100, 64); g.lineTo(84, 80); g.stroke();
});

// Circled-letter badges — the controller's own button glyphs (A/B right hand,
// X/Y left), telling the user which physical key each bead answers to.
const makeBadge = (letter) => makeIconTexture((g) => {
  g.lineWidth = 5;
  g.beginPath(); g.arc(64, 64, 42, 0, Math.PI * 2); g.stroke();
  g.font = "300 52px Georgia, serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(letter, 64, 68);
});

export function createWristMenu({ renderer, rig, camera, onExit, onAmbientToggle }) {
  // The beads reuse the orb's dreamcore cubemap (HTTP cache makes this second
  // load free) on the cheap classic envmap path — miniature glass echoes of
  // the orb rather than new UI material language.
  const envMap = new THREE.CubeTextureLoader()
    .setPath("./resources/env/")
    .load(["px.png", "nx.png", "py.png", "ny.png", "pz.png", "nz.png"]);

  const beadGeo = new THREE.SphereGeometry(BEAD_RADIUS, 24, 24);
  const texOn = iconSpeakerOn();
  const texOff = iconSpeakerOff();
  const texLeave = iconLeave();
  const badges = { A: makeBadge("A"), B: makeBadge("B"), X: makeBadge("X"), Y: makeBadge("Y") };
  let ambientOn = true;

  // Beads and icons are atmosphere, not scenery: no depth write OR test (the
  // same conclusion as the orb halo / glow dust — soft splat edges would
  // otherwise hard-clip them), composited after everything via renderOrder.
  function makeBead(parent, pos, iconTex, badgeTex) {
    const beadMat = new THREE.MeshBasicMaterial({
      envMap,
      color: BEAD_TINT,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    const bead = new THREE.Mesh(beadGeo, beadMat);
    bead.renderOrder = 4;
    bead.position.copy(pos);
    parent.add(bead);

    const iconMat = new THREE.SpriteMaterial({
      map: iconTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    const icon = new THREE.Sprite(iconMat);
    icon.renderOrder = 5;
    icon.scale.setScalar(BEAD_RADIUS * 1.35);
    bead.add(icon);

    // Button badge at the bead's lower right — which physical key answers.
    const badgeMat = new THREE.SpriteMaterial({
      map: badgeTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    const badge = new THREE.Sprite(badgeMat);
    badge.renderOrder = 5;
    badge.scale.setScalar(BEAD_RADIUS * 0.8);
    badge.position.set(BEAD_RADIUS * 1.45, -BEAD_RADIUS * 0.9, 0);
    bead.add(badge);
    return { bead, beadMat, iconMat, badgeMat };
  }

  // One menu per hand — symmetric, no handedness assumptions.
  const hands = [0, 1].map((i) => {
    const grip = renderer.xr.getControllerGrip(i);
    rig.add(grip);
    // Sibling of the grip under the rig (NOT a child): update() re-anchors it
    // to the grip's position every frame, dropping the grip's rotation.
    const group = new THREE.Group();
    group.visible = false;
    rig.add(group);
    const hand = {
      grip,
      group,
      mute: makeBead(group, LOWER_POS, texOn, badges.A),   // right-hand default
      leave: makeBead(group, UPPER_POS, texLeave, badges.B),
      source: null,      // XRInputSource once the controller connects
      held: false,       // squeeze button currently held
      shown: false,
      fade: 0,
      prevBtn: [false, false],
    };
    // three broadcasts controller events to every space, grip included.
    grip.addEventListener("connected", (e) => {
      hand.source = e.data;
      // xr-standard buttons[4]/[5] are A/B on the right controller, X/Y on
      // the left — the badges must show the keys this hand actually has.
      const left = e.data?.handedness === "left";
      hand.mute.badgeMat.map = left ? badges.X : badges.A;
      hand.leave.badgeMat.map = left ? badges.Y : badges.B;
    });
    grip.addEventListener("disconnected", () => { hand.source = null; hand.held = false; });
    grip.addEventListener("squeezestart", () => { hand.held = true; });
    grip.addEventListener("squeezeend", () => { hand.held = false; });
    return hand;
  });

  // Desktop stand-in (?debug key 5): no XR means no grip poses, so park hand
  // 0's grip at a fixed spot in front of the desktop camera for visual tuning.
  let forceShown = false;
  function forceShow(b) {
    forceShown = b;
    if (b && !renderer.xr.isPresenting) {
      // Rig-local: the desktop camera sits at the rig origin (eye height is
      // on the rig itself), so this lands in front of and below the eye.
      // Only .position/.quaternion matter — the bead group re-anchors off
      // them directly, never through the grip's (XR-owned, frozen) matrix.
      hands[0].grip.position.set(0.12, -0.25, -0.5);
      hands[0].grip.quaternion.identity();
    }
  }

  function setAmbientOn(on) {
    ambientOn = on;
    for (const h of hands) h.mute.iconMat.map = on ? texOn : texOff;
  }

  // Simulated press for desktop dev: _wrist.press(0) = mute, _wrist.press(1) = leave.
  function press(i) { (i === 0 ? onAmbientToggle : onExit)(); }

  // Reused per-frame vectors — never allocated in update.
  const _away = new THREE.Vector3();
  const _target = new THREE.Vector3();

  function update(dt) {
    const presenting = renderer.xr.isPresenting;
    for (const h of hands) {
      // ----- show condition: that hand's squeeze button is held -----
      const want =
        (forceShown && h === hands[0]) ||
        (presenting && (h.held || CFG.debug));
      h.shown = want;

      // ----- fade (~0.3 s) -----
      const wasHidden = h.fade <= 0.01;
      h.fade += ((want ? 1 : 0) - h.fade) * Math.min(dt * CFG.fadeRate, 1);
      h.group.visible = h.fade > 0.01;
      if (h.group.visible) {
        // Anchor: over the controller, pushed PUSH_OUT beyond it away from
        // the head (grip and camera are rig-siblings, so all rig-local).
        _away.copy(h.grip.position).sub(camera.position);
        _away.y = 0;
        const d = _away.length();
        if (d > 1e-4) _away.multiplyScalar(PUSH_OUT / d);
        else _away.set(0, 0, -PUSH_OUT);
        _target.copy(h.grip.position).add(_away);
        // Snap on the appearing frame (no glide-in from a stale spot), damped
        // follow afterwards.
        if (wasHidden) h.group.position.copy(_target);
        else h.group.position.lerp(_target, Math.min(dt * FOLLOW_RATE, 1));

        h.mute.beadMat.opacity = BEAD_OPACITY * h.fade;
        h.leave.beadMat.opacity = BEAD_OPACITY * h.fade;
        h.mute.iconMat.opacity = ICON_OPACITY * h.fade;
        h.leave.iconMat.opacity = ICON_OPACITY * h.fade;
        h.mute.badgeMat.opacity = BADGE_OPACITY * h.fade;
        h.leave.badgeMat.opacity = BADGE_OPACITY * h.fade;
      }

      // ----- same-hand keys, read only while the menu is up -----
      const gp = h.source?.gamepad;
      if (gp && h.shown && h.fade > 0.5) {
        const a = gp.buttons[4]?.pressed ?? false; // A / X → mute
        const b = gp.buttons[5]?.pressed ?? false; // B / Y → leave
        if (a && !h.prevBtn[0]) onAmbientToggle();
        if (b && !h.prevBtn[1]) onExit();
        h.prevBtn[0] = a;
        h.prevBtn[1] = b;
      } else {
        // Track state even while hidden so a button held through the flip
        // can't fire on the edge of appearing.
        h.prevBtn[0] = gp?.buttons[4]?.pressed ?? false;
        h.prevBtn[1] = gp?.buttons[5]?.pressed ?? false;
      }
    }
  }

  return { update, forceShow, setAmbientOn, press, cfg: CFG, hands, ambientOn: () => ambientOn };
}
