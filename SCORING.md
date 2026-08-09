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

**Scored 2026-08-09 by Mohammad (native Arabic, Jordanian).** Verdict: *all four are the
same, 7/10* — i.e. 3.5/5 flat across every column, no voice distinguishable from another.

| Voice | Naturalness | Gulf-appropriate | Code-switch (02) | Numbers (03) | Brand name (08) | Total |
|---|---|---|---|---|---|---|
| `ar-SA-HamedNeural` (Saudi, m) | 3.5 | 3.5 | 3.5 | 3.5 | 3.5 | **17.5 / 25** |
| `ar-SA-ZariyahNeural` (Saudi, f) | 3.5 | 3.5 | 3.5 | 3.5 | 3.5 | **17.5 / 25** |
| `ar-JO-TaimNeural` (Jordanian, m) | 3.5 | 3.5 | 3.5 | 3.5 | 3.5 | **17.5 / 25** |
| `ar-JO-SanaNeural` (Jordanian, f) | 3.5 | 3.5 | 3.5 | 3.5 | 3.5 | **17.5 / 25** |

The two `ar-JO` voices are **calibration references, not candidates** — the booth is in
Riyadh. They're here so a Levantine listener can tell "this model sounds robotic" apart
from "this model sounds fine but foreign to a Saudi." If Hamed sounds as natural to you
as Taim does, the Saudi voice is good.

**Reading the tie:** this is the outcome the calibration was designed to detect. A
Jordanian listener rating the Saudi voices exactly level with the Jordanian ones means
the ar-SA voices carry no accent penalty and no extra robotness — the calibration test
passes. 3.5 clears the "acceptable for a booth" bar (3) without clearing "good" (4), so
the voice is a **pass, not an asset**: it won't sink the booth and it won't sell it.
Nothing here justifies spending money to upgrade TTS before the renderer is proven.

Because voice quality can't break the tie, it's broken on context instead:
- **Locale** — the booth is in Riyadh, so `ar-SA` over `ar-JO`.
- **Gender** — must match the avatar. The Anam persona is `Faisal - Cultural Guide`
  (male), so the male voice.

**Winner:** `ar-SA-HamedNeural` → `fixtures/audio/edge/ar-SA-HamedNeural@24k/`
→ use this voice's audio for every renderer below.

> These were rendered via the Edge endpoint for evaluation. They are the same neural
> voices Azure Speech serves, so the ranking transfers — but the shipped build must
> re-render through an Azure F0 key (`node scripts/render-tts.mjs azure`).

### Also decide here: dialect or MSA?

Phrases 01 and 12 are deliberately Gulf-dialect (*هلا وغلا*, *خلني أنادي*). Many Saudi
corporate settings default to MSA instead. If the dialect sounds forced coming from
these voices, switch the booth to MSA — it's a one-file change in
`fixtures/phrases.ar.json` and it affects the system prompt in Phase 1.

**Decision (2026-08-09):** **mixed** — MSA body, Gulf-dialect greeting and handoff.

Substantive answers about Devoteam services are Modern Standard Arabic; only the opening
greeting and the "let me call a colleague" handoff are dialect. This is what most Saudi
corporate booths actually sound like, and it hedges the one soft spot in the voice score:
MSA masks accent origin, dialect exposes it, so the 3.5 on Gulf-appropriateness is
confined to two short phrases where warmth matters more than register.

**No re-render needed** — `fixtures/phrases.ar.json` is already built this way (01 and 12
dialect, everything else MSA). The 48 WAVs stand as scored.

**Carry into Phase 1** — system prompt rule: *respond in Modern Standard Arabic; use Gulf
dialect only for greetings and for handing off to a human.*

---

## Step 2 — Renderer scorecard

