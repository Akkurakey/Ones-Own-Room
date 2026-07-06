# One's Own Room

A WebXR room that owes you nothing. Named after Virginia Woolf's *A Room of One's Own*: an autonomous space where you may give less — no name needed, no mood required, no words expected. A nameless voice (the room's own gentle consciousness) welcomes you at the threshold; the world condenses out of darkness the moment she first speaks to you; afterwards, holding the orb is talking to her, and leaving it alone is solitude.

Built for Meta Quest 3, playable in any WebXR browser; a desktop fallback runs the same flow with mouse and keyboard.

## Stack

Three.js 0.178 + [Spark](https://sparkjs.dev) (Gaussian splatting, dyno GPU shaders) · WebXR · Marble (pre-generated splat worlds) · Claude (script generation + language detection) · ElevenLabs (TTS + STT). No build tools — plain ES modules via importmap.

## Run

```bash
# frontend only (AI pipeline falls back to pre-recorded lines)
npx serve public

# full pipeline (needs .env.local with ANTHROPIC_API_KEY and ELEVENLABS_API_KEY)
node dev-server.mjs
```

Then open http://localhost:3000. Append `?debug` for first-person controls and the key-`0` check-in skip.

Design document (Chinese): [docs/design.md](docs/design.md)
