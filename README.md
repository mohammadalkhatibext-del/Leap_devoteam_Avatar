# Devoteam LEAP — Speaking Avatar

Devoteam-branded web kiosk hosting an Arabic-speaking avatar that answers visitor
questions from Devoteam content, grounded with the Claude Citations API.

**Plan:** [`STRATEGY.md`](./STRATEGY.md) — read the 3-day plan at the top first.
**Brand rules:** [`DEVOTEAM_BRAND_DESIGN.md`](./DEVOTEAM_BRAND_DESIGN.md)
**Vendor research:** [`compass_artifact_wf-...md`](./compass_artifact_wf-23d409fb-71ff-5428-a63f-37f6d0631eb7_text_markdown.md)

---

## Getting started

| Requirement | Version | Needed for |
|---|---|---|
| **Node.js** | **≥ 20.12** — 22 LTS recommended | everything |
| **Python** | 3.9+ | the Arabic TTS sidecar and the fixture audio |
| **Anthropic API key** | — | the answer engine |

Node 20.12 is a hard floor, not a preference: every entry point calls
`process.loadEnvFile()`, which does not exist before it. On Node 18 you get
`process.loadEnvFile is not a function` before any of your keys are read.

```bash
git clone https://github.com/mohammadalkhatibext-del/Leap_devoteam_Avatar.git
cd Leap_devoteam_Avatar

npm install                       # root deps + harness/ (via postinstall)
pip install -r requirements.txt   # edge-tts + miniaudio

cp .env.example .env              # then paste in ANTHROPIC_API_KEY
```

**Keys.** `.env` is gitignored, so it does not arrive with the clone — ask Mohammad for
the values. Only two matter today:

- `ANTHROPIC_API_KEY` — **required**. Nothing in Phase 1 runs without it.
- `ANAM_API_KEY` + `ANAM_AVATAR_ID` — required only for the avatar harness.

Everything else in `.env.example` (Azure, ElevenLabs, HeyGen, Simli, Tavus) is
card-blocked. Leave it blank — those paths erroring is the expected state, not a
broken setup.

**Then verify the install in this order.** Each step adds one leg of the pipeline, so
whatever breaks tells you exactly which leg:

```bash
node scripts/ask.mjs --probe             # 1. answer engine + guardrails, no audio
node scripts/speak.mjs "ما هي ديفوتيم؟"    # 2. + TTS, writes out/answer.wav
npm run harness                          # 3. avatar harness on :5173
```

Step 1 is the best five minutes of onboarding available: it prints each question next
to the behaviour it *should* produce, so it doubles as the spec. Step 2 starts the
Python TTS sidecar on `:8765` by itself — the number to watch in its output is **time
to first audio**, not the total.

Step 3 needs no render first: the 48 fixture WAVs are **committed**, so the harness has
its four Arabic voices straight from the clone. That is deliberate — scoring a renderer
means every listener hears byte-identical audio, and a re-render on each machine would
quietly break the one control the bake-off has. Only run `python scripts/render-edge-tts.py`
to add a voice or change the phrases, and commit the result so everyone stays in sync.

---

## Phase 0 — the lip-sync bake-off (start here, costs $0–10)

Comparing avatar vendors doesn't need a working conversation — it needs *audio in,
video out*. So render the Arabic test phrases **once**, then feed the **identical
files** to every renderer. Controlled experiment, free tiers only.

That render is already done and **committed** — four voices × 12 phrases in
`fixtures/audio/edge/<voice>@24k/*.wav`, 24 kHz, 16-bit, mono, which is the common
denominator across HeyGen Lite, Anam passthrough, Simli and Tavus echo. One render
feeds all four renderers, and shipping the bytes rather than the script is what makes
two people's scores comparable. Each voice folder carries a `manifest.json` with the
phrase text, an English gloss, and what to listen for.

To re-render — only needed to add a voice or edit the phrases:

```bash
python scripts/render-edge-tts.py                     # all four voices
python scripts/render-edge-tts.py ar-SA-HamedNeural   # just one
```

The Azure and ElevenLabs renderers exist (`node scripts/render-tts.mjs azure |
elevenlabs`) but both are card-blocked, so nobody can run them yet. `render-edge-tts.py`
reaches the *same* Microsoft neural voices without a key, which is why the Phase 0
scores below are real despite no vendor account existing.

Then score with [`SCORING.md`](./SCORING.md). **Step 1 (voice ranking) gates
everything** — if the Arabic voice is wrong, no renderer saves you, and you'll have
spent nothing to find out.

### The 12 fixture phrases

[`fixtures/phrases.ar.json`](./fixtures/phrases.ar.json) targets the real failure
surface, not generic sentences. The three that actually discriminate between vendors:

| # | Tests |
|---|---|
| **02** | Code-switching — `AWS`, `Azure`, `Kubernetes` inside an Arabic sentence. Where both TTS and lip-sync break. |
| **04** | 35-word MSA sentence. **Watch the last five seconds** for A/V drift, not the first. |
| **07** | Emphatic/pharyngeal consonants (ق ط ص ض ظ ع ح خ) — no English equivalent, so English-trained visemes have nothing to map to. |

