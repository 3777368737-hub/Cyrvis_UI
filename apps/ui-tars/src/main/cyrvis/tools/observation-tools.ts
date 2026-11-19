/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ToolDefinition, ToolResult } from './types';

const MAX_OCR_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_UI_ELEMENTS = 800;
const MAX_UI_DEPTH = 8;

const text = (
  input: Record<string, unknown>,
  key: string,
  options: { required?: boolean; fallback?: string } = {},
): string => {
  const value = input[key];
  if (typeof value === 'string') {
    return value.trim();
  }
  if (options.required) {
    throw new Error(`${key} is required`);
  }
  return options.fallback ?? '';
};

const number = (
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
};

const success = (tool: string, speech: string, data?: unknown): ToolResult => ({
  ok: true,
  tool,
  speech,
  data,
});

const failure = (
  tool: string,
  speech: string,
  code = 'TOOL_FAILED',
): ToolResult => ({
  ok: false,
  tool,
  speech,
  error: { code, message: speech },
});

const runPowerShell = (
  script: string,
  env: NodeJS.ProcessEnv = {},
  timeout = 30_000,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
${script}`,
      ],
      {
        env: { ...process.env, ...env },
        timeout,
        windowsHide: true,
        maxBuffer: 12 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              (stderr || stdout || error.message).trim() || error.message,
            ),
          );
          return;
        }
        resolve(stdout.trim());
      },
    );
  });

interface CaptureRegionInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

const parseRegion = (value: unknown): CaptureRegionInput | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const fields = ['x', 'y', 'width', 'height'] as const;
  if (
    fields.some(
      (field) =>
        typeof candidate[field] !== 'number' ||
        !Number.isFinite(candidate[field]),
    )
  ) {
    throw new Error('region requires finite x, y, width, and height values');
  }
  const region = {
    x: Math.max(0, Math.floor(candidate.x as number)),
    y: Math.max(0, Math.floor(candidate.y as number)),
    width: Math.max(1, Math.floor(candidate.width as number)),
    height: Math.max(1, Math.floor(candidate.height as number)),
  };
  return region;
};

const captureScreen = async (
  region: CaptureRegionInput | null,
): Promise<{ path: string; bytes: number; width: number; height: number }> => {
  const { FileType, Region, screen } = await import('@computer-use/nut-js');
  const directory = path.join(os.tmpdir(), 'cyrvis-screen');
  await fs.mkdir(directory, { recursive: true });
  const basename = `screen-${Date.now()}`;
  const captured = region
    ? await screen.captureRegion(
        basename,
        new Region(region.x, region.y, region.width, region.height),
        FileType.PNG,
        directory,
      )
    : await screen.capture(basename, FileType.PNG, directory);
  const target = path.isAbsolute(captured)
    ? captured
    : path.resolve(directory, captured);
  const stats = await fs.stat(target);
  return {
    path: target,
    bytes: stats.size,
    width: region?.width ?? (await screen.width()),
    height: region?.height ?? (await screen.height()),
  };
};

const OCR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:CYRV_OCR_PATH
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskGeneric = $asTaskMethods | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation')
} | Select-Object -First 1

function Await-WinRtOperation($operation, [Type]$resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  [void]$task.Wait(-1)
  return $task.Result
}

try {
  $file = Await-WinRtOperation (
    [Windows.Storage.StorageFile]::GetFileFromPathAsync($path)
  ) ([Windows.Storage.StorageFile])
  $stream = Await-WinRtOperation (
    $file.OpenAsync([Windows.Storage.FileAccessMode]::Read)
  ) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-WinRtOperation (
    [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
  ) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WinRtOperation (
    $decoder.GetSoftwareBitmapAsync()
  ) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) {
    throw 'Windows OCR has no language pack available for the current user.'
  }
  $result = Await-WinRtOperation (
    $engine.RecognizeAsync($bitmap)
  ) ([Windows.Media.Ocr.OcrResult])
  $lines = @($result.Lines | ForEach-Object { $_.Text })
  [pscustomobject]@{
    text = $result.Text
    language = $engine.RecognizerLanguage.LanguageTag
    lineCount = $lines.Count
    lines = $lines
  } | ConvertTo-Json -Depth 4 -Compress
} catch {
  $messages = @($_.Exception.Message)
  $inner = $_.Exception.InnerException
  while ($null -ne $inner) {
    $messages += $inner.Message
    $inner = $inner.InnerException
  }
  throw ($messages -join ' <- ')
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
  if ($null -ne $bitmap) { $bitmap.Dispose() }
}
`;

const UI_INSPECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$null = Add-Type -AssemblyName UIAutomationClient
$null = Add-Type -AssemblyName UIAutomationTypes
$null = Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CyrvisForegroundWindow {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@

$maxElements = [int]$env:CYRV_UI_MAX_ELEMENTS
$maxDepth = [int]$env:CYRV_UI_MAX_DEPTH
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$handle = [CyrvisForegroundWindow]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) {
  throw 'No foreground window is available.'
}
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($null -eq $root) {
  throw 'Could not inspect the foreground window.'
}

$script:visited = 0
$script:truncated = $false

function Get-ElementValue($element) {
  try {
    $pattern = $element.GetCurrentPattern(
      [System.Windows.Automation.ValuePattern]::Pattern
    )
    return [string]$pattern.Current.Value
  } catch {
    return $null
  }
}

function Get-ElementSelection($element) {
  try {
    $pattern = $element.GetCurrentPattern(
      [System.Windows.Automation.TextPattern]::Pattern
    )
    $selection = @($pattern.GetSelection())
    if ($selection.Count -eq 0) {
      return $null
    }
    return (($selection | ForEach-Object { $_.GetText(-1) }) -join [Environment]::NewLine)
  } catch {
    return $null
  }
}

function Convert-Element($element, [int]$depth) {
  if ($null -eq $element) {
    return $null
  }
  if ($script:visited -ge $maxElements) {
    $script:truncated = $true
    return $null
  }
  $script:visited += 1
  $current = $element.Current
  $bounds = $current.BoundingRectangle
  $item = [ordered]@{
    name = [string]$current.Name
    role = [string]$current.ControlType.ProgrammaticName
    className = [string]$current.ClassName
    automationId = [string]$current.AutomationId
    enabled = [bool]$current.IsEnabled
    offscreen = [bool]$current.IsOffscreen
    focused = [bool]$current.HasKeyboardFocus
    bounds = @{
      x = [int]$bounds.X
      y = [int]$bounds.Y
      width = [int]$bounds.Width
      height = [int]$bounds.Height
    }
  }
  $value = Get-ElementValue $element
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    $item.value = $value
  }
  $selection = Get-ElementSelection $element
  if (-not [string]::IsNullOrWhiteSpace($selection)) {
    $item.selectedText = $selection
  }
  if ($depth -lt $maxDepth) {
    $children = @()
    $child = $walker.GetFirstChild($element)
    while ($null -ne $child -and $script:visited -lt $maxElements) {
      $converted = Convert-Element $child ($depth + 1)
      if ($null -ne $converted) {
        $children += $converted
      }
      $child = $walker.GetNextSibling($child)
    }
    if ($children.Count -gt 0) {
      $item.children = $children
    }
  } elseif ($null -ne $walker.GetFirstChild($element)) {
    $script:truncated = $true
  }
  return [pscustomobject]$item
}

