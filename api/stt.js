// ElevenLabs Scribe STT: audio bytes in, transcript + detected language out.
//
// This is route B from design.md Step 12 — server-side STT with built-in
// language detection, which is the whole reason to pay the extra network hop:
// we never know in advance what language the user will speak, and Web Speech
// (route A) needs the language preset.
//
// The client POSTs the recorded blob as a RAW body (audio/webm etc.), not
// multipart — so this function needs no multipart parser; it just reads bytes
// and builds the outgoing FormData itself with Node's built-in Blob/FormData.

const MODEL_ID = "scribe_v1";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  try {
    const audio = await readRawBody(req);
    if (audio.length === 0) return res.status(400).json({ error: "empty audio" });

    const mime = req.headers["content-type"] || "audio/webm";
    // Filename extension matters to some decoders; derive it from the mime the
    // recorder actually produced (Quest may give ogg or mp4 instead of webm).
    const ext = mime.includes("ogg") ? "ogg"
      : mime.includes("mp4") ? "mp4"
      : mime.includes("mpeg") || mime.includes("mp3") ? "mp3"
      : "webm";

    const form = new FormData();
    form.append("model_id", MODEL_ID);
    form.append("file", new Blob([audio], { type: mime }), `clip.${ext}`);

    const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
      body: form,
    });
    if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${await r.text()}`);

    const data = await r.json();
    return res.status(200).json({ text: data.text ?? "", lang: data.language_code ?? "" });
  } catch (e) {
    console.error("stt failed:", e);
    // Non-ok → voice.js transcribe() throws → session._turn() plays the
    // in-character "I didn't quite catch that" fallback. Never hangs the orb.
    return res.status(500).json({ error: "stt failed" });
  }
}

// Raw body, whatever the content type. Vercel may have pre-buffered it into
// req.body (Buffer) for some types; otherwise read the stream.
async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