> **Reduced to one candidate on 2026-08-09 — payment access, not quality.** HeyGen
> rejects every card and Apple Pay, so no LiveAvatar API key can be issued; Simli and
> Tavus both require a card to pass signup. **Anam is the only renderer reachable**, and
> its key is verified working (`GET /v1/avatars` → 200, passthrough session token → 200).
>
> So this stops being a comparison and becomes a **pass/fail qualification**: Anam either
> clears the bar or the project falls back to the `STRATEGY.md` §5 kill criterion. Score
> it exactly as strictly as if there were three alternatives — there aren't, which makes
> an honest score *more* important, not less. A generous score here buys a bad booth.

### Renderer: Anam (audio passthrough) — **PASS**

**Scored 2026-08-09 by Mohammad**, fixture set `edge/ar-JO-SanaNeural@24k`, avatar
`Faisal - Cultural Guide`. Scores are for the **avatar's lip-sync**, judged separately
from voice quality — the voice is the known 3.5 from Step 1 and is not what is being
tested here.

| # | What it tests | Lip-sync 1–5 | Notes |
|---|---|---|---|
| 01 | Gulf greeting | 4 | |
| 02 | **Code-switch (AWS/Azure/Kubernetes)** | **4** | decisive row — clears |
| 03 | Arabic numbers | 5 | |
| 04 | **Long sentence — check the LAST 5 seconds** | **5** | decisive row — no drift |
| 05 | Short interjection | 4 | |
| 06 | Short interjection 2 | 5 | |
| 07 | **Emphatic consonants ق ط ص ض** | **4** | decisive row — clears |
| 08 | Brand name "ديفوتيم" | 5 | |
| 09 | Question intonation | 4 | |
| 10 | List pausing | 5 | |
| 11 | Refusal (tone) | 4 | the response visitors will see most |
| 12 | Dialect handoff | 5 | |

**Total 55/60 (avg 4.6). No row below 4; all three decisive rows clear comfortably.**

Bolded rows are the ones that actually discriminate between vendors. If a renderer
scores ≤2 on 02, 04 or 07, it fails regardless of its average. Anam does not come
close to that bar — **04 scoring 5 is the strongest single result**, because A/V drift
over a 35-word sentence is the failure that no amount of prompt or audio work can fix.

> **One confirmation pass still owed.** These scores were taken with a *female*
> Jordanian voice (`ar-JO-SanaNeural`) driving a *male* avatar (Faisal). Lip-sync
> judgements transfer — same phoneme inventory, same 24 kHz PCM, and viseme mapping is
> not gender-specific — so the PASS stands. But the shipping pair is
> `ar-SA-HamedNeural` through Faisal, and nobody has yet watched that combination for
> the thing this test could not surface: whether voice and face read as the same person.
> Five minutes, once, before the booth is signed off.

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

**Phase 0 closed 2026-08-09.** Anam passed at 55/60 with every decisive row ≥4, so the
`STRATEGY.md` §5 kill criterion is **not** invoked as the primary path — it becomes the
backup deliverable instead.

| | Renderer | Why |
|---|---|---|
| **Primary** | **Anam — PASS (55/60)** | Lip-sync clears on all three decisive rows; only vendor reachable without a card; key verified live |
| **Hot backup** | **Not a vendor** — `STRATEGY.md` §5 fallback | See below |
| **Rejected** | HeyGen LiveAvatar | Cards + Apple Pay all declined → no API key obtainable |
| **Rejected** | Simli, Tavus | Card required at signup; same blocker |

**On the hot backup.** The original plan assumed the backup was a second renderer. With
every other vendor behind a card, there is no second renderer to hold in reserve — so
the backup has to be the thing that needs no vendor at all: a **pre-rendered Devoteam
avatar loop plus live text chat on the same Claude endpoint**. Treat this as a real
deliverable to build, not a paragraph to point at. It is the only thing standing between
an Anam outage on the show floor and a dead booth, and it is cheap to build precisely
because it shares the Claude + corpus layer with the live path.

**Money spent so far:** $0 (target: $0–10)

**If nothing clears the bar:** invoke the kill criterion in `STRATEGY.md` §5 — ship a
pre-rendered Devoteam avatar loop plus live text chat on the same Claude endpoint. It
still looks good, it never breaks, and it costs a fraction. Decide this on **Day 1**,
not Day 3.
