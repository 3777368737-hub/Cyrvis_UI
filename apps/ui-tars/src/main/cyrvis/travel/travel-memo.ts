/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { app, shell } from 'electron';

import type { TravelPlanSnapshot } from './travel-planner';
import { aspectLabel, interestLabel } from './travel-planner';

export interface TravelMemoEntry {
  id: string;
  createdAt: number;
  kind: string;
  title: string;
  body: string;
}

interface TravelMemoFile {
  version: 1;
  entries: TravelMemoEntry[];
}

const MAX_ENTRIES = 200;

const getMemoPath = (): string =>
  path.join(app.getPath('userData'), 'cyrvis-travel-memos.json');

const readMemos = async (): Promise<TravelMemoFile> => {
  try {
    const parsed = JSON.parse(
      await readFile(getMemoPath(), 'utf8'),
    ) as Partial<TravelMemoFile>;
    return {
      version: 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    return { version: 1, entries: [] };
  }
};

const writeMemos = async (file: TravelMemoFile): Promise<void> => {
  await mkdir(path.dirname(getMemoPath()), { recursive: true });
  await writeFile(getMemoPath(), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
};

export const appendTravelMemo = async (
  kind: string,
  title: string,
  body: string,
): Promise<TravelMemoEntry | null> => {
  const normalizedTitle = title.trim();
  const normalizedBody = body.trim();
  if (!normalizedTitle || !normalizedBody) return null;

  const file = await readMemos();
  const entry: TravelMemoEntry = {
    id: randomUUID(),
    createdAt: Date.now(),
    kind: kind.trim() || 'note',
    title: normalizedTitle.slice(0, 80),
    body: normalizedBody.slice(0, 4000),
  };
  file.entries = [...file.entries, entry].slice(-MAX_ENTRIES);
  await writeMemos(file);
  return entry;
};

export const listRecentTravelMemos = async (
  limit = 12,
): Promise<TravelMemoEntry[]> => {
  const file = await readMemos();
  return file.entries.slice(-limit);
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatConstraint = (value?: boolean | null): string => {
  if (value === true) return '可以接受';
  if (value === false) return '尽量避免';
  return '未确认';
};

const linkifyText = (text: string): string => {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /(https?:\/\/[^\s）】）]+)/g,
    '<a class="inline-link" href="$1" target="_blank" rel="noreferrer">$1</a>',
  );
};

const renderParagraphs = (text: string): string => {
  const chunks = text
    .split(/(?<=[。！？；])\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (chunks.length <= 1) {
    return `<p>${linkifyText(text)}</p>`;
  }
  return chunks.map((chunk) => `<p>${linkifyText(chunk)}</p>`).join('\n');
};

/** Plain-text fallback kept for memos / debugging. */
export const formatTravelPlanSummary = (
  plan: TravelPlanSnapshot,
  recentMemos: TravelMemoEntry[] = [],
): string => {
  const f = plan.framework;
  const lines: string[] = [
    'CYRVIS 旅行计划',
    `${f.origin || '待定'} → ${f.destination || '待定'}`,
    `时间：${[f.startDate, f.endDate].filter(Boolean).join(' ~ ') || '待定'}`,
  ];
  if (plan.primaryInterest) {
    lines.push(`偏好：${interestLabel(plan.primaryInterest)}`);
  }
  for (const item of plan.aspects) {
    lines.push(`${aspectLabel(item.aspect)}：${item.summary}`);
  }
  for (const link of plan.confirmedBookings || []) {
    lines.push(`${link.name}：${link.url}`);
  }
  void recentMemos;
  return lines.join('\n');
};

export const formatTravelPlanHtml = (
  plan: TravelPlanSnapshot,
  _recentMemos: TravelMemoEntry[] = [],
): string => {
  const f = plan.framework;
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const route = `${f.origin || '待定'} → ${f.destination || '待定'}`;
  const when =
    [f.startDate, f.endDate].filter(Boolean).join(' ~ ') || '日期待定';
  // Desktop HTML only lists links the user has already confirmed in chat.
  const bookingLinks = plan.confirmedBookings?.length
    ? plan.confirmedBookings
    : [];
  const metaChips = [
    ['时间', when],
    ['同行', f.companions || '待定'],
    ['预算', f.budget || '待定'],
    ['交通', f.transport || '待定'],
    ['主题', f.purpose || plan.interestLabel || '待定'],
  ]
    .map(
      ([label, value]) =>
        `<span class="chip"><em>${escapeHtml(label)}</em>${escapeHtml(value)}</span>`,
    )
    .join('\n');

  // Scheme first: aspects are the body. Constraints / preference are footnotes.
  const aspectsBlock = plan.aspects.length
    ? `<section class="panel hero-plan">
        <h2>可执行方案</h2>
        <div class="stack">
          ${plan.aspects
            .map(
              (item) => `<article class="card">
              <div class="eyebrow">${escapeHtml(aspectLabel(item.aspect))}</div>
              <div class="body">${renderParagraphs(item.summary)}</div>
            </article>`,
            )
            .join('\n')}
        </div>
      </section>`
    : '';

  const preferenceBlock = plan.primaryInterest
    ? `<p class="pref note">主线偏好：${escapeHtml(interestLabel(plan.primaryInterest))}（备注，可改）</p>`
    : '';

  const constraintBlock = plan.constraints
    ? `<section class="panel muted">
        <h2>方案备注 · 节奏</h2>
        <ul class="facts">
          <li><span>步行</span><strong>${escapeHtml(formatConstraint(plan.constraints.okWithWalking))}</strong></li>
          <li><span>早起</span><strong>${escapeHtml(formatConstraint(plan.constraints.okWithEarlyStart))}</strong></li>
          <li><span>排队</span><strong>${escapeHtml(formatConstraint(plan.constraints.okWithQueues))}</strong></li>
          ${
            plan.constraints.notes
              ? `<li><span>补充</span><strong>${escapeHtml(plan.constraints.notes)}</strong></li>`
              : ''
          }
        </ul>
      </section>`
    : '';

  // Only show highlight chips when we don't yet have a real day plan.
  const highlightsBlock =
    !plan.aspects.length && plan.highlights.length
      ? `<section class="panel">
        <h2>可选主线（点位示例）</h2>
        <div class="grid">
          ${plan.highlights
            .map(
              (item) => `<article class="card soft">
              <div class="eyebrow">${escapeHtml(interestLabel(item.interest))}</div>
              <h3>${escapeHtml(item.title)}</h3>
              ${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ''}
            </article>`,
            )
            .join('\n')}
        </div>
      </section>`
      : '';

  const linksBlock = bookingLinks.length
    ? `<section class="panel">
        <h2>订票 / 预约 / 住宿</h2>
        <p class="note">请自行打开链接下单，助手不代订。</p>
        <div class="link-list">
          ${bookingLinks
            .map(
              (
                link,
              ) => `<a class="link-card" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">
              <div>
                <strong>${escapeHtml(link.name)}</strong>
                <span>${escapeHtml(link.blurb)}</span>
              </div>
              <em>打开</em>
            </a>`,
            )
            .join('\n')}
        </div>
      </section>`
    : '';

  // Skeleton is only a quiet footnote — never the main content.
  const skeletonBlock =
    plan.skeleton && !plan.aspects.length
      ? `<p class="skeleton note">${escapeHtml(plan.skeleton.replace(/^骨架攻略：/, '行程要点：').replace(/^行程要点：/, '行程要点：'))}</p>`
      : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CYRVIS 旅行计划 · ${escapeHtml(f.destination || '行程')}</title>
  <style>
    :root {
      --ink: #17302c;
      --muted: #5d716c;
      --paper: #f4f7f5;
      --panel: rgba(255, 255, 255, 0.82);
      --line: rgba(23, 48, 44, 0.1);
      --accent: #0f7a66;
      --accent-soft: #d7efe8;
      --shadow: 0 18px 50px rgba(23, 48, 44, 0.08);
      --radius: 22px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(1200px 600px at 10% -10%, #dff3ec 0%, transparent 55%),
        radial-gradient(900px 500px at 100% 0%, #e7eef5 0%, transparent 45%),
        linear-gradient(180deg, #eef3f0 0%, var(--paper) 40%, #e9efec 100%);
      min-height: 100vh;
    }
    .wrap {
      width: min(920px, calc(100% - 32px));
      margin: 0 auto;
      padding: 40px 0 72px;
    }
    .hero {
      position: relative;
      overflow: hidden;
      border-radius: 32px;
      padding: 36px 36px 28px;
      background:
        linear-gradient(135deg, rgba(15, 122, 102, 0.95), rgba(24, 58, 74, 0.92));
      color: #f7fffc;
      box-shadow: var(--shadow);
    }
    .hero::after {
      content: "";
      position: absolute;
      inset: auto -40px -60px auto;
      width: 220px;
      height: 220px;
      border-radius: 50%;
      background: rgba(255,255,255,0.08);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      opacity: 0.86;
    }
    .brand i {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #9dffd8;
      display: inline-block;
    }
    h1 {
      margin: 14px 0 8px;
      font-size: clamp(28px, 5vw, 42px);
      line-height: 1.15;
      font-weight: 700;
    }
    .sub {
      margin: 0;
      max-width: 36em;
      color: rgba(247, 255, 252, 0.82);
      font-size: 15px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 22px;
    }
    .chip {
      display: inline-flex;
      gap: 8px;
      align-items: baseline;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.16);
      font-size: 13px;
    }
    .chip em {
      font-style: normal;
      opacity: 0.72;
    }
    .pref {
      margin: 18px 0 0;
      color: var(--muted);
      font-size: 14px;
    }
    .pref strong { color: var(--accent); }
    .skeleton {
      margin: 14px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
    }
    .panel {
      margin-top: 22px;
      padding: 24px;
      border-radius: var(--radius);
      background: var(--panel);
      border: 1px solid var(--line);
      backdrop-filter: blur(10px);
      box-shadow: var(--shadow);
    }
    .panel.muted { background: rgba(255,255,255,0.66); }
    h2 {
      margin: 0 0 16px;
      font-size: 18px;
      letter-spacing: 0.02em;
    }
    .facts {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    .facts li {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 14px;
      border-radius: 14px;
      background: var(--accent-soft);
    }
    .facts span { color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .stack { display: grid; gap: 14px; }
    .card {
      padding: 18px;
      border-radius: 18px;
      background: #fff;
      border: 1px solid var(--line);
    }
    .card.soft { background: linear-gradient(180deg, #fff, #f7fbf9); }
    .eyebrow {
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 8px;
    }
    .card h3 {
      margin: 0 0 8px;
      font-size: 16px;
    }
    .body p, .card p {
      margin: 0 0 8px;
      color: var(--muted);
      line-height: 1.7;
      font-size: 14px;
    }
    .body p:last-child, .card p:last-child { margin-bottom: 0; }
    .note {
      margin: -4px 0 14px;
      color: var(--muted);
      font-size: 13px;
    }
    .link-list { display: grid; gap: 10px; }
    .link-card {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 14px 16px;
      border-radius: 16px;
      text-decoration: none;
      color: inherit;
      background: #fff;
      border: 1px solid var(--line);
      transition: transform 0.15s ease, border-color 0.15s ease;
    }
    .link-card:hover {
      transform: translateY(-1px);
      border-color: rgba(15, 122, 102, 0.35);
    }
    .link-card strong { display: block; margin-bottom: 4px; }
    .link-card span { color: var(--muted); font-size: 13px; }
    .link-card em {
      font-style: normal;
      color: var(--accent);
      font-weight: 600;
      white-space: nowrap;
    }
    .inline-link {
      color: var(--accent);
      word-break: break-all;
    }
    .timeline {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    .timeline li {
      padding-left: 14px;
      border-left: 3px solid var(--accent-soft);
    }
    .timeline strong { display: block; margin-bottom: 2px; }
    .timeline span { color: var(--muted); font-size: 13px; }
    footer {
      margin-top: 28px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.7;
      text-align: center;
    }
    @media (max-width: 640px) {
      .wrap { width: min(100% - 20px, 920px); padding-top: 20px; }
      .hero { padding: 28px 22px; border-radius: 24px; }
      .panel { padding: 18px; }
      .facts li { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <div class="brand"><i></i> CYRVIS Travel</div>
      <h1>${escapeHtml(f.destination || '旅行计划')}</h1>
      <p class="sub">${escapeHtml(route)} · ${escapeHtml(when)}</p>
      <div class="chips">${metaChips}</div>
    </header>

    ${aspectsBlock}
    ${highlightsBlock}
    ${linksBlock}
    ${preferenceBlock}
    ${constraintBlock}
    ${skeletonBlock}

    <footer>
      由 CYRVIS 于 ${escapeHtml(generatedAt)} 生成 · 价格与开放时间以链接页面为准 · 可随时让我继续补充
    </footer>
  </div>
</body>
</html>`;
};

export const writeTravelPlanDesktopTxt = async (
  plan: TravelPlanSnapshot,
): Promise<{ memoPath: string; desktopPath: string; summaryChars: number }> => {
  const recent = await listRecentTravelMemos(12);
  const html = formatTravelPlanHtml(plan, recent);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = (plan.framework.destination || '旅行').replace(
    /[\\/:*?"<>|]/g,
    '_',
  );
  const desktopPath = path.join(
    app.getPath('desktop'),
    `CYRVIS旅行计划-${dest}-${stamp}.html`,
  );
  await writeFile(desktopPath, html, 'utf8');
  void shell.openPath(desktopPath);
  void appendTravelMemo(
    'finalize',
    '旅行计划敲定摘要',
    `已生成桌面网页：${path.basename(desktopPath)}`,
  );

  return {
    memoPath: getMemoPath(),
    desktopPath,
    summaryChars: html.length,
  };
};
