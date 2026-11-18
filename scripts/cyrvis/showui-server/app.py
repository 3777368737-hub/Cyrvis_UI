#!/usr/bin/env python
"""
ShowUI-2B OpenAI-compatible sidecar for CYRVIS / UI-TARS.

The Electron app speaks UI-TARS `Action:` text. This service:
  1. accepts the app's OpenAI chat-completions request,
  2. extracts the task instruction and latest screenshot,
  3. runs ShowUI-2B's navigation prompt,
  4. translates ShowUI dict actions into UI-TARS Action lines.

Run:
  D:\\Desktop\\project\\CYRVIS\\showui-env\\Scripts\\python.exe app.py

Environment:
  SHOWUI_MODEL_DIR   default D:\\Desktop\\project\\CYRVIS\\models\\ShowUI-2B
  SHOWUI_4BIT=1      load NF4 (requires bitsandbytes)
  SHOWUI_MAX_STEPS   safety cap per task, default 20
  SHOWUI_PORT        default 8000
"""
import ast
import base64
import io
import json
import os
import re
import threading
import time
from datetime import datetime
from pathlib import Path

import torch
from fastapi import FastAPI
from PIL import Image
from pydantic import BaseModel
from transformers import AutoProcessor, Qwen2VLForConditionalGeneration

MODEL_DIR = os.environ.get(
    "SHOWUI_MODEL_DIR", r"D:\Desktop\project\CYRVIS\models\ShowUI-2B"
)
USE_4BIT = os.environ.get("SHOWUI_4BIT", "0") == "1"
MAX_STEPS = int(os.environ.get("SHOWUI_MAX_STEPS", "20"))
PORT = int(os.environ.get("SHOWUI_PORT", "8000"))
LOG_PATH = Path(r"D:\temp\cyrvis-bench\showui-requests.jsonl")
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

MIN_PIXELS = 256 * 28 * 28
MAX_PIXELS = 1344 * 28 * 28

_NAV_SYSTEM = """You are an assistant trained to navigate the {_APP} screen.
Given a task instruction, a screen observation, and an action history sequence,
output the next action and wait for the next observation.
Here is the action space:
{_ACTION_SPACE}
"""
_NAV_FORMAT = """
Format the action as a dictionary with the following keys:
{'action': 'ACTION_TYPE', 'value': 'element', 'position': [x,y]}

If value or position is not applicable, set it as `None`.
Position might be [[x1,y1], [x2,y2]] if the action requires a start and end position.
Position represents the relative coordinates on the screenshot and should be scaled to a range of 0-1.
"""
_WEB_ACTIONS = """
1. `CLICK`: Click on an element, value is not applicable and the position [x,y] is required.
2. `INPUT`: Type a string into an element, value is a string to type and the position [x,y] is required.
3. `SELECT`: Select a value for an element, value is not applicable and the position [x,y] is required.
4. `HOVER`: Hover on an element, value is not applicable and the position [x,y] is required.
5. `ANSWER`: Answer the question, value is the answer and the position is not applicable.
6. `ENTER`: Enter operation, value and position are not applicable.
7. `SCROLL`: Scroll the screen, value is the direction to scroll and the position is not applicable.
8. `SELECT_TEXT`: Select some text content, value is not applicable and position [[x1,y1], [x2,y2]] is the start and end position of the select operation.
9. `COPY`: Copy the text, value is the text to copy and the position is not applicable.
"""
SYSTEM_PROMPT = (
    _NAV_SYSTEM.format(_APP="desktop", _ACTION_SPACE=_WEB_ACTIONS)
    + _NAV_FORMAT
    + """
When the task is complete, output exactly one ANSWER action with a short report:
{'action': 'ANSWER', 'value': '<short report>', 'position': None}
You may output multiple actions separated by commas only when they are deterministic
and do not require observing an intermediate screen.
"""
)

print(f"[showui] loading {MODEL_DIR} (4bit={USE_4BIT})", flush=True)
kwargs = {
    "torch_dtype": torch.bfloat16,
    "device_map": "auto",
}
if USE_4BIT:
    from transformers import BitsAndBytesConfig

    kwargs["quantization_config"] = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
    )

