# Devoteam LEAP Avatar — Build Strategy

**Goal:** a Devoteam-branded web page that hosts a photorealistic, Arabic-speaking
avatar answering visitor questions from Devoteam content, at a LEAP booth.

**Constraints driving this document:** start at minimum cost, test more than one
approach before committing money, **3-day build window**.

---

## The 3-day plan

Compressed from the full plan below. The compression rules: **two renderers, not four;
no STT comparison; fallback ships before polish.**

### Day 1 — Decide the renderer (this is the whole day, and it's the important one)

| | |
|---|---|
| **Morning** | Create free accounts (Azure Speech F0, ElevenLabs, Anam, HeyGen LiveAvatar). Run `node scripts/render-tts.mjs azure` and `... elevenlabs`. **Score the voices with a native Gulf speaker** (`SCORING.md` Step 1) — ~30 min, and it gates everything else. |
| **Afternoon** | Feed the winning voice's 12 WAVs to **Anam** and **HeyGen Lite**. Score both (`SCORING.md` Step 2). Pick primary + backup. |
| **In parallel** | Stand up the Claude RAG endpoint (§2.3) and test grounding + refusals **in text only** — no audio, no avatar. Needs the Devoteam corpus. |
| **Gate** | If neither renderer clears the bar on Arabic lip-sync (phrases 02 / 04 / 07), **stop and switch to the pre-rendered + text-chat fallback today.** Do not spend Day 2 hoping. |

*Skipped vs. the full plan:* Simli and Tavus. Add them only if both primaries fail —
the harness makes that ~1 extra hour, so it's a cheap escape hatch, not a lost option.

### Day 2 — Wire the loop, in Arabic, end to end

- Mic (push-to-talk) → **Deepgram Nova-3 Arabic** → Claude RAG → winning TTS → `AvatarAdapter`.
- **Skip the STT bake-off.** Ship Deepgram; measure its WER on the 12 fixture phrases
  read aloud and only revisit if it's visibly wrong. One STT provider is enough for
  three days.
- Build the branded page (§3): tokens, self-hosted Montserrat, dark hero, glass panel,
  push-to-talk CTA, transcript panel, **"Generated with AI" label**.
- Wire the backup renderer behind an env var and verify the swap works. Do this on Day 2
  while it's cheap, not on Day 3 under pressure.

### Day 3 — Make it unbreakable, then stop

- **Fallbacks first, before any polish:** pre-rendered avatar loop, text-chat fallback
  on the same Claude endpoint, 20–30s idle reset.
- Kiosk mode, auto-relaunch, 5G router, noisy-room mic test with the real hardware.
- Rehearse the failure drills: kill Wi-Fi, kill the avatar session, confirm graceful
  degradation. **Freeze the build.**

**Do not attempt on a 3-day timeline:** LiveKit adoption, self-hosted open-source
lip-sync, a vector database, a custom avatar likeness, or a fourth renderer.

---

## 0. Read this first — the framing that saves the money

The research doc treats "which avatar vendor" as the central question. It isn't. The
avatar is the **cheapest and most swappable** layer in the stack:

| Layer | Cost | Swap cost once built |
|---|---|---|
| Avatar renderer (HeyGen / Anam / Simli / Tavus) | $0.01–0.37/min | **One adapter file** |
| Arabic STT → Claude RAG → Arabic TTS | ~$0.02–0.05/min | Rebuild everything |
| Devoteam knowledge base + guardrails | ~free after authoring | Rebuild everything |
| Kiosk shell, fallbacks, branding | staff time | Rebuild everything |

So: **build the expensive layer once, behind a provider-agnostic interface, and make
the avatar a plugin.** Every "test more than one approach" question then becomes a
config change instead of a second project.

This gives us three testable axes, independently:

- **Renderer** — HeyGen Lite / Anam passthrough / Simli / Tavus echo
- **Arabic STT** — Deepgram Nova-3 vs ElevenLabs Scribe v2 Realtime
- **Arabic TTS** — Azure `ar-SA` (Hamed/Zariyah) vs ElevenLabs Arabic

---

## 1. Start here: Phase 0 — the zero-cost lip-sync bake-off

**Do this before writing any pipeline code, and before paying any vendor.**

