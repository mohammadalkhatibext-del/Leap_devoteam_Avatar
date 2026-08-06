#!/usr/bin/env python3
"""
EVALUATION ONLY — do not ship this path.

Renders the Arabic fixture phrases using Microsoft's neural voices via the Edge
read-aloud endpoint (no API key, no card). The voices are byte-for-byte the same
models as Azure Speech `ar-SA-HamedNeural` / `ar-SA-ZariyahNeural`, so judgements
made here carry over exactly to the production Azure path.

Why it exists: it unblocks the Phase 0 voice ranking today, without waiting on an
Azure subscription. The booth build must use a real Azure key on the F0 free tier
(scripts/render-tts.mjs azure) — this endpoint is undocumented and is not a
production dependency.

    python scripts/render-edge-tts.py                          # all four voices
    python scripts/render-edge-tts.py ar-SA-HamedNeural        # just one

Output: fixtures/audio/edge/<voice>@24k/<id>.wav  (24 kHz, 16-bit, mono)
        — the same format the avatar bake-off harness consumes.
"""

import asyncio
import json
import struct
import sys
from pathlib import Path

import edge_tts
import miniaudio

ROOT = Path(__file__).resolve().parent.parent
SAMPLE_RATE = 24000

# Windows consoles default to cp1252, which can't encode the arrows (or Arabic)
# we print. Force UTF-8 so progress output doesn't crash the render.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_VOICES = [
    "ar-SA-HamedNeural",    # Saudi male   — the primary booth candidate
    "ar-SA-ZariyahNeural",  # Saudi female — the primary booth candidate
    "ar-JO-TaimNeural",     # Jordanian male   — calibration reference
    "ar-JO-SanaNeural",     # Jordanian female — calibration reference
]


def write_wav(path: Path, pcm: bytes, rate: int = SAMPLE_RATE) -> None:
    """Minimal RIFF/WAVE wrapper for 16-bit mono PCM."""
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", len(pcm))
    path.write_bytes(header + pcm)


async def synth(text: str, voice: str) -> bytes:
    """Collect the MP3 stream, then decode to raw 16-bit mono PCM at 24 kHz."""
    mp3 = bytearray()
    async for chunk in edge_tts.Communicate(text, voice).stream():
        if chunk["type"] == "audio":
            mp3.extend(chunk["data"])

    decoded = miniaudio.decode(
        bytes(mp3),
        output_format=miniaudio.SampleFormat.SIGNED16,
        nchannels=1,
        sample_rate=SAMPLE_RATE,
    )
    return decoded.samples.tobytes()


async def render(voice: str, phrases: list) -> None:
    out_dir = ROOT / "fixtures" / "audio" / "edge" / f"{voice}@{SAMPLE_RATE // 1000}k"
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n{voice} → fixtures/audio/edge/{out_dir.name}/\n")

    for p in phrases:
        label = p["tests"][:52].ljust(54)
        print(f"  {p['id']}  {label}", end="", flush=True)
        try:
            pcm = await synth(p["ar"], voice)
            write_wav(out_dir / f"{p['id']}.wav", pcm)
            secs = len(pcm) / 2 / SAMPLE_RATE
            print(f"ok  {secs:.1f}s")
        except Exception as err:
            print("FAIL")
            print(f"       {err}\n")

    (out_dir / "manifest.json").write_text(
        json.dumps(
            {
                "provider": "edge",
                "voice": voice,
                "sampleRate": SAMPLE_RATE,
                "provenance": "EVALUATION ONLY — Edge read-aloud endpoint. "
                "Same neural voice as Azure Speech; production must use an Azure F0 key.",
                "phrases": phrases,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


async def main() -> None:
    phrases = json.loads(
        (ROOT / "fixtures" / "phrases.ar.json").read_text(encoding="utf-8")
    )["phrases"]

    voices = sys.argv[1:] or DEFAULT_VOICES
    for voice in voices:
        await render(voice, phrases)

    print("\nRanked these in SCORING.md Step 1 — the winner becomes the audio")
    print("for every renderer in the avatar bake-off.\n")


if __name__ == "__main__":
    asyncio.run(main())
