# One's Own Room

A virtual safe room. 

Built for Meta Quest 3, playable in any WebXR browser.

## Stack

Three.js 0.178 + [Spark](https://sparkjs.dev) (Gaussian splatting, dyno GPU shaders) · WebXR · Marble (ai-generated splat worlds) · ElevenLabs (TTS + STT). 

---

# Why is it called *One's Own Room*?

The name is inspired by *A Room of One's Own* by Virginia Woolf: the idea that everyone needs a space of their own, free from interruption. In the context of an emotional safe zone, this room is a **self-governed virtual space created through the user's own agency**.

The project deliberately avoids framing itself as *therapy*, *meditation*, or a *guided wellbeing experience*, because those imply that the room is a service that does something *to* the user. Instead, the room does nothing. It simply **exists**.

Everything is determined by the person who inhabits it. The voice you converse with is the room itself, and the space gradually reveals itself through your own input.

---

# System Architecture

| Layer | Input | Generation Method | Latency | Real-Time Behaviour |
|-------|-------|-------------------|---------|---------------------|
| **Room** | Marble prompt | World-model generation | Tens of seconds to several minutes | **Pre-generated (Wizard-of-Oz workflow)** |
| **Atmosphere Parameters** | Valence × Arousal scale | Shader uniforms | None | **True real-time, zero latency** |
| **Voice** | Mood description + turn-by-turn speech | LLM + TTS pipeline | 1–4 seconds | **Near real-time, turn-based** |

**Valence × Arousal Scale**

The emotional dimensions are based on **Russell's Circumplex Model of Affect (1980)**, which represents emotion within a two-dimensional space defined by **valence** and **arousal**.

The assessment uses the **Self-Assessment Manikin (SAM; Bradley & Lang, 1994)**.

---

# User Journey & Interaction

## On the Screen

1. **Title Screen**
   - Tap anywhere to begin (required to unlock audio playback).
   - The room says:
     > *"Welcome to your own room."*

2. **Name**
   - Enter a name, or select **"I don't need a name here"** to remain anonymous.

3. **Emotion Scales**
   - Select one figure on each scale:
     - **Valence:** Heavy → Light
     - **Arousal:** Calm → Turbulent

4. **Describe Your Mood**
   - **Press and hold anywhere on the screen to speak. Release to finish recording.**
   - Microphone permission is requested immediately after the emotion scales, so recording starts directly at this step.
   - Alternatively:
     - Select **"Not today"** to skip.
     - Tap the keyboard icon to type instead.

5. **Enter the Room**
   - The experience transitions automatically into the VR room.

---

## Inside the Room

| Action | Behaviour |
|--------|-----------|
| **Hold the orb (trigger or mouse button) to speak; release to finish.** | Begin a conversation. The room responds to what you say. |
| **Ignore the orb.** | Remain in solitude. The room will never initiate conversation. |
| **Thumbstick (either controller).** | Move freely in all directions relative to your head orientation. Movement stops automatically at the room boundaries. |
| **Hold the grip button (middle-finger button).** | Two floating beads appear above the controller: **A/X** mutes the ambient sound, **B/Y** exits the room. They disappear when the grip is released. |

---

# Researcher Console

A **Wizard-of-Oz control interface** for managing the pre-generated room layer. From the PC, researchers can switch rooms, adjust the atmosphere in real time, and monitor the participant's headset view via a pose-twin reconstruction.

### Room

Select a room from the dropdown menu, then click **Apply & Reload Headset**.

The headset automatically reloads into the selected room within approximately one second.

Participants return to the title screen and complete the check-in process again, so **the target room should be selected before the headset is worn**.

### Atmosphere (Real-Time)

The following parameters update immediately (typically within one second):

- Exposure
- Bloom
- Fog Density
- Fog Intensity
- Light Softness

Changes take effect as the sliders are moved. Once released, the headset reports the actual rendered values back to the console, keeping the UI synchronised.

### Pose-Twin Monitor

Click **Start** to display a **live reconstruction of the headset's first-person viewpoint** within the monitoring canvas.
