import * as THREE from "three";

// Procedurally generate a soft radial-gradient sprite texture — white centre,
// lavender mid, transparent edge — so no image asset is needed.
function makeGlowTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0.0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(230,210,255,0.6)");
  grad.addColorStop(1.0, "rgba(200,180,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

export function createGlowDust(scene, count = 180) {
  const texture = makeGlowTexture();
  const sprites = [];

  for (let i = 0; i < count; i++) {
    const mat = new THREE.SpriteMaterial({
      map: texture,
      blending: THREE.AdditiveBlending,
      depthWrite: false,   // transparent dust must not occlude each other
      depthTest: false,    // splat depth buffer would cull sprites otherwise
      transparent: true,
      opacity: 0.15 + Math.random() * 0.25,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 1;  // draw after splat pass so additive blend composites correctly

    // Distribute sprites in a 1–9 m ring around the origin, 0.1–3.8 m high.
    const angle = Math.random() * Math.PI * 2;
    const r     = 1 + Math.random() * 8;
    sprite.position.set(
      Math.cos(angle) * r,
      0.1 + Math.random() * 3.7,
      Math.sin(angle) * r
    );

    const scale = 0.008 + Math.random() * 0.022;  // 0.8–3 cm light dots
    sprite.scale.set(scale, scale, 1);

    // Cache per-particle animation parameters so update() allocates nothing.
    sprite.userData = {
      baseY:  sprite.position.y,
      speed:  0.2 + Math.random() * 0.4,
      phase:  Math.random() * Math.PI * 2,
      baseOp: 0.15 + Math.random() * 0.25,
    };

    sprites.push(sprite);
    scene.add(sprite);
  }

  // elapsed: seconds from clock.getElapsedTime()
  // breath:  0..1 inhale phase — dust brightens on inhale (pass 0 until wired up)
  function update(elapsed, breath) {
    for (const s of sprites) {
      const { baseY, speed, phase, baseOp } = s.userData;
      s.position.y = baseY + Math.sin(elapsed * speed + phase) * 0.15;
      s.material.opacity =
        (baseOp + 0.1 * Math.sin(elapsed * speed * 0.7 + phase))
        * (0.8 + 0.4 * breath);
    }
  }

  return { update };
}
