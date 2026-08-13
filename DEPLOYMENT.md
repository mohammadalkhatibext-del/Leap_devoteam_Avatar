# Deployment — LEAP, Riyadh

Cloud primary, booth PC as a hot local fallback, switched by changing one URL.

This document is written to be followed by somebody standing at the stand who did not
build the thing. Commands are copy-pasteable. Where a step can fail at an event, the
failure and its fix are next to the step rather than in a troubleshooting appendix
nobody reads at 9am.

---

## 0. The shape of it, in one paragraph

The booth is **one container**. It serves the visitor page, the operator settings page,
and the API that talks to Anthropic, ElevenLabs, OpenAI and Anam. It holds no database —
a visitor's conversation lives in memory and dies with them, which is the
privacy-correct default rather than an oversight. The only state worth keeping is
`data/settings.json`, which the operator page writes and a Docker volume preserves.

That single container runs in **two places at once**: on a cloud host near Riyadh
(primary) and on the booth PC itself (fallback). The kiosk browser points at one of
them. Failing over is editing a shortcut and pressing F5 — no rebuild, no redeploy, no
DNS wait.

```
                    ┌──────────────────────────────┐
   Kiosk browser ──▶│  PRIMARY   cloud, Bahrain    │──▶ Anthropic · ElevenLabs
   (Chrome kiosk)   │  https://booth.<domain>      │    OpenAI · Anam
        │           └──────────────────────────────┘
        │  one URL change
        │           ┌──────────────────────────────┐
        └──────────▶│  FALLBACK  the booth PC      │──▶ same vendors
                    │  http://localhost:8080       │
                    └──────────────────────────────┘
```

**Why both.** The cloud host has reliable power, reliable networking and a real TLS
certificate. The booth PC keeps working when the venue's uplink dies — which at an
exhibition is not a hypothetical. Neither alone is enough: a cloud-only booth is dark
the moment the hall's internet drops, and a PC-only booth has a single point of failure
sitting under a table where people kick cables.

**What neither survives.** Both call the same four vendor APIs over the internet. If the
venue has *no* connectivity at all, no deployment topology saves you — see §8 for the
only real mitigation, which is a 4G backup and a rehearsed degraded mode.

---

## 1. Before you go — the week before

- [ ] **Billing has headroom on all four vendors.** Anthropic, ElevenLabs, OpenAI, Anam.
      A card that declines mid-event is the most likely total failure and the one with
      no technical workaround. Check the actual balance, not the plan name.
- [ ] **ElevenLabs character budget.** Answers run ~150 characters each. 3,000 visitor
      questions is ~450k characters. Confirm the plan covers it with margin, because
      running out is silent — the API just starts returning 401s.
- [ ] **Anam concurrent-session limit.** You will run at least two copies of this booth
      (cloud + local) and probably a laptop testing. Each open avatar holds a slot.
      Know the number before you find it at the stand.
- [ ] **`npm run check:anam`** — confirms the avatar id the key can actually use.
- [ ] **Read §2 of this file and actually deploy the cloud host.** Not on the day.
- [ ] **A rehearsal on the real hardware**, in a room with the real screen, with someone
      who has not seen it before walking up and talking to it.

---

## 2. Primary — the cloud host

### 2.1 Where

**Region matters more than provider.** Every leg of the pipeline is a round trip, and
the booth makes several per question. From this machine the vendor round-trips measured
172–371 ms; from a host in the Gulf they are meaningfully shorter, and from us-east-1
they are worse than running on the booth PC.

Pick, in order of preference:

| Option | Region | Notes |
|---|---|---|
| **AWS Bahrain** `me-south-1` | ~30 ms to Riyadh | Closest mainstream region. A `t4g.small` is ample. |
| **AWS UAE** `me-central-1` | ~40 ms | Equivalent. Pick on whichever account exists already. |
| **Azure UAE North** | ~40 ms | Also where `AZURE_SPEECH_REGION=uaenorth` points, if you ever move TTS to Azure. |
| Anything in Europe | ~120 ms+ | Adds ~250 ms per question round trip. Acceptable, not good. |

Do **not** deploy to a US region. It adds roughly a second to every answer, which is
about a third of the entire latency budget the speed work just recovered.

### 2.2 Size

`t4g.small` (2 vCPU, 2 GB) or equivalent. The booth is I/O-bound — it waits on vendor
APIs — so cores buy nothing. 2 GB is comfortable; the compose file caps the container
at 1 GB.

### 2.3 Bring it up

```bash
# on the host, once
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER   # log out and back in

git clone https://github.com/mohammadalkhatibext-del/Leap_devoteam_Avatar.git
cd Leap_devoteam_Avatar

# Keys. .env is gitignored, so it does not arrive with the clone.
cp .env.example .env
nano .env                       # paste the real values

docker compose up -d --build
docker compose logs -f booth    # ctrl-C to stop watching
```