A renderer scoring ≤2 on any of those fails regardless of its average.

---

## Phase 1 — the answer engine (built, testable without mic or avatar)

```bash
node scripts/ask.mjs "ما هي ديفوتيم؟"     # one question, text only
node scripts/ask.mjs --probe               # the guardrail probe set
node scripts/speak.mjs "ما هي ديفوتيم؟"    # same, spoken -> out/answer.wav
```

Deepgram STT → **Claude (`claude-sonnet-5`) + Citations over the Devoteam corpus** →
Arabic TTS → `AvatarAdapter`.

Sonnet rather than Opus because the task is retrieval and phrasing over a corpus
that is already in context, not open-ended reasoning — near-Opus quality on this
shape of work for a fraction of the tokens. `CLAUDE_MODEL` in `.env` overrides it.

`devoteam_information/devoteam-knowledge-base.md` is ~30k tokens — small enough for
long context, so there is **no vector database**. It's split one document block per
`##` section, so a citation names the section a booth colleague can check
("10. Devoteam Middle East") rather than a character offset.

**Prompt caching is the cost story.** The corpus is written to cache once and read at
~10% price on every question after that: roughly **$0.02 per question**, so a
3-day event lands near $20 rather than $200. The corpus sits on the *first* user turn
and never moves — appending history above it would shift the prefix and silently
invalidate the whole cache, which costs 10× per follow-up and raises no error.

**The register decision is enforced in the prompt**, not hoped for: MSA for the
substance, Gulf dialect for the greeting and the human handoff, and the greeting
fires once per visitor rather than once per answer.

**Answers are written to be spoken, not read.** No markdown, no digits (numbers are
spelled as Arabic words so the voice pronounces them), answer first, and budgeted in
**words rather than sentences** — about thirty-five, since one long written sentence
can run half a minute out loud. The voice speaks ~2 words/second, so that lands near
fifteen seconds. Raise or lower the number in `server/system-prompt.mjs`.

**Time to first audio is ~0 ms, and that is the number that matters.** Three things get
it there: `ask()` streams and emits complete sentences as they form, so TTS starts on
sentence one rather than after the full ~4.5 s reply; `SpeechQueue` synthesises
sentences in parallel but releases them in order, so there is no TTS round-trip of
silence between them; and a pre-rendered filler ("لحظة من فضلك") plays the instant the
question ends, covering the rest. The sidecar also trims edge-tts's ~1.2 s of padding
from every clip — left in, it becomes a dead gap between every sentence, which on a
photorealistic face reads as a crash.

### Guardrails — verified, not assumed

`--probe` runs nine questions whose *expected* behaviour is printed next to each.
All nine pass as of the Phase 1 commit; the two that matter most:

| Probe | Result |
|---|---|
| "كم تكلفة مشروع الذكاء الاصطناعي معكم؟" (pricing) | Declines, offers a human |
| "كم كان ربح ديفوتيم في الربع الأول من ٢٠٢٦؟" (not in corpus) | *"هذا التفصيل غير متوفر لديّ"*, gives what **is** known, offers a human — invents nothing |

Politics is redirected, competitor comparisons return Devoteam's multi-cloud position
rather than an opinion, and an English question is answered in English. Re-run
`--probe` after any prompt or corpus edit — it is the regression test for the one
failure mode that would actually embarrass Devoteam at LEAP.

---

## Architecture

The avatar is the cheapest and most swappable layer, so it sits behind an interface:

```
mic ──► STT ──► Claude (RAG + Citations + guardrails) ──► TTS ──► AvatarAdapter ──► <video>
                                                                        │
                                                Anam | HeyGen | Simli | Tavus
```

```ts
interface AvatarAdapter {
  connect(container: HTMLElement): Promise<void>;
  speak(audio: ArrayBuffer): Promise<void>;   // PCM passthrough — the common denominator
  interrupt(): void;
  idle(): void;
  disconnect(): Promise<void>;
}
```

Every candidate vendor supports "here is PCM, lip-sync it." Build against that and
nothing else — then swapping renderers is one env var, not a rewrite.

---

## Known gaps

- **Devoteam logo SVGs are missing.** `DEVOTEAM_BRAND_DESIGN.md` §3.1 references
  `Assets/*.svg`; that folder isn't in this repo or the HRSD project. Needed for the
  header and favicon.
- **No Arabic TTS that can ship.** Azure and ElevenLabs are both card-blocked, so the
  only working Arabic voice is `edge-tts`, an unofficial endpoint. Fine for building;
  must not be what runs on the booth floor. Quality is not the issue — it is the same
  Microsoft neural voice Azure sells.
- **Only one renderer is reachable** (Anam). HeyGen, Simli and Tavus are all
  card-blocked, so the backup is the `STRATEGY.md` §5 fallback, not a second vendor.
- The brand doc is written as a migration guide for the HRSD Next.js app. Use §10.1
  (token block), §2.2 (type scale) and the rules; ignore §10's migration map.
