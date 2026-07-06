// ElevenLabs TTS: text in, mp3 out.
//
// One voice for everything — threshold guides, opening, every turn reply.
// She must be the same presence from the title screen into the room, so the
// voice id is a constant (env-overridable), never chosen per request.
// eleven_multilingual_v2 speaks zh/en/ja/... with that one voice, so language
// switching costs nothing; the client's `lang` is accepted for future use
// (e.g. Web Speech fallback) but multilingual_v2 detects language from text.

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel": calm, soft
const MODEL_ID = "eleven_multilingual_v2";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  const { text = "" } = await readJsonBody(req);
  if (!text.trim()) return res.status(400).json({ error: "text required" });

  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text,
          model_id: MODEL_ID,
          // High stability reads calmer and softer — gentler delivery was
          // explicit user feedback (2026-07); guides are generated with the
          // same settings so she is one voice throughout.
          voice_settings: { stability: 0.75, similarity_boost: 0.75 },
        }),
      },
    );
    if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${await r.text()}`);

    const audio = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    return res.status(200).send(audio);
  } catch (e) {
    console.error("tts failed:", e);
    // Plain 500: audio.js treats a non-ok TTS response as pipeline failure and
    // switches to the pre-recorded local fallbacks.
    return res.status(500).json({ error: "tts failed" });
  }
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
