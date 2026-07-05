import { dyno } from "@sparkjsdev/spark";

// Layer 1 — dyno-based bright-splat glow.
//
// Spark splats are gaussian blobs: enlarging a bright one makes its soft edge
// feather outward, giving a "free" bloom halo without any post-processing pass.
// Three operations compound this: scale-up → overexpose → lavender tint-shift.
// All run entirely on the GPU via the dyno node graph.
//
// Breathing (Layer 0) will be added in Phase 2 by extending the dynoBlock.
// The entry reveal (design.md Step 5) lives at the end of the dynoBlock and
// is driven externally via playReveal() / the uReveal uniform.

export function setupEffects(splatMesh) {
  const uGlow   = dyno.dynoFloat(0.8);  // glow intensity, exposed to session.js
  const uBreath = dyno.dynoFloat(0);    // stub — Phase 2 wires breathing here
  const uTime   = dyno.dynoFloat(0);    // seconds elapsed; drives spatial drift

  // ---- Step 5: entry reveal (two-front, log-space) ----
  //
  // Dormant state is fully black: every splat collapsed below one pixel.
  // On playReveal() two spherical fronts expand from the orb point:
  //   orb ──[ solid world ]── condense front ──[ star-dust ]── dust front ──[ black ]──→
  // The dust front summons splats as ~4 mm points (the scene's own point
  // cloud); the condense front trails behind it, restoring full size.
  //
  // Fronts advance in LOG space (radius grows exponentially with progress):
  // the scene's bounding radius is dominated by far-away sky splats, and a
  // linear sweep to that radius would flood the near field in under a second.
  // Exponential growth reads as constant speed perceptually — slow ceremony
  // nearby, fast sweep across the distant sky — and any scene size fits.
  //
  // uReveal is NEVER ramped on a timer inside effects.js — session.js
  // triggers it on the "AI response ready" event (see design.md Step 5/6).
  // Defaults to 1 (fully revealed) so the scene stays visible until session.js
  // owns the gating; for a manual trial, call playReveal() from the console.
  const uReveal = dyno.dynoFloat(1);

  // ln(R_end/R0 + 1) — log-space span of the sweep. Placeholder until the
  // splat finishes loading, then recomputed from its real bounding box.
  const REVEAL_R0 = 0.5;  // metres of solid radius "unlocked" per e-fold
  const uRevealSpan = dyno.dynoFloat(Math.log(60 / REVEAL_R0 + 1));

  const uDustScale = dyno.dynoFloat(0.004);  // star-dust point size (m)
  const uDustLead  = dyno.dynoFloat(0.8);    // dust front's log-space lead (×e^0.8 ≈ 2.2)

  // Global exposure — the final brightness multiply on every splat.
  // 0.9 with uGlow at 0.8 is the user-tuned keeper (2026-07): calmer dusk,
  // highlights held back. Tune live via _fx.uniforms.uExposure.value, then
  // bake the keeper here.
  const uExposure = dyno.dynoFloat(0.9);

  // Distance haze, live-tunable like exposure (bake keepers when settled):
  // density — how fast distance fades toward the haze colour (per metre);
  // strength — the cap on how hazed anything can get (1 = full whiteout).
  const uHazeDensity  = dyno.dynoFloat(0.04);
  const uHazeStrength = dyno.dynoFloat(0.60);

  // Glow halo shape (bake the keeper when settled):
  // 0 keeps each splat's own shape when glowing (elongated splats become
  // long spikes), 1 kneads it into a sphere (round dreamy halo).
  const uGlowRound = dyno.dynoFloat(0.5);

  // Skeleton strength: how visibly the sparse point-cloud premonition of the
  // room shows through the pre-reveal void (0 = classic pure black).
  const uSkeleton = dyno.dynoFloat(1);

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

      // Two masks, one number apart, because scale and colour must not share
      // the drift: a drift-modulated SCALE makes bright splats swell/shrink
      // over time, and any small dark feature between them (door handles,
      // mouldings) gets alternately covered and uncovered — the "black
      // shimmer on details" artifact confirmed by static-camera frame diffs
      // (72% of pixels changing at rest; 0.85% with glow off). So:
      //   glowMaskStatic (no drift) → geometry: boost + rounding
      //   glowMask       (drifted)  → colour: overexposure + tint breathe on
      // The light still waxes and wanes; the splats stop moving.
      const glowMaskStatic = dyno.mul(
        dyno.smoothstep(
          dyno.dynoConst("float", 0.25),
          dyno.dynoConst("float", 0.95),
          lum,
        ),
        uGlow,
      );
      const glowMask = dyno.mul(
        dyno.smoothstep(
          dyno.dynoConst("float", 0.25),
          dyno.dynoConst("float", 0.95),
          dyno.add(lum, dyno.mul(dyno.dynoConst("float", 0.12), drift)),
        ),
        uGlow,
      );

      // (1) Halo shape. Splats are anisotropic gaussians — light fixtures are
      //     often long thin splats, and inflating them along their own axes
      //     (the old approach) produced long sharp spikes. Instead the shape
      //     is blended toward an isotropic sphere (radius = mean of the three
      //     axes) as glow rises: the gaussian falloff then reads as a round,
      //     dreamy halo. Boost is the original ×2.6 max, radius uncapped.
      const boost = dyno.add(
        dyno.dynoConst("float", 1.0),
        dyno.mul(dyno.dynoConst("float", 1.6), glowMaskStatic),
      );
      const meanScale = dyno.dot(
        scales3,
        dyno.dynoConst("vec3", [1 / 3, 1 / 3, 1 / 3]),
      );
      const haloVec = dyno.mul(
        dyno.dynoConst("vec3", [1, 1, 1]),
        dyno.mul(meanScale, boost),
      );
      // glowMask can exceed 1 (it carries uGlow), so clamp the blend factor —
      // an extrapolating mix would overshoot the sphere into inverted shapes.
      const roundT = dyno.min(
        dyno.mul(glowMaskStatic, uGlowRound),
        dyno.dynoConst("float", 1.0),
      );
      const newScales = dyno.mix(dyno.mul(scales3, boost), haloVec, roundT);

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

      // Global exposure before the flow wave — uniform multiply on luminosity,
      // no contrast change. Live-tunable; replaces the old fixed 1.10 lift.
      const liftedRgb = dyno.mul(
        dyno.splitGsplat(gsplat).outputs.rgb,
        uExposure,
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
      // Haze colour: a grey with only a whisper of violet — saturating it
      // reads as "purple fog" instead of depth.
      const HAZE = dyno.dynoConst("vec3", [0.79, 0.77, 0.84]);
      const dist = dyno.length(dyno.splitGsplat(gsplat).outputs.center);
      const fogAmount = dyno.mul(
        dyno.sub(
          dyno.dynoConst("float", 1.0),
          dyno.exp(dyno.mul(
            dyno.mul(uHazeDensity, dyno.dynoConst("float", -1.0)),
            dist,
          )),
        ),
        uHazeStrength,
      );
      const hazedRgb = dyno.mix(dyno.splitGsplat(gsplat).outputs.rgb, HAZE, fogAmount);
      gsplat = dyno.combineGsplat({ gsplat, rgb: hazedRgb });

      // Step 5 — entry reveal, two fronts expanding from the orb.
      //
      // REVEAL_CENTER is in the splat's LOCAL space (the objectModifier runs
      // pre-transform): main.js offsets the mesh by position.y = 0.4, so the
      // orb's world anchor (0, 1.4, -1.6) is local (0, 1.0, -1.6). Compile-time
      // constant — the orb never moves.
      //
      // Hiding uses scales (not alpha): below one pixel a splat vanishes, and
      // shrinking is far cheaper than alpha-blending hundreds of thousands of
      // large splats. Three states, two masks:
      //   solid (original scales) → dust (uDustScale points) → hidden (0.5 mm)
      const REVEAL_CENTER = dyno.dynoConst("vec3", [0.0, 1.0, -1.6]);
      const dC = dyno.length(dyno.sub(
        dyno.splitGsplat(gsplat).outputs.center,
        REVEAL_CENTER,
      ));

      // Log-space fronts: radius = R0 * (e^(progress·span) − 1), which is 0 at
      // progress 0 and exactly the measured scene radius at progress 1.
      // The dust front runs the same curve with a constant log-space lead, so
      // the dust band stays a constant *ratio* ahead — perceptually a steady
      // ring of star-dust at every distance. smoothstep(0, 0.12, uReveal)
      // grows that lead from zero so the dormant state stays fully black
      // (otherwise a small dust bubble would float around the orb at rest).
      const R0 = dyno.dynoConst("float", REVEAL_R0);
      const solidFront = dyno.mul(R0, dyno.sub(
        dyno.exp(dyno.mul(uReveal, uRevealSpan)),
        dyno.dynoConst("float", 1.0),
      ));
      const lead = dyno.mul(uDustLead, dyno.smoothstep(
        dyno.dynoConst("float", 0.0),
        dyno.dynoConst("float", 0.12),
        uReveal,
      ));
      const dustFront = dyno.mul(R0, dyno.sub(
        dyno.exp(dyno.add(dyno.mul(uReveal, uRevealSpan), lead)),
        dyno.dynoConst("float", 1.0),
      ));

      // dustZone: 1 outside the condense front (still dust), 0 once solid.
      // The 2.5 m ramp is the visible "mist condensing into matter" band.
      const dustZone = dyno.smoothstep(
        dyno.sub(solidFront, dyno.dynoConst("float", 2.5)),
        solidFront,
        dC,
      );
      // hiddenMask: 1 beyond the dust front — not summoned yet.
      const hiddenMask = dyno.smoothstep(
        dyno.sub(dustFront, dyno.dynoConst("float", 1.0)),
        dustFront,
        dC,
      );

      // vec3(uDustScale) — scalar to vec3 via multiply, no constructor needed.
      const DUST_VEC = dyno.mul(dyno.dynoConst("vec3", [1, 1, 1]), uDustScale);
      const HIDDEN_VEC = dyno.dynoConst("vec3", [0.0005, 0.0005, 0.0005]);

      // Skeleton: ~2% of hidden splats stay faintly visible as micro points —
      // a sparse premonition of the room inside the pre-reveal void (the world
      // is sensed, not shown; the real reveal then swallows it). Selection is
      // a classic position hash so the subset is stable frame to frame; the
      // points are half dust size and dimmed hard so the title stays readable.
      const skelHash = dyno.fract(dyno.mul(
        dyno.sin(dyno.add(
          dyno.mul(x, dyno.dynoConst("float", 12.9898)),
          dyno.mul(z, dyno.dynoConst("float", 78.233)),
        )),
        dyno.dynoConst("float", 43758.5453),
      ));
      // Highlight weighting for both density and brightness: bright splats
      // (window, lamp, lit walls) are picked ~3x as often, so the skeleton
      // sketches the room's light structure instead of a uniform star field.
      const skelLum = dyno.smoothstep(
        dyno.dynoConst("float", 0.30),
        dyno.dynoConst("float", 0.85),
        lum,
      );
      const skelEdge = dyno.sub(
        dyno.dynoConst("float", 0.975),
        dyno.mul(dyno.dynoConst("float", 0.045), skelLum),
      );
      const skelMask = dyno.mul(
        dyno.mul(
          dyno.smoothstep(
            dyno.sub(skelEdge, dyno.dynoConst("float", 0.01)),
            skelEdge,
            skelHash,
          ),
          uSkeleton,
        ),
        hiddenMask,
      );
      // Full dust size (4 mm): anything smaller drops sub-pixel in-headset,
      // where the 0.85 framebuffer scale eats small points first.
      const SKEL_VEC = dyno.mul(
        dyno.dynoConst("vec3", [1, 1, 1]),
        uDustScale,
      );
      // Per-splat hidden appearance: invisible for most, a micro point for
      // the skeleton subset.
      const hiddenVec = dyno.mix(HIDDEN_VEC, SKEL_VEC, skelMask);

      const revealScales = dyno.mix(
        dyno.mix(dyno.splitGsplat(gsplat).outputs.scales, DUST_VEC, dustZone),
        hiddenVec,
        hiddenMask,
      );
      // Dust is dimmed 35% so it reads as dormant; full brightness returns
      // exactly when the condense front restores full size.
      //
      // Skeleton brightness = base 0.2, pushed to 0.75 on highlights — the
      // sparse points sketch the room's LIGHT structure (window, lamp), not a
      // uniform star field. A slow ripple radiating from the orb centre
      // modulates it ±35%: the void breathes faintly around her, and the
      // ripple's outward direction quietly foreshadows the reveal itself.
      const skelRipple = dyno.add(
        dyno.dynoConst("float", 0.65),
        dyno.mul(
          dyno.dynoConst("float", 0.35),
          dyno.sin(dyno.sub(
            dyno.mul(dC, dyno.dynoConst("float", 1.4)),
            dyno.mul(uTime, dyno.dynoConst("float", 0.9)),
          )),
        ),
      );
      const skelBright = dyno.mul(
        dyno.mix(
          dyno.dynoConst("float", 0.2),
          dyno.dynoConst("float", 0.75),
          skelLum,
        ),
        skelRipple,
      );
      const revealRgb = dyno.mul(
        dyno.splitGsplat(gsplat).outputs.rgb,
        dyno.mul(
          dyno.sub(
            dyno.dynoConst("float", 1.0),
            dyno.mul(dyno.dynoConst("float", 0.35), dustZone),
          ),
          dyno.mix(
            dyno.dynoConst("float", 1.0),
            skelBright,
            skelMask,
          ),
        ),
      );
      gsplat = dyno.combineGsplat({ gsplat, scales: revealScales, rgb: revealRgb });

      return { gsplat };
    },
  );

  // Compile the node graph into shader code once.
  // Never call this again in the render loop — Spark handles incremental
  // uniform updates automatically each frame.
  splatMesh.updateGenerator();

  // Measure the real scene radius once the splat data is loaded, so the
  // sweep's endpoint covers everything (sky splats included) in any world.
  // Bounding box and REVEAL_CENTER are both in the mesh's local space.
  const REVEAL_CENTER_LOCAL = [0.0, 1.0, -1.6];
  splatMesh.initialized.then(() => {
    const box = splatMesh.getBoundingBox(true);
    const [cx, cy, cz] = REVEAL_CENTER_LOCAL;
    let rMax = 0;
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z])
          rMax = Math.max(rMax, Math.hypot(x - cx, y - cy, z - cz));
    // +5 m margin keeps the condense band (2.5 m) fully past the farthest
    // splat at uReveal = 1, so the settled image is bit-identical to no-effect.
    uRevealSpan.value = Math.log((rMax + 5) / REVEAL_R0 + 1);
  });

  // Reveal driver state. Progress is accumulated from elapsed-time deltas
  // inside update() — never requestAnimationFrame, which both stops firing
  // inside a WebXR session and pauses while the headset is off.
  //
  // Two phases: the ceremonial curve carries the condense front out to
  // SPRINT_RADIUS at the original pacing; beyond it the sprint drives the
  // front at CONSTANT radial speed (metres/second, linear space) — the far
  // field marches in steadily instead of popping. The sprint is driven in
  // radius and converted back to uReveal through the inverse of the shader's
  // exponential curve each frame, so the shader stays untouched.
  const SPRINT_RADIUS = 10;   // metres — where the sprint takes over
  const SPRINT_SPEED  = 25;   // target cruise speed (m/s) before clamping
  const SPRINT_MIN_S  = 4;    // sprint duration clamp (seconds)
  const SPRINT_MAX_S  = 9;
  const SPRINT_RAMP   = 0.4;  // seconds easing from handover speed to cruise
  let revealPhase = null;     // null | "main" | "sprint"
  let revealT = 0;            // linear time 0..1 within the main phase
  let sprintFromU = 1;        // uReveal value where the sprint begins
  let sprintR = 0;            // sprint front radius (m)
  let sprintEndR = 0;         // measured scene radius (m)
  let sprintV0 = 0;           // radial speed inherited from the main curve
  let sprintVCruise = 0;      // constant cruise speed (m/s)
  let sprintTime = 0;
  let revealDuration = 15;
  let revealResolve = null;
  let lastElapsed = null;
  let frameCount = 0;

  // External trigger for the reveal (session.js calls this when the AI
  // response is ready; or call window._fx.playReveal() to trial it).
  // Resolves once both fronts have swept past the scene's farthest splat.
  function playReveal(duration = 15) {
    revealDuration = duration;
    // Progress at which the condense front crosses SPRINT_RADIUS — inverse
    // of the shader's exponential radius curve, using the measured span
    // (read at call time; the bounding box has long since resolved).
    sprintFromU = Math.min(
      Math.log(SPRINT_RADIUS / REVEAL_R0 + 1) / uRevealSpan.value,
      1,
    );
    revealPhase = "main";
    revealT = 0;
    uReveal.value = 0;
    return new Promise((resolve) => { revealResolve = resolve; });
  }

  const api = {
    update(elapsed) {
      uTime.value = elapsed;

      const dt = lastElapsed === null ? 0 : elapsed - lastElapsed;
      lastElapsed = elapsed;

      if (revealPhase === "main") {
        revealT = Math.min(revealT + dt / revealDuration, 1);
        // Quadratic ease-out only: the shader's exponential radius already
        // paces the sweep perceptually (near field slow, far sky fast), so a
        // strong cubic here would stall the ending. This just softens onset.
        const u = revealT * (2 - revealT);
        if (u >= sprintFromU || revealT >= 1) {
          // Hand over exactly at the boundary value so the front never jumps.
          uReveal.value = sprintFromU;
          revealPhase = "sprint";
          sprintEndR = REVEAL_R0 * (Math.exp(uRevealSpan.value) - 1);
          if (sprintEndR <= SPRINT_RADIUS + 1) {
            // Scene smaller than the sprint boundary — the main curve already
            // covered it; nothing left to sprint through.
            uReveal.value = 1;
            revealPhase = null;
            revealResolve?.();
            revealResolve = null;
          } else {
            // Duration scales with scene size, clamped to 2–5 s; cruise speed
            // is then constant for the whole run (uniformity over exact speed).
            const dur = Math.min(Math.max(
              (sprintEndR - SPRINT_RADIUS) / SPRINT_SPEED, SPRINT_MIN_S), SPRINT_MAX_S);
            sprintVCruise = (sprintEndR - SPRINT_RADIUS) / dur;
            // Radial speed of the main curve at handover (chain rule on
            // r = R0·(e^(u·span)−1), u = t(2−t)) — the ramp starts here so
            // the front accelerates smoothly instead of kicking.
            sprintV0 = uRevealSpan.value * (SPRINT_RADIUS + REVEAL_R0)
              * 2 * (1 - revealT) / revealDuration;
            sprintR = SPRINT_RADIUS;
            sprintTime = 0;
          }
        } else {
          uReveal.value = u;
        }
      } else if (revealPhase === "sprint") {
        sprintTime += dt;
        // Brief smoothstep ramp from the inherited speed up to cruise, then
        // constant m/s to the scene edge — no deceleration at the end.
        const ramp = Math.min(sprintTime / SPRINT_RAMP, 1);
        const blend = ramp * ramp * (3 - 2 * ramp);
        const v = sprintV0 + (sprintVCruise - sprintV0) * blend;
        sprintR = Math.min(sprintR + v * dt, sprintEndR);
        // Inverse of the shader's radius curve: feed the linear-space radius
        // back through as a uReveal value.
        uReveal.value = Math.log(sprintR / REVEAL_R0 + 1) / uRevealSpan.value;
        if (sprintR >= sprintEndR) {
          uReveal.value = 1;
          revealPhase = null;
          revealResolve?.();
          revealResolve = null;
        }
      }

      // Spark caches generated splat data and only re-runs the dyno pipeline
      // when the mesh version changes — without this bump, uniform .value
      // writes (uTime drift, uReveal, console tuning) silently never land.
      // Confirmed against spark 0.1.9 source: SparkRenderer compares
      // generator.version per frame; SplatMesh.update() only bumps it for
      // built-in params (transform/recolor), never for user dyno uniforms.
      //
      // Bumped every OTHER frame: regeneration walks every splat, and paying
      // that each frame leaves no headroom for the re-sort that view rotation
      // triggers (the rotation stutter). The ambient drifts are far too slow
      // to read the difference at 30 Hz. Exception: while the reveal plays,
      // the front moves metres per frame, so it gets the full rate.
      // (bumpEveryFrame is a device-side diagnostic — ?bump=1 — for testing
      // whether the half-rate stepping reads as texture flicker in-headset.)
      frameCount += 1;
      if (api.bumpEveryFrame || revealPhase !== null || frameCount % 2 === 0) {
        splatMesh.updateVersion();
      }
    },
    playReveal,
    bumpEveryFrame: false,
    uniforms: {
      uGlow, uBreath, uTime, uReveal, uDustScale, uDustLead,
      uExposure, uHazeDensity, uHazeStrength, uGlowRound, uSkeleton,
    },
  };
  return api;
}