model = Qwen2VLForConditionalGeneration.from_pretrained(MODEL_DIR, **kwargs)
model.eval()
processor = AutoProcessor.from_pretrained(
    MODEL_DIR, min_pixels=MIN_PIXELS, max_pixels=MAX_PIXELS
)
print(
    f"[showui] loaded; cuda={torch.cuda.is_available()}; "
    f"vram={torch.cuda.memory_allocated() / 1024**3:.2f}GB",
    flush=True,
)

app = FastAPI(title="ShowUI-2B sidecar")
_lock = threading.Lock()
_last_instruction = None
_step_count = 0


class ChatRequest(BaseModel):
    model: str = "showui-2b"
    messages: list
    max_tokens: int | None = None
    temperature: float | None = None
    top_p: float | None = None
    stream: bool = False


def _content_parts(message):
    content = message.get("content")
    if isinstance(content, list):
        return content
    return []


def _extract_instruction(messages):
    for message in messages:
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str) and "## User Instruction" in content:
            return content.split("## User Instruction", 1)[1].strip()
    for message in reversed(messages):
        if message.get("role") == "user" and isinstance(message.get("content"), str):
            return message["content"].strip()
    return ""


def _extract_image(messages):
    for message in reversed(messages):
        for part in _content_parts(message):
            if part.get("type") not in ("image_url", "input_image"):
                continue
            url = part.get("image_url", {}).get("url") or part.get("image_url")
            if not isinstance(url, str):
                continue
            if url.startswith("data:"):
                _, encoded = url.split(",", 1)
                raw = base64.b64decode(encoded)
                return Image.open(io.BytesIO(raw)).convert("RGB")
            # The app always sends data URLs; remote URLs are not fetched here.
            raise ValueError(f"unsupported image URL: {url[:40]}")
    raise ValueError("no image found in messages")


def _extract_history(messages):
    parts = []
    for message in messages:
        if message.get("role") != "assistant":
            continue
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            parts.append(content.strip())
    text = "\n\n".join(parts[-5:])
    return text[-6000:]


def _escape(text):
    if text is None:
        return ""
    return (
        str(text)
        .replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\r", "")
        .replace("\n", "\\n")
    )


