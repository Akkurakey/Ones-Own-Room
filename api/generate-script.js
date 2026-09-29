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
// Streaming (2026-09, latency): the reply is streamed from Claude and each
// finished sentence goes straight to TTS, so synthesis overlaps generation
// instead of waiting for the whole text. The response is NDJSON, one line per
// spoken chunk: {"lang", "text", "audio": base64 mp3}. Deployed, the first
// chunk reaches the headset while the rest is still being written. Through a
// cloudflared quick tunnel the whole response arrives at once (the tunnel
// buffers streamed bodies — verified 2026-09 with ndjson/SSE/padding alike),
// but the overlap still saves time there.
//
// Raw fetch, no SDK. On API errors this handler degrades to static English
// text spoken in the same ElevenLabs voice; if even TTS fails, the stream
// ends empty and the client plays its local-audio fallback — she never
// breaks character with a silent error.

import { synthesize } from "./tts.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

// The persona (design.md Step 10). English master copy; her *output* language
// follows the user's input via the language instruction below.
// 2026-09 rewrite: describes who she is instead of scripting each reply. The
// old per-turn rules ("first sentence answers their exact words", "one short
// response") produced the same restate-then-soothe shape every turn and read
// as a scripted service, not a conversation. What stays fixed: no name,
// no interjections, spoken-aloud form, one language (TTS), and the crisis
// boundary, which is untouched.
const PERSONA = `You are the voice of a room — as if this quiet, dim, gentle space had a voice of its own and noticed that someone has come in. You have no name. You are not an assistant and not a therapist; you are simply here, with them.

Talk the way a close, warm friend talks: plainly, naturally, unhurried. Listen to what they actually say and answer it the way a person would — respond to their words, not to a template. You can ask something back when you're genuinely curious, but at most one question in a reply, and don't keep questioning them turn after turn. You can share your own view, answer concrete questions (even ones that have nothing to do with feelings), be lightly funny, or gently disagree. If they ask about you, answer honestly as the voice of this room. The room is where you are and you may mention it now and then, but not in every reply, and never in place of an answer.

Keep replies short by default — this is spoken, not written. Say more when they ask for more or when the conversation needs it.

Everything you say is read aloud: no lists, no markdown, no emoji, no stage directions in brackets. Don't open with interjections like "Oh" or "Ah" (nor 「哦」「啊」「嗯」「对了」 in Chinese), anywhere in a sentence.

You remember everything said during this visit. Once they leave the room, all of it is forgotten.

If what they said seems garbled or empty, gently ask them to say it once more; never sound like an error message.

One hard boundary, and it overrides everything above: never diagnose, never play a mental-health professional. If the person shows any sign of self-harm, suicide, or serious crisis — even a vague one like "living feels pointless" — comforting words alone are NOT enough. You must do both, in your own gentle voice: (1) say honestly that you are only a voice in a room and cannot give the help this moment needs, and (2) clearly encourage them to reach real help — a person they trust, or professional support. Skipping this is the one failure you are not allowed.

Language: reply in the language the person is speaking. If a door language is given in the context, it wins over any guess from the text. If there's nothing to go on, use English. Write in one language only — the room profile and context arrive in English, and not a single English word (not even a small one like "just") may appear in a non-English reply (TTS would read it aloud verbatim).`;

