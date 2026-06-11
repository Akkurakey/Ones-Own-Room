import { dyno } from "@sparkjsdev/spark";

// Layer 1 — dyno-based bright-splat glow.
//
// Spark splats are gaussian blobs: enlarging a bright one makes its soft edge
// feather outward, giving a "free" bloom halo without any post-processing pass.
// Three operations compound this: scale-up → overexpose → lavender tint-shift.
// All run entirely on the GPU via the dyno node graph.
//
// Breathing (Layer 0) and reveal (Layer 3) will be added in Phase 2 by
// extending the dynoBlock and populating update().

export function setupEffects(splatMesh) {
  const uGlow   = dyno.dynoFloat(1.3);  // glow intensity, exposed to session.js
  const uBreath = dyno.dynoFloat(0);    // stub — Phase 2 wires breathing here
  const uTime   = dyno.dynoFloat(0);    // seconds elapsed; drives spatial drift

  splatMesh.objectModifier = dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {
      if (!gsplat) throw new Error("effects: missing gsplat input");

      // Extract only the fields we need; all others pass through combineGsplat.
      // x / z are the world-space position components used for spatial drift.
      const { rgb, scales, x, z } = dyno.splitGsplat(gsplat).outputs;

      // Global dreamcore colour wash — applied to every splat before glow.
      // A fixed 18% blend toward rgb * GLOW_TINT * 1.08 shifts the whole scene
      // into the lavender palette without depending on scale or brightness.
      const GLOW_TINT = dyno.dynoConst("vec3", [0.78, 0.62, 0.95]);
      const tintedBase = dyno.mul(rgb, dyno.mul(GLOW_TINT, dyno.dynoConst("float", 1.08)));
      const washedRgb = dyno.mix(rgb, tintedBase, dyno.dynoConst("float", 0.18));
      gsplat = dyno.combineGsplat({ gsplat, rgb: washedRgb });

      // Re-split so downstream nodes read the washed colour.
      const { rgb: rgb2, scales: scales2 } = dyno.splitGsplat(gsplat).outputs;

      // Rec.709 perceptual luminance — human vision weights green most strongly.
      const lum = dyno.dot(rgb2, dyno.dynoConst("vec3", [0.2126, 0.7152, 0.0722]));

      // Split toning: warm gold in highlights, cool lavender in shadows.
      // splitT = lum² concentrates warmth in the bright zone; multiplying the
      // current colour by the grade (not replacing it) preserves hue variation.
      const WARM = dyno.dynoConst("vec3", [1.0, 0.92, 0.72]);
      const COOL = dyno.dynoConst("vec3", [0.72, 0.78, 1.0]);
      const splitT = dyno.mul(lum, lum);
      const grade = dyno.mix(COOL, WARM, splitT);
      const gradedRgb = dyno.mix(rgb2, dyno.mul(rgb2, grade), dyno.dynoConst("float", 0.28));
      gsplat = dyno.combineGsplat({ gsplat, rgb: gradedRgb });

      // Re-split so the glow block operates on the split-toned colour.
      const { rgb: rgb3, scales: scales3 } = dyno.splitGsplat(gsplat).outputs;

      // Spatial drift: slow sin/cos waves in XZ produce large, gently shifting
      // bright patches. Low spatial frequencies (0.8 / 0.6) = big regions, not
      // fine ripple. Low time multipliers (0.4 / 0.3) = barely-perceptible flow.
      const drift = dyno.add(
        dyno.dynoConst("float", 0.5),
        dyno.mul(
          dyno.dynoConst("float", 0.5),
          dyno.mul(
            dyno.sin(dyno.add(dyno.mul(x, dyno.dynoConst("float", 0.8)),
                              dyno.mul(uTime, dyno.dynoConst("float", 0.4)))),
            dyno.cos(dyno.add(dyno.mul(z, dyno.dynoConst("float", 0.6)),
                              dyno.mul(uTime, dyno.dynoConst("float", 0.3)))),
          ),
        ),
      );

      // glowMask: lower threshold (0.32) and wider band (→0.82) pulls in more
      // splats with a gentler falloff. Adding 0.12 * drift makes the glow
      // breathe spatially — patches wax and wane over time without flickering.
      const glowMask = dyno.mul(
        dyno.smoothstep(
          dyno.dynoConst("float", 0.25),
          dyno.dynoConst("float", 0.95),
          dyno.add(lum, dyno.mul(dyno.dynoConst("float", 0.12), drift)),
        ),
        uGlow,
      );

      // (1) Scale-up: ×2.1 max — enough halo density without star artifacts.
      const newScales = dyno.mul(
        scales3,
        dyno.add(
          dyno.dynoConst("float", 1.0),
          dyno.mul(dyno.dynoConst("float", 1.6), glowMask),
        ),
      );

      // (2) Overexpose: reduced to 0.3 to avoid harsh blown-out cores on the
      //     wider splats produced by the larger scale multiplier above.
      const brightRgb = dyno.mul(
        rgb3,
        dyno.add(
          dyno.dynoConst("float", 1.0),
          dyno.mul(dyno.dynoConst("float", 0.18), glowMask),
        ),
      );

      // (3) Tint toward dreamcore lavender as glow strength rises.
      //     Multiplying GLOW_TINT by (1 + lum) keeps the tint colour from
      //     feeling muddy on already-bright splats.
      const tintRgb = dyno.mul(
        GLOW_TINT,
        dyno.add(dyno.dynoConst("float", 1.0), lum),
      );
      const newRgb = dyno.mix(
        brightRgb,
        tintRgb,
        dyno.mul(dyno.dynoConst("float", 0.5), glowMask),
      );

      gsplat = dyno.combineGsplat({ gsplat, scales: newScales, rgb: newRgb });

      // Global brightness lift before the flow wave — raises luminosity to
      // compensate for the smaller scale multiplier, without adding contrast.
      const liftedRgb = dyno.mul(
        dyno.splitGsplat(gsplat).outputs.rgb,
        dyno.dynoConst("float", 1.10),
      );
      gsplat = dyno.combineGsplat({ gsplat, rgb: liftedRgb });

      // Two additive travelling waves sweep diagonally across the scene.
      // Multiplicative sin*sin creates a standing pulse; additive t-phase here
      // makes bright bands move (true flow). Two angles + two speeds = organic.
      const w1 = dyno.sin(dyno.add(
        dyno.add(dyno.mul(x, dyno.dynoConst("float", 0.5)),
                 dyno.mul(z, dyno.dynoConst("float", 0.3))),
        dyno.mul(uTime, dyno.dynoConst("float", 0.45)),
      ));
      const w2 = dyno.sin(dyno.add(
        dyno.sub(dyno.mul(x, dyno.dynoConst("float", 0.2)),
                 dyno.mul(z, dyno.dynoConst("float", 0.45))),
        dyno.mul(uTime, dyno.dynoConst("float", 0.30)),
      ));
      const lightWave = dyno.add(
        dyno.dynoConst("float", 0.9),
        dyno.mul(
          dyno.dynoConst("float", 0.10),
          dyno.mul(dyno.add(w1, w2), dyno.dynoConst("float", 0.5)),
        ),
      );
      const wavedRgb = dyno.mul(dyno.splitGsplat(gsplat).outputs.rgb, lightWave);
      gsplat = dyno.combineGsplat({ gsplat, rgb: wavedRgb });

      // Layer 3 — distance haze.
      // scene.fog has no effect on splats (colours are baked), so haze lives
      // here. Exponential formula `1 - exp(-density * d)` is standard GLSL fog;
      // capped at 0.45 so distant geometry stays readable through the veil.
      const HAZE = dyno.dynoConst("vec3", [0.80, 0.74, 0.90]);
      const dist = dyno.length(dyno.splitGsplat(gsplat).outputs.center);
      const fogAmount = dyno.mul(
        dyno.sub(
          dyno.dynoConst("float", 1.0),
          dyno.exp(dyno.mul(dyno.dynoConst("float", -0.04), dist)),
        ),
        dyno.dynoConst("float", 0.60),
      );
      const hazedRgb = dyno.mix(dyno.splitGsplat(gsplat).outputs.rgb, HAZE, fogAmount);
      gsplat = dyno.combineGsplat({ gsplat, rgb: hazedRgb });

      return { gsplat };
    },
  );

  // Compile the node graph into shader code once.
  // Never call this again in the render loop — Spark handles incremental
  // uniform updates automatically each frame.
  splatMesh.updateGenerator();

  return {
    update(elapsed) { uTime.value = elapsed; },
    uniforms: { uGlow, uBreath, uTime },
  };
}
