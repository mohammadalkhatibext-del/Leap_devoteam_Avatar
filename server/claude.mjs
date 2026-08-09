import Anthropic from "@anthropic-ai/sdk";
import { loadCorpus } from "./corpus.mjs";
import { buildSystemPrompt, buildLanguageDirective } from "./system-prompt.mjs";
import { getSettings } from "./settings.mjs";

/**
 * Sonnet 5, not Opus: the work here is retrieval and phrasing over a corpus already
 * in context, not open-ended reasoning, and Sonnet reaches near-Opus quality on that
 * shape of task at a fraction of the token cost. Override with CLAUDE_MODEL if a
 * booth answer ever needs more than this can give.
 */
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

const client = new Anthropic();

/**
 * Cached per operator-notes value. The knowledge base itself never changes at
 * runtime, but the admin page can add notes to it, and those must take effect on the
 * next question rather than on the next restart — a booth operator adding "our demo
 * is at 3pm" expects the avatar to know it immediately.
 */
let corpusCache = { key: null, value: null };
function corpus(settings) {
  const key = settings.extraKnowledge ?? "";
  if (corpusCache.key !== key) {
    corpusCache = { key, value: loadCorpus({ extraKnowledge: key }) };
  }
  return corpusCache.value;
}

/**
 * Arabic sentence enders. `،` (Arabic comma) is deliberately absent — it is a comma,
 * not a full stop, and splitting on it would chop answers mid-clause.
 */
const SENTENCE_END = /[.!?؟۔]/;

/**
 * Buffers streamed text and releases it one complete sentence at a time, so the
 * TTS/avatar leg can start speaking sentence one while Claude is still writing
 * sentence three. This is the whole latency story for the booth: without it, the
 * visitor waits for the full response before the mouth moves.
 */
class Sentencer {
  #buf = "";
  constructor(onSentence) {
    this.onSentence = onSentence;
  }
  push(text) {
    this.#buf += text;
    let cut;
    // Emit up to and including each sentence terminator, plus any trailing
    // closing punctuation/space that belongs with it.
    while ((cut = this.#findEnd(this.#buf)) !== -1) {
      const sentence = this.#buf.slice(0, cut + 1).trim();
      this.#buf = this.#buf.slice(cut + 1);
      if (sentence) this.onSentence(sentence);
    }
  }
  #findEnd(s) {
    for (let i = 0; i < s.length; i++) {
      if (!SENTENCE_END.test(s[i])) continue;
      // "3.5" / "www.devoteam.com" — a period between digits or letters is not a stop.
      if (s[i] === "." && /[\d\w]/.test(s[i - 1] ?? "") && /[\d\w]/.test(s[i + 1] ?? "")) continue;
      return i;
    }
    return -1;
  }
  flush() {
    const rest = this.#buf.trim();
    this.#buf = "";
    if (rest) this.onSentence(rest);
  }
}

/**
 * Thinking is disabled for latency — a booth visitor is standing there waiting, and
 * Opus 5 at low effort answers a grounded lookup well without it. The documented
 * cost of disabling thinking on Opus 5 is that internal XML tags can occasionally
 * leak into the visible response; the system prompt forbids them and this strips
 * any that survive, because the failure mode here is the avatar literally speaking
 * the word "thinking" to a visitor.
 */
const stripTags = (s) => s.replace(/<\/?[^>\n]{1,60}>/g, "").replace(/\s{2,}/g, " ").trim();

/**
 * The corpus rides on the FIRST user turn and never moves.
 *
 * Caching is a prefix match, so the documents' byte offset has to stay identical
 * across every turn of a conversation. Appending history *before* them shifts that
 * offset and silently invalidates the whole 30k-token corpus cache — the request
 * still works, it just costs ~10x more per follow-up. Re-anchoring the documents
 * to turn one keeps every later question a cache read.
 *
 * @param {Array} history  Plain [{role, content: string}] turns, oldest first.
 */
