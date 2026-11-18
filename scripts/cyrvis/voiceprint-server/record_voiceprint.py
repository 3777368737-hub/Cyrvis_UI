"""
Record a speaker sample and enroll it with the local voiceprint service.

Examples:
  python record_voiceprint.py                 # record 8s and enroll
  python record_voiceprint.py --check         # enroll, then record 3s and score
  python record_voiceprint.py --verify        # record 3s and score only
  python record_voiceprint.py --device cc     # choose input device by name

The app and this script both open the microphone in shared mode. If Bluetooth
HFP is exclusive on your machine, stop the app's capture first.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

ROOT = Path(__file__).resolve().parents[4]
OUT_DIR = ROOT / "models" / "voiceprint"
DEFAULT_URL = os.environ.get("CYRVIS_VOICEPRINT_URL", "http://127.0.0.1:8100")


def list_inputs() -> list[tuple[int, dict]]:
    result = []
    for index, device in enumerate(sd.query_devices()):
        if device["max_input_channels"] > 0:
            result.append((index, device))
    return result


def pick_device(pattern: str | None) -> int | None:
    devices = list_inputs()
    if pattern:
        for index, device in devices:
            if pattern.lower() in device["name"].lower():
                return index
        raise SystemExit(f"no input device matching {pattern!r}")
    # Prefer the Bluetooth headset used by CYRVIS; never fall back to ToDesk
    # virtual audio because it captures system playback instead of the user.
    for wanted in ("cc ultimate", "airpods", "headset", "耳机", "麦克风"):
        for index, device in devices:
            name = device["name"].lower()
            if wanted.lower() in name and "todesk" not in name:
                return index
    for index, device in devices:
        if "todesk" not in device["name"].lower():
            return index
    raise SystemExit("no physical input device found")


def record(seconds: float, device: int, sample_rate: int) -> np.ndarray:
    print(
        f"1 秒后开始录音 {seconds:.0f}s（设备 {device} @ {sample_rate} Hz），请持续说话...",
        flush=True,
    )
    time.sleep(1)
    audio = sd.rec(
        int(seconds * sample_rate),
        samplerate=sample_rate,
        channels=1,
        dtype="int16",
        device=device,
    )
    sd.wait()
    print("录音结束", flush=True)
    return audio[:, 0]


def resample_to_16k(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    if sample_rate == 16000:
        return samples.astype(np.int16)
    count = int(len(samples) * 16000 / sample_rate)
    positions = np.linspace(0, len(samples) - 1, count)
    values = np.interp(positions, np.arange(len(samples)), samples.astype(np.float32))
    return np.clip(values, -32768, 32767).astype(np.int16)


def post(url: str, pcm: bytes) -> dict:
    request = urllib.request.Request(
        url,
        data=pcm,
        method="POST",
        headers={"Content-Type": "application/octet-stream"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--device", help="input device name substring")
    parser.add_argument("--seconds", type=float, default=8.0)
    parser.add_argument("--verify-seconds", type=float, default=5.0)
    parser.add_argument("--check", action="store_true", help="enroll then verify 3s")
    parser.add_argument("--verify", action="store_true", help="verify only")
    parser.add_argument("--list", action="store_true", help="list input devices")
    args = parser.parse_args()

    if args.list:
        for index, device in list_inputs():
            print(index, device["name"], device["default_samplerate"])
        return

    device = pick_device(args.device)
    info = sd.query_devices(device)
    sample_rate = int(info["default_samplerate"] or 16000)
    if sample_rate not in (16000, 44100, 48000):
        sample_rate = 16000

    if args.verify:
        audio = resample_to_16k(
            record(args.verify_seconds, device, sample_rate), sample_rate
        )
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        sf.write(OUT_DIR / "verify.wav", audio, 16000)
        result = post(args.url + "/verify", audio.tobytes())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    audio = resample_to_16k(record(args.seconds, device, sample_rate), sample_rate)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sf.write(OUT_DIR / "enroll.wav", audio, 16000)
    result = post(args.url + "/enroll", audio.tobytes())
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if args.check:
        audio = resample_to_16k(
            record(args.verify_seconds, device, sample_rate), sample_rate
        )
        sf.write(OUT_DIR / "verify.wav", audio, 16000)
        result = post(args.url + "/verify", audio.tobytes())
        print("verify:", json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
