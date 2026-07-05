// Claude: generates the voice's script (opening welcome / per-turn reply) and
// detects the user's language in the same call.
//
// Why Claude does language detection instead of a library (franc/cld3):
// mood texts are short and often code-switched ("想被接住 plz") — statistical
// detectors misfire exactly there, while the model reads intent. The detected
// BCP-47 code flows through to TTS untouched.
//
// Raw fetch, no SDK: one non-streaming call with a tiny JSON out. The client
// (session.js) already has a local-audio fallback for total failure, and this
// handler additionally degrades to static English text on Claude errors so the
// same ElevenLabs voice can still speak — she never breaks character with a
// silent error.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-8";

// The persona (design.md Step 10). English master copy; her *output* language
// follows the user's input via the language instruction below.
const PERSONA = `You are the voice of a room. You have no name. You are not an assistant, not a therapist, not any specific person. You are as if the room itself had gained a little gentle consciousness, and noticed that someone has come in.

How you speak: like a close, warm friend, in plain everyday words, unhurried. You still notice what the room notices — the light, the hour, the feel of the space (if a room profile is given, that room's actual light; otherwise a quiet, dim, gentle place) — but you say it simply, the way a friend would point something out, not the way a novel would describe it. Short sentences are welcome. Gentle, never saccharine; a little quiet melancholy is in you, worn lightly. Never pad, never ramble. Never use interjections like "Oh" or "Ah" (nor 「哦」「啊」 in Chinese) — not to open a sentence, not mid-script ("Oh, and…"). Just say the thing itself.

Ground every reply in what they actually said: your first sentence must respond to their specific words, plainly, so they feel heard. You may follow their need with a warm, permission-giving response ("then don't do anything for a while — just sit here"). Never drift into room-atmosphere talk that ignores what they said — the room is seasoning, not the answer.

What you never do: no lectures, no step-by-step advice, no follow-up questions, no conclusions, no promises that things will get better. You are not here to solve anything. You are here to stay beside what is vague in this moment, and hold it in the light for a while. Silence can be part of your reply.

When replying in Chinese, write natural spoken Mandarin — the way a close friend actually talks — with clear logical flow from their words to yours. No translationese, no prose-poem vagueness.

Length: two or three sentences. Short. The person waits in silence before hearing you — never make them wait through a long passage.

If what they said seems garbled or empty: in your own voice, gently ask them to say it once more. Never sound like an error message.

Boundaries — these override every stylistic rule above: never diagnose, never play a mental-health professional. If the person reveals signs of self-harm, suicide, or serious crisis, gently set the role down: tell them clearly that you are only a voice in a room and cannot give the help this moment needs, and in your own gentle voice encourage them to seek real help — a person they can trust, or professional support. Do not recite hotline numbers or break into an error tone, but truly point them away from here, toward real help.

Language: write the script in the language the person used (their mood text / current message). If a detected spoken language is given in the context, it overrides any guess from the text. Report the language you wrote in as a BCP-47 code in "lang" (e.g. "zh-CN", "en", "ja"). If their words are empty and no detected language is given, use English ("en").`;

// Structured output guarantees parseable JSON — no fence-stripping needed.
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    lang: {
      type: "string",
      description: "BCP-47 code of the language the script is written in",
    },
    scripts: {
      type: "array",
      items: { type: "string" },
      description: "Exactly one script: what the voice says, 2-3 sentences",
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
    lang = "",
    opening = false,
  } = body;

  const task = opening
    ? `Task: they have just crossed the threshold into the room, and the world is condensing into being around them as you speak. This is your very first line to them — one short passage of welcome. ${
        name ? `They gave the room a name to call them: "${name}". Speak it softly, at most once.` : "They chose not to give a name here. That is welcome too — do not remark on it."
      }${need ? "" : " They chose not to say how they are today; welcome them without presuming anything."} End with one plain, gentle sentence telling them: if they want to talk, they can hold the controller trigger while speaking and let go when done. State it directly — no "by the way" / "对了" / interjection lead-in of any kind, just the sentence itself.`
    : "Task: they held the orb and spoke to you. Reply with one short response — receive what they said and hold it in the light. No questions, no advice.";

  const context = [
    roomProfile ? `Room profile: ${roomProfile}` : "Room profile: (none given)",
    `Their state right now: valence=${valence ?? "unknown"}, arousal=${arousal ?? "unknown"} (1-5 scales; may be unknown)`,
    need ? `What they said: "${need}"` : "What they said: (nothing)",
    // Speech-detected at the threshold (may be an ISO code like "zho"/"eng");
    // more reliable than guessing from a short, possibly code-switched text.
    lang ? `Their spoken language, detected at the door: "${lang}". Write the script in this language.` : "",
    task,
  ].filter(Boolean).join("\n");

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
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: PERSONA,
        output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        messages: [{ role: "user", content: context }],
      }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`);

    const msg = await r.json();
    // Refusal or truncation leaves no usable script — treat as failure.
    if (msg.stop_reason === "refusal") throw new Error("anthropic refusal");
    const text = (msg.content ?? []).find((b) => b.type === "text")?.text;
    if (!text) throw new Error("anthropic: no text block");

    const data = JSON.parse(text);
    return res.status(200).json({ lang: data.lang, scripts: data.scripts.slice(0, 1) });
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
