"""
Record a real double-talk sample: AI TTS on Realtek speakers + user speaking
into the Bluetooth headset mic at the same time.

Run:
  python record_doubletalk.py

It records 12s. After 1s the TTS starts. Speak over it, for example:
  "停一下，别说了，帮我打开记事本"
"""

from __future__ import annotations

import argparse
import os
import subprocess
import time
import winsound
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

ROOT = Path(__file__).resolve().parents[4]
DEFAULT_FAR = Path("D:/temp/tts-probe.wav")
OUT_DIR = ROOT / "models" / "voiceprint"
SR = 16000


def load16(path: Path) -> np.ndarray:
    audio, rate = sf.read(str(path), dtype="float32")
    if audio.ndim > 1:
        audio = audio[:, 0]
    if rate != SR:
        count = int(len(audio) * SR / rate)
        audio = np.interp(
            np.linspace(0, len(audio) - 1, count),
            np.arange(len(audio)),
            audio,
        ).astype(np.float32)
    return audio


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
            if wanted.lower() in device["name"].lower() and "todesk" not in device["name"].lower():
                return index
    for index, device in devices:
        if "todesk" not in device["name"].lower():
            return index
    raise SystemExit("no physical input device")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--far", default=str(DEFAULT_FAR))
    parser.add_argument("--device", help="input device name substring")
    parser.add_argument("--seconds", type=float, default=14.0)
    parser.add_argument("--lead-in", type=float, default=1.2)
    parser.add_argument("--no-switch-output", action="store_true")
    args = parser.parse_args()

    far_path = Path(args.far)
    if not far_path.exists():
        raise SystemExit(f"far WAV not found: {far_path}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = OUT_DIR / ".recording.lock"
    if lock_path.exists():
        age = time.time() - lock_path.stat().st_mtime
        if age < 120:
            raise SystemExit(
                f"another recording is running or hung ({age:.0f}s old): {lock_path}"
            )
        lock_path.unlink(missing_ok=True)
    fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)

    try:
        # Make sure the external speaker is the default playback device.
        script = ROOT / "scripts" / "cyrvis" / "audio" / "set-default-output.ps1"
        if script.exists() and not args.no_switch_output:
            try:
                subprocess.run(
                    [
                        "powershell",
                        "-NoProfile",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        str(script),
                        "-Kind",
                        "speaker",
                    ],
                    check=False,
                    timeout=20,
                )
            except subprocess.TimeoutExpired:
                print("warning: output switch timed out; continuing", flush=True)

        device = pick_device(args.device)
        info = sd.query_devices(device)
        # Use the device's native rate; resampling in PortAudio can delay frames.
        rate = int(info["default_samplerate"] or 16000)
        print(
            f"mic: [{device}] {info['name']} @ {rate} Hz",
            flush=True,
        )

        frames: list[np.ndarray] = []
        blocked = [0]

        def callback(indata, frame_count, time_info, status) -> None:
            if status:
                print(f"stream status: {status}", flush=True)
            frames.append(indata[:, 0].copy())
            blocked[0] += frame_count

        print(
            f"录音 {args.seconds:.0f}s。{args.lead_in:.1f}s 后播放 AI 声音。",
            flush=True,
        )
        print("请同时说：停一下，别说了，帮我打开记事本。", flush=True)

        stream = sd.InputStream(
            device=device,
            channels=1,
            samplerate=rate,
            dtype="int16",
            blocksize=max(160, int(rate * 0.05)),
            callback=callback,
        )
        started = time.monotonic()
        far_started_at: float | None = None
        stream.start()
        try:
            last_report = 0.0
            while True:
                elapsed = time.monotonic() - started
                if far_started_at is None and elapsed >= args.lead_in:
                    winsound.PlaySound(
                        str(far_path),
                        winsound.SND_FILENAME | winsound.SND_ASYNC,
                    )
                    far_started_at = time.monotonic()
                    print("AI 声音开始播放", flush=True)
                if elapsed - last_report >= 2.0:
                    last_report = elapsed
                    print(
                        f"  {elapsed:.1f}s, captured {blocked[0] / rate:.1f}s",
                        flush=True,
                    )
                if elapsed >= args.seconds:
                    break
                time.sleep(0.02)
        finally:
            stream.stop()
            stream.close()

        captured = blocked[0] / rate
        print(
            f"录音结束: wall {time.monotonic() - started:.1f}s, "
            f"audio {captured:.1f}s",
            flush=True,
        )
        if captured < 1.0 or not frames:
            raise SystemExit("no microphone audio captured")

        mic = np.concatenate(frames).astype(np.float32) / 32768.0
        if rate != SR:
            count = int(len(mic) * SR / rate)
            mic = np.interp(
                np.linspace(0, len(mic) - 1, count),
                np.arange(len(mic)),
                mic,
            ).astype(np.float32)

        # Save the far reference at the nominal playback offset. The analysis
        # script refines the true delay by cross-correlation.
        far = load16(far_path)
        far_aligned = np.zeros(len(mic), dtype=np.float32)
        nominal = args.lead_in
        if far_started_at is not None:
            nominal = far_started_at - started
        start = int(nominal * SR)
        far_aligned[start : start + len(far)] = far[: max(0, len(far_aligned) - start)]

        sf.write(OUT_DIR / "doubletalk.wav", mic, SR, subtype="PCM_16")
        sf.write(OUT_DIR / "doubletalk-far.wav", far_aligned, SR, subtype="PCM_16")
        print("saved:", OUT_DIR / "doubletalk.wav")
        print("saved:", OUT_DIR / "doubletalk-far.wav")
    finally:
        lock_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