$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
$tree = Convert-Element $root 0
[pscustomobject]@{
  window = @{
    title = [string]$root.Current.Name
    className = [string]$root.Current.ClassName
    processId = [int]$root.Current.ProcessId
  }
  focused = if ($null -eq $focused) { $null } else { @{
    name = [string]$focused.Current.Name
    role = [string]$focused.Current.ControlType.ProgrammaticName
    automationId = [string]$focused.Current.AutomationId
  } }
  elementCount = $script:visited
  truncated = $script:truncated
  tree = $tree
} | ConvertTo-Json -Depth 20 -Compress
`;

const keyName = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  const aliases: Record<string, string> = {
    control: 'LeftControl',
    ctrl: 'LeftControl',
    shift: 'LeftShift',
    alt: 'LeftAlt',
    option: 'LeftAlt',
    win: 'LeftWin',
    windows: 'LeftWin',
    meta: 'LeftWin',
    command: 'LeftCmd',
    cmd: 'LeftCmd',
    enter: 'Enter',
    return: 'Return',
    escape: 'Escape',
    esc: 'Escape',
    space: 'Space',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    insert: 'Insert',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    volumeup: 'AudioVolUp',
    volumedown: 'AudioVolDown',
    mute: 'AudioMute',
    playpause: 'AudioPlay',
    next: 'AudioNext',
    previous: 'AudioPrev',
  };
  return aliases[normalized] || value.trim();
};

export const OBSERVATION_TOOLS: ToolDefinition[] = [
  {
    name: 'screen.capture',
    domain: 'desktop',
    description:
      'Capture the current screen or a screen region to a PNG file for visual inspection and verification.',
    risk: 'medium',
    capability: {
      providerId: 'desktop.screen',
      tier: 2,
      activation: 'on-demand',
      priority: 79,
      tags: ['screen', 'capture', 'screenshot', '屏幕', '截图', '观察'],
      permissions: ['desktop.screen'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        region: {
          type: 'object',
          properties: {
            x: { type: 'number', minimum: 0 },
            y: { type: 'number', minimum: 0 },
            width: { type: 'number', minimum: 1 },
            height: { type: 'number', minimum: 1 },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({ region: parseRegion(input.region) }),
    async execute(args) {
      const captured = await captureScreen(
        args.region as CaptureRegionInput | null,
      );
      return success(
        'screen.capture',
        `已截取当前屏幕，图片大小 ${captured.width}×${captured.height}。`,
        captured,
      );
    },
  },
  {
    name: 'screen.ocr',
    domain: 'desktop',
    description:
      'Recognize text with the native Windows OCR engine. If imagePath is omitted, capture the current screen first.',
    risk: 'medium',
    capability: {
      providerId: 'desktop.screen',
      tier: 2,
      activation: 'on-demand',
      priority: 64,
      tags: ['screen', 'ocr', 'text', '识别', '屏幕', '文字', '读取'],
      permissions: ['desktop.screen'],
      requirements: { platforms: ['win32'] },
    },
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string' },
      },
      additionalProperties: false,
    },
    pathArgs: (args) =>
      typeof args.imagePath === 'string' && args.imagePath
        ? [args.imagePath]
        : [],
    prepare: (input, context) => ({
      imagePath: text(input, 'imagePath')
        ? context.resolvePath(text(input, 'imagePath'))
        : null,
    }),
    async execute(args) {
      if (process.platform !== 'win32') {
        return failure(
          'screen.ocr',
          '原生 OCR 当前只支持 Windows。',
          'UNSUPPORTED_PLATFORM',
        );
      }
      const captured = args.imagePath ? null : await captureScreen(null);
      const imagePath = String(args.imagePath || captured?.path || '');
      const stats = await fs.stat(imagePath);
      if (stats.size > MAX_OCR_IMAGE_BYTES) {
        return failure(
          'screen.ocr',
          '图片超过 20 MB，无法进行 OCR。',
          'IMAGE_TOO_LARGE',
        );
      }
      const raw = await runPowerShell(OCR_SCRIPT, {
        CYRV_OCR_PATH: imagePath,
      });
      const parsed = JSON.parse(raw) as {
        text?: string;
        language?: string;
        lineCount?: number;
        lines?: string[];
      };
      const recognized = (parsed.text || '').trim();
      return success(
        'screen.ocr',
        recognized
          ? `识别到 ${parsed.lineCount || 0} 行文字。`
          : '没有识别到文字。',
        {
          imagePath,
          language: parsed.language || 'auto',
          lineCount: parsed.lineCount || 0,
          lines: parsed.lines || [],
          text: recognized,
        },
      );
    },
  },
  {
    name: 'ui.inspect',
    domain: 'desktop',
    description:
      'Inspect the foreground window accessibility tree, including controls, bounds, values, focus, and selected text. Use this before coordinate-based UI actions.',
    risk: 'medium',
    capability: {
      providerId: 'desktop.ui',
      tier: 2,
      activation: 'on-demand',
      priority: 78,
      tags: [
        'ui',
        'window',
        'accessibility',
        'element',
        '界面',
        '窗口',
        '控件',
        '元素',
      ],
      permissions: ['desktop.screen'],
      requirements: { platforms: ['win32'] },
    },
    inputSchema: {
      type: 'object',
      properties: {
        maxElements: { type: 'number', minimum: 20, maximum: MAX_UI_ELEMENTS },
        maxDepth: { type: 'number', minimum: 1, maximum: MAX_UI_DEPTH },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({
      maxElements: number(input, 'maxElements', 300, 20, MAX_UI_ELEMENTS),
      maxDepth: number(input, 'maxDepth', 5, 1, MAX_UI_DEPTH),
    }),
    async execute(args) {
      if (process.platform !== 'win32') {
        return failure(
          'ui.inspect',
          'UI Automation 当前只支持 Windows。',
          'UNSUPPORTED_PLATFORM',
        );
      }
      const raw = await runPowerShell(UI_INSPECT_SCRIPT, {
        CYRV_UI_MAX_ELEMENTS: String(args.maxElements),
        CYRV_UI_MAX_DEPTH: String(args.maxDepth),
      });
      const parsed = JSON.parse(raw) as {
        window?: { title?: string };
        elementCount?: number;
        truncated?: boolean;
        focused?: { name?: string } | null;
        tree?: unknown;
      };
      return success(
        'ui.inspect',
        `已读取窗口“${parsed.window?.title || '当前窗口'}”的 ${parsed.elementCount || 0} 个控件。`,
        parsed,
      );
    },
  },
  {
    name: 'ui.action',
    domain: 'desktop',
    description:
      'Perform one low-level desktop action at absolute screen coordinates: click, double-click, right-click, move, type, press keys, scroll, or drag.',
    risk: 'medium',
    capability: {
      providerId: 'desktop.ui',
      tier: 3,
      activation: 'on-demand',
      priority: 42,
      tags: [
        'ui',
        'click',
        'type',
        'hotkey',
        'drag',
        'scroll',
        '点击',
        '输入',
        '快捷键',
        '拖拽',
        '滚动',
      ],
      permissions: ['desktop.input'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'click',
            'double_click',
            'right_click',
            'middle_click',
            'move',
            'type',
            'press_keys',
            'scroll',
            'drag',
          ],
        },
        x: { type: 'number', minimum: 0 },
        y: { type: 'number', minimum: 0 },
        endX: { type: 'number', minimum: 0 },
        endY: { type: 'number', minimum: 0 },
        text: { type: 'string' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 8,
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
        },
        amount: { type: 'number', minimum: 1, maximum: 20 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    prepare: (input) => {
      const action = text(input, 'action', { required: true });
      const coordinateActions = new Set([
        'click',
        'double_click',
        'right_click',
        'middle_click',
        'move',
      ]);
      const coordinateRequired =
        coordinateActions.has(action) || action === 'drag';
      const x =
        typeof input.x === 'number' && Number.isFinite(input.x)
          ? Math.floor(input.x)
          : null;
      const y =
        typeof input.y === 'number' && Number.isFinite(input.y)
          ? Math.floor(input.y)
          : null;
      if (coordinateRequired && (x === null || y === null || x < 0 || y < 0)) {
        throw new Error(`${action} requires non-negative x and y coordinates`);
      }
      if (action === 'drag') {
        if (
          typeof input.endX !== 'number' ||
          !Number.isFinite(input.endX) ||
          typeof input.endY !== 'number' ||
          !Number.isFinite(input.endY)
        ) {
          throw new Error('drag requires endX and endY coordinates');
        }
      }
      if (action === 'type' && typeof input.text !== 'string') {
        throw new Error('type requires text');
      }
      if (action === 'press_keys') {
        if (
          !Array.isArray(input.keys) ||
          input.keys.length === 0 ||
          input.keys.some((key) => typeof key !== 'string')
        ) {
          throw new Error('press_keys requires a non-empty string array');
        }
      }
      if (
        action === 'scroll' &&
        !['up', 'down', 'left', 'right'].includes(String(input.direction))
      ) {
        throw new Error('scroll requires direction up, down, left, or right');
      }
      return {
        action,
        x,
        y,
        endX: typeof input.endX === 'number' ? Math.floor(input.endX) : null,
        endY: typeof input.endY === 'number' ? Math.floor(input.endY) : null,
        text: typeof input.text === 'string' ? input.text : '',
        keys: Array.isArray(input.keys)
          ? input.keys.filter((key): key is string => typeof key === 'string')
          : [],
        direction: text(input, 'direction', { fallback: 'down' }),
        amount: number(input, 'amount', 3, 1, 20),
      };
    },
    async execute(args) {
      const {
        Button,
        Key,
        Point,
        clipboard,
        keyboard,
        mouse,
        sleep,
        straightTo,
      } = await import('@computer-use/nut-js');
      const action = String(args.action);
      const x = args.x === null ? null : Number(args.x);
      const y = args.y === null ? null : Number(args.y);
      const moveToTarget = async () => {
        if (x !== null && y !== null) {
          await mouse.setPosition(new Point(x, y));
          await sleep(80);
        }
      };
      const pressKeys = async (values: string[]) => {
        const enumValues = Key as unknown as Record<string, number>;
        const normalizedEnum = new Map(
          Object.entries(enumValues)
            .filter(([, value]) => typeof value === 'number')
            .map(([name, value]) => [name.toLowerCase(), value]),
        );
        const resolved = values.map((value) => {
          const name = keyName(value);
          const enumValue =
            normalizedEnum.get(name.replace(/[\s_-]+/g, '').toLowerCase()) ??
            enumValues[name];
          if (typeof enumValue !== 'number') {
            throw new Error(`Unsupported key: ${value}`);
          }
          return enumValue as (typeof Key)[keyof typeof Key];
        });
        await keyboard.pressKey(...resolved);
        await keyboard.releaseKey(...resolved);
      };

      switch (action) {
        case 'click':
          await moveToTarget();
          await mouse.click(Button.LEFT);
          break;
        case 'double_click':
          await moveToTarget();
          await mouse.doubleClick(Button.LEFT);
          break;
        case 'right_click':
          await moveToTarget();
          await mouse.click(Button.RIGHT);
          break;
        case 'middle_click':
          await moveToTarget();
          await mouse.click(Button.MIDDLE);
          break;
        case 'move':
          await moveToTarget();
          break;
        case 'type': {
          const content = String(args.text);
          const previous = await clipboard.getContent();
          await clipboard.setContent(content);
          const commandKey =
            process.platform === 'darwin' ? Key.LeftCmd : Key.LeftControl;
          await keyboard.pressKey(commandKey, Key.V);
          await keyboard.releaseKey(commandKey, Key.V);
          await sleep(80);
          await clipboard.setContent(previous);
          break;
        }
        case 'press_keys':
          await pressKeys(args.keys as string[]);
          break;
        case 'scroll': {
          await moveToTarget();
          const step = Math.max(1, Number(args.amount)) * 100;
          switch (String(args.direction)) {
            case 'up':
              await mouse.scrollUp(step);
              break;
            case 'left':
              await mouse.scrollLeft(step);
              break;
            case 'right':
              await mouse.scrollRight(step);
              break;
            default:
              await mouse.scrollDown(step);
          }
          break;
        }
        case 'drag':
          await moveToTarget();
          await mouse.drag(
            straightTo(new Point(Number(args.endX), Number(args.endY))),
          );
          break;
        default:
          return failure(
            'ui.action',
            `不支持的 UI 动作：${action}`,
            'UNSUPPORTED_UI_ACTION',
          );
      }
      return success('ui.action', `已执行 UI 动作：${action}。`, {
        action,
        x,
        y,
        endX: args.endX,
        endY: args.endY,
        amount: args.amount,
        direction: args.direction,
      });
    },
  },
];