The insight: comparing avatar vendors does **not** require a working conversation. It
requires *audio in, video out*. So generate the Arabic audio **once**, then feed the
**identical files** to every renderer. Controlled experiment, near-zero cost, done in
a day.

### Step 0.1 — Author 12 Gulf-Arabic test phrases
Cover the real failure surface, not generic sentences:

1. Devoteam service names and English tech terms inside Arabic sentences
   (code-switching is where Arabic TTS and lip-sync both break)
2. Numbers, percentages, dates spoken in Arabic
3. Saudi/Gulf dialect greeting + a formal MSA answer
4. Long sentence (25+ words) — tests lip-sync drift
5. Short interjection (2 words) — tests attack/latency
6. A refusal ("I don't have that information…") — you'll say it a lot

Write them in `fixtures/phrases.ar.json` with an English gloss.

### Step 0.2 — Render each phrase with both TTS candidates
- **Azure Speech `ar-SA-HamedNeural` / `ar-SA-ZariyahNeural`** — free tier **F0
  gives 0.5M characters/month**. Twelve phrases is a rounding error. This is the
  single biggest cost saver in the whole project.
- **ElevenLabs** free tier for the same 12.

Output: `fixtures/audio/{azure|elevenlabs}/{01..12}.wav` at 24 kHz PCM (HeyGen Lite
wants 24000 Hz; resample per-vendor as needed).

**Have a native Gulf Arabic speaker rank these before touching any avatar.** If the
voice is wrong, no renderer saves you — and you'll have spent $0 to find out.

### Step 0.3 — Feed the same audio to every renderer, on free credits only

| Renderer | Free allowance (per research doc — verify at signup) | Mode to use |
|---|---|---|
| Anam | free tier | audio passthrough |
| Simli | $10 credits | audio in (cheapest/min) |
| HeyGen LiveAvatar | ~10 min Lite | Lite mode |
| Tavus | 25 min | echo mode |

Twelve phrases ≈ 2–3 minutes of stream per vendor. **All four fit inside free tiers.**

### Step 0.4 — Score and decide
Record each output (screen capture is fine). Score 1–5 on:

- Arabic lip-sync accuracy (esp. emphatic consonants ط/ص/ق, and code-switched English)
- Photorealism / uncanniness at booth viewing distance
- Time-to-first-frame and audio/video drift over a long sentence
- Session start latency (visitor is standing there waiting)
- Behaviour when audio stops mid-sentence (idle/listening pose)

**Exit criterion:** one primary renderer + one hot backup. Cost so far: **$0–10.**

> If no renderer clears the bar on Arabic lip-sync, stop and reconsider before
> spending on the pipeline. That's the entire point of doing this first.

---

## 2. Phase 1 — the pipeline (the part that's actually worth building)

Build only after Phase 0 names a winner.

```
mic ──► STT ──► Claude (RAG + Citations + guardrails) ──► TTS ──► AvatarAdapter ──► <video>
       (swap)                                                    (swap)
        │                                                          │
   Deepgram | ElevenLabs                        Anam | HeyGen | Simli | Tavus
```

### 2.1 The interface that makes it swappable

```ts
interface AvatarAdapter {
  connect(container: HTMLElement): Promise<void>;
  speak(audio: ArrayBuffer): Promise<void>;   // PCM passthrough — the common denominator
  interrupt(): void;                          // barge-in / new visitor
  idle(): void;
  disconnect(): Promise<void>;
}
```

Every vendor in Phase 0 supports "here is PCM, lip-sync it." Build against that and
nothing else. Anything vendor-specific (Tavus native Arabic, HeyGen Full mode) stays
behind the adapter or gets skipped.

### 2.2 Do we need LiveKit? — Not at first.

The research doc leads with LiveKit Agents. It's a good framework, but for **Phase 1
it adds a service, a deployment, and a concept layer we don't yet need**:

- LiveKit's main value is turn detection + VAD + noise cancellation. **Push-to-talk
  removes most of that value** — and push-to-talk is already the right call for a loud
  exhibition hall (the research doc says so too, §4).
- Every renderer ships a browser SDK that does WebRTC for us.
- LiveKit's noise-cancellation plugin is LiveKit-Cloud-only, i.e. another dependency
  on venue connectivity.

