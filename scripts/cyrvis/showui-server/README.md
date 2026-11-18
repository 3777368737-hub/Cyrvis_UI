# ShowUI-2B sidecar

Local OpenAI-compatible service that lets CYRVIS use ShowUI-2B as its GUI VLM.

## Why

- 2B model, BF16 ~5.1GB (or 4-bit smaller), fits an 8GB RTX 5060.
- ShowUI caps input at ~1MP (`1344*28*28`), much cheaper than the current
  3.7MP screenshot.
- It emits dict actions (`CLICK`/`INPUT`/`ENTER`/`ANSWER`/...), which this
  service translates to UI-TARS `Action:` text.

## Run

```powershell
# one-time
python -m venv D:\Desktop\project\CYRVIS\showui-env
D:\Desktop\project\CYRVIS\showui-env\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
D:\Desktop\project\CYRVIS\showui-env\Scripts\python.exe -m pip install transformers accelerate fastapi uvicorn pillow qwen-vl-utils -i https://pypi.tuna.tsinghua.edu.cn/simple

# every run
.\run-showui.ps1
```

Health check: `curl http://127.0.0.1:8000/health`

## Configure the app

In `%APPDATA%\ui-tars-desktop\ui_tars.setting.json`:

| Field | Value |
|---|---|
| `vlmBaseUrl` | `http://127.0.0.1:8000/v1` |
| `vlmApiKey` | `local` |
| `vlmModelName` | `showui-2b` |
| `vlmProvider` | `VolcEngine Ark for Doubao-1.5-UI-TARS` |
| `useResponsesApi` | `false` |

The app still sends its UI-TARS system prompt; the sidecar extracts the task
instruction after `## User Instruction` and uses ShowUI's own navigation prompt.

## Action mapping

| ShowUI | UI-TARS |
|---|---|
| `CLICK` / `SELECT` / `TAP` | `click(start_box='[x*1000,y*1000,...]')` |
| `INPUT` + position + value | `click(...)` + `type(content='...')` |
| `ENTER` | `hotkey(key='enter')` |
| `SCROLL` | `scroll(start_box='[...]', direction='down/up')` |
| `ANSWER` | `finished(content='...')` |
| `SELECT_TEXT` | `drag(start_box=..., end_box=...)` |
| `COPY` | `hotkey(key='ctrl c')` |

Multiple dict actions are joined with blank lines, so the existing Action
Batching executor runs them in one loop.

## Debug

- Raw model output and translated actions: `D:\temp\cyrvis-bench\showui-requests.jsonl`
- `/reset` clears the per-task step counter; call it before each benchmark run.
- `SHOWUI_4BIT=1` enables NF4 if BF16 OOMs.
- `SHOWUI_MAX_STEPS` (default 20) forces a `finished(...step limit...)` if the
  model never emits `ANSWER`.
