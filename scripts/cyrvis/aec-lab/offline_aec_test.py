"""
Offline near/far AEC validation for CYRVIS.

Inputs are mono WAV files. `near` is what the microphone records; `far` is the
TTS reference that the speaker is playing. The script builds echo-only,
user-only, and double-talk cases, runs WebRTC AEC3 (pywebrtc-audio), saves the
processed WAVs, and reports echo suppression plus speaker-embedding scores.

Examples:
  python offline_aec_test.py \
    --near models/voiceprint/verify.wav \
    --user models/voiceprint/verify.wav \
    --far D:/temp/tts-probe.wav \
    --delay-ms 120
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pywebrtc_audio
import sherpa_onnx
import soundfile as sf

ROOT = Path(__file__).resolve().parents[4]
MODEL = ROOT / "models" / "voiceprint" / "3dspeaker_eres2net_base.onnx"
EMBEDDING = ROOT / "models" / "voiceprint" / "user_embedding.npy"
SR = 16000
FRAME = 160


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


def save16(path: Path, audio: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.clip(audio, -1, 1), SR, subtype="PCM_16")


def embed(audio: np.ndarray, extractor: sherpa_onnx.SpeakerEmbeddingExtractor) -> np.ndarray:
    stream = extractor.create_stream()
    stream.accept_waveform(SR, audio.astype(np.float32))
    stream.input_finished()
    value = np.asarray(extractor.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(value))
    return value / norm if norm > 1e-6 else value


def aec_process(
    near: np.ndarray,
    far: np.ndarray,
    delay_ms: int,
    noise_suppression: bool = True,
) -> np.ndarray:
    processor = pywebrtc_audio.AudioProcessor(
        sample_rate=SR,
        num_channels=1,
        echo_cancellation=True,
        noise_suppression=noise_suppression,
        high_pass_filter=True,
        auto_gain_control=False,
        stream_delay_ms=delay_ms,
    )
    out = np.zeros(len(near), dtype=np.int16)
    for offset in range(0, len(near), FRAME):
        end = min(offset + FRAME, len(near))
        near_frame = np.zeros(FRAME, dtype=np.int16)
        far_frame = np.zeros(FRAME, dtype=np.int16)
        near_frame[: end - offset] = np.clip(
            near[offset:end] * 32767, -32768, 32767
        ).astype(np.int16)
        far_frame[: end - offset] = np.clip(
            far[offset:end] * 32767, -32768, 32767
        ).astype(np.int16)
        processed = processor.process(near_frame, far_frame)
        out[offset:end] = processed[: end - offset]
    return out.astype(np.float32) / 32768.0


def energy_db(audio: np.ndarray) -> float:
    energy = float(np.mean(audio.astype(np.float64) ** 2))
    return 10 * np.log10(max(energy, 1e-12))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--near", required=True, help="microphone WAV (for reference)")
    parser.add_argument("--user", required=True, help="clean user voice WAV")
    parser.add_argument("--far", required=True, help="TTS reference WAV")
    parser.add_argument("--out", default=str(ROOT / "doc" / "aec-lab"))
    parser.add_argument("--delay-ms", type=int, default=120)
    parser.add_argument("--echo-gains", default="0.8,1.5,2.5")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    user = load16(Path(args.user))
    far = load16(Path(args.far))
    far = np.resize(far, len(user))
    delay = int(SR * args.delay_ms / 1000)
    echo = np.concatenate([np.zeros(delay, dtype=np.float32), far])[: len(user)]
    # `near` is accepted for real recordings; synthetic cases below use the
    # supplied user/far pair so each echo gain is comparable.
    _ = load16(Path(args.near))

    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(MODEL), num_threads=2, provider="cpu"
        )
    )
    user_emb = embed(user, extractor)
    if EMBEDDING.exists():
        saved = np.load(EMBEDDING).astype(np.float32)
        saved /= max(float(np.linalg.norm(saved)), 1e-9)
    else:
        saved = user_emb

    results = []
    for gain in [float(item) for item in args.echo_gains.split(",") if item]:
        mixed = np.clip(echo * gain + user, -1, 1)
        cleaned = aec_process(mixed, far, args.delay_ms)
        tag = f"echo{gain:g}"
        save16(out_dir / f"{tag}-mixed.wav", mixed)
        save16(out_dir / f"{tag}-aec.wav", cleaned)
        mixed_score = float(np.dot(saved, embed(mixed, extractor)))
        aec_score = float(np.dot(saved, embed(cleaned, extractor)))
        results.append(
            {
                "echo_gain": gain,
                "mixed_energy_db": round(energy_db(mixed), 2),
                "aec_energy_db": round(energy_db(cleaned), 2),
                "energy_reduction_db": round(
                    energy_db(mixed) - energy_db(cleaned), 2
                ),
                "mixed_voiceprint": round(mixed_score, 4),
                "aec_voiceprint": round(aec_score, 4),
            }
        )

    # Echo-only: measure ERLE without the user speaking.
    echo_only = np.clip(echo * 1.5, -1, 1)
    echo_clean = aec_process(echo_only, far, args.delay_ms)
    save16(out_dir / "echo-only-aec.wav", echo_clean)
    echo_result = {
        "echo_only_energy_db": round(energy_db(echo_only), 2),
        "echo_only_aec_db": round(energy_db(echo_clean), 2),
        "erle_db": round(energy_db(echo_only) - energy_db(echo_clean), 2),
    }

    print(json.dumps({"echo_only": echo_result, "double_talk": results}, indent=2))
    print("saved to", out_dir)


if __name__ == "__main__":
    main()
