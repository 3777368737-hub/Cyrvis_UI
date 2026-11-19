import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ToolDefinition, ToolResult } from './types';

const execFileAsync = promisify(execFile);
const MAX_DOCUMENT_CHARS = 200_000;

const text = (
  input: Record<string, unknown>,
  key: string,
  fallback = '',
): string => (typeof input[key] === 'string' ? input[key] : fallback);

const boundedText = (value: unknown): string =>
  String(value || '').slice(0, MAX_DOCUMENT_CHARS);

const success = (tool: string, speech: string, data?: unknown): ToolResult => ({
  ok: true,
  tool,
  speech,
  data,
});

const failure = (
  tool: string,
  speech: string,
  code: string,
  message: string,
): ToolResult => ({
  ok: false,
  tool,
  speech,
  error: { code, message },
});

const runPowerShell = async (
  script: string,
  env: Record<string, string>,
): Promise<string> => {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ],
    {
      env: { ...process.env, ...env },
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return stdout.trim();
};

const OFFICE_TEXT_SCRIPT = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($env:CYRV_DOC_PATH)
try {
  $extension = [System.IO.Path]::GetExtension($env:CYRV_DOC_PATH).ToLowerInvariant()
  $entries = @()
  if ($extension -eq '.docx') {
    $entries = @($archive.Entries | Where-Object { $_.FullName -eq 'word/document.xml' })
  } elseif ($extension -eq '.pptx') {
    $entries = @($archive.Entries | Where-Object { $_.FullName -match '^ppt/slides/slide[0-9]+\\.xml$' } | Sort-Object FullName)
  } elseif ($extension -eq '.xlsx') {
    $entries = @($archive.Entries | Where-Object {
      $_.FullName -eq 'xl/sharedStrings.xml' -or $_.FullName -match '^xl/worksheets/sheet[0-9]+\\.xml$'
    } | Sort-Object FullName)
  }
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($entry in $entries) {
    $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
    try { $xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $matches = [regex]::Matches($xml, '<(?:[A-Za-z0-9]+:)?(?:t|v)(?:\\s[^>]*)?>(.*?)</(?:[A-Za-z0-9]+:)?(?:t|v)>', 'Singleline')
    foreach ($match in $matches) {
      $value = [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
      if ($value) { $parts.Add($value) }
    }
  }
  [pscustomobject]@{
    text = ($parts -join [Environment]::NewLine)
    entries = $entries.Count
  } | ConvertTo-Json -Compress
} finally {
  $archive.Dispose()
}
`;

const extractOfficeText = async (
  target: string,
): Promise<{ text: string; entries: number }> => {
  const output = await runPowerShell(OFFICE_TEXT_SCRIPT, {
    CYRV_DOC_PATH: target,
  });
  const parsed = JSON.parse(output) as { text?: string; entries?: number };
  return {
    text: boundedText(parsed.text),
    entries: Number(parsed.entries || 0),
  };
};

export const DOCUMENT_TOOLS: ToolDefinition[] = [
  {
    name: 'document.extract_text',
    domain: 'filesystem',
    description:
      'Extract text from text files and Open XML DOCX, PPTX, or XLSX documents.',
    risk: 'low',
    capability: {
      providerId: 'filesystem',
      tier: 2,
      activation: 'on-demand',
      priority: 66,
      permissions: ['filesystem.read'],
      tags: [
        'document',
        'docx',
        'xlsx',
        'pptx',
        'text',
        '文档',
        '读取',
        '表格',
      ],
    },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      path: context.resolvePath(text(input, 'path')),
    }),
    async execute(args) {
      const target = String(args.path);
      const extension = path.extname(target).toLowerCase();
      try {
        if (
          ['.docx', '.xlsx', '.pptx'].includes(extension) &&
          process.platform !== 'win32'
        ) {
          return failure(
            'document.extract_text',
            'Open XML 文档提取当前只支持 Windows。',
            'UNSUPPORTED_PLATFORM',
            'Open XML extraction is implemented on Windows.',
          );
        }
        if (['.docx', '.xlsx', '.pptx'].includes(extension)) {
          const extracted = await extractOfficeText(target);
          return success(
            'document.extract_text',
            `已提取 ${extracted.entries} 个文档部分。`,
            {
              path: target,
              format: extension.slice(1),
              ...extracted,
            },
          );
        }
        const content = await fs.readFile(target, 'utf8');
        return success('document.extract_text', '文档文本已读取。', {
          path: target,
          format: extension.slice(1) || 'text',
          text: boundedText(content),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          'document.extract_text',
          `读取文档失败：${message}`,
          'DOCUMENT_EXTRACT_FAILED',
          message,
        );
      }
    },
  },
  {
    name: 'pdf.extract_text',
    domain: 'filesystem',
    description:
      'Extract text from a PDF using the locally installed pdftotext executable.',
    risk: 'low',
    capability: {
      providerId: 'filesystem',
      tier: 2,
      activation: 'on-demand',
      priority: 65,
      permissions: ['filesystem.read'],
      requirements: { executables: ['pdftotext'] },
      tags: ['pdf', 'document', 'text', '文档', '读取'],
    },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      path: context.resolvePath(text(input, 'path')),
    }),
    async execute(args) {
      const target = String(args.path);
      try {
        const { stdout } = await execFileAsync('pdftotext', [target, '-'], {
          timeout: 30_000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        });
        return success('pdf.extract_text', 'PDF 文本已提取。', {
          path: target,
          format: 'pdf',
          text: boundedText(stdout),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          'pdf.extract_text',
          `PDF 文本提取失败：${message}`,
          'PDF_EXTRACT_FAILED',
          message,
        );
      }
    },
  },
  {
    name: 'archive.create',
    domain: 'filesystem',
    description: 'Create a ZIP archive from a file or directory.',
    risk: 'medium',
    capability: {
      providerId: 'filesystem',
      tier: 3,
      activation: 'on-demand',
      priority: 45,
      permissions: ['filesystem.read', 'filesystem.write'],
      tags: ['archive', 'zip', 'compress', '压缩', '归档'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' },
      },
      required: ['source', 'destination'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.source), String(args.destination)],
    prepare: (input, context) => ({
      source: context.resolvePath(text(input, 'source')),
      destination: context.resolvePath(text(input, 'destination')),
    }),
    requiresConfirmation: async (args) => {
      try {
        await fs.access(String(args.destination));
        return '目标压缩包已存在，需要覆盖确认。';
      } catch {
        return null;
      }
    },
    async execute(args) {
      if (process.platform !== 'win32') {
        return failure(
          'archive.create',
          '压缩工具当前只支持 Windows。',
          'UNSUPPORTED_PLATFORM',
          'archive.create is implemented on Windows.',
        );
      }
      try {
        await runPowerShell(
          'Compress-Archive -LiteralPath $env:CYRV_ARCHIVE_SOURCE -DestinationPath $env:CYRV_ARCHIVE_DEST -Force',
          {
            CYRV_ARCHIVE_SOURCE: String(args.source),
            CYRV_ARCHIVE_DEST: String(args.destination),
          },
        );
        return success('archive.create', '压缩包已创建。', {
          source: args.source,
          destination: args.destination,
          verification: {
            kind: 'path_exists',
            target: args.destination,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          'archive.create',
          `创建压缩包失败：${message}`,
          'ARCHIVE_CREATE_FAILED',
          message,
        );
      }
    },
  },
  {
    name: 'archive.extract',
    domain: 'filesystem',
    description: 'Extract a ZIP archive into a destination directory.',
    risk: 'medium',
    capability: {
      providerId: 'filesystem',
      tier: 3,
      activation: 'on-demand',
      priority: 44,
      permissions: ['filesystem.read', 'filesystem.write'],
      tags: ['archive', 'zip', 'extract', '解压', '归档'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        archive: { type: 'string' },
        destination: { type: 'string' },
      },
      required: ['archive', 'destination'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.archive), String(args.destination)],
    prepare: (input, context) => ({
      archive: context.resolvePath(text(input, 'archive')),
      destination: context.resolvePath(text(input, 'destination')),
    }),
    requiresConfirmation: async (args) => {
      try {
        const entries = await fs.readdir(String(args.destination));
        return entries.length ? '目标目录非空，需要覆盖确认。' : null;
      } catch {
        return null;
      }
    },
    async execute(args) {
      if (process.platform !== 'win32') {
        return failure(
          'archive.extract',
          '解压工具当前只支持 Windows。',
          'UNSUPPORTED_PLATFORM',
          'archive.extract is implemented on Windows.',
        );
      }
      try {
        await runPowerShell(
          'Expand-Archive -LiteralPath $env:CYRV_ARCHIVE_SOURCE -DestinationPath $env:CYRV_ARCHIVE_DEST -Force',
          {
            CYRV_ARCHIVE_SOURCE: String(args.archive),
            CYRV_ARCHIVE_DEST: String(args.destination),
          },
        );
        return success('archive.extract', '压缩包已解压。', {
          archive: args.archive,
          destination: args.destination,
          verification: {
            kind: 'path_exists',
            target: args.destination,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          'archive.extract',
          `解压失败：${message}`,
          'ARCHIVE_EXTRACT_FAILED',
          message,
        );
      }
    },
  },
];
