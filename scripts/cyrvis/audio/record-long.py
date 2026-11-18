"""
Long microphone stability test for CYRVIS.

Records 10 minutes from the Bluetooth headset with sounddevice, logs gaps and
levels every 5 seconds, and writes a WAV. Run it once with the CYRVIS app
closed, once with CYRVIS capturing, and compare the gap counts.

Examples:
  python scripts/cyrvis/audio/record-long.py --seconds 600
  python scripts/cyrvis/audio/record-long.py --device "cc ultimate" --seconds 120
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT = ROOT / "doc" / "kws-lab" / "long-capture.wav"


def pick_device(pattern: str | None) -> int:
    devices = [
        (index, device)
        for index, device in enumerate(sd.query_devices())
        if device["max_input_channels"] > 0
    ]
    if pattern:
        for index, device in devices:
            if pattern.lower() in device["name"].lower():
                return index
        raise SystemExit(f"no input device matching {pattern!r}")
    for wanted in ("cc ultimate", "airpods", "headset", "耳机", "麦克风"):
        for index, device in devices:
            if wanted.lower() in device["name"].lower():
                return index
    raise SystemExit("no physical input device found")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", help="input device name substring")
    parser.add_argument("--seconds", type=float, default=600.0)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    device = pick_device(args.device)
    info = sd.query_devices(device)
    rate = int(info["default_samplerate"] or 16000)
    print(
        f"device=[{device}] {info['name']} rate={rate} "
        f"duration={args.seconds:.0f}s",
        flush=True,
    )

    chunks: list[np.ndarray] = []
    captured_frames = 0
    last_callback = time.monotonic()
    max_gap = 0.0
    gaps = 0
    started = time.monotonic()

    def callback(indata, frames, _time_info, status) -> None:
        nonlocal captured_frames, last_callback, max_gap, gaps
        now = time.monotonic()
        gap = now - last_callback
        last_callback = now
        if gap > 1.0:
            gaps += 1
            max_gap = max(max_gap, gap)
            print(f"  GAP {gap:.2f}s", flush=True)
        if status:
            print(f"  status: {status}", flush=True)
        chunks.append(indata[:, 0].copy())
        captured_frames += frames

    stream = sd.InputStream(
        device=device,
        channels=1,
        samplerate=rate,
        dtype="int16",
        blocksize=max(160, int(rate * 0.05)),
        callback=callback,
    )
    print("recording... Ctrl+C to stop", flush=True)
    stream.start()
    last_report = 0.0
    try:
        while True:
            elapsed = time.monotonic() - started
            if elapsed - last_report >= 5.0:
                last_report = elapsed
                captured = captured_frames / rate
                if chunks:
                    recent = np.concatenate(chunks[-20:]) if len(chunks) >= 20 else np.concatenate(chunks)
                    rms = float(np.sqrt(np.mean(recent.astype(np.float32) ** 2)))
                else:
                    rms = 0.0
                lag = elapsed - captured
                print(
                    f"  t={elapsed:6.1f}s captured={captured:6.1f}s "
                    f"lag={lag:5.1f}s rms={rms:8.1f} gaps={gaps} max_gap={max_gap:.2f}s",
                    flush=True,
                )
            if elapsed >= args.seconds:
                break
            time.sleep(0.1)
    except KeyboardInterrupt:
        print("stopped by user", flush=True)
    finally:
        stream.stop()
        stream.close()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    captured_seconds = 0.0
    if chunks:
        audio = np.concatenate(chunks)
        captured_seconds = len(audio) / rate
        sf.write(out, audio, rate, subtype="PCM_16")
        print(
            f"saved {out} duration={captured_seconds:.1f}s "
            f"gaps={gaps} max_gap={max_gap:.2f}s",
            flush=True,
        )
    else:
        print("no audio captured", flush=True)

    wall_seconds = time.monotonic() - started
    summary = {
        "device": info["name"],
        "device_index": device,
        "sample_rate": rate,
        "requested_seconds": args.seconds,
        "captured_seconds": round(captured_seconds, 2),
        "wall_seconds": round(wall_seconds, 2),
        "lag_final_seconds": round(wall_seconds - captured_seconds, 2),
        "gaps": gaps,
        "max_gap_seconds": round(max_gap, 3),
        "out": str(out),
    }
    summary_path = out.with_suffix(".json")
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("summary:", json.dumps(summary, ensure_ascii=False), flush=True)
    print("summary saved:", summary_path, flush=True)


if __name__ == "__main__":
    main()
