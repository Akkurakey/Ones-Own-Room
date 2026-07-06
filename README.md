# One's Own Room

A WebXR room. 

Built for Meta Quest 3, playable in any WebXR browser; a desktop fallback runs the same flow with mouse and keyboard.

## Stack

Three.js 0.178 + [Spark](https://sparkjs.dev) (Gaussian splatting, dyno GPU shaders) · WebXR · Marble (pre-generated splat worlds) · Claude (script generation + language detection) · ElevenLabs (TTS + STT). No build tools — plain ES modules via importmap.