Verify before you trust it:

```bash
curl -s localhost:8080/api/health
# {"ok":true,"answerModel":"claude-sonnet-5","ttsEngine":"elevenlabs", ... }
```

`ok:false` means either the settings file could not be read or `ANTHROPIC_API_KEY` is
missing. Both are in `.env`.

### 2.4 TLS — not optional

**The browser will not give you a microphone over plain HTTP.** `getUserMedia` requires
a secure context, and the only exception is `localhost`. So the cloud host *must* have a
real certificate or the booth cannot hear anybody — while looking otherwise perfectly
healthy, which makes it a nasty thing to discover on the day. (The local fallback is
exempt because it is served from `localhost`.)

Caddy is the least effort, because it obtains and renews the certificate itself:

```bash
sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
booth.your-domain.com {
    reverse_proxy localhost:8080 {
        # The answer is streamed to the browser sentence by sentence over SSE. A proxy
        # that buffers delivers the whole answer at once at the end — every latency
        # gain in the pipeline undone by the thing in front of it. Caddy does not
        # buffer by default; this makes it explicit so nobody "optimises" it later.
        flush_interval -1
    }
}
EOF
sudo systemctl restart caddy
```

Point `booth.your-domain.com` at the host's IP **before** starting Caddy — certificate
issuance needs the DNS record to already resolve.

> If you use nginx instead, you need `proxy_buffering off;` and
> `proxy_read_timeout 300s;` on the `/api/ask` location. The app already sends
> `X-Accel-Buffering: no`, which nginx honours, but the timeout is yours to set.

### 2.5 Lock the door

The operator page has no password. It is reachable at `/admin.html` and it can change
the avatar, the voice, and the knowledge base. On a public URL, restrict it:

```
# inside the Caddyfile site block, above the reverse_proxy
@admin path /admin.html /api/settings*
basic_auth @admin {
    devoteam $2a$14$...      # caddy hash-password
}
```

Alternatively bind it to the stand's IP. What you must not do is leave it open and hope
nobody at a technology conference types `/admin.html`.

---

## 3. Fallback — the booth PC

Same container, same commands, on the machine driving the screen.

```bash
cd Leap_devoteam_Avatar
docker compose up -d --build
```

Then confirm `http://localhost:8080/api/health` answers. That is the whole fallback: it
is already running, all day, warm, alongside the cloud one. It costs nothing but a
little RAM, and having it *already running* rather than "ready to start" is the entire
point — a fallback you have to build under pressure is not a fallback.

**Windows note.** Docker Desktop must be set to start on login, or the booth does not
come back after the machine is switched off overnight. Settings → General → *Start
Docker Desktop when you sign in*. The compose file's `restart: always` handles the
container itself once the daemon is up.

**If Docker is unavailable on that machine**, the same thing runs natively:

```bash
npm ci
npm run build
npm start                       # http://localhost:8080
```

---

## 4. The kiosk browser

```
chrome.exe --kiosk --app=https://booth.your-domain.com
           --autoplay-policy=no-user-gesture-required
           --unsafely-treat-insecure-origin-as-secure=http://booth-pc.local:8080
```

- `--kiosk` removes the browser chrome, so nobody at LEAP can navigate away.
- `--autoplay-policy=no-user-gesture-required` matters: the avatar's audio comes through
  a `<video>` element that is deliberately **not muted** (Anam puts audio and video on
  the same element, so muting it silences the avatar entirely). Without this flag the
  first answer can be silent until someone clicks. The tap-to-start gate makes this
  unlikely — a tap *is* a user gesture — but the flag removes the case entirely.
- The last flag is only needed if you ever point the kiosk at the fallback over the
  network rather than `localhost`. Prefer `localhost`.

**Make a desktop shortcut for each target**, named `BOOTH — cloud` and
`BOOTH — local`. Failing over then means closing one and double-clicking the other,
which is a thing a stand host can do without being talked through it.

Also: **disable Windows sleep, screen blanking, and Windows Update restarts.** An
overnight forced reboot with a pending update is a classic way to arrive at a dark
stand.

---

## 5. Settings, on the day

Open `/admin.html` on whichever instance is live. The settings that matter, and what
they are set to:

| Setting | Value | Why |
|---|---|---|
| Renderer | **Anam** | Passed Phase 0 at 55/60. Lip-syncs our own Arabic voice. |
| Avatar | **Dania** | ⚠ The `.env` comment said "Faisal" for months and was wrong. Verify by eye. |
| Voice | **Female — Abrar Sabbah / Jessa** | Must match the avatar's gender. See below. |
| Voice engine | **ElevenLabs, Flash v2.5** | ~290 ms per sentence against ~3.4 s for OpenAI. |
| Hearing | **OpenAI** | ~280 ms on a booth-length clip. |
| Answer model | **Sonnet 5** | Haiku is ~1 s faster but overruns the length budget. |
| Answer length | **Short (22 words)** | Runs ~16 s out loud. |
| Tap to start | **On** | No avatar session until a visitor touches the screen. |
| Close after | **2 minutes** | An empty stand costs nothing. |

