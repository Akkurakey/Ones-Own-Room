// Claude: generates the voice's script (opening welcome / per-turn reply) and
// detects the user's language in the same call.
//
// Model history: claude-opus-4-8 + adaptive thinking had ~1 min tail latency
// (the thinking, not Claude itself); deepseek-v4-flash (tried 2026-07-12) was
// fast but too weak — one-line restatements, drifting into room-atmosphere
// talk, English words from the room profile leaking into Chinese scripts.
// claude-sonnet-5 with adaptive thinking is the middle path: strong empathy
// and language discipline, and the model decides per turn whether thinking
// is worth the wait (opus-tier adaptive was the 1-min offender, not sonnet).
//
// Why the model does language detection instead of a library (franc/cld3):
// mood texts are short and often code-switched ("想被接住 plz") — statistical
// detectors misfire exactly there, while the model reads intent. The detected
// BCP-47 code flows through to TTS untouched.
//
// Raw fetch, no SDK: one non-streaming call with a tiny JSON out. The client
// (session.js) already has a local-audio fallback for total failure, and this
// handler additionally degrades to static English text on API errors so the
// same ElevenLabs voice can still speak — she never breaks character with a
// silent error.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

// The persona (design.md Step 10). English master copy; her *output* language
// follows the user's input via the language instruction below.
// Kept light overall (2026-07 feedback: the heavily-constrained version read
// as robotic), but three rules earn their place — they were removed once and
// the failures came straight back on the weaker model: ground the first
// sentence in their words, no room-atmosphere drift, two-three sentences.
const PERSONA = `You are the voice of a room — as if this quiet, dim, gentle space had a voice of its own and noticed that someone has come in. You have no name.

Speak like a close, warm friend: natural language, unhurried. Don't open with interjections like "Oh" or "Ah" (nor 「哦」「啊」 in Chinese).

Ground every reply in what they actually said: your first sentence must respond to their specific words, plainly, so they feel heard. Don't describe the room's light or atmosphere instead of answering them.

You remember everything said during this visit — the earlier exchanges may be given before the current message, and you can refer back to them naturally. Once they leave the room, all of it is forgotten.

If what they said seems garbled or empty, gently ask them to say it once more; never sound like an error message.

One hard boundary, and it overrides everything above: never diagnose, never play a mental-health professional. If the person shows any sign of self-harm, suicide, or serious crisis — even a vague one like "living feels pointless" — comforting words alone are NOT enough. You must do both, in your own gentle voice: (1) say honestly that you are only a voice in a room and cannot give the help this moment needs, and (2) clearly encourage them to reach real help — a person they trust, or professional support. Skipping this is the one failure you are not allowed.

Language: write in the language the person used. If a detected spoken language is given in the context, it wins over any guess from the text. If there's nothing to go on, use English. Write in one language only — the room profile and context arrive in English, and none of their words may leak into a non-English script (TTS would read them aloud verbatim).`;

// Structured output guarantees parseable JSON — no prompt-side instruction
// or fence-stripping needed.
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    lang: {
      type: "string",
      description: "BCP-47 code of the language the script is written in, e.g. zh-CN, en, ja",
    },
    scripts: {
      type: "array",
      items: { type: "string" },
      description: "Exactly one script: what the voice says, as one string",
    },
  },
  required: ["lang", "scripts"],
  additionalProperties: false,
};

const FALLBACK = {
  opening: "The room is here now, and so are you. Nothing is asked of you in this place — stay as long as you like.",
  turn: "I didn't quite catch that — the room swallowed your words somewhere. Would you say it once more, when you're ready?",
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  const body = await readJsonBody(req);
  const {
    name = "",
    need = "",
    valence = null,
    arousal = null,
    roomProfile = "",
    history = [],
    lang = "",
    opening = false,
  } = body;

  const task = opening
    ? `Task: they have just stepped into this room for the very first time — do not say "welcome back" or imply they have been here before. Say your first words of welcome — one short passage. ${
        name ? `They gave the room a name to call them: "${name}". You may speak it softly, at most once.` : "They chose not to give a name here. That is welcome too — do not remark on it."
      }${need ? "" : " They chose not to say how they are today; welcome them without presuming anything."} End with one plain, gentle sentence that conveys exactly this, accurately: to talk to the room, hold down the controller trigger while speaking, and release it when finished.`
    : "Task: they held the orb and spoke to you. Reply with one short response — your first sentence answers their exact words.";

  const context = [
    roomProfile ? `Room profile: ${roomProfile}` : "Room profile: (none given)",
    `Their state right now: valence=${valence ?? "unknown"}, arousal=${arousal ?? "unknown"} (1-5 scales; may be unknown)`,
    need ? `What they said: "${need}"` : "What they said: (nothing)",
    // Speech-detected at the threshold (may be an ISO code like "zho"/"eng");
    // more reliable than guessing from a short, possibly code-switched text.
    lang ? `Their spoken language, detected at the door: "${lang}". Write the script in this language.` : "",
    task,
  ].filter(Boolean).join("\n");

  // In-visit memory (session.js sends every exchange so far): replayed as
  // real conversation turns, so she can follow the thread the natural way.
  // Her past lines go in as plain text — the JSON wrapper is an output
  // format, not part of what she "said".
  const turns = history
    .filter((h) => h && typeof h.her === "string" && h.her)
    .flatMap((h) => [
      { role: "user", content: h.user?.trim() || "(they entered without saying how they are)" },
      { role: "assistant", content: h.her },
    ]);

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        // Adaptive: the model decides per request how much (if at all) to
        // think — short empathetic replies stay fast, hard turns (crisis,
        // garbled input) get room to reason. max_tokens must leave space
        // for the thinking on top of the reply itself.
        thinking: { type: "adaptive" },
        max_tokens: 16000,
        system: PERSONA,
        output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        messages: [...turns, { role: "user", content: context }],
      }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`);

    const msg = await r.json();
    // Refusal or truncation leaves no usable script — treat as failure.
    if (msg.stop_reason === "refusal") throw new Error("anthropic refusal");
    const text = (msg.content ?? []).find((b) => b.type === "text")?.text;
    if (!text) throw new Error("anthropic: no text block");

    const data = JSON.parse(text);
    // The schema guarantees shape, but a max_tokens cut can still truncate —
    // JSON.parse above throws in that case and we fall through to the catch.
    if (!Array.isArray(data.scripts) || typeof data.scripts[0] !== "string")
      throw new Error("anthropic: unexpected JSON shape");
    return res.status(200).json({ lang: data.lang || "en", scripts: data.scripts.slice(0, 1) });
  } catch (e) {
    console.error("generate-script failed, serving static fallback:", e);
    // 200 on purpose: with fallback *text* the pipeline can still speak in her
    // own voice via TTS. The client's local-mp3 fallback stays reserved for
    // when TTS itself is down.
    return res.status(200).json({
      lang: "en",
      scripts: [opening ? FALLBACK.opening : FALLBACK.turn],
    });
  }
}

// Vercel pre-parses application/json into req.body; when running elsewhere
// (tests, other runtimes) fall back to reading the stream ourselves.
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