**Decision:** Phase 1 is a Next.js app + a thin server route. Adopt LiveKit only if
barge-in or hall noise proves to be the blocker in Phase 2 testing. Because everything
sits behind `AvatarAdapter`, that adoption is additive, not a rewrite.

*(If you'd rather not revisit it later, say so and I'll build on LiveKit from day one —
it costs ~a day of extra setup, not a redesign.)*

### 2.3 The knowledge layer — Claude Citations API, no vector DB

For a booth-sized corpus (tens of pages), **do not stand up a vector database.**
Pass the Devoteam documents as `document` content blocks with citations enabled:

```python
messages=[{
  "role": "user",
  "content": [
    {"type": "document",
     "source": {"type": "text", "media_type": "text/plain", "data": DEVOTEAM_CORPUS},
     "title": "Devoteam — LEAP booth knowledge base",
     "citations": {"enabled": True},
     "cache_control": {"type": "ephemeral"}},   # cache the corpus, not the question
    {"type": "text", "text": visitor_question},
  ],
}]
```

Two things this buys us:

- **Grounding with traceability.** Claude returns the exact source passage behind each
  claim, so "no citation → refuse" becomes an enforceable rule rather than a hope.
- **Near-zero cost.** The corpus is a stable prefix, so prompt caching applies: cache
  reads bill at ~0.1× input. Note `cache_control` goes on the **document block** (the
  stable part), never on the visitor's question.

Two constraints to design around now, not discover later:
- Citations is **incompatible with `output_config.format`** (structured outputs) —
  returns a 400. Get structure from the citation objects, not a JSON schema.
- Minimum cacheable prefix is 512 tokens on Opus 5, 1024 on Sonnet 5. Our corpus is
  far above both — but a *tiny* test corpus won't cache, and that's not a bug.

### 2.4 Model choice — and why the LLM is not the cost problem

| Model | Input / Output per MTok | Fit |
|---|---|---|
| `claude-sonnet-5` | $3 / $15 (**$2 / $10 intro through 2026-08-31**) | **Recommended for the live path** |
| `claude-opus-5` | $5 / $25 | If Arabic answer quality needs it |
| `claude-haiku-4-5` | $1 / $5 | Not needed — see the arithmetic |

Per visitor turn: ~20k cached corpus tokens read at 0.1× + ~300 output tokens.
On Sonnet 5 at intro pricing that's roughly **$0.01 per turn** — about **$10 for a
thousand booth conversations.** The LLM is the cheapest line item in the project.
Choose it on latency and Arabic quality, not price.

For the live path, favour latency explicitly:

```python
client.messages.create(
    model="claude-sonnet-5",
    max_tokens=400,                       # booth answers are short by design
    thinking={"type": "disabled"},        # accepted on Sonnet 5; cuts time-to-first-token
    output_config={"effort": "low"},
    system=DEVOTEAM_BOOTH_SYSTEM_PROMPT,
    messages=[...],
)
```

Keep a second config at `effort: "medium"` with thinking on for offline evaluation of
answer quality, so you can measure what latency is costing you.

### 2.5 Guardrails

- System prompt: answer **only** from the provided documents; if not present, say so
  and offer to fetch a Devoteam representative; never invent services, client names,
  pricing, or numbers; refuse competitors, politics, religion, anything off-Devoteam.
- **Enforce in code, not just in prose:** if a response contains no citation, replace
  it with the scripted refusal. This is the guardrail that actually holds.
- Cap answer length (`max_tokens=400`) and keep answers to 2–3 sentences — booth
  visitors don't listen to paragraphs.
- Log unanswered questions for the booth staff to follow up.
- Tone follows the brand doc §11 ("The Friendly Expert", British spelling, banned
  words list) — put the No-Fly Zone words directly in the system prompt.

### 2.6 Phase 1 exit criterion
Full loop working end-to-end in Arabic, on the winning renderer, on a laptop, over
office Wi-Fi. Backup renderer swappable by changing one env var.

---

## 3. Phase 2 — the website and the kiosk

The brand doc governs this phase. Scope for the page itself:

- **Single-purpose page**, dark surface (§1.6 `--dv-surface-base #141413`), because
  §8.1 says: no brand photography available → build heroes on dark surfaces with a
  soft neon glow, and neon + glass are designed for exactly that.