> **The voice and the avatar must agree.** If you switch the avatar to Faisal, switch
> the voice to Male in the same breath. A woman's face speaking with a man's voice is
> the most visible way this booth can be wrong — a visitor notices it before they hear
> a word of the answer.

Settings are stored in a Docker volume and survive `docker compose up --build`. They do
**not** transfer between the cloud and local instances — set both, once, and check them
both before doors open.

---

## 6. Event-day runbook

### Doors open, 30 minutes before

```bash
docker compose ps                        # both hosts: "Up (healthy)"
curl -s localhost:8080/api/health        # both hosts: ok:true
```

Then, on the kiosk itself: tap the screen, ask **"ما هي ديفوتيم؟"** out loud, and listen
to the whole answer. This is the only check that exercises every leg — microphone,
speech recognition, model, voice, avatar and speakers. A green health check with a dead
microphone is a booth that fails on its first visitor.

Listen for: does it start speaking within ~3 seconds, is the voice the right gender, is
the face framed properly, does the sound come out of the right speakers.

### During the day

| Symptom | First thing to do |
|---|---|
| Screen frozen, no face | Long-press the Devoteam logo 1.5 s → operator panel → **Wake avatar** |
| Face there, no sound | Check the physical volume and output device before anything else |
| "Not connected", won't wake | Another instance is holding the Anam session. Close the other tab/laptop. |
| Answers slow, everything else fine | Venue uplink. Switch the kiosk shortcut to **BOOTH — local**. |
| Nothing works | `docker compose restart booth` — ~15 s. Fixes most things. |
| Still nothing | Switch to the other instance. Diagnose later, not in front of visitors. |

The operator panel (long-press the logo, or Ctrl+Shift+O) shows the timing of the last
answer: `speak at 1780ms · answer 3204ms · cache read 31352`. If **cache read** is 0 on
every question, the prompt cache is not being hit and every answer costs ~10× — worth
noticing, not worth fixing during show hours.

### End of day

Nothing required. The idle timer closes the avatar session after 2 minutes, so an
unattended stand overnight costs nothing. Leave the machine on.

---

## 7. What it costs

Per visitor question, roughly:

| Leg | Cost |
|---|---|
| Claude (Sonnet 5, ~31k cached input + ~150 output) | ~$0.01 |
| ElevenLabs (~150 characters, Flash) | ~$0.002 |
| OpenAI speech-to-text (~3 s clip) | ~$0.0003 |
| Anam | per session-minute, not per question |

So the model dominates, and the prompt cache is what keeps it at a cent rather than ten.
1,000 questions a day is on the order of **$15–20/day** plus the Anam session time — and
the tap-to-start gate plus the 2-minute idle close is what stops Anam from being billed
for eight idle hours a day.

Cloud host: a `t4g.small` is a few dollars for the week.

---

## 8. When the venue's internet dies

This is the failure with no clean technical answer, so decide the response in advance
rather than improvising it.

1. **Have a 4G/5G router or a phone hotspot at the stand, already paired with the booth
   PC.** Switching to it should be selecting a known network, not entering a password
   found in someone's email. The booth's traffic is small — text and short audio clips,
   not video: the avatar's video comes *from* Anam over the same link, which is the
   heaviest part, so budget for a real connection rather than a trickle.
2. **Switch the kiosk to `BOOTH — local`**, so at least you are not routing through a
   cloud host over a dying uplink.
3. **If there is genuinely no connectivity**, the booth cannot answer — every leg is a
   vendor API. The fallback message is already configured and the avatar will say it
   out loud in the visitor's language, which is a far better failure than a frozen
   face. Brief the stand hosts that this is what they will see, and what to say.

There is no offline mode and building one is not a week's work — it would mean a local
model, a local Arabic voice and a local renderer. Do not let anyone promise it on the
morning of day one.

---

## 9. Rollback

The image is tagged `devoteam-leap-booth:latest`. Before making any change during the
event, tag what is currently working:

```bash
docker tag devoteam-leap-booth:latest devoteam-leap-booth:known-good
```

To go back:

```bash
docker compose down
docker tag devoteam-leap-booth:known-good devoteam-leap-booth:latest
docker compose up -d          # no --build: reuses the tagged image
```

Settings are in a volume and are untouched by this.

**Do not `git pull` during show hours.** If a fix is genuinely needed, make it on the
fallback instance first, prove it with a real spoken question, and only then touch the
primary.
