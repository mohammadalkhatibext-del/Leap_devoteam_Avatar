import Anthropic from "@anthropic-ai/sdk";
import { loadCorpus } from "./corpus.mjs";
import {
  buildSystemPrompt,
  buildLanguageDirective,
  buildLengthDirective,
} from "./system-prompt.mjs";
import { getSettings, ANSWER_MODELS } from "./settings.mjs";
import { buildFallbackChain } from "./fallback-answer.mjs";

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

/**
 * The order models are tried in, best first.
 *
 * A booth failure is not a developer failure: there is a visitor standing in front of
 * a screen, and the operator's fallback line ("one of my colleagues would be glad to
 * help") is a real answer being replaced by an apology. Anything that can still answer
 * the question is worth a second or two before we spend that.
 *
 * The Claude rungs come from ANSWER_MODELS, which is the measured, operator-visible
 * list — the configured model first, then whatever else was scored. Everything after
 * them comes from fallback-answer.mjs, in that file's order, and only for vendors this
 * deployment actually holds a key for. They all answer without citations, which is
 * strictly worse than any Claude rung and strictly better than silence.
 */
function buildChain(settings) {
  const first = modelFor(settings);
  const claude = [first, ...ANSWER_MODELS.map((m) => m.id).filter((id) => id !== first)];
  return [
    ...claude.map((model) => ({ provider: "anthropic", model })),
    ...buildFallbackChain(),
  ];
}

/**
 * Is this a failure of the *account* rather than of the model?
 *
 * The distinction decides whether the next Claude rung is worth its latency. An
 * exhausted balance arrives as a 400 reading "Your credit balance is too low to access
 * the Anthropic API", and a revoked key as a 401 — neither says anything about Sonnet
 * in particular, and both come back identically from every model on that key. Walking
 * the rest of the Claude list there buys nothing and costs a visitor another round
 * trip of standing still, so we skip straight to a different vendor.
 *
 * Everything else — 429, 529 overloaded, a 400 on a parameter one model rejects, a
 * dropped socket — is model- or moment-specific, and is exactly what the next rung is
 * for.
 */
function isAccountLevel(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 401 || status === 403) return true;
  return /credit balance|billing|quota|payment required|insufficient/i.test(
    String(err?.message ?? ""),
  );
}

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
  /**
   * Drop a half-written sentence so the next rung starts clean.
   *
   * Only ever called when a rung died before any sentence reached the TTS queue, so
   * the buffer holds a fragment nobody heard. Resetting `#emitted` too is deliberate:
   * the clause-level escape hatch above exists to get the avatar talking sooner, and
   * on a retry the visitor has been waiting longer, not less.
   */
  reset() {
    this.#buf = "";
    this.#emitted = 0;
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
 * One attempt at one Claude model. Throws; the chain in ask() decides what that means.
 *
 * @param {(s: string) => void} onText  Called per streamed delta, before sentencing.
 */
async function runAnthropic({ model, settings, blocks, question, history, directive, onText }) {
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

  stream.on("text", (delta) => onText?.(delta));

  const message = await stream.finalMessage();

  return {
    text: message.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    // Every cited span, with the section it came from — this is what booth staff
    // check an answer against, and what the guardrail below is measured on.
    citations: message.content
      .filter((b) => b.type === "text")
      .flatMap((b) => b.citations ?? [])
      .map((c) => ({ title: c.document_title, quote: c.cited_text?.trim() })),
    model,
    provider: "anthropic",
    stopReason: message.stop_reason,
    usage: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheWrite: message.usage.cache_creation_input_tokens,
      cacheRead: message.usage.cache_read_input_tokens,
    },
  };
}

