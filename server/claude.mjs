import Anthropic from "@anthropic-ai/sdk";
import { loadCorpus } from "./corpus.mjs";
import {
  buildSystemPrompt,
  buildLanguageDirective,
  buildLengthDirective,
} from "./system-prompt.mjs";
import { getSettings, ANSWER_MODELS } from "./settings.mjs";

/**
 * Sonnet 5, not Opus: the work here is retrieval and phrasing over a corpus already
 * in context, not open-ended reasoning, and Sonnet reaches near-Opus quality on that
 * shape of task at a fraction of the token cost.
 *
 * The operator can switch to Haiku from the settings page — it is a second faster to
 * first token and the settings page states what that second costs. CLAUDE_MODEL still
 * overrides both, for benchmarking without touching a live booth's saved settings.
 */
const modelFor = (settings) =>
  process.env.CLAUDE_MODEL || settings.answerModel || "claude-sonnet-5";

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
 * not a full stop, and splitting every clause on it would chop answers mid-thought.
 * See CLAUSE_BREAK below for the one place a comma *is* allowed to cut.
 */
const SENTENCE_END = /[.!?؟۔]/;

/**
 * Clause boundaries, used for the FIRST emission only.
 *
 * Measured against this corpus: the model's first token lands around 1.9 s, its first
 * comma around 2.5 s, and its first full stop around 4.2 s. Waiting for the full stop
 * therefore costs ~1.7 s during which the avatar has words available and is not saying
 * them, at the one moment a visitor is most likely to conclude the thing is broken.
 *
 * Only the first, and this is the whole design. Later sentences are synthesised while
 * an earlier clip is still playing, so cutting them early recovers nothing — and it
 * would cost something real: TTS gives each clip its own intonation contour, so a
 * clause spoken alone falls at the end like a finished sentence. Paying that once, on
 * the opening fragment, to start 1.7 s sooner is a good trade. Paying it on every
 * clause of every answer is not.
 */
const CLAUSE_BREAK = /[،,؛;:]/;

/** Below this, a first clause is too short to be worth its own clip and its own breath. */
const MIN_FIRST_CLAUSE = 24;

/**
 * Buffers streamed text and releases it one complete sentence at a time, so the
 * TTS/avatar leg can start speaking sentence one while Claude is still writing
 * sentence three. This is the whole latency story for the booth: without it, the
 * visitor waits for the full response before the mouth moves.
 */
class Sentencer {
  #buf = "";
  #emitted = 0;
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
      if (sentence) {
        this.#emitted++;
        this.onSentence(sentence);
      }
    }
  }
  #findEnd(s) {
    for (let i = 0; i < s.length; i++) {
      // The clause escape hatch, live only until something has been emitted.
      if (this.#emitted === 0 && i >= MIN_FIRST_CLAUSE && CLAUSE_BREAK.test(s[i])) return i;
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
    if (rest) {
      this.#emitted++;
      this.onSentence(rest);
    }
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
  // Both directives ride with the question, past the cache breakpoint — see
  // buildLengthDirective for why the length rule cannot live in the system prompt.
  const directive =
    `${buildLanguageDirective({ defaultLanguage, spokenLanguage })}\n` +
    `${buildLengthDirective({ words: settings.answerWords })}`;

  const startedAt = Date.now();
  let firstTokenMs = null;
  let firstSentenceMs = null;
  if (sentencer) {
    const inner = sentencer.onSentence;
    sentencer.onSentence = (s) => {
      firstSentenceMs ??= Date.now() - startedAt;
      inner(s);
    };
  }

  const model = modelFor(settings);

  // Not every model takes `effort`, and sending it to one that does not is a hard 400
  // — i.e. a booth that cannot answer at all, not a booth that answers slightly worse.
  // Haiku 4.5 is exactly that case, so the capability is declared alongside the model
  // in ANSWER_MODELS rather than inferred from the id here.
  const supportsEffort = ANSWER_MODELS.find((m) => m.id === model)?.supportsEffort ?? false;

  const stream = client.messages.stream({
    model,
    max_tokens: 1024,
    // Effort is the quality knob that matters here, and `low` is too low. The task
    // looks like retrieval but is really translation-and-composition: the corpus is
    // English notes in bullets and table rows, and the answer has to be spoken Arabic
    // prose. At `low`, Sonnet takes the most literal path available and reads source
    // lines out verbatim — including English ones, mid-Arabic-answer. `medium` makes
    // it compose instead, for latency the clause-level flush above has since repaid.
    ...(supportsEffort
      ? {
          thinking: { type: "disabled" },
          output_config: { effort: process.env.CLAUDE_EFFORT || "medium" },
        }
      : {}),
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
    model,
    stopReason: message.stop_reason,
    // firstSentenceMs, not just firstTokenMs, is the number that describes the booth:
    // it is the moment the avatar can physically start speaking. Reporting only time
    // to first token flattered the pipeline by a second and a half.
    timing: { firstTokenMs, firstSentenceMs, totalMs: Date.now() - startedAt },
    usage: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheWrite: message.usage.cache_creation_input_tokens,
      cacheRead: message.usage.cache_read_input_tokens,
    },
  };
}