def _norm_coord(value, size):
    """ShowUI normally emits 0-1, but sometimes emits a percentage or pixel."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v < 0:
        return 0.0
    if 0 <= v <= 1:
        return v
    if v <= 100:
        # Observed on the Ctrip/L4 screenshots: y=45 meaning 45%.
        return min(1.0, v / 100.0)
    if size:
        return min(1.0, v / float(size))
    return 1.0


def _box(position, image_size=None):
    if not position or not isinstance(position, (list, tuple)) or len(position) < 2:
        return None
    width, height = image_size or (None, None)
    x = _norm_coord(position[0], width)
    y = _norm_coord(position[1], height)
    if x is None or y is None:
        return None
    xi, yi = round(x * 1000), round(y * 1000)
    return f"[{xi}, {yi}, {xi}, {yi}]"


def _actions_to_ui_tars(actions, image_size=None):
    lines = []
    for action in actions:
        if not isinstance(action, dict):
            continue
        kind = str(action.get("action") or "").upper()
        value = action.get("value")
        position = action.get("position")

        if kind in ("CLICK", "SELECT", "TAP"):
            box = _box(position, image_size)
            if box:
                lines.append(f"click(start_box='{box}')")
        elif kind == "INPUT":
            box = _box(position, image_size)
            if box:
                lines.append(f"click(start_box='{box}')")
            if value is not None:
                lines.append(f"type(content='{_escape(value)}')")
        elif kind == "ENTER":
            lines.append("hotkey(key='enter')")
        elif kind == "SCROLL":
            direction = value if value in ("down", "up", "left", "right") else "down"
            lines.append(
                f"scroll(start_box='[950, 500, 950, 500]', direction='{direction}')"
            )
        elif kind == "COPY":
            lines.append("hotkey(key='ctrl c')")
        elif kind == "SELECT_TEXT":
            if isinstance(position, (list, tuple)) and len(position) == 2:
                start, end = position
                sb, eb = _box(start, image_size), _box(end, image_size)
                if sb and eb:
                    lines.append(f"drag(start_box='{sb}', end_box='{eb}')")
        elif kind == "ANSWER":
            lines.append(f"finished(content='{_escape(value or 'task complete')}')")
        elif kind == "HOVER":
            box = _box(position, image_size)
            if box:
                lines.append(f"click(start_box='{box}')")
        else:
            print(f"[showui] unknown action: {action}", flush=True)

    if not lines:
        return "wait()"
    return "\n\n".join(lines)


def _parse_actions(raw):
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    candidates = []
    try:
        parsed = ast.literal_eval("[" + text + "]")
        if isinstance(parsed, list):
            candidates = parsed
    except Exception:
        pass
    if not candidates:
        for match in re.finditer(r"\{[^{}]*\}", text):
            try:
                item = ast.literal_eval(match.group(0))
                if isinstance(item, dict):
                    candidates.append(item)
            except Exception:
                continue
    return [item for item in candidates if isinstance(item, dict)]


def _log(entry):
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_DIR,
        "cuda": torch.cuda.is_available(),
        "vram_gb": round(torch.cuda.memory_allocated() / 1024**3, 2)
        if torch.cuda.is_available()
        else 0,
    }


@app.post("/reset")
def reset():
    global _last_instruction, _step_count
    _last_instruction = None
    _step_count = 0
    return {"ok": True}


@app.get("/v1/models")
def models():
    return {
        "object": "list",
        "data": [{"id": "showui-2b", "object": "model", "owned_by": "local"}],
    }


@app.post("/v1/chat/completions")
def chat(request: ChatRequest):
    global _last_instruction, _step_count

    instruction = _extract_instruction(request.messages)
    image = _extract_image(request.messages)
    history = _extract_history(request.messages)

    if instruction != _last_instruction:
        _last_instruction = instruction
        _step_count = 0
    _step_count += 1

    content = [
        {"type": "text", "text": SYSTEM_PROMPT},
        {"type": "text", "text": f"Task: {instruction}"},
    ]
    if history:
        content.append({"type": "text", "text": f"Action history:\n{history}"})
    content.append(
        {
            "type": "image",
            "image": image,
            "min_pixels": MIN_PIXELS,
            "max_pixels": MAX_PIXELS,
        }
    )
    messages = [{"role": "user", "content": content}]

    text = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    inputs = processor(
        text=[text],
        images=[image],
        videos=None,
        padding=True,
        return_tensors="pt",
    ).to(model.device)

    started = time.time()
    with _lock, torch.inference_mode():
        generated = model.generate(
            **inputs,
            max_new_tokens=min(int(request.max_tokens or 256), 512),
            do_sample=False,
        )
    trimmed = [
        out_ids[len(in_ids) :]
        for in_ids, out_ids in zip(inputs.input_ids, generated)
    ]
    raw = processor.batch_decode(
        trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False
    )[0].strip()
    actions = _parse_actions(raw)
    action_text = _actions_to_ui_tars(actions, (image.width, image.height))

    if _step_count > MAX_STEPS:
        action_text = f"finished(content='ShowUI step limit {MAX_STEPS}')"

    elapsed_ms = int((time.time() - started) * 1000)
    entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "instruction": instruction,
        "image": [image.width, image.height],
        "raw": raw,
        "actions": actions,
        "translated": action_text,
        "elapsedMs": elapsed_ms,
        "step": _step_count,
    }
    _log(entry)
    print(
        f"[showui] step={_step_count} {elapsed_ms}ms "
        f"raw={raw[:400]!r} -> {action_text[:400]!r}",
        flush=True,
    )

    return {
        "id": f"chatcmpl-showui-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": request.model or "showui-2b",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": action_text},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


if __name__ == "__main__":
    import uvicorn

    # The app polls slower than uvicorn's 5s keep-alive default; that caused
    # intermittent "Connection error" on a reused HTTP connection.
    uvicorn.run(app, host="127.0.0.1", port=PORT, timeout_keep_alive=120)