- Avatar video in a **25px-radius** hero container (§4.1 hero radius), one glass panel,
  **max 1–2 neon focal points** (§6 Rule 2).
- Montserrat **self-hosted** as a variable woff2, `font-display: optional` (§2.1) —
  no Google Fonts CDN.
- Push-to-talk as a **hero CTA** (`--dv-poppy` fill, 12px radius, ≥18.66px bold label
  so 3:1 contrast passes — §7.1).
- **"Generated with AI" label is mandatory**, not optional: EU AI Act Art. 50 (§11)
  *and* SDAIA's Generative AI Guidelines. Bilingual, visible, on the avatar surface.
- A live transcript panel — doubles as the text-chat fallback.
- Tagline "AI-driven tech consulting" — Light weight in hero (§2.5).

**Kiosk hardening (do not skip — a booth that never goes blank beats a prettier one
that crashes):**

1. Pre-rendered Devoteam avatar loop video as the attract screen and the network-failure
   fallback.
2. Text-chat fallback on the same page, same Claude endpoint, if the avatar session
   fails to initialise.
3. 20–30s idle timeout → clear conversation history → attract loop. Protects privacy
   (PDPL) and prevents context bleed between visitors.
4. Chrome `--kiosk`, sleep/screensaver disabled, auto-relaunch on crash.
5. 5G router with a local Saudi SIM as primary or backup.
6. Directional mic + push-to-talk button; noisy-room test with the actual hardware.

**PDPL (Royal Decree M/19) is in full enforcement.** Process audio in memory, retain
nothing, post a short bilingual privacy notice at the booth, and have Devoteam's DPO
review before the event. Use a stock avatar — not an employee likeness — unless signed
consent is already in hand; it removes the largest legal risk for free.

---

## 4. The cost ladder — spend in this order, stop when satisfied

| Stage | Spend | What it buys |
|---|---|---|
| Phase 0 bake-off | **$0–10** | The renderer decision, on real Arabic |
| STT/TTS comparison | **$0** | Azure F0 free tier + Deepgram/ElevenLabs free credits |
| Phase 1 pipeline dev | **$20–60** | Claude tokens + overage on whichever free tier runs out first |
| Phase 2 soak testing | **$50–150** | One paid entry tier on the *winning* vendor only |
| Event itself (3 days, ~1,080 min) | **$110–400** | Depends on renderer: Lite ~$0.10/min vs Anam/Tavus $0.20–0.37/min |

**Total realistic: $200–600**, versus the research doc's $300–600 *just for
prototyping* — because that plan buys three paid tiers up front to compare vendors.
The fixture-audio bake-off gets the same comparison for free.

**Buy nothing until Phase 0 has named a winner.** Verify every price on the vendor's
own page the day you buy — the research doc flags its own pricing as third-party and
volatile.

---

## 5. Kill criteria — decide these now, while it's cheap

- Arabic lip-sync unacceptable on **all four** renderers → pre-rendered avatar +
  live text chat. Ship that; it still looks good and it never breaks.
- End-to-end latency >2s and untunable → drop to Simli (lighter renderer) or lower
  the video resolution before touching anything else.
- Venue upload <2 Mbps and 5G congested → pre-rendered loop becomes the **default**,
  live avatar becomes the opportunistic mode.
- Any vendor puts the streaming API behind a sales call → drop it that day.

---

## 6. What I need from you

1. **Devoteam logo pack** — the four RGB SVGs referenced at `Assets/` in the brand
   doc are not in this folder or the HRSD folder. Needed for header + favicon.
2. **The knowledge corpus** — which Devoteam materials should the avatar answer from?
   Booth one-pagers, service descriptions, case studies. Rough page count decides
   whether §2.3 (long-context + Citations) holds or we need retrieval.
3. **A Gulf Arabic speaker** who can score 12 audio clips. This is the single highest-
   leverage half-hour in the project and it's free.
4. **Accounts to create** (all free, all self-serve, no sales call):
   Anam · Simli · HeyGen LiveAvatar · Tavus · Azure Speech (F0) · Deepgram ·
   ElevenLabs · Anthropic.
