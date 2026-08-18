/**
 * The non-Anthropic rungs of the answer chain, tried in order after every Claude model
 * has failed.
 *
 * These exist for one failure the model chain in claude.mjs cannot otherwise survive.
 * A dead Anthropic balance is not a per-model fault — it is a `400 invalid_request_error`
 * carrying "credit balance is too low", and it comes back identically from Sonnet, from
 * Haiku, and from anything else on that key. Retrying across Claude models answers a
 * 429 or a 529; it cannot answer a billing stop. Only a different vendor can.
 *
 * Order is quality-first, and it doubles as a rate-limit escape: the OpenAI key is on a
 * 30k TPM tier and each question spends ~13.4k input tokens, so roughly every third
 * visitor in a busy minute hits a 429 there. A 429 is not an account-level error, so
 * the chain simply walks on to Gemini rather than apologising. That is the main reason
 * to keep more than one of these keyed at an event.
 *
 * Three things are worse here than on the Claude path, and all three are deliberate
 * rather than fixable:
 *
 *   - No citations. The Messages API returns cited spans as structured blocks; none of
 *     these vendors has an equivalent, so answers come back with an empty citation list
 *     and `grounded: false`. The booth's sources panel will be empty and staff should
 *     read that as "unverified", which is exactly true.
 *   - The corpus rides as plain prompt text rather than as document blocks, so it is
 *     re-sent in full on every question. Automatic prefix caching softens the cost
 *     where a vendor has it, but nothing here matches the ~0.1x of an Anthropic cache
 *     read.
 *   - The Arabic register degrades down the list. Every rung was given the same system
 *     prompt, but only Claude was scored against it. Judge each by ear before trusting
 *     it at a stand — see the note on Cohere below.
 *
 * All of that is the price of still answering a visitor. None of it is a reason to
 * promote any of these above Claude.
 */
import { buildSystemPrompt } from "./system-prompt.mjs";

const env = (k) => process.env[k]?.trim() || "";

/**
 * Flatten the corpus sections into one prompt block.
 *
 * Section headings survive the flattening on purpose. They are the only thing left
 * that tells the model which facts belong together once the document boundaries are
 * gone, and they are what a staffer would look for when checking an answer by hand.
 */
const corpusText = (sections) => sections.map((s) => s.text).join("\n\n---\n\n");

const CORPUS_PREAMBLE =
  "Answer only from the Devoteam knowledge base below. If it does not cover the " +
  "question, say so rather than inventing an answer.\n\n";

/**
 * Read an SSE body line at a time.
 *
 * Line-at-a-time, because a chunk boundary lands mid-JSON often enough that parsing
 * whatever arrived would drop tokens at random. Every vendor here speaks the same
 * `data: {json}` framing, so this is the one piece none of them needs its own copy of.
 */
async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        onEvent(JSON.parse(payload));
      } catch {
        // a keep-alive, a comment frame, or a partial we do not need
      }
    }
  }
}

/** Every rung fails the same way, so that claude.mjs can classify them the same way. */
async function assertOk(res, vendor) {
  if (!res.ok || !res.body) {
    throw new Error(
      `${vendor} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
    );
  }
}

/* --------------------------------------------------------------------- openai */

/**
 * `gpt-4o` rather than a mini tier: this rung only ever runs when the booth is already
 * degraded, and the job it inherits — Modern Standard Arabic prose composed from
 * English notes, inside a word budget — is the part small models drop first.
 */
async function runOpenAI({ settings, sections, question, history, directive, onText }) {
  const model = env("OPENAI_ANSWER_MODEL") || "gpt-4o";
  const base = env("OPENAI_BASE_URL") || "https://api.openai.com/v1";

  const messages = [
    { role: "system", content: buildSystemPrompt({ settings }) },
    { role: "system", content: CORPUS_PREAMBLE + corpusText(sections) },
    ...history.map(({ role, content }) => ({ role, content })),
    // The directives are restated as their own system turn, not only alongside the
    // question as on the Claude path. Measured: with them in the user turn alone,
    // gpt-4o answered "What does Devoteam do?" in Arabic — it read the booth's Arabic
    // default and ignored the "if the question is clearly in English" escape clause
    // that Claude honours. Answering a visitor in a language they did not speak is a
    // worse booth failure than any of the ones this rung exists to prevent.
    { role: "system", content: directive },
    { role: "user", content: `${directive}\n${question}` },
  ];

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      // `max_completion_tokens`, not `max_tokens`: the older name is rejected outright
      // by newer OpenAI models, and OPENAI_ANSWER_MODEL means an operator can point
      // this at one. Same 1024 ceiling as the Claude path.
      max_completion_tokens: 1024,
      stream: true,
      // Without this the usage block never arrives on a streamed response, and the
      // operator panel shows a blank cost for exactly the answers worth auditing.
      stream_options: { include_usage: true },
      messages,
    }),
  });
  await assertOk(res, "OpenAI");

  let text = "";
  let stopReason = null;
  let usage = null;
  await readSse(res, (event) => {
    const choice = event.choices?.[0];
    const delta = choice?.delta?.content;
    if (delta) {
      text += delta;
      onText?.(delta);
    }
    if (choice?.finish_reason) stopReason = choice.finish_reason;
    if (event.usage) usage = event.usage;
  });

  return finish("openai", model, text, stopReason, {
    input: usage?.prompt_tokens,
    output: usage?.completion_tokens,
    cacheRead: usage?.prompt_tokens_details?.cached_tokens,
  });
}

/* --------------------------------------------------------------------- gemini */

/**
 * Gemini takes the system prompt in its own `system_instruction` field rather than as
 * a message, and calls the assistant role `model`. Both are easy to get subtly wrong:
 * an assistant turn labelled `assistant` is a 400, and a system prompt smuggled in as
 * a user turn is accepted and quietly ignored — the second being much the worse of the
 * two, because the booth's guardrails would be the part silently dropped.
 */
async function runGemini({ settings, sections, question, history, directive, onText }) {
  const model = env("GEMINI_ANSWER_MODEL") || "gemini-2.0-flash";
  const base = env("GEMINI_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta";
  const key = env("GEMINI_API_KEY") || env("GOOGLE_API_KEY");

  const res = await fetch(`${base}/models/${model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    // The key rides as a header, not as `?key=` in the query string. Same credential
    // either way, but a query string is the one place a secret reliably ends up in
    // proxy logs, and this booth sits behind one at every venue.
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: `${buildSystemPrompt({ settings })}\n\n${CORPUS_PREAMBLE}${corpusText(sections)}` }],
      },
      contents: [
        ...history.map(({ role, content }) => ({
          role: role === "assistant" ? "model" : "user",
          parts: [{ text: content }],
        })),
        { role: "user", parts: [{ text: `${directive}\n${question}` }] },
      ],
      generationConfig: { maxOutputTokens: 1024 },
    }),
  });
  await assertOk(res, "Gemini");

  let text = "";
  let stopReason = null;
  let usage = null;
  await readSse(res, (event) => {
    const candidate = event.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (!part.text) continue;
      text += part.text;
      onText?.(part.text);
    }
    if (candidate?.finishReason) stopReason = candidate.finishReason;
    if (event.usageMetadata) usage = event.usageMetadata;
  });

  return finish("gemini", model, text, stopReason, {
    input: usage?.promptTokenCount,
    output: usage?.candidatesTokenCount,
    cacheRead: usage?.cachedContentTokenCount,
  });
}

