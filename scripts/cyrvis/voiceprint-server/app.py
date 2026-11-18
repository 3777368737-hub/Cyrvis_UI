"""
Local speaker-verification sidecar for CYRVIS.

The service keeps a single enrolled speaker embedding on disk. It accepts raw
16 kHz mono PCM16 bodies, so the Electron main process can post the same PCM it
already receives from the hidden capture window.

Run:
  python app.py
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import sherpa_onnx
import uvicorn
from fastapi import FastAPI, HTTPException, Request

ROOT = Path(__file__).resolve().parents[4]
MODEL_PATH = Path(
    os.environ.get(
        "CYRVIS_VOICEPRINT_MODEL",
        ROOT / "models" / "voiceprint" / "3dspeaker_eres2net_base.onnx",
    )
)
EMBEDDING_PATH = Path(
    os.environ.get(
        "CYRVIS_VOICEPRINT_EMBEDDING",
        ROOT / "models" / "voiceprint" / "user_embedding.npy",
    )
)
THRESHOLD = float(os.environ.get("CYRVIS_VOICEPRINT_THRESHOLD", "0.55"))
SAMPLE_RATE = 16000
MIN_SECONDS = float(os.environ.get("CYRVIS_VOICEPRINT_MIN_SECONDS", "1.0"))

print(f"[voiceprint] model={MODEL_PATH}", flush=True)
if not MODEL_PATH.exists():
    raise SystemExit(f"model not found: {MODEL_PATH}")

config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
    model=str(MODEL_PATH),
    num_threads=int(os.environ.get("CYRVIS_VOICEPRINT_THREADS", "2")),
    provider="cpu",
)
extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
app = FastAPI(title="CYRVIS voiceprint")


def _embedding(pcm: bytes) -> np.ndarray:
    if len(pcm) < SAMPLE_RATE * 2 * MIN_SECONDS:
        raise HTTPException(
            status_code=400,
            detail=f"audio too short: need >= {MIN_SECONDS:.1f}s of 16k PCM16",
        )
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    # Trim leading/trailing silence. A 3s clip that starts with 1s of silence
    # otherwise produces an embedding dominated by the noise floor.
    active = np.where(np.abs(samples) > 0.008)[0]
    if len(active):
        pad = int(SAMPLE_RATE * 0.15)
        start = max(0, int(active[0]) - pad)
        end = min(len(samples), int(active[-1]) + pad)
        samples = samples[start:end]
    if len(samples) < SAMPLE_RATE * MIN_SECONDS:
        raise HTTPException(
            status_code=400,
            detail=f"too little active speech (need >= {MIN_SECONDS:.1f}s)",
        )
    stream = extractor.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    stream.input_finished()
    embedding = np.asarray(extractor.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(embedding))
    if not np.isfinite(norm) or norm <= 1e-6:
        raise HTTPException(status_code=500, detail="invalid embedding")
    return embedding / norm


def _embedding_f32_path() -> Path:
    return EMBEDDING_PATH.with_suffix(".f32")


def _load_embedding() -> np.ndarray | None:
    if not EMBEDDING_PATH.exists():
        return None
    value = np.load(EMBEDDING_PATH).astype(np.float32)
    norm = float(np.linalg.norm(value))
    return value / norm if norm > 1e-6 else None


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_PATH.name,
        "enrolled": EMBEDDING_PATH.exists(),
        "threshold": THRESHOLD,
        "embedding": str(EMBEDDING_PATH),
    }


@app.post("/enroll")
async def enroll(request: Request):
    pcm = await request.body()
    embedding = _embedding(pcm)
    EMBEDDING_PATH.parent.mkdir(parents=True, exist_ok=True)
    np.save(EMBEDDING_PATH, embedding)
    # Node/Electron reads a raw float32 file; the .npy stays for Python tools.
    embedding.astype(np.float32).tofile(_embedding_f32_path())
    return {
        "ok": True,
        "seconds": round(len(pcm) / 2 / SAMPLE_RATE, 2),
        "embedding": str(EMBEDDING_PATH),
        "embedding_f32": str(_embedding_f32_path()),
    }


@app.post("/verify")
async def verify(request: Request):
    enrolled = _load_embedding()
    if enrolled is None:
        raise HTTPException(status_code=409, detail="no enrolled voiceprint")
    pcm = await request.body()
    candidate = _embedding(pcm)
    score = float(np.dot(enrolled, candidate))
    return {
        "score": round(score, 4),
        "match": bool(score >= THRESHOLD),
        "threshold": THRESHOLD,
    }


@app.delete("/enroll")
def reset():
    if EMBEDDING_PATH.exists():
        EMBEDDING_PATH.unlink()
    if _embedding_f32_path().exists():
        _embedding_f32_path().unlink()
    return {"ok": True, "enrolled": False}


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.environ.get("CYRVIS_VOICEPRINT_HOST", "127.0.0.1"),
        port=int(os.environ.get("CYRVIS_VOICEPRINT_PORT", "8100")),
        log_level="info",
    )