function buildMessages(blocks, question, history, directive) {
  // The language directive sits with the question, after the documents — see
  // buildLanguageDirective for why it must not live in the system prompt.
  const asked = `${directive}\n${question}`;
  if (!history.length) {
    return [{ role: "user", content: [...blocks, { type: "text", text: asked }] }];
  }
  const [first, ...rest] = history;
  return [
    { role: "user", content: [...blocks, { type: "text", text: first.content }] },
    ...rest,
    { role: "user", content: asked },
  ];
}

const ARABIC = /[؀-ۿ]/;

/**
 * Detect the answer reading source documents aloud instead of speaking.
 *
 * The corpus is English notes; when an Arabic answer degrades it does so by quoting
 * whole English bullet lines, which the avatar then reads out to a visitor. This is
 * worth catching rather than just avoiding, because of how it propagates: the bad
 * answer goes into conversation history, the model reads its own previous turn as
 * precedent, and every remaining answer in that visitor's session degrades with it.
 * One slip poisons the whole conversation, so the caller needs to know it happened.
 *
 * Short Latin runs are expected and fine — "AWS", "Google Cloud", "Premier Tier" are
 * how these things are actually said in Arabic speech. Six consecutive Latin words is
 * not a brand name; it is a sentence from the documents.
 */
function looksLikeSourceLeak(answer, question) {
  if (!ARABIC.test(answer)) return false; // an English answer to an English question
  if (ARABIC.test(question) === false) return false;
  return /(?:\b[A-Za-z][A-Za-z'’-]*\b[ ,;:()-]+){5,}\b[A-Za-z]/.test(answer);
}

/**
 * Ask the booth assistant a question, grounded in the Devoteam corpus.
 *
 * @param {string} question           Visitor's question, Arabic or English.
 * @param {object} [opts]
 * @param {(s: string) => void} [opts.onSentence]  Called per complete sentence, as it streams.
 * @param {Array}  [opts.history]     Prior [{role, content}] turns for follow-ups.
 * @param {"ar"|"en"} [opts.defaultLanguage]   which screen the visitor walked up to
 * @param {"ar"|"en"|null} [opts.spokenLanguage]  what STT detected, when known
 */
export async function ask(
  question,
  { onSentence, history = [], defaultLanguage = "ar", spokenLanguage = null } = {},
) {
  const settings = await getSettings();
  const { blocks } = await corpus(settings);
  const sentencer = onSentence ? new Sentencer((s) => onSentence(stripTags(s))) : null;
  const directive = buildLanguageDirective({ defaultLanguage, spokenLanguage });

  const startedAt = Date.now();
  let firstTokenMs = null;

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    // Effort is the quality knob that matters here, and `low` is too low. The task
    // looks like retrieval but is really translation-and-composition: the corpus is
    // English notes in bullets and table rows, and the answer has to be spoken Arabic
    // prose. At `low`, Sonnet takes the most literal path available and reads source
    // lines out verbatim — including English ones, mid-Arabic-answer. `medium` makes
    // it compose instead, for about a second of extra latency that the filler covers.
    thinking: { type: "disabled" },
    output_config: { effort: process.env.CLAUDE_EFFORT || "medium" },
    system: [
      {
        type: "text",
        text: buildSystemPrompt({ settings }),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: buildMessages(blocks, question, history, directive),
  });

  stream.on("text", (delta) => {
    firstTokenMs ??= Date.now() - startedAt;
    sentencer?.push(delta);
  });

  const message = await stream.finalMessage();
  sentencer?.flush();

  const answer = stripTags(
    message.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
  );

  // Every cited span, with the section it came from — this is what booth staff
  // check an answer against, and what the guardrail below is measured on.
  const citations = message.content
    .filter((b) => b.type === "text")
    .flatMap((b) => b.citations ?? [])
    .map((c) => ({ title: c.document_title, quote: c.cited_text?.trim() }));

  return {
    answer,
    citations,
    grounded: citations.length > 0,
    leakedSource: looksLikeSourceLeak(answer, question),
    stopReason: message.stop_reason,
    timing: { firstTokenMs, totalMs: Date.now() - startedAt },
    usage: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheWrite: message.usage.cache_creation_input_tokens,
      cacheRead: message.usage.cache_read_input_tokens,
    },
  };
}