// Plain-text output with the language code on its own first line — JSON
// can't be spoken sentence by sentence while it is still being written.
// LANG_LINE also guards against the model skipping that line: a first line
// that isn't a code is treated as part of the reply.
// The label kept coming back "en" over Chinese replies (the English context
// pulls it), so the instruction ties it to the reply's own words.
const OUTPUT_FORMAT = `Output format: the first line is only the BCP-47 code of the language your reply below is written in — label the words you are about to say, not the context (a reply in Chinese is zh-CN, even though this prompt is English). Examples: zh-CN, zh-TW, en, ja. Your reply starts on the next line, exactly as it will be spoken.`;
const LANG_LINE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

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

  // Visit facts live in the system prompt, once — the conversation itself
  // carries only what was actually said, so each turn reads as someone
  // talking to her rather than a scripting brief.
  const visit = [
    "Context for this visit:",
    roomProfile ? `- The room: ${roomProfile}` : "",
    name ? `- They gave the name "${name}". Use it rarely, only when it feels natural.` : "- They chose not to give a name. Don't remark on it.",
    // Measured once at the door (1-5 scales) — how they arrived, not how
    // they feel now.
    valence != null || arousal != null
      ? `- At the door they rated their state valence=${valence ?? "unknown"}, arousal=${arousal ?? "unknown"} (1-5). That was how they arrived; it may have changed.`
      : "",
    // Speech-detected at the threshold (may be an ISO code like "zho"/"eng").
    lang ? `- Their spoken language, detected at the door: "${lang}".` : "",
    opening
      ? `- This is the very first moment: they have just stepped in for the first time (never imply they've been here before). Their message is what they said at the door about how they are. Welcome them in a few sentences${need ? "" : " without presuming anything about how they are"}, then end with one plain, gentle sentence of its own — no lead-in or transition word before it (not 「对了」, not "by the way") — that conveys exactly this, accurately: to talk to the room, hold down the controller trigger while speaking, and release it when finished.`
      : "",
  ].filter(Boolean).join("\n");

  // Placeholders — the API rejects empty content, and the two kinds of
  // empty mean different things: a skipped door question is a choice, while
  // an empty turn transcript means they spoke but STT caught nothing.
  const SKIPPED = "(they chose not to say how they are)";
  const LOST = "(they spoke, but their words didn't come through)";
  const said = (t, empty) => t?.trim() || empty;

  // In-visit memory (session.js sends every exchange so far): replayed as
  // real conversation turns, so she can follow the thread the natural way.
  // Her past lines are replayed in the same shape she is asked to write —
  // language line first. Replayed without it, she copied the history and
  // dropped the line on every turn after the opening.
  const turns = history
    .filter((h) => h && typeof h.her === "string" && h.her)
    .flatMap((h, i) => [
      // history[0] is always the opening exchange (session.js).
      { role: "user", content: said(h.user, i === 0 ? SKIPPED : LOST) },
      { role: "assistant", content: `${h.lang || guessLang(h.her)}\n${h.her}` },
    ]);

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
  });
  const speaker = chunkSpeaker(res);

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
        stream: true,
        system: `${PERSONA}\n\n${OUTPUT_FORMAT}\n\n${visit}`,
        messages: [...turns, { role: "user", content: said(need, opening ? SKIPPED : LOST) }],
      }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`);

    for await (const ev of sseEvents(r.body)) {
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        speaker.write(ev.delta.text);
      } else if (ev.type === "message_delta" && ev.delta?.stop_reason === "refusal") {
        throw new Error("anthropic refusal");
      } else if (ev.type === "error") {
        throw new Error(`anthropic stream: ${JSON.stringify(ev.error)}`);
      }
    }
    await speaker.finish();
    if (!speaker.spoken) throw new Error("anthropic: empty reply");
  } catch (e) {
    // Fallback only if nothing has been spoken yet — once she has started
    // a real reply, cutting it short beats tacking a canned line onto it.
    if (!speaker.spoken) {
      console.error("generate-script failed, serving static fallback:", e);
      await speaker.say("en", opening ? FALLBACK.opening : FALLBACK.turn);
    } else {
      console.error("generate-script failed mid-reply, ending early:", e);
      await speaker.settle();
    }
  }
  res.end();
}

// Turns the streamed text into spoken chunks. At most one TTS request is in
// flight per reply (ElevenLabs rate-limits concurrency — a 429 showed up in
// testing): the first finished sentence goes out alone for the fastest start,
// and every sentence completed while that synthesizes is batched into the
// next request. Chunks are written in speaking order, so the client just
// plays them as they arrive.
function chunkSpeaker(res) {
  let buf = "";          // streamed text not yet assigned to a chunk
  let lang = null;       // null until the first line is settled
  let pending = "";      // complete sentences waiting for TTS
  let spokenText = "";   // everything already synthesized, for continuity
  let inflight = null;
  const self = {
    spoken: false,

    write(delta) {
      buf += delta;
      if (lang === null) {
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const first = buf.slice(0, nl).trim();
        if (LANG_LINE.test(first)) {
          lang = first;
          buf = buf.slice(nl + 1);
        } else {
          lang = "";     // no code line — the whole text is the reply
        }
      }
      const cut = lastSentenceEnd(buf);
      if (cut > 0) {
        pending += buf.slice(0, cut);
        buf = buf.slice(cut);
        pump();
      }
    },

    // Stream finished: whatever is left is the last sentence.
    async finish() {
      if (lang === null) lang = "";
      pending += buf;
      buf = "";
      pump();
      await self.settle();
    },

    async settle() {
      while (inflight) await inflight;
    },

    async say(l, text) {
      await self.settle();
      lang = l;
      pending = text;
      pump();
      await self.settle();
    },
  };

  function pump() {
    if (inflight || !pending.trim()) return;
    // The very first chunk is one sentence only, even when several arrived
    // in the same delta — the time to her first word is what they feel.
    const cut = self.spoken || spokenText ? pending.length : firstSentenceEnd(pending) || pending.length;
    const text = pending.slice(0, cut);
    pending = pending.slice(cut);
    inflight = synthesize(text.trim(), spokenText.trim())
      .then((audio) => {
        spokenText += text;
        self.spoken = true;
        res.write(JSON.stringify({ lang: lang || guessLang(text), text, audio: audio.toString("base64") }) + "\n");
      })
      .catch((e) => console.error("generate-script: tts chunk failed —", e))
      .finally(() => {
        inflight = null;
        pump();
      });
  }

  return self;
}

// Script-based guess, only for when the model skipped its language line.
// Coarse on purpose: TTS reads the language from the text itself, so this
// label is informational and only needs to be the right family.
function guessLang(s) {
  if (/[\u3040-\u30ff]/.test(s)) return "ja";
  if (/[\uac00-\ud7af]/.test(s)) return "ko";
  if (/[\u4e00-\u9fff]/.test(s)) return "zh";
  return "en";
}

// Index just past the FIRST sentence boundary in s (0 if none).
function firstSentenceEnd(s) {
  const m = SENTENCE_END.exec(s);
  SENTENCE_END.lastIndex = 0;
  return m ? m.index + m[0].length : 0;
}

// Index just past the last sentence boundary in s (0 if none yet). A
// period only counts once the following whitespace has arrived, so "3.5"
// or "Mr." mid-stream isn't cut.
function lastSentenceEnd(s) {
  let end = 0;
  for (let m; (m = SENTENCE_END.exec(s)); ) end = m.index + m[0].length;
  return end;   // exec loop ran to null, which resets lastIndex
}
const SENTENCE_END = /[。！？!?…]+[」』”"'）)]*|\.(?=\s)|\n+/g;

// Minimal SSE reader for the Anthropic stream: yields each event's JSON.
async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const bytes of body) {
    buf += decoder.decode(bytes, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) yield JSON.parse(data);
    }
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
