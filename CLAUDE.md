# Dreamcore VR Spa

WebXR relaxation experience. A guided, no-interaction VR spa with AI-personalised
voice and a "dreamcore" aesthetic, rendered with Gaussian splatting.

Full design spec: see @docs/design.md — always consult it before implementing a feature.

## Stack (do not change without asking)
- Three.js 0.178.0 + Spark (@sparkjsdev/spark 0.1.9) for Gaussian splat rendering
- WebXR (immersive-vr) targeting Meta Quest 3
- No build tools. Plain ES modules via importmap. Run with `npx serve`.
- DO NOT introduce Vite, Webpack, Tailwind, React, or any bundler/framework.

## Hard constraints (violating these breaks the experience — never do them)
- Main loop MUST use `renderer.setAnimationLoop()`, NEVER `requestAnimationFrame`
  (rAF does not fire inside a WebXR session).
- Audio MUST be unlocked inside the enter-VR button's click handler
  (AudioContext can't start outside a user gesture).
- The breathing effect MUST NOT include any rotation component
  (rotation in VR causes motion sickness). Amplitude stays <= 0.03 m.
- Lighting/glow/fog MUST be done inside Spark's dyno shader, NEVER with
  THREE.PointLight or scene.fog — splat colours are baked and ignore both.
- Bloom post-processing (EffectComposer) is DESKTOP-ONLY, never in the VR path.
- Move the user by moving the camera RIG (parent Group), never the camera itself
  (the headset owns the camera transform in VR).

## Language policy
- ALL user-facing UI text is in English.
- AI-generated voice scripts FOLLOW the user's input language (Claude detects it
  and returns a BCP-47 code that flows through to TTS). See design.md Step 8.

## File layout
- public/index.html          importmap + enter-VR button
- public/js/main.js          scene, WebXR, main loop
- public/js/effects.js       dyno shaders: breathing + reveal + glow + haze
- public/js/glow.js          additive sprite light-dust layer
- public/js/session.js       timeline: voice slots, env switching, fade
- public/js/audio.js         AudioContext, ambient, voice playback with ducking
- api/*.js                   Vercel serverless: Claude script gen + ElevenLabs TTS

## Commands
- Local dev:  node dev-server.mjs  (http://localhost:3000 — static + REAL api/
              pipeline with .env.local keys; use this for anything voice/AI)
- Frontend-only static alternative: npx serve public (api/* 404s → fallback voices)
- Deploy:     vercel

## Style
- Comments in code explaining WHY, not just what.
- Keep functions small. No premature abstraction.

