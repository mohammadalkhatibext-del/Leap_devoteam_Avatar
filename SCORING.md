# Phase 0 — Scoring Sheet

Fill one table per renderer. **Use the same audio files for every renderer** — that's
the whole point. Score 1–5, where 3 = "acceptable for a booth", 5 = "indistinguishable".

**Score with a native Gulf Arabic speaker present.** Half an hour of their time is the
highest-leverage input in this project, and it's free.

---

## Step 1 — TTS voice ranking (do this BEFORE any avatar)

If the voice is wrong, no renderer saves you. Listen to all 12 phrases from each voice
and rank. Stop here if none clear a 3.

Rendered and waiting in `fixtures/audio/edge/`:

| Voice | Naturalness | Gulf-appropriate | Code-switch (02) | Numbers (03) | Brand name (08) | Total |
|---|---|---|---|---|---|---|
| `ar-SA-HamedNeural` (Saudi, m) | | | | | | |
| `ar-SA-ZariyahNeural` (Saudi, f) | | | | | | |
| `ar-JO-TaimNeural` (Jordanian, m) | | | | | | |
| `ar-JO-SanaNeural` (Jordanian, f) | | | | | | |

The two `ar-JO` voices are **calibration references, not candidates** — the booth is in
Riyadh. They're here so a Levantine listener can tell "this model sounds robotic" apart
from "this model sounds fine but foreign to a Saudi." If Hamed sounds as natural to you
as Taim does, the Saudi voice is good.

**Winner:** ________________  → use this voice's audio for every renderer below.

> These were rendered via the Edge endpoint for evaluation. They are the same neural
> voices Azure Speech serves, so the ranking transfers — but the shipped build must
> re-render through an Azure F0 key (`node scripts/render-tts.mjs azure`).

### Also decide here: dialect or MSA?

Phrases 01 and 12 are deliberately Gulf-dialect (*هلا وغلا*, *خلني أنادي*). Many Saudi
corporate settings default to MSA instead. If the dialect sounds forced coming from
these voices, switch the booth to MSA — it's a one-file change in
`fixtures/phrases.ar.json` and it affects the system prompt in Phase 1.

**Decision:** dialect / MSA / mixed → ________________

---

## Step 2 — Renderer scorecard

Copy this block per renderer: **Anam · HeyGen LiveAvatar (Lite) · Simli · Tavus (echo)**

### Renderer: ________________

| # | What it tests | Lip-sync 1–5 | Notes |
|---|---|---|---|
| 01 | Gulf greeting | | |
| 02 | **Code-switch (AWS/Azure/Kubernetes)** | | |
| 03 | Arabic numbers | | |
| 04 | **Long sentence — check the LAST 5 seconds** | | |
| 05 | Short interjection | | |
| 06 | Short interjection 2 | | |
| 07 | **Emphatic consonants ق ط ص ض** | | |
| 08 | Brand name "ديفوتيم" | | |
| 09 | Question intonation | | |
| 10 | List pausing | | |
| 11 | Refusal (tone) | | |
| 12 | Dialect handoff | | |

Bolded rows are the ones that actually discriminate between vendors. If a renderer
scores ≤2 on 02, 04 or 07, it fails regardless of its average.

**Non-lip-sync criteria:**

| Criterion | Score / measurement |
|---|---|
| Photorealism at ~1.5 m viewing distance | /5 |
| Uncanniness (does it unsettle people?) | /5 |
| Session start latency (click → avatar visible) | ______ s |
| `speak()` → first mouth movement | ______ ms |
| A/V drift by end of phrase 04 | none / slight / bad |
| Idle pose when audio stops | natural / frozen / glitchy |
| Behaviour on mid-sentence interrupt | ______ |
| Reconnect after network drop | ______ |

**Verdict:** primary / backup / reject
**Blocking issue (if any):** ________________

---

## Step 3 — Decision

| | Renderer | Why |
|---|---|---|
| **Primary** | | |
| **Hot backup** | | |
| **Rejected** | | |

**Money spent so far:** $______ (target: $0–10)

**If nothing clears the bar:** invoke the kill criterion in `STRATEGY.md` §5 — ship a
pre-rendered Devoteam avatar loop plus live text chat on the same Claude endpoint. It
still looks good, it never breaks, and it costs a fraction. Decide this on **Day 1**,
not Day 3.
