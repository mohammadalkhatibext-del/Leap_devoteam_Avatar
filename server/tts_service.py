#!/usr/bin/env python3
"""
Arabic TTS sidecar — text in, 24 kHz PCM out.

    python server/tts_service.py [--port 8765]

    POST /tts   {"text": "...", "voice": "ar-SA-HamedNeural"}  ->  raw s16le PCM
    GET  /health                                               ->  {"ok": true, ...}

WHY A LONG-RUNNING SERVICE, not a subprocess per sentence: the booth synthesises one
sentence at a time while the visitor is standing there. Paying ~300 ms of Python
interpreter startup on every sentence would roughly double perceived latency for no
reason. This process stays warm; Node talks to it over localhost.

WHY PYTHON AT ALL, in an otherwise Node project: `edge-tts` is the only Arabic voice
reachable without a credit card, and it is a Python package. See the provenance note.

────────────────────────────────────────────────────────────────────────────────
PROVENANCE — READ BEFORE SHIPPING

This reaches Microsoft's neural voices through the **Edge read-aloud endpoint**: no
API key, no card. The voices are the same models Azure Speech serves as
`ar-SA-HamedNeural` / `ar-SA-ZariyahNeural`, so quality is identical to the paid path
— what differs is legitimacy and reliability, not sound.

The endpoint is undocumented and can change or start refusing traffic without notice.
It is fine for building and for internal demos. It is **not** what should be running
on the booth floor at LEAP. Swapping to Azure F0 (free tier, 0.5M chars/month) is a
change to `synth()` alone, because everything downstream already consumes 24 kHz PCM.

As of 2026-08-09 Azure signup is still card-blocked, so this is the only working
Arabic voice — a constraint, not a choice.
────────────────────────────────────────────────────────────────────────────────
"""

import argparse
import array
import asyncio
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import edge_tts
import miniaudio

SAMPLE_RATE = 24000  # Anam takes the rate as a parameter; 24 kHz matches the fixtures.
DEFAULT_VOICE = "ar-SA-HamedNeural"  # SCORING.md Step 1 winner — male, matches Faisal.

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


SILENCE_THRESHOLD = 300  # out of 32767 — comfortably above the codec's noise floor
FRAME_MS = 10
KEEP_PAD_MS = 40  # leave a little air so the first consonant isn't clipped


def trim_silence(pcm: bytes, rate: int = SAMPLE_RATE) -> bytes:
    """Strip leading and trailing silence from a clip.

    edge-tts pads every utterance with roughly a second of silence at each end. That
    is harmless for a one-off file and ruinous for the booth: answers are synthesised
    one sentence at a time and played back to back, so the padding becomes a dead gap
    between every sentence — about eight seconds across a typical answer, during which
    a photorealistic face sits motionless and looks like it has crashed.

    Trimming here rather than in Node keeps it next to the samples, and means the
    Azure swap inherits the fix for free.
    """
    samples = array.array("h")
    samples.frombytes(pcm)
    if not samples:
        return pcm

    frame = max(1, rate * FRAME_MS // 1000)
    pad = rate * KEEP_PAD_MS // 1000

    def loud(i: int) -> bool:
        chunk = samples[i : i + frame]
        return any(s > SILENCE_THRESHOLD or s < -SILENCE_THRESHOLD for s in chunk)

    starts = range(0, len(samples), frame)
    first = next((i for i in starts if loud(i)), None)
    if first is None:
        return b""  # nothing but silence
    last = next(i for i in reversed(starts) if loud(i))

    lo = max(0, first - pad)
    hi = min(len(samples), last + frame + pad)
    return samples[lo:hi].tobytes()


async def synth(text: str, voice: str) -> bytes:
    """Arabic text -> raw 16-bit mono PCM at 24 kHz.

    This is the single function to replace when an Azure key becomes available;
    nothing downstream knows or cares which endpoint produced the samples.
    """
    mp3 = bytearray()
    async for chunk in edge_tts.Communicate(text, voice).stream():
        if chunk["type"] == "audio":
            mp3.extend(chunk["data"])

    if not mp3:
        raise RuntimeError(f"no audio returned for voice {voice!r}")

    # edge-tts emits MP3; miniaudio decodes it without needing ffmpeg on PATH,
    # which this machine does not have.
    decoded = miniaudio.decode(
        bytes(mp3),
        output_format=miniaudio.SampleFormat.SIGNED16,
        nchannels=1,
        sample_rate=SAMPLE_RATE,
    )
    return trim_silence(decoded.samples.tobytes())


BOOTH_LOCALES = ("ar-", "en-")


async def list_voices() -> list:
    """Arabic and English neural voices, for the admin page's picker.

    Restricted to the booth's two languages — the full list is several hundred
    entries, and an operator scrolling past Vietnamese to find Saudi Arabic is a
    worse experience than a short list that only contains usable options.
    """
    out = []
    for v in await edge_tts.list_voices():
        name = v.get("ShortName", "")
        if not name.startswith(BOOTH_LOCALES):
            continue
        out.append(
            {
                "id": name,
                "language": name[:2],
                "locale": name.split("-")[1] if "-" in name else "",
                "gender": v.get("Gender", ""),
            }
        )
    out.sort(key=lambda v: (v["language"] != "ar", v["id"]))
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter than the default access log
        pass

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "sampleRate": SAMPLE_RATE, "voice": DEFAULT_VOICE})
        elif self.path.startswith("/voices"):
            # Powers the admin page's voice picker, so a booth operator chooses from
            # real voices rather than typing an id they'd have to look up.
            try:
                self._json(200, {"voices": asyncio.run(list_voices())})
            except Exception as err:
                self._json(502, {"error": f"{type(err).__name__}: {err}"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/tts":
            return self._json(404, {"error": "not found"})

        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception as err:
            return self._json(400, {"error": f"bad request body: {err}"})

        text = (req.get("text") or "").strip()
        if not text:
            return self._json(400, {"error": "text is required"})

        voice = req.get("voice") or DEFAULT_VOICE

        try:
            pcm = asyncio.run(synth(text, voice))
        except Exception as err:
            print(f"  tts FAIL  {type(err).__name__}: {err}", flush=True)
            return self._json(502, {"error": f"{type(err).__name__}: {err}"})

        secs = len(pcm) / 2 / SAMPLE_RATE
        print(f"  tts ok  {secs:5.1f}s  {voice}  {text[:60]}", flush=True)

        self.send_response(200)
        # audio/L16 is the IANA type for raw 16-bit linear PCM.
        self.send_header("Content-Type", f"audio/L16; rate={SAMPLE_RATE}; channels=1")
        self.send_header("X-Sample-Rate", str(SAMPLE_RATE))
        self.send_header("X-Provenance", "edge-tts; evaluation endpoint; not for production")
        self.send_header("Content-Length", str(len(pcm)))
        self.end_headers()
        self.wfile.write(pcm)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Arabic TTS sidecar on http://127.0.0.1:{args.port}  ({DEFAULT_VOICE} @ {SAMPLE_RATE} Hz)")
    print("  edge-tts endpoint — evaluation only, see the provenance note in this file\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
