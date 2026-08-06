# Devoteam LEAP — Speaking Avatar

Devoteam-branded web kiosk hosting an Arabic-speaking avatar that answers visitor
questions from Devoteam content, grounded with the Claude Citations API.

**Plan:** [`STRATEGY.md`](./STRATEGY.md) — read the 3-day plan at the top first.
**Brand rules:** [`DEVOTEAM_BRAND_DESIGN.md`](./DEVOTEAM_BRAND_DESIGN.md)
**Vendor research:** [`compass_artifact_wf-...md`](./compass_artifact_wf-23d409fb-71ff-5428-a63f-37f6d0631eb7_text_markdown.md)

---

## Phase 0 — the lip-sync bake-off (start here, costs $0–10)

Comparing avatar vendors doesn't need a working conversation — it needs *audio in,
video out*. So render the Arabic test phrases **once**, then feed the **identical
files** to every renderer. Controlled experiment, free tiers only.

```bash
cp .env.example .env      # fill in AZURE_SPEECH_KEY + region (F0 tier is free)

node scripts/render-tts.mjs azure
node scripts/render-tts.mjs azure --voice ar-SA-ZariyahNeural
node scripts/render-tts.mjs elevenlabs
```

Output lands in `fixtures/audio/<provider>/<voice>/*.wav` — 24 kHz, 16-bit, mono,
which is the common denominator across HeyGen Lite, Anam passthrough, Simli and
Tavus echo. One render feeds all four.

Then score with [`SCORING.md`](./SCORING.md). **Step 1 (voice ranking) gates
everything** — if the Arabic voice is wrong, no renderer saves you, and you'll have
spent nothing to find out.

Requires Node 18+. No dependencies.

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
- **Knowledge corpus not yet supplied.** Page count decides whether long-context +
  Citations holds (it should, for a booth-sized corpus) or retrieval is needed.
- The brand doc is written as a migration guide for the HRSD Next.js app. Use §10.1
  (token block), §2.2 (type scale) and the rules; ignore §10's migration map.
