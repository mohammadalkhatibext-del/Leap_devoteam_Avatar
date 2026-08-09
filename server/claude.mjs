import Anthropic from "@anthropic-ai/sdk";
import { loadCorpus } from "./corpus.mjs";
import { SYSTEM_PROMPT } from "./system-prompt.mjs";

const MODEL = "claude-opus-5";

const client = new Anthropic();

/** Loaded once per process — the corpus never changes at runtime. */
let corpusPromise = null;
const corpus = () => (corpusPromise ??= loadCorpus());

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
function buildMessages(blocks, question, history) {
  if (!history.length) {
    return [{ role: "user", content: [...blocks, { type: "text", text: question }] }];
  }
  const [first, ...rest] = history;
  return [
    { role: "user", content: [...blocks, { type: "text", text: first.content }] },
    ...rest,
    { role: "user", content: question },
  ];
}

/**
 * Ask the booth assistant a question, grounded in the Devoteam corpus.
 *
 * @param {string} question           Visitor's question, Arabic or English.
 * @param {object} [opts]
 * @param {(s: string) => void} [opts.onSentence]  Called per complete sentence, as it streams.
 * @param {Array}  [opts.history]     Prior [{role, content}] turns for follow-ups.
 */
export async function ask(question, { onSentence, history = [] } = {}) {
  const { blocks } = await corpus();
  const sentencer = onSentence ? new Sentencer((s) => onSentence(stripTags(s))) : null;

  const startedAt = Date.now();
  let firstTokenMs = null;

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    // Effort `low` is not a downgrade here: the work is retrieval and phrasing over
    // a corpus already in context, not open-ended reasoning.
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: buildMessages(blocks, question, history),
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
