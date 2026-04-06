#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const DEFAULT_REPORTS_DIR = path.join(projectDir, 'generated', 'reports');

function parseArgs(argv) {
  const options = {
    reportsDir: DEFAULT_REPORTS_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--reports-dir') {
      options.reportsDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/build-dashboard.mjs [options]

Options:
  --reports-dir <path>   Directory that contains LATEST.md, TIMELINE.md, and weekly/
  -h, --help             Show this help
`);
}

function parseLatestWeek(markdown) {
  return markdown.match(/^- Latest Week: (.+)$/m)?.[1]?.trim() ?? '';
}

function splitSections(markdown) {
  const regex = /^##\s+(.+)$/gm;
  const matches = [...markdown.matchAll(regex)];
  const sections = [];

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const heading = current[1].trim();
    const start = current.index + current[0].length;
    const end = next ? next.index : markdown.length;
    const body = markdown.slice(start, end).trim();
    sections.push({ heading, body });
  }

  return sections;
}

function parseSummaryItemsFromSections(sections) {
  const summarySection = sections[1];
  if (!summarySection) {
    return [];
  }

  return summarySection.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => {
      const [label, ...rest] = line.slice(2).split(':');
      return {
        label: label.trim(),
        value: rest.join(':').trim(),
      };
    });
}

function parseScoreRowsFromSections(sections) {
  const scoreSection = sections[2];
  if (!scoreSection) {
    return [];
  }

  const tableLines = scoreSection.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !line.includes('---'));

  return tableLines
    .slice(1)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 3)
    .map((cells) => ({
      label: cells[0],
      score: Number.parseInt(cells[1], 10) || 0,
      meaning: cells[2],
    }));
}

function parseTimelineRows(markdown) {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !line.includes('---'));

  return lines
    .slice(1)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 5)
    .map((cells) => ({
      week: cells[0],
      level: cells[1],
      averageScore: cells[2],
      sessions: cells[3],
      focus: cells[4],
    }));
}

function computeAverageScores(reports) {
  const labels = reports[0]?.scores.map((item) => item.label) ?? [];
  return labels.map((label) => {
    const rows = reports
      .map((report) => report.scores.find((item) => item.label === label))
      .filter(Boolean);

    const average = rows.length
      ? Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length)
      : 0;

    return {
      label,
      score: average,
      meaning: rows[0]?.meaning ?? '',
    };
  });
}

async function loadReports(reportsDir) {
  const latestPath = path.join(reportsDir, 'LATEST.md');
  const timelinePath = path.join(reportsDir, 'TIMELINE.md');
  const weeklyDir = path.join(reportsDir, 'weekly');

  const latestMarkdown = await fs.readFile(latestPath, 'utf8');
  const timelineMarkdown = await fs.readFile(timelinePath, 'utf8');
  const latestSections = splitSections(latestMarkdown);
  const timelineRows = parseTimelineRows(timelineMarkdown);

  const weeklyEntries = await fs.readdir(weeklyDir, { withFileTypes: true });
  const weeklyFiles = weeklyEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  const reports = [];

  for (const fileName of weeklyFiles) {
    const markdown = await fs.readFile(path.join(weeklyDir, fileName), 'utf8');
    const sections = splitSections(markdown);

    reports.push({
      weekKey: fileName.replace(/\.md$/i, ''),
      filePath: `weekly/${fileName}`,
      markdown,
      headline: sections[0]?.body ?? '',
      scores: parseScoreRowsFromSections(sections),
    });
  }

  return {
    latestWeek: parseLatestWeek(latestMarkdown),
    latestHeadline: latestSections[0]?.body ?? '',
    latestSummaryItems: parseSummaryItemsFromSections(latestSections),
    timelineRows,
    reports,
    overallAverageScores: computeAverageScores(reports),
  };
}

function buildHtml(data) {
  const serialized = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Growth Experience Review Dashboard</title>
  <style>
    :root {
      --bg: #f4efe6;
      --bg-soft: #fbf8f2;
      --panel: rgba(255, 252, 246, 0.94);
      --panel-strong: rgba(255, 255, 255, 0.82);
      --ink: #1f2a24;
      --muted: #5f6b63;
      --line: rgba(31, 42, 36, 0.14);
      --accent: #0f766e;
      --accent-soft: rgba(15, 118, 110, 0.12);
      --accent-strong: #155e75;
      --compare-current: #0f766e;
      --compare-previous: #c08457;
      --compare-average: #4b5563;
      --shadow: 0 20px 50px rgba(36, 46, 39, 0.10);
      --radius-lg: 24px;
      --radius-md: 16px;
      --radius-sm: 12px;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: "IBM Plex Sans KR", "Segoe UI Variable", "Noto Sans KR", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15, 118, 110, 0.15), transparent 34%),
        radial-gradient(circle at top right, rgba(21, 94, 117, 0.16), transparent 28%),
        linear-gradient(180deg, #f6f0e7 0%, #efe7db 100%);
    }

    a { color: var(--accent-strong); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .shell {
      max-width: 1380px;
      margin: 0 auto;
      padding: 28px 20px 48px;
    }

    .hero {
      border: 1px solid var(--line);
      border-radius: 32px;
      padding: 28px;
      background:
        linear-gradient(145deg, rgba(255, 253, 249, 0.94), rgba(249, 243, 234, 0.90)),
        var(--bg-soft);
      box-shadow: var(--shadow);
    }

    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(420px, 1fr);
      gap: 22px;
      align-items: stretch;
    }

    .hero-side {
      display: grid;
      grid-template-rows: auto 1fr;
      gap: 22px;
      min-height: 100%;
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent-strong);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }

    h1 {
      margin: 14px 0 10px;
      font-family: "Aptos Display", "Bahnschrift", sans-serif;
      font-size: clamp(32px, 5vw, 52px);
      line-height: 0.98;
      letter-spacing: -0.03em;
    }

    .hero p {
      margin: 0;
      font-size: 16px;
      line-height: 1.7;
      color: var(--muted);
      max-width: 60ch;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .summary-card, .panel {
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      background: var(--panel);
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }

    .summary-card {
      padding: 16px;
      min-height: 104px;
    }

    .summary-label {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 8px;
    }

    .summary-value {
      font-size: 28px;
      font-weight: 700;
      line-height: 1.15;
      word-break: keep-all;
    }

    .layout {
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      gap: 20px;
      margin-top: 22px;
      align-items: start;
    }

    .main-stack {
      display: grid;
      gap: 20px;
    }

    .panel { padding: 18px; }
    .panel h2 {
      margin: 0 0 14px;
      font-size: 20px;
      letter-spacing: -0.02em;
    }

    .radar-panel {
      position: relative;
      height: 100%;
      display: flex;
      flex-direction: column;
    }

    .radar-square {
      position: relative;
      width: 100%;
      min-height: 520px;
      flex: 1 1 auto;
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: var(--panel-strong);
      padding: 12px;
      overflow: visible;
    }

    .radar-square svg {
      width: 100%;
      height: 100%;
      display: block;
      overflow: visible;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 14px;
      margin-top: 14px;
      font-size: 13px;
      color: var(--muted);
    }

    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      display: inline-block;
    }

    .legend-note {
      margin-top: 12px;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.55;
    }

    .radar-grid {
      fill: none;
      stroke: rgba(31, 42, 36, 0.12);
      stroke-width: 1;
    }

    .radar-axis {
      stroke: rgba(31, 42, 36, 0.14);
      stroke-width: 1;
    }

    .radar-label {
      fill: var(--ink);
      font-size: 12px;
      font-weight: 700;
      text-anchor: middle;
      cursor: help;
    }

    .radar-level {
      fill: var(--muted);
      font-size: 10px;
      text-anchor: start;
    }

    .radar-shape {
      fill-opacity: 0.12;
      stroke-width: 2.4;
    }

    .radar-point {
      cursor: pointer;
      transition: transform 160ms ease;
      transform-origin: center;
    }

    .radar-point:hover {
      transform: scale(1.12);
    }

    .radar-tooltip {
      position: absolute;
      min-width: 220px;
      max-width: 280px;
      pointer-events: none;
      background: rgba(24, 36, 31, 0.96);
      color: #f7f5ef;
      border-radius: 14px;
      padding: 12px 14px;
      box-shadow: 0 16px 32px rgba(19, 27, 24, 0.22);
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 140ms ease, transform 140ms ease;
      z-index: 20;
    }

    .radar-tooltip.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .tooltip-title {
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 6px;
    }

    .tooltip-score {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 8px;
    }

    .tooltip-text {
      font-size: 12px;
      line-height: 1.55;
      color: rgba(247, 245, 239, 0.86);
    }

    .trend-panel {
      overflow: hidden;
    }

    .trend-chart-wrap {
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.65);
      padding: 12px 12px 8px;
    }

    .trend-chart-wrap svg {
      width: 100%;
      height: auto;
      display: block;
      overflow: visible;
    }

    .trend-grid {
      stroke: rgba(31, 42, 36, 0.10);
      stroke-width: 1;
    }

    .trend-axis {
      stroke: rgba(31, 42, 36, 0.16);
      stroke-width: 1;
    }

    .trend-label {
      fill: var(--muted);
      font-size: 11px;
      text-anchor: middle;
    }

    .trend-y-label {
      fill: var(--muted);
      font-size: 10px;
      text-anchor: end;
    }

    .trend-line {
      fill: none;
      stroke-width: 3;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .trend-point {
      stroke: #ffffff;
      stroke-width: 2;
    }

    .timeline-table {
      overflow: auto;
      border-radius: var(--radius-md);
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.65);
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }

    th {
      background: rgba(15, 118, 110, 0.08);
      font-size: 13px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    tr:last-child td { border-bottom: none; }

    .report-list {
      display: grid;
      gap: 12px;
    }

    .report-item {
      width: 100%;
      text-align: left;
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.72);
      padding: 14px 14px 12px;
      cursor: pointer;
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
      color: inherit;
    }

    .report-item:hover, .report-item.is-active {
      transform: translateY(-1px);
      border-color: rgba(15, 118, 110, 0.35);
      background: rgba(240, 252, 250, 0.92);
    }

    .report-week {
      display: block;
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 6px;
    }

    .report-meta {
      display: block;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }

    .report-actions {
      margin-top: 10px;
      font-size: 12px;
      color: var(--accent-strong);
    }

    .viewer-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      margin-bottom: 14px;
      flex-wrap: wrap;
    }

    .viewer-title {
      margin: 0;
      font-size: 24px;
      letter-spacing: -0.02em;
    }

    .viewer-subtitle {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 14px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent-strong);
      font-size: 13px;
      font-weight: 700;
    }

    .markdown-body {
      line-height: 1.74;
      font-size: 15px;
    }

    .markdown-body h1,
    .markdown-body h2,
    .markdown-body h3 {
      font-family: "Aptos Display", "Bahnschrift", sans-serif;
      letter-spacing: -0.02em;
      line-height: 1.15;
      margin: 26px 0 12px;
    }

    .markdown-body h1 { font-size: 34px; }
    .markdown-body h2 { font-size: 24px; }
    .markdown-body h3 { font-size: 18px; }
    .markdown-body p { margin: 0 0 14px; }

    .markdown-body ul,
    .markdown-body ol {
      margin: 0 0 18px 22px;
      padding: 0;
    }

    .markdown-body li { margin-bottom: 8px; }

    .markdown-body code {
      padding: 2px 6px;
      border-radius: 8px;
      background: rgba(31, 42, 36, 0.08);
      font-family: "Cascadia Code", "Consolas", monospace;
      font-size: 0.92em;
    }

    .markdown-body pre {
      margin: 0 0 16px;
      padding: 16px;
      overflow: auto;
      border-radius: var(--radius-md);
      background: #1f2a24;
      color: #f8f7f2;
      font-family: "Cascadia Code", "Consolas", monospace;
      font-size: 13px;
      line-height: 1.6;
    }

    .markdown-body table {
      margin: 0 0 20px;
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      overflow: hidden;
      background: rgba(255, 255, 255, 0.65);
    }

    .footer-note {
      margin-top: 16px;
      color: var(--muted);
      font-size: 13px;
    }

    @media (max-width: 980px) {
      .hero-grid, .layout {
        grid-template-columns: 1fr;
      }

      .hero-side {
        grid-template-rows: auto auto;
      }

      .summary-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .radar-square {
        min-height: 420px;
      }
    }

    @media (max-width: 640px) {
      .shell {
        padding: 18px 14px 36px;
      }

      .hero {
        padding: 20px;
      }

      .summary-grid {
        grid-template-columns: 1fr;
      }

      .radar-square {
        min-height: 320px;
      }

      .summary-value {
        font-size: 24px;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="hero-grid">
        <div class="hero-side">
          <div>
            <span class="eyebrow">Growth Experience Review (G.E.R)</span>
            <h1>최신 성장 리뷰와 주간 흐름을 한 화면에서 봅니다.</h1>
            <p id="hero-headline"></p>
          </div>
          <div class="summary-grid" id="summary-grid"></div>
        </div>
        <section class="panel radar-panel">
          <h2>6축 비교 그래프</h2>
          <div class="radar-square" id="radar-wrap">
            <svg id="radar-chart" viewBox="0 0 360 360" aria-label="6-axis comparison radar chart"></svg>
            <div class="radar-tooltip" id="radar-tooltip"></div>
          </div>
          <div class="legend">
            <span class="legend-item"><span class="legend-dot" style="background: var(--compare-current);"></span>선택 주차</span>
            <span class="legend-item"><span class="legend-dot" style="background: var(--compare-previous);"></span>지난주</span>
            <span class="legend-item"><span class="legend-dot" style="background: var(--compare-average);"></span>전체평균</span>
          </div>
          <p class="legend-note">축 라벨에 마우스를 올리면 의미가, 점에 마우스를 올리면 점수만 보입니다.</p>
        </section>
      </div>
    </section>

    <div class="layout">
      <aside>
        <section class="panel trend-panel">
          <h2>성장 흐름</h2>
          <div class="trend-chart-wrap">
            <svg id="trend-chart" viewBox="0 0 320 210" aria-label="growth trend chart"></svg>
          </div>
          <div class="legend" style="margin-top: 12px;">
            <span class="legend-item"><span class="legend-dot" style="background: var(--accent-strong);"></span>평균 점수</span>
            <span class="legend-item"><span class="legend-dot" style="background: var(--compare-previous);"></span>레벨 x10</span>
          </div>
        </section>

        <section class="panel">
          <h2>과거 리포트</h2>
          <div class="report-list" id="report-list"></div>
          <p class="footer-note">주차를 누르면 그래프, 타임라인 비교 기준, 아래 본문이 함께 바뀝니다.</p>
        </section>
      </aside>

      <main class="main-stack">
        <section class="panel">
          <div class="viewer-head">
            <div>
              <h2 class="viewer-title" id="viewer-title"></h2>
              <p class="viewer-subtitle" id="viewer-subtitle"></p>
            </div>
            <span class="chip" id="viewer-chip"></span>
          </div>
          <article class="markdown-body" id="report-viewer"></article>
        </section>
      </main>
    </div>
  </div>

  <script>
    const data = ${serialized};

    function escapeHtml(text) {
      return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function inlineMarkdown(text) {
      const codeToken = String.fromCharCode(96);
      return escapeHtml(text)
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(new RegExp(codeToken + '([^' + codeToken + ']+)' + codeToken, 'g'), '<code>$1</code>')
        .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
    }

    function renderMarkdown(markdown) {
      const lines = markdown.replace(/\\r\\n/g, '\\n').split('\\n');
      let html = '';
      let paragraph = [];
      let listItems = [];
      let listType = null;
      let tableLines = [];
      let inCode = false;
      let codeLines = [];

      const renderTable = (rows) => {
        const parsed = rows
          .map((line) => line.trim())
          .filter((line) => line.startsWith('|'))
          .map((line) => line.split('|').slice(1, -1).map((cell) => inlineMarkdown(cell.trim())));

        const header = parsed[0];
        const body = parsed.slice(2);

        return '<table><thead><tr>' +
          header.map((cell) => '<th>' + cell + '</th>').join('') +
          '</tr></thead><tbody>' +
          body.map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>').join('') +
          '</tbody></table>';
      };

      const flushParagraph = () => {
        if (paragraph.length) {
          html += '<p>' + inlineMarkdown(paragraph.join(' ')) + '</p>';
          paragraph = [];
        }
      };

      const flushList = () => {
        if (listItems.length) {
          html += '<' + listType + '>' + listItems.map((item) => '<li>' + inlineMarkdown(item) + '</li>').join('') + '</' + listType + '>';
          listItems = [];
          listType = null;
        }
      };

      const flushTable = () => {
        if (tableLines.length) {
          html += renderTable(tableLines);
          tableLines = [];
        }
      };

      const flushCode = () => {
        if (codeLines.length || inCode) {
          html += '<pre><code>' + escapeHtml(codeLines.join('\\n')) + '</code></pre>';
          codeLines = [];
        }
      };

      for (const rawLine of lines) {
        const line = rawLine;

        if (line.startsWith('~~~')) {
          flushParagraph();
          flushList();
          flushTable();
          if (inCode) {
            flushCode();
            inCode = false;
          } else {
            inCode = true;
            codeLines = [];
          }
          continue;
        }

        if (inCode) {
          codeLines.push(line);
          continue;
        }

        if (line.trim().startsWith('|')) {
          flushParagraph();
          flushList();
          tableLines.push(line);
          continue;
        }

        flushTable();

        if (!line.trim()) {
          flushParagraph();
          flushList();
          continue;
        }

        const heading = line.match(/^(#{1,3})\\s+(.+)$/);
        if (heading) {
          flushParagraph();
          flushList();
          html += '<h' + heading[1].length + '>' + inlineMarkdown(heading[2].trim()) + '</h' + heading[1].length + '>';
          continue;
        }

        const bullet = line.match(/^-\\s+(.+)$/);
        if (bullet) {
          flushParagraph();
          if (listType && listType !== 'ul') {
            flushList();
          }
          listType = 'ul';
          listItems.push(bullet[1].trim());
          continue;
        }

        const ordered = line.match(/^\\d+\\.\\s+(.+)$/);
        if (ordered) {
          flushParagraph();
          if (listType && listType !== 'ol') {
            flushList();
          }
          listType = 'ol';
          listItems.push(ordered[1].trim());
          continue;
        }

        paragraph.push(line.trim());
      }

      flushParagraph();
      flushList();
      flushTable();
      if (inCode) {
        flushCode();
      }

      return html;
    }

    function getReportByWeek(weekKey) {
      return data.reports.find((item) => item.weekKey === weekKey) ?? data.reports[0];
    }

    function getPreviousReport(weekKey) {
      const index = data.reports.findIndex((item) => item.weekKey === weekKey);
      if (index < 0) {
        return null;
      }
      return data.reports[index + 1] ?? null;
    }

    function renderSummaryCards() {
      const container = document.getElementById('summary-grid');
      container.innerHTML = data.latestSummaryItems.map((item) =>
        '<div class="summary-card">' +
          '<div class="summary-label">' + escapeHtml(item.label) + '</div>' +
          '<div class="summary-value">' + escapeHtml(item.value) + '</div>' +
        '</div>'
      ).join('');
    }

    function renderTrendChart() {
      const svg = document.getElementById('trend-chart');
      const rows = [...data.timelineRows].reverse();
      const width = 320;
      const height = 210;
      const margin = { top: 14, right: 14, bottom: 34, left: 30 };
      const innerWidth = width - margin.left - margin.right;
      const innerHeight = height - margin.top - margin.bottom;

      if (!rows.length) {
        svg.innerHTML = '';
        return;
      }

      const step = rows.length === 1 ? 0 : innerWidth / (rows.length - 1);
      const yFor = (value) => margin.top + innerHeight - (value / 100) * innerHeight;
      const xFor = (index) => margin.left + step * index;

      const scorePoints = rows.map((row, index) => ({ x: xFor(index), y: yFor(Number(row.averageScore) || 0), label: row.week, value: Number(row.averageScore) || 0 }));
      const levelPoints = rows.map((row, index) => {
        const numeric = Number(String(row.level).match(/([0-9]+(?:\\.[0-9]+)?)/)?.[1] ?? 0);
        return { x: xFor(index), y: yFor(numeric * 10), label: row.week, value: numeric * 10 };
      });

      const linePath = (points) => points.map((point, index) => (index === 0 ? 'M' : 'L') + point.x.toFixed(2) + ' ' + point.y.toFixed(2)).join(' ');

      const yTicks = [0, 25, 50, 75, 100];
      let markup = '';

      markup += yTicks.map((tick) =>
        '<line class="trend-grid" x1="' + margin.left + '" y1="' + yFor(tick).toFixed(2) + '" x2="' + (width - margin.right) + '" y2="' + yFor(tick).toFixed(2) + '"></line>' +
        '<text class="trend-y-label" x="' + (margin.left - 6) + '" y="' + (yFor(tick) + 4).toFixed(2) + '">' + tick + '</text>'
      ).join('');

      markup += '<line class="trend-axis" x1="' + margin.left + '" y1="' + (margin.top + innerHeight) + '" x2="' + (width - margin.right) + '" y2="' + (margin.top + innerHeight) + '"></line>';

      markup += rows.map((row, index) => '<text class="trend-label" x="' + xFor(index).toFixed(2) + '" y="' + (height - 10) + '">' + escapeHtml(row.week.replace('2026-', '')) + '</text>').join('');

      markup += '<path class="trend-line" d="' + linePath(scorePoints) + '" stroke="var(--accent-strong)"></path>';
      markup += '<path class="trend-line" d="' + linePath(levelPoints) + '" stroke="var(--compare-previous)"></path>';

      markup += scorePoints.map((point) => '<circle class="trend-point" cx="' + point.x.toFixed(2) + '" cy="' + point.y.toFixed(2) + '" r="4.5" fill="var(--accent-strong)"></circle>').join('');
      markup += levelPoints.map((point) => '<circle class="trend-point" cx="' + point.x.toFixed(2) + '" cy="' + point.y.toFixed(2) + '" r="4.5" fill="var(--compare-previous)"></circle>').join('');

      svg.innerHTML = markup;
    }

    function renderReportList() {
      const container = document.getElementById('report-list');
      container.innerHTML = data.reports.map((report, index) =>
        '<button class="report-item ' + (index === 0 ? 'is-active' : '') + '" data-week="' + escapeHtml(report.weekKey) + '">' +
          '<span class="report-week">' + escapeHtml(report.weekKey) + '</span>' +
          '<span class="report-meta">' + escapeHtml(report.headline || '주간 멘토링 리포트') + '</span>' +
          '<span class="report-actions"><a href="' + encodeURI(report.filePath) + '" target="_blank" rel="noreferrer">원본 Markdown 열기</a></span>' +
        '</button>'
      ).join('');

      container.querySelectorAll('.report-item').forEach((button) => {
        button.addEventListener('click', () => {
          renderReport(button.dataset.week);
          container.querySelectorAll('.report-item').forEach((item) => item.classList.remove('is-active'));
          button.classList.add('is-active');
        });
      });
    }

    function getRadarGeometry() {
      return { center: 180, radius: 105 };
    }

    function polarToCartesian(center, radius, angleIndex, total) {
      const angle = (-Math.PI / 2) + (Math.PI * 2 * angleIndex / total);
      return {
        x: center + Math.cos(angle) * radius,
        y: center + Math.sin(angle) * radius,
      };
    }

    function polygonPoints(items, radius) {
      const { center } = getRadarGeometry();
      return items.map((item, index) => {
        const pointRadius = radius * (item.score / 100);
        return polarToCartesian(center, pointRadius, index, items.length);
      });
    }

    function pointsToString(points) {
      return points.map((point) => point.x.toFixed(2) + ',' + point.y.toFixed(2)).join(' ');
    }

    function showTooltip(event, payload) {
      const tooltip = document.getElementById('radar-tooltip');
      const wrap = document.getElementById('radar-wrap');
      const rect = wrap.getBoundingClientRect();
      const left = Math.min(event.clientX - rect.left + 14, rect.width - 220);
      const top = Math.max(10, event.clientY - rect.top - 8);

      if (payload.mode === 'label') {
        tooltip.innerHTML =
          '<div class="tooltip-title">' + escapeHtml(payload.label) + '</div>' +
          '<div class="tooltip-text">' + escapeHtml(payload.meaning) + '</div>';
      } else {
        tooltip.innerHTML =
          '<div class="tooltip-score">' + escapeHtml(String(payload.score)) + '점</div>';
      }

      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
      tooltip.classList.add('is-visible');
    }

    function hideTooltip() {
      document.getElementById('radar-tooltip').classList.remove('is-visible');
    }

    function renderRadarChart(currentScores, previousScores, averageScores) {
      const svg = document.getElementById('radar-chart');
      const { center, radius } = getRadarGeometry();
      const total = currentScores.length;
      const levels = [20, 40, 60, 80, 100];

      const grid = levels.map((level) => {
        const points = currentScores.map((_, index) => polarToCartesian(center, radius * (level / 100), index, total));
        return '<polygon class="radar-grid" points="' + pointsToString(points) + '"></polygon>';
      }).join('');

      const axes = currentScores.map((_, index) => {
        const point = polarToCartesian(center, radius, index, total);
        return '<line class="radar-axis" x1="' + center + '" y1="' + center + '" x2="' + point.x.toFixed(2) + '" y2="' + point.y.toFixed(2) + '"></line>';
      }).join('');

      const labels = currentScores.map((item, index) => {
        const point = polarToCartesian(center, radius + 28, index, total);
        return '<text class="radar-label" data-label="' + escapeHtml(item.label) + '" data-meaning="' + escapeHtml(item.meaning) + '" x="' + point.x.toFixed(2) + '" y="' + point.y.toFixed(2) + '">' + escapeHtml(item.label) + '</text>';
      }).join('');

      const levelLabels = levels.map((level, index) => {
        const y = center - radius * (level / 100);
        return '<text class="radar-level" x="' + (center + 8).toFixed(2) + '" y="' + (y + 4).toFixed(2) + '">' + levels[index] + '</text>';
      }).join('');

      const datasets = [
        { key: 'current', title: '선택 주차', color: 'var(--compare-current)', scores: currentScores, width: 2.8, fillOpacity: 0.16, pointRadius: 5.5 },
        { key: 'previous', title: '지난주', color: 'var(--compare-previous)', scores: previousScores, width: 2.2, fillOpacity: 0.10, pointRadius: 4.8 },
        { key: 'average', title: '전체평균', color: 'var(--compare-average)', scores: averageScores, width: 2, fillOpacity: 0.06, pointRadius: 4.4 },
      ].filter((item) => Array.isArray(item.scores) && item.scores.length === total);

      let markup = grid + axes + levelLabels + labels;

      for (const dataset of datasets) {
        const points = polygonPoints(dataset.scores, radius);
        markup += '<polygon class="radar-shape" style="fill:' + dataset.color + ';stroke:' + dataset.color + ';fill-opacity:' + dataset.fillOpacity + ';stroke-width:' + dataset.width + ';" points="' + pointsToString(points) + '"></polygon>';
        markup += points.map((point, index) => {
          const item = dataset.scores[index];
          return '<circle class="radar-point" data-score="' + escapeHtml(String(item.score)) + '" cx="' + point.x.toFixed(2) + '" cy="' + point.y.toFixed(2) + '" r="' + dataset.pointRadius + '" fill="' + dataset.color + '" stroke="#ffffff" stroke-width="2"></circle>';
        }).join('');
      }

      svg.innerHTML = markup;

      svg.querySelectorAll('.radar-label').forEach((node) => {
        const payload = {
          mode: 'label',
          label: node.getAttribute('data-label'),
          meaning: node.getAttribute('data-meaning'),
        };

        node.addEventListener('mouseenter', (event) => showTooltip(event, payload));
        node.addEventListener('mousemove', (event) => showTooltip(event, payload));
        node.addEventListener('mouseleave', hideTooltip);
      });

      svg.querySelectorAll('.radar-point').forEach((node) => {
        const payload = {
          mode: 'point',
          score: node.getAttribute('data-score'),
        };

        node.addEventListener('mouseenter', (event) => showTooltip(event, payload));
        node.addEventListener('mousemove', (event) => showTooltip(event, payload));
        node.addEventListener('mouseleave', hideTooltip);
      });
    }

    function renderReport(weekKey) {
      const report = getReportByWeek(weekKey);
      const previousReport = getPreviousReport(weekKey);
      const viewer = document.getElementById('report-viewer');
      const title = document.getElementById('viewer-title');
      const subtitle = document.getElementById('viewer-subtitle');
      const chip = document.getElementById('viewer-chip');

      title.textContent = report.weekKey + ' 리포트';
      subtitle.textContent = report.headline || '주간 G.E.R 보고서';
      chip.textContent = weekKey === data.latestWeek ? '최신 보고서' : '과거 보고서';
      viewer.innerHTML = renderMarkdown(report.markdown);

      renderRadarChart(
        report.scores,
        previousReport?.scores ?? data.overallAverageScores,
        data.overallAverageScores
      );
    }

    document.getElementById('hero-headline').textContent =
      data.latestHeadline || '최신 주간 멘토링 요약을 가장 먼저 보여줍니다.';

    renderSummaryCards();
    renderTrendChart();
    renderReportList();
    renderReport(data.latestWeek || data.reports[0]?.weekKey);
  </script>
</body>
</html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const data = await loadReports(options.reportsDir);
  const html = buildHtml(data);
  const outputPath = path.join(options.reportsDir, 'index.html');

  await fs.writeFile(outputPath, html, 'utf8');
  console.log(`Generated mentoring dashboard at ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