/* --------------------------------------------------------------------- cohere */

/**
 * Last, and last for a reason: Command's Arabic is the weakest here by some distance,
 * and this corpus asks for Modern Standard Arabic composed from English source notes —
 * exactly the shape of task where it drifts into English or into a stilted register.
 *
 * It stays in the chain because a stilted Arabic answer is still an answer and the
 * alternative at this depth is the apology line. Listen to it against a few real
 * questions before an event and decide for yourself whether you would rather it spoke;
 * if not, leave COHERE_API_KEY unset and the rung disappears.
 */
async function runCohere({ settings, sections, question, history, directive, onText }) {
  const model = env("COHERE_ANSWER_MODEL") || "command-r-plus-08-2024";
  const base = env("COHERE_BASE_URL") || "https://api.cohere.com/v2";

  const messages = [
    { role: "system", content: buildSystemPrompt({ settings }) },
    { role: "system", content: CORPUS_PREAMBLE + corpusText(sections) },
    ...history.map(({ role, content }) => ({ role, content })),
    { role: "system", content: directive },
    { role: "user", content: `${directive}\n${question}` },
  ];

  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("COHERE_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: 1024 }),
  });
  await assertOk(res, "Cohere");

  let text = "";
  let stopReason = null;
  let usage = null;
  await readSse(res, (event) => {
    if (event.type === "content-delta") {
      const chunk = event.delta?.message?.content?.text;
      if (chunk) {
        text += chunk;
        onText?.(chunk);
      }
    }
    if (event.type === "message-end") {
      stopReason = event.delta?.finish_reason ?? stopReason;
      usage = event.delta?.usage?.tokens ?? usage;
    }
  });

  return finish("cohere", model, text, stopReason, {
    input: usage?.input_tokens,
    output: usage?.output_tokens,
  });
}

/* ------------------------------------------------------------------- registry */

/** The one result shape claude.mjs understands, however differently each vendor spoke. */
function finish(provider, model, text, stopReason, usage) {
  if (!text.trim()) throw new Error(`${provider} ${model} returned an empty answer`);
  return {
    text,
    // No citations API on any of these — see the header. An empty list is what makes
    // the booth report `grounded: false`, the honest reading of an answer from here.
    citations: [],
    model,
    provider,
    stopReason,
    usage: {
      input: usage.input ?? null,
      output: usage.output ?? null,
      // Prefix caching, where these vendors have it at all, is automatic and never
      // reported as a write. Null rather than 0 so the panel shows "unknown", not "none".
      cacheWrite: null,
      cacheRead: usage.cacheRead ?? null,
    },
  };
}

/**
 * Every non-Anthropic rung, best first, with the key that switches it on.
 *
 * Presence of a key is the whole activation rule. There is no setting for this and
 * deliberately so: these rungs are not a choice an operator makes at a booth, they are
 * what happens when the choice they did make has already failed.
 */
const RUNGS = [
  { provider: "openai", requires: ["OPENAI_API_KEY"], run: runOpenAI },
  { provider: "gemini", requires: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], run: runGemini },
  { provider: "cohere", requires: ["COHERE_API_KEY"], run: runCohere },
];

/** The rungs this deployment actually has credentials for, in order. */
export function buildFallbackChain() {
  return RUNGS.filter((r) => r.requires.some((k) => env(k))).map((r) => ({
    provider: r.provider,
    model: null, // resolved from env inside the rung, and reported back on the result
    run: r.run,
  }));
}

/** For the health endpoint and the admin page: which safety nets are actually strung. */
export const fallbackProviders = () => buildFallbackChain().map((r) => r.provider);