/** Every rung failed. Carries the whole trail, because "it failed" is not diagnosable. */
export class AnswerChainError extends Error {
  constructor(attempts, cause) {
    const trail = attempts.map((a) => `${a.model ?? a.provider}: ${a.error}`).join(" | ");
    super(`all ${attempts.length} answer model(s) failed — ${trail}`);
    this.name = "AnswerChainError";
    this.attempts = attempts;
    this.cause = cause;
  }
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
  const { blocks, sections } = await corpus(settings);
  const sentencer = onSentence ? new Sentencer((s) => onSentence(stripTags(s))) : null;
  // Both directives ride with the question, past the cache breakpoint — see
  // buildLengthDirective for why the length rule cannot live in the system prompt.
  const directive =
    `${buildLanguageDirective({ defaultLanguage, spokenLanguage })}\n` +
    `${buildLengthDirective({ words: settings.answerWords })}`;

  const startedAt = Date.now();
  let firstTokenMs = null;
  let firstSentenceMs = null;
  // The gate on retrying at all: once this is non-zero the avatar has audio in hand
  // and a second rung would make it stutter rather than recover. See the catch below.
  let spokenCount = 0;
  if (sentencer) {
    const inner = sentencer.onSentence;
    sentencer.onSentence = (s) => {
      firstSentenceMs ??= Date.now() - startedAt;
      spokenCount++;
      inner(s);
    };
  }

  const chain = buildChain(settings);

  /** Failed rungs, in order — carried on success too, so a degraded answer says so. */
  const attempts = [];
  let lastError = null;

  for (let i = 0; i < chain.length; i++) {
    const rung = chain[i];

    // Each rung streams from scratch. firstTokenMs is re-measured against the original
    // startedAt rather than reset to zero: what it reports is what the visitor waited,
    // and a failed rung is part of that wait whether or not it produced anything.
    firstTokenMs = null;
    sentencer?.reset();
    const onText = (delta) => {
      firstTokenMs ??= Date.now() - startedAt;
      sentencer?.push(delta);
    };

    try {
      // Claude takes the corpus as citable document blocks; every other vendor takes
      // it as flattened text, because none of them has an equivalent. That difference
      // is the whole reason the two call shapes never converged.
      const out = rung.run
        ? await rung.run({ settings, sections, question, history, directive, onText })
        : await runAnthropic({
            model: rung.model,
            settings,
            blocks,
            question,
            history,
            directive,
            onText,
          });

      sentencer?.flush();
      const answer = stripTags(out.text);

      return {
        answer,
        citations: out.citations,
        grounded: out.citations.length > 0,
        leakedSource: looksLikeSourceLeak(answer, question),
        model: out.model,
        // Which vendor actually answered. The booth sends this on to the operator
        // panel: an answer with no sources panel is either a bad Claude answer or a
        // normal OpenAI one, and only this field tells the two apart.
        provider: out.provider,
        attempts,
        stopReason: out.stopReason,
        // firstSentenceMs, not just firstTokenMs, is the number that describes the
        // booth: it is the moment the avatar can physically start speaking. Reporting
        // only time to first token flattered the pipeline by a second and a half.
        timing: { firstTokenMs, firstSentenceMs, totalMs: Date.now() - startedAt },
        usage: out.usage,
      };
    } catch (err) {
      lastError = err;
      attempts.push({ provider: rung.provider, model: rung.model, error: err.message });

      // The one hard stop. Once a sentence has left for the TTS queue the avatar is
      // already speaking it, and a second rung would start a different answer from the
      // top — the visitor hears the sentence restart, or hears two answers spliced.
      // A half-answer plus the apology line is bad; a stuttering avatar is worse.
      if (spokenCount > 0) break;

      // A dead balance or a revoked key fails every rung on that vendor the same way,
      // so do not spend a visitor's patience proving it twice — skip to the next
      // vendor. Only Anthropic currently has more than one rung, but the rule is the
      // vendor's, not Claude's, and a second Gemini model would inherit it for free.
      if (isAccountLevel(err)) {
        while (i + 1 < chain.length && chain[i + 1].provider === rung.provider) i++;
      }
    }
  }

  throw new AnswerChainError(attempts, lastError);
}
