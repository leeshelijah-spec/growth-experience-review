#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvaluationConfig, scoreToGrade } from './lib/evaluation-config.mjs';

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

function findSection(sections, headingCandidates) {
  return sections.find((section) => headingCandidates.includes(section.heading));
}

function parseSummaryItemsFromSections(sections) {
  const summarySection = findSection(sections, ['이번 주 활동 요약']);
  if (!summarySection) {
    return [];
  }

  const lines = summarySection.body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const tableRows = lines
    .filter((line) => line.startsWith('|') && !line.includes('---'))
    .slice(1)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 2)
    .map((cells) => ({
      label: cells[0],
      value: cells[1],
    }))
    .filter((item) => item.label && item.value);

  if (tableRows.length) {
    return tableRows;
  }

  return lines
    .filter((line) => line.startsWith('- '))
    .map((line) => {
      const [label, ...rest] = line.slice(2).split(':');
      return {
        label: label.trim(),
        value: rest.join(':').trim(),
      };
    })
    .filter((item) => item.label && item.value);
}

function parseCompositeTypeFromSections(sections) {
  const typeSection = findSection(sections, ['타입 판정', '종합 타입']);

  if (!typeSection) {
    return {
      name: 'Fool',
      subtitle: '탐색형',
      reversedActive: false,
      reversedLabel: 'Normal',
      typeReason: '리포트에서 타입 판정 섹션을 찾지 못했습니다.',
      reversedReason: '해당 없음',
      displayName: 'Fool',
    };
  }

  const typeLine = typeSection.body.match(/-\s*(?:대표 타입|판정 타입):\s*(.+)$/m)?.[1]?.trim();
  const subtitleLine = typeSection.body.match(/-\s*타입 의미:\s*(.+)$/m)?.[1]?.trim();
  const statusLine = typeSection.body.match(/-\s*Reversed 상태:\s*(.+)$/m)?.[1]?.trim();
  const typeReasonLine = typeSection.body.match(/-\s*(?:타입 판정 근거|판정 근거):\s*(.+)$/m)?.[1]?.trim();
  const reversedReasonLine = typeSection.body.match(/-\s*Reversed 판정 근거:\s*(.+)$/m)?.[1]?.trim();
  const baseName = typeLine?.replace(/\s+\(Reversed\)$/i, '').trim() || 'Fool';
  const reversedActive = /\(Reversed\)$/i.test(typeLine ?? '') || /^reversed$/i.test(statusLine ?? '');

  return {
    name: baseName,
    subtitle: subtitleLine ?? '',
    reversedActive,
    reversedLabel: reversedActive ? 'Reversed' : (statusLine ?? 'Normal'),
    typeReason: typeReasonLine ?? '타입 판정 근거를 찾지 못했습니다.',
    reversedReason: reversedReasonLine ?? (reversedActive ? 'Reversed 판정 근거를 찾지 못했습니다.' : '해당 없음'),
    displayName: reversedActive ? `${baseName} (Reversed)` : baseName,
  };
}

function parseScoreRowsFromSections(sections, evaluationConfig) {
  const scoreSection = findSection(sections, ['6축 평가 결과']);
  if (!scoreSection) {
    return [];
  }

  const tableLines = scoreSection.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !line.includes('---'));

  const parsedRows = tableLines
    .slice(1)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4)
    .map((cells) => ({
      label: cells[0],
      score: Number.parseInt(cells[1], 10) || 0,
      grade: cells[2] || scoreToGrade(Number.parseInt(cells[1], 10) || 0, evaluationConfig),
      meaning: (cells[3] || '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim(),
    }));

  const byLabel = new Map(parsedRows.map((row) => [row.label, row]));

  return evaluationConfig.axes.map((axis) => {
    const row = byLabel.get(axis.name);

    if (row) {
      return {
        key: axis.key,
        label: axis.name,
        score: row.score,
        grade: row.grade,
        meaning: row.meaning || axis.description,
        description: axis.description,
        criterion: axis.gradeCriteria?.[row.grade] ?? axis.description,
      };
    }

    return {
      key: axis.key,
      label: axis.name,
      score: 0,
      grade: 'E',
      meaning: '데이터 없음',
      description: axis.description,
      criterion: axis.gradeCriteria?.E ?? axis.description,
    };
  });
}

function parseTimelineRows(markdown) {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !line.includes('---'));

  return lines
    .slice(1)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 6)
    .map((cells) => {
      if (cells.length >= 7) {
        return {
          week: cells[0],
          type: cells[1],
          reversed: cells[2],
          averageGrade: cells[3],
          averageScore: Number.parseInt(cells[4], 10) || 0,
          sessions: cells[5],
          focus: cells[6],
        };
      }

      return {
        week: cells[0],
        type: cells[1],
        reversed: 'Normal',
        averageGrade: cells[2],
        averageScore: Number.parseInt(cells[3], 10) || 0,
        sessions: cells[4],
        focus: cells[5],
      };
    });
}

function computeAverageScores(reports, evaluationConfig) {
  return evaluationConfig.axes.map((axis) => {
    const rows = reports
      .map((report) => report.scores.find((item) => item.key === axis.key))
      .filter(Boolean);

    const average = rows.length
      ? Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length)
      : 0;

    return {
      key: axis.key,
      label: axis.name,
      score: average,
      grade: scoreToGrade(average, evaluationConfig),
      meaning: axis.description,
      description: axis.description,
      criterion: axis.gradeCriteria?.[scoreToGrade(average, evaluationConfig)] ?? axis.description,
    };
  });
}

function buildProfileGuideData(evaluationConfig) {
  const profileRules = evaluationConfig.profileRules ?? {};
  const byKey = new Map((profileRules.types ?? []).map((type) => [type.key, type]));
  const orderedTypes = (profileRules.priority ?? [])
    .map((key) => byKey.get(key))
    .filter(Boolean)
    .map((type) => ({
      key: type.key,
      name: type.name,
      subtitle: type.subtitle,
      description: type.description,
    }));

  return {
    intro: [
      '타입은 현재 주된 작업 스타일을 요약하는 레이블입니다.',
      'Reversed는 별도 타입이 아니라 구조적 문제 또는 재설계 필요 신호를 나타내는 경고 상태입니다.',
    ],
    reversed: {
      label: profileRules.reversed?.label ?? 'Reversed',
      description: profileRules.reversed?.description ?? '',
    },
    types: orderedTypes,
  };
}

async function loadReports(reportsDir, evaluationConfig) {
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
      sections,
      headline: findSection(sections, ['한 줄 진단'])?.body?.split('\n').map((line) => line.trim()).find(Boolean) ?? '',
      compositeType: parseCompositeTypeFromSections(sections),
      summaryItems: parseSummaryItemsFromSections(sections),
      scores: parseScoreRowsFromSections(sections, evaluationConfig),
    });
  }

  return {
    latestWeek: parseLatestWeek(latestMarkdown),
    latestHeadline: findSection(latestSections, ['한 줄 진단'])?.body?.split('\n').map((line) => line.trim()).find(Boolean) ?? '',
    latestSummaryItems: parseSummaryItemsFromSections(latestSections),
    timelineRows,
    reports,
    overallAverageScores: computeAverageScores(reports, evaluationConfig),
    profileGuide: buildProfileGuideData(evaluationConfig),
  };
}

function buildHtml(data) {
  const serialized = JSON.stringify(data).replace(/</g, '\\u003c');

  return String.raw`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" type="image/x-icon" href="../../config/favicon.ico" />
  <link rel="shortcut icon" type="image/x-icon" href="../../config/favicon.ico" />
  <title>Growth Experience Review (G.E.R)</title>
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
      --ui-scale: 0.765;
      --shadow: 0 20px 50px rgba(36, 46, 39, 0.10);
      --radius-lg: 24px;
      --radius-md: 16px;
      --radius-sm: 12px;
      --halo-left: rgba(201, 151, 61, 0.18);
      --halo-right: rgba(183, 129, 52, 0.15);
      --page-top: #f6f0e7;
      --page-bottom: #efe7db;
      --hero-start: rgba(255, 253, 249, 0.94);
      --hero-end: rgba(249, 243, 234, 0.90);
      --type-card-bg: rgba(255, 247, 228, 0.90);
      --status-border: rgba(15, 118, 110, 0.18);
      --status-bg: rgba(15, 118, 110, 0.10);
      --status-ink: #155e75;
      --button-bg: rgba(255, 251, 242, 0.98);
      --button-border: rgba(145, 113, 55, 0.22);
      --button-hover-bg: rgba(255, 244, 219, 0.98);
      --button-hover-border: rgba(145, 113, 55, 0.38);
      --button-active-bg: #8f6620;
      --button-active-border: #8f6620;
      --button-active-ink: #fffaf0;
      --button-shadow: inset 0 -1px 0 rgba(117, 90, 38, 0.08);
      --action-button-bg: rgba(247, 236, 212, 0.98);
      --action-button-ink: #7b5819;
      --action-button-border: rgba(145, 113, 55, 0.28);
      --picker-panel-bg: rgba(255, 250, 242, 0.92);
      --picker-field-bg: rgba(255, 253, 248, 0.98);
      --picker-field-border: rgba(145, 113, 55, 0.22);
      --week-list-bg: rgba(255, 252, 247, 0.98);
      --week-button-bg: rgba(255, 251, 242, 0.94);
      --week-button-hover-bg: rgba(255, 244, 219, 0.98);
      --week-button-border: rgba(117, 90, 38, 0.18);
      --week-button-hover-border: rgba(184, 134, 40, 0.4);
      --radar-surface-bg: rgba(255, 251, 242, 0.90);
      --grade-card-bg: rgba(255, 251, 242, 0.86);
      --grade-card-same-bg: rgba(255, 251, 242, 0.88);
      --grade-card-same-border: rgba(184, 134, 40, 0.18);
      --grade-card-same-current-bg: rgba(255, 249, 237, 0.94);
      --grade-card-same-ink: #8f6620;
      --type-card-shadow: 0 14px 30px rgba(118, 86, 27, 0.08);
      --badge-neutral-bg: rgba(184, 134, 40, 0.12);
      --badge-neutral-ink: #8f6620;
      --reversed-border: rgba(183, 71, 42, 0.20);
      --reversed-bg: rgba(255, 243, 236, 0.82);
      --reversed-ink: #8f3c22;
    }

    body[data-profile-theme="fool"] {
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
      --halo-left: rgba(201, 151, 61, 0.18);
      --halo-right: rgba(183, 129, 52, 0.15);
      --page-top: #f6f0e7;
      --page-bottom: #efe7db;
      --hero-start: rgba(255, 253, 249, 0.94);
      --hero-end: rgba(249, 243, 234, 0.90);
      --type-card-bg: rgba(255, 247, 228, 0.90);
      --status-border: rgba(15, 118, 110, 0.18);
      --status-bg: rgba(15, 118, 110, 0.10);
      --status-ink: #155e75;
    }

    body[data-profile-theme="hierophant"] {
      --bg: #edf4ee;
      --bg-soft: #f7fbf6;
      --panel: rgba(248, 253, 248, 0.94);
      --panel-strong: rgba(255, 255, 255, 0.84);
      --ink: #1d2c22;
      --muted: #58705f;
      --line: rgba(29, 44, 34, 0.14);
      --accent: #2f7d4d;
      --accent-soft: rgba(47, 125, 77, 0.12);
      --accent-strong: #24623c;
      --compare-current: #2f7d4d;
      --compare-previous: #84a96e;
      --compare-average: #5a6d61;
      --shadow: 0 20px 50px rgba(33, 60, 42, 0.10);
      --halo-left: rgba(72, 153, 96, 0.18);
      --halo-right: rgba(40, 117, 72, 0.14);
      --page-top: #eef7f0;
      --page-bottom: #dde9df;
      --hero-start: rgba(252, 255, 252, 0.95);
      --hero-end: rgba(237, 246, 239, 0.92);
      --type-card-bg: rgba(236, 248, 237, 0.92);
      --status-border: rgba(47, 125, 77, 0.20);
      --status-bg: rgba(47, 125, 77, 0.11);
      --status-ink: #24623c;
      --button-bg: rgba(243, 250, 244, 0.98);
      --button-border: rgba(47, 125, 77, 0.24);
      --button-hover-bg: rgba(231, 245, 234, 0.98);
      --button-hover-border: rgba(47, 125, 77, 0.40);
      --button-active-bg: #2f7d4d;
      --button-active-border: #2f7d4d;
      --button-active-ink: #f6fff8;
      --button-shadow: inset 0 -1px 0 rgba(47, 125, 77, 0.10);
      --action-button-bg: rgba(231, 245, 234, 0.98);
      --action-button-ink: #24623c;
      --action-button-border: rgba(47, 125, 77, 0.28);
      --picker-panel-bg: rgba(239, 248, 241, 0.92);
      --picker-field-bg: rgba(249, 253, 249, 0.98);
      --picker-field-border: rgba(47, 125, 77, 0.22);
      --week-list-bg: rgba(247, 252, 248, 0.98);
      --week-button-bg: rgba(243, 250, 244, 0.96);
      --week-button-hover-bg: rgba(231, 245, 234, 0.98);
      --week-button-border: rgba(47, 125, 77, 0.18);
      --week-button-hover-border: rgba(47, 125, 77, 0.36);
      --radar-surface-bg: rgba(243, 250, 244, 0.90);
      --grade-card-bg: rgba(244, 251, 245, 0.88);
      --grade-card-same-bg: rgba(244, 251, 245, 0.90);
      --grade-card-same-border: rgba(47, 125, 77, 0.18);
      --grade-card-same-current-bg: rgba(236, 248, 239, 0.94);
      --grade-card-same-ink: #24623c;
      --type-card-shadow: 0 14px 30px rgba(47, 125, 77, 0.08);
      --badge-neutral-bg: rgba(47, 125, 77, 0.12);
      --badge-neutral-ink: #24623c;
    }

    body[data-profile-theme="magician"] {
      --bg: #f7ece9;
      --bg-soft: #fff8f6;
      --panel: rgba(255, 249, 247, 0.94);
      --panel-strong: rgba(255, 255, 255, 0.84);
      --ink: #321f1c;
      --muted: #7a5751;
      --line: rgba(50, 31, 28, 0.14);
      --accent: #b5443c;
      --accent-soft: rgba(181, 68, 60, 0.12);
      --accent-strong: #933129;
      --compare-current: #b5443c;
      --compare-previous: #d47a57;
      --compare-average: #6e5d59;
      --shadow: 0 20px 50px rgba(72, 39, 34, 0.12);
      --halo-left: rgba(197, 76, 64, 0.18);
      --halo-right: rgba(145, 37, 36, 0.14);
      --page-top: #fbf0ed;
      --page-bottom: #ecd9d4;
      --hero-start: rgba(255, 252, 251, 0.95);
      --hero-end: rgba(248, 235, 231, 0.92);
      --type-card-bg: rgba(255, 239, 235, 0.90);
      --status-border: rgba(181, 68, 60, 0.22);
      --status-bg: rgba(181, 68, 60, 0.12);
      --status-ink: #933129;
      --button-bg: rgba(252, 243, 241, 0.98);
      --button-border: rgba(181, 68, 60, 0.24);
      --button-hover-bg: rgba(248, 228, 224, 0.98);
      --button-hover-border: rgba(181, 68, 60, 0.40);
      --button-active-bg: #b5443c;
      --button-active-border: #b5443c;
      --button-active-ink: #fff8f6;
      --button-shadow: inset 0 -1px 0 rgba(181, 68, 60, 0.10);
      --action-button-bg: rgba(248, 228, 224, 0.98);
      --action-button-ink: #933129;
      --action-button-border: rgba(181, 68, 60, 0.30);
      --picker-panel-bg: rgba(250, 239, 236, 0.92);
      --picker-field-bg: rgba(255, 248, 246, 0.98);
      --picker-field-border: rgba(181, 68, 60, 0.22);
      --week-list-bg: rgba(255, 249, 247, 0.98);
      --week-button-bg: rgba(252, 243, 241, 0.96);
      --week-button-hover-bg: rgba(248, 228, 224, 0.98);
      --week-button-border: rgba(181, 68, 60, 0.18);
      --week-button-hover-border: rgba(181, 68, 60, 0.36);
      --radar-surface-bg: rgba(252, 243, 241, 0.90);
      --grade-card-bg: rgba(252, 244, 242, 0.88);
      --grade-card-same-bg: rgba(252, 244, 242, 0.90);
      --grade-card-same-border: rgba(181, 68, 60, 0.18);
      --grade-card-same-current-bg: rgba(250, 235, 232, 0.94);
      --grade-card-same-ink: #933129;
      --type-card-shadow: 0 14px 30px rgba(181, 68, 60, 0.08);
      --badge-neutral-bg: rgba(181, 68, 60, 0.12);
      --badge-neutral-ink: #933129;
    }

    body[data-profile-theme="star"] {
      --bg: #f0f1f4;
      --bg-soft: #fafbfd;
      --panel: rgba(250, 251, 253, 0.94);
      --panel-strong: rgba(255, 255, 255, 0.86);
      --ink: #243041;
      --muted: #647283;
      --line: rgba(36, 48, 65, 0.14);
      --accent: #7f8ea3;
      --accent-soft: rgba(127, 142, 163, 0.14);
      --accent-strong: #58677c;
      --compare-current: #7f8ea3;
      --compare-previous: #b9bec8;
      --compare-average: #596271;
      --shadow: 0 20px 50px rgba(62, 74, 93, 0.12);
      --halo-left: rgba(182, 188, 199, 0.24);
      --halo-right: rgba(135, 146, 167, 0.20);
      --page-top: #f4f6f9;
      --page-bottom: #e1e5eb;
      --hero-start: rgba(255, 255, 255, 0.95);
      --hero-end: rgba(241, 244, 248, 0.92);
      --type-card-bg: rgba(245, 247, 251, 0.92);
      --status-border: rgba(127, 142, 163, 0.22);
      --status-bg: rgba(127, 142, 163, 0.12);
      --status-ink: #58677c;
      --button-bg: rgba(247, 249, 252, 0.98);
      --button-border: rgba(127, 142, 163, 0.24);
      --button-hover-bg: rgba(236, 240, 245, 0.98);
      --button-hover-border: rgba(127, 142, 163, 0.40);
      --button-active-bg: #7f8ea3;
      --button-active-border: #7f8ea3;
      --button-active-ink: #f9fbff;
      --button-shadow: inset 0 -1px 0 rgba(127, 142, 163, 0.10);
      --action-button-bg: rgba(236, 240, 245, 0.98);
      --action-button-ink: #58677c;
      --action-button-border: rgba(127, 142, 163, 0.30);
      --picker-panel-bg: rgba(242, 245, 249, 0.92);
      --picker-field-bg: rgba(251, 252, 254, 0.98);
      --picker-field-border: rgba(127, 142, 163, 0.22);
      --week-list-bg: rgba(250, 251, 253, 0.98);
      --week-button-bg: rgba(247, 249, 252, 0.96);
      --week-button-hover-bg: rgba(236, 240, 245, 0.98);
      --week-button-border: rgba(127, 142, 163, 0.18);
      --week-button-hover-border: rgba(127, 142, 163, 0.34);
      --radar-surface-bg: rgba(246, 248, 252, 0.92);
      --grade-card-bg: rgba(247, 249, 252, 0.88);
      --grade-card-same-bg: rgba(247, 249, 252, 0.90);
      --grade-card-same-border: rgba(127, 142, 163, 0.18);
      --grade-card-same-current-bg: rgba(239, 243, 248, 0.94);
      --grade-card-same-ink: #58677c;
      --type-card-shadow: 0 14px 30px rgba(127, 142, 163, 0.08);
      --badge-neutral-bg: rgba(127, 142, 163, 0.12);
      --badge-neutral-ink: #58677c;
    }

    body[data-profile-theme="hermit"] {
      --bg: #f2ecf8;
      --bg-soft: #fbf8fe;
      --panel: rgba(251, 248, 254, 0.94);
      --panel-strong: rgba(255, 255, 255, 0.84);
      --ink: #2b2136;
      --muted: #6d5f7f;
      --line: rgba(43, 33, 54, 0.14);
      --accent: #7651a8;
      --accent-soft: rgba(118, 81, 168, 0.12);
      --accent-strong: #5d3f87;
      --compare-current: #7651a8;
      --compare-previous: #aa86c7;
      --compare-average: #645d72;
      --shadow: 0 20px 50px rgba(56, 42, 76, 0.12);
      --halo-left: rgba(132, 93, 182, 0.18);
      --halo-right: rgba(91, 61, 140, 0.16);
      --page-top: #f6f1fb;
      --page-bottom: #e7ddf2;
      --hero-start: rgba(255, 253, 255, 0.95);
      --hero-end: rgba(242, 236, 249, 0.92);
      --type-card-bg: rgba(246, 239, 252, 0.90);
      --status-border: rgba(118, 81, 168, 0.22);
      --status-bg: rgba(118, 81, 168, 0.12);
      --status-ink: #5d3f87;
      --button-bg: rgba(248, 243, 252, 0.98);
      --button-border: rgba(118, 81, 168, 0.24);
      --button-hover-bg: rgba(239, 230, 248, 0.98);
      --button-hover-border: rgba(118, 81, 168, 0.40);
      --button-active-bg: #7651a8;
      --button-active-border: #7651a8;
      --button-active-ink: #fbf8ff;
      --button-shadow: inset 0 -1px 0 rgba(118, 81, 168, 0.10);
      --action-button-bg: rgba(239, 230, 248, 0.98);
      --action-button-ink: #5d3f87;
      --action-button-border: rgba(118, 81, 168, 0.30);
      --picker-panel-bg: rgba(244, 238, 250, 0.92);
      --picker-field-bg: rgba(252, 249, 254, 0.98);
      --picker-field-border: rgba(118, 81, 168, 0.22);
      --week-list-bg: rgba(251, 248, 254, 0.98);
      --week-button-bg: rgba(248, 243, 252, 0.96);
      --week-button-hover-bg: rgba(239, 230, 248, 0.98);
      --week-button-border: rgba(118, 81, 168, 0.18);
      --week-button-hover-border: rgba(118, 81, 168, 0.36);
      --radar-surface-bg: rgba(248, 243, 252, 0.90);
      --grade-card-bg: rgba(248, 243, 252, 0.88);
      --grade-card-same-bg: rgba(248, 243, 252, 0.90);
      --grade-card-same-border: rgba(118, 81, 168, 0.18);
      --grade-card-same-current-bg: rgba(242, 236, 249, 0.94);
      --grade-card-same-ink: #5d3f87;
      --type-card-shadow: 0 14px 30px rgba(118, 81, 168, 0.08);
      --badge-neutral-bg: rgba(118, 81, 168, 0.12);
      --badge-neutral-ink: #5d3f87;
    }

    body[data-profile-theme="chariot"] {
      --bg: #eef1f3;
      --bg-soft: #fafcfd;
      --panel: rgba(249, 251, 252, 0.94);
      --panel-strong: rgba(255, 255, 255, 0.85);
      --ink: #27313a;
      --muted: #66737d;
      --line: rgba(39, 49, 58, 0.14);
      --accent: #7c8b96;
      --accent-soft: rgba(124, 139, 150, 0.13);
      --accent-strong: #5f6d77;
      --compare-current: #7c8b96;
      --compare-previous: #a8b2b9;
      --compare-average: #5e6871;
      --shadow: 0 20px 50px rgba(57, 67, 76, 0.11);
      --halo-left: rgba(164, 175, 184, 0.22);
      --halo-right: rgba(120, 132, 143, 0.18);
      --page-top: #f3f5f7;
      --page-bottom: #e0e4e8;
      --hero-start: rgba(255, 255, 255, 0.95);
      --hero-end: rgba(239, 243, 246, 0.92);
      --type-card-bg: rgba(242, 245, 247, 0.92);
      --status-border: rgba(124, 139, 150, 0.22);
      --status-bg: rgba(124, 139, 150, 0.12);
      --status-ink: #5f6d77;
      --button-bg: rgba(246, 248, 249, 0.98);
      --button-border: rgba(124, 139, 150, 0.24);
      --button-hover-bg: rgba(234, 239, 242, 0.98);
      --button-hover-border: rgba(124, 139, 150, 0.40);
      --button-active-bg: #7c8b96;
      --button-active-border: #7c8b96;
      --button-active-ink: #fbfdff;
      --button-shadow: inset 0 -1px 0 rgba(124, 139, 150, 0.10);
      --action-button-bg: rgba(234, 239, 242, 0.98);
      --action-button-ink: #5f6d77;
      --action-button-border: rgba(124, 139, 150, 0.30);
      --picker-panel-bg: rgba(240, 243, 245, 0.92);
      --picker-field-bg: rgba(250, 252, 253, 0.98);
      --picker-field-border: rgba(124, 139, 150, 0.22);
      --week-list-bg: rgba(249, 251, 252, 0.98);
      --week-button-bg: rgba(246, 248, 249, 0.96);
      --week-button-hover-bg: rgba(234, 239, 242, 0.98);
      --week-button-border: rgba(124, 139, 150, 0.18);
      --week-button-hover-border: rgba(124, 139, 150, 0.34);
      --radar-surface-bg: rgba(245, 248, 249, 0.90);
      --grade-card-bg: rgba(246, 248, 249, 0.88);
      --grade-card-same-bg: rgba(246, 248, 249, 0.90);
      --grade-card-same-border: rgba(124, 139, 150, 0.18);
      --grade-card-same-current-bg: rgba(238, 242, 244, 0.94);
      --grade-card-same-ink: #5f6d77;
      --type-card-shadow: 0 14px 30px rgba(124, 139, 150, 0.08);
      --badge-neutral-bg: rgba(124, 139, 150, 0.12);
      --badge-neutral-ink: #5f6d77;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: "IBM Plex Sans KR", "Segoe UI Variable", "Noto Sans KR", sans-serif;
      font-size: 16.5px;
      color: var(--ink);
      zoom: var(--ui-scale);
      background:
        radial-gradient(circle at top left, var(--halo-left), transparent 34%),
        radial-gradient(circle at top right, var(--halo-right), transparent 28%),
        linear-gradient(180deg, var(--page-top) 0%, var(--page-bottom) 100%);
      transition: background 220ms ease, color 220ms ease;
    }

    a { color: var(--accent-strong); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .shell {
      max-width: 1520px;
      margin: 0 auto;
      padding: 16px 10px 24px;
    }

    .hero {
      border: 1px solid var(--line);
      border-radius: 30px;
      padding: 20px 18px 18px;
      background:
        linear-gradient(145deg, var(--hero-start), var(--hero-end)),
        var(--bg-soft);
      box-shadow: var(--shadow);
    }

    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
      align-items: stretch;
    }

    .hero-side {
      display: grid;
      grid-template-rows: auto auto auto auto;
      gap: 10px;
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
      grid-template-columns: 1fr;
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

    .type-card {
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: var(--type-card-bg);
      padding: 14px 16px;
      margin-top: 0;
      min-height: 0;
      display: grid;
      gap: 12px;
    }

    .type-card-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
    }

    .type-copy {
      min-width: 0;
    }

    .type-name {
      margin: 0;
      font-family: "IBM Plex Sans KR", "Segoe UI Variable", "Noto Sans KR", sans-serif;
      font-size: 30px;
      font-weight: 700;
      line-height: 1.16;
      letter-spacing: -0.03em;
      word-break: keep-all;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 88px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid var(--status-border);
      background: var(--status-bg);
      color: var(--status-ink);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }

    .status-badge.is-reversed {
      border-color: rgba(183, 71, 42, 0.26);
      background: rgba(183, 71, 42, 0.12);
      color: #8f3c22;
    }

    .type-detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .type-reason-label {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }

    .type-reason {
      margin: 0;
      font-size: 13px;
      line-height: 1.6;
      color: var(--muted);
    }

    .detail-panel {
      border: 1px solid rgba(31, 42, 36, 0.10);
      border-radius: var(--radius-sm);
      background: rgba(255, 255, 255, 0.62);
      padding: 12px;
      display: grid;
      gap: 8px;
    }

    .detail-panel.is-reversed {
      border-color: var(--reversed-border);
      background: var(--reversed-bg);
      color: var(--reversed-ink);
    }

    .detail-panel.is-reversed .type-reason-label,
    .detail-panel.is-reversed .type-reason {
      color: var(--reversed-ink);
    }

    .type-actions {
      display: flex;
      justify-content: flex-start;
    }

    .grade-compare-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .grade-card {
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.72);
      padding: 12px;
    }

    .grade-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 6px;
    }

    .grade-axis {
      font-size: 15px;
      font-weight: 700;
    }

    .grade-badge {
      min-width: 42px;
      text-align: center;
      border-radius: 999px;
      padding: 4px 8px;
      background: var(--accent-soft);
      color: var(--accent-strong);
      font-weight: 700;
      font-size: 13px;
    }

    .grade-meta {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.55;
      margin-bottom: 6px;
    }

    .grade-reason {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.6;
      margin: 0;
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
      font-size: 21px;
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
      font-size: 15px;
      font-weight: 800;
      text-anchor: middle;
      cursor: help;
    }

    .radar-label-desc {
      fill: var(--muted);
      font-size: 15px;
      font-weight: 600;
      text-anchor: middle;
      pointer-events: none;
    }

    .radar-grade-label {
      fill: var(--muted);
      font-size: 13px;
      font-weight: 700;
      text-anchor: middle;
      pointer-events: none;
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
      left: 50%;
      top: 50%;
      min-width: 260px;
      max-width: 340px;
      pointer-events: none;
      background: rgba(24, 36, 31, 0.96);
      color: #f7f5ef;
      border-radius: 14px;
      padding: 14px 16px;
      box-shadow: 0 16px 32px rgba(19, 27, 24, 0.22);
      opacity: 0;
      transform: translate(-50%, calc(-50% + 6px));
      transition: opacity 140ms ease, transform 140ms ease;
      z-index: 20;
    }

    .radar-tooltip.is-visible {
      opacity: 1;
      transform: translate(-50%, -50%);
    }

    .tooltip-title {
      font-size: 18px;
      font-weight: 800;
      margin-bottom: 7px;
      line-height: 1.35;
    }

    .tooltip-sub {
      font-size: 17px;
      font-weight: 600;
      line-height: 1.45;
      color: rgba(247, 245, 239, 0.92);
      margin-bottom: 8px;
    }

    .tooltip-score {
      font-size: 17px;
      font-weight: 700;
      line-height: 1.35;
      margin-bottom: 8px;
    }

    .tooltip-text {
      font-size: 17px;
      font-weight: 600;
      line-height: 1.45;
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

    .viewer-topbar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 10px;
    }

    .viewer-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 14px;
    }

    .viewer-title {
      margin: 0;
      font-size: 24px;
      letter-spacing: -0.02em;
    }

    .viewer-subtitle {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 14px;
    }

    .modal-actions {
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }

    .viewer-week-popover {
      position: relative;
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
        display: grid;
        grid-template-rows: auto auto auto auto;
        gap: 10px;
        min-height: 100%;
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

    .hero-grid {
      grid-template-columns: minmax(360px, 430px) minmax(0, 1fr);
    }

    .hero-side {
      display: grid;
      grid-template-rows: auto auto auto auto;
      gap: 10px;
      min-height: 100%;
    }

    .type-card {
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: var(--type-card-bg);
      padding: 14px 16px;
      margin-top: 0;
      min-height: 0;
      justify-content: start;
      gap: 6px;
    }

    .type-kicker {
      margin: 0;
      margin-top: -2px;
    }

    .type-name {
      margin: 0;
      font-family: "IBM Plex Sans KR", "Segoe UI Variable", "Noto Sans KR", sans-serif;
      font-size: 30px;
      font-weight: 700;
      line-height: 1.16;
      letter-spacing: -0.03em;
    }

    .type-reason {
      margin: 0;
      font-size: 13px;
      line-height: 1.6;
      color: var(--muted);
    }

    .panel-head,
    .report-picker-header,
    .modal-actions {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: center;
      flex-wrap: wrap;
    }

    .helper-text {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }

    .toggle-button,
    .action-button,
    .modal-close {
      border: 1px solid var(--button-border);
      border-radius: 12px;
      background: var(--button-bg);
      color: var(--ink);
      padding: 9px 14px;
      font: inherit;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: var(--button-shadow);
      transition: border-color 140ms ease, background 140ms ease, color 140ms ease, transform 140ms ease;
    }

    .toggle-button:hover,
    .action-button:hover,
    .modal-close:hover {
      border-color: var(--button-hover-border);
      background: var(--button-hover-bg);
      transform: translateY(-1px);
    }

    .toggle-button.is-active,
    .toggle-button[aria-pressed='true'] {
      background: var(--button-active-bg);
      color: var(--button-active-ink);
      border-color: var(--button-active-border);
      box-shadow: none;
    }

    .toggle-button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      transform: none;
    }

    .action-button {
      background: var(--action-button-bg);
      color: var(--action-button-ink);
      border-color: var(--action-button-border);
    }

    .radar-actions {
      display: inline-flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .legend-item.is-hidden {
      opacity: 0.42;
    }

    .radar-point {
      transition: opacity 140ms ease, stroke-width 140ms ease;
      transform: none !important;
    }

    .radar-point:hover {
      transform: none !important;
      stroke-width: 3;
    }

    .report-picker-panel {
      position: relative;
    }

    .report-picker-popover {
      display: none;
      margin-top: 14px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.82);
    }

    .report-picker-popover.is-open {
      display: block;
    }

    .report-select {
      width: 100%;
      margin-top: 8px;
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.96);
      color: var(--ink);
      font: inherit;
    }

    .modal {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(25, 31, 28, 0.48);
      z-index: 40;
    }

    .modal.is-open {
      display: flex;
    }

    .modal-card {
      width: min(980px, 100%);
      max-height: min(88vh, 980px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 28px;
      background: rgba(255, 252, 246, 0.98);
      box-shadow: 0 30px 80px rgba(18, 25, 22, 0.22);
      padding: 22px;
    }

    .modal-body {
      margin-top: 0;
      overflow: auto;
      padding-right: 4px;
    }

    body.is-modal-open {
      overflow: hidden;
    }

    .page-title {
      margin: 0 0 12px;
      font-family: "Aptos Display", "Bahnschrift", sans-serif;
      font-size: clamp(38px, 4.8vw, 58px);
      font-weight: 700;
      line-height: 0.94;
      letter-spacing: -0.03em;
      color: #7b5819;
      max-width: 100%;
      white-space: normal;
      text-wrap: balance;
      text-shadow: 0 8px 22px rgba(123, 88, 25, 0.12);
    }

    .page-title span {
      display: inline;
      margin-left: 10px;
      color: #9c7424;
    }

    .hero-grid {
      grid-template-columns: minmax(0, 0.94fr) minmax(0, 1.06fr);
      align-items: stretch;
      gap: 10px;
    }

    .hero-side {
      display: grid;
      grid-template-rows: auto auto;
      gap: 10px;
      min-width: 0;
      min-height: 100%;
      align-content: start;
    }

    .hero-main {
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      gap: 10px;
      min-width: 0;
      min-height: 100%;
    }

    .type-card {
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: var(--type-card-bg);
      padding: 18px 20px;
      margin-top: 0;
      min-height: 0;
      justify-content: start;
      gap: 8px;
      box-shadow: var(--type-card-shadow);
    }

    .type-kicker {
      margin: 0 0 4px;
      font-size: 20px;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -0.02em;
      color: var(--ink);
    }

    .type-name {
      margin: 0 0 8px;
      font-family: "IBM Plex Sans KR", "Segoe UI Variable", "Noto Sans KR", sans-serif;
      font-size: 30px;
      font-weight: 700;
      line-height: 1.16;
      letter-spacing: -0.03em;
    }

    .type-reason {
      margin: 0;
      font-size: 14px;
      line-height: 1.75;
      color: var(--muted);
    }

    .grade-compare-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .grade-card {
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: var(--grade-card-bg);
      padding: 14px 15px;
      display: grid;
      gap: 12px;
      min-height: 128px;
      transition: background 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
    }

    .grade-card.is-up {
      background: rgba(242, 252, 244, 0.92);
      border-color: rgba(47, 125, 77, 0.26);
      box-shadow: 0 12px 24px rgba(47, 125, 77, 0.08);
    }

    .grade-card.is-down {
      background: rgba(246, 241, 238, 0.92);
      border-color: rgba(125, 96, 84, 0.22);
      box-shadow: 0 12px 24px rgba(92, 68, 59, 0.06);
    }

    .grade-card.is-same {
      background: var(--grade-card-same-bg);
    }

    .grade-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
      margin: 0;
    }

    .grade-axis {
      font-size: 15px;
      font-weight: 700;
      line-height: 1.4;
    }

    .grade-delta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 56px;
      padding: 5px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
      background: rgba(31, 42, 36, 0.06);
      color: var(--muted);
      white-space: nowrap;
    }

    .grade-card.is-up .grade-delta {
      background: rgba(47, 125, 77, 0.12);
      color: #24623c;
    }

    .grade-card.is-down .grade-delta {
      background: rgba(125, 96, 84, 0.12);
      color: #7d6054;
    }

    .grade-values {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      align-items: stretch;
    }

    .grade-value-box {
      border-radius: 12px;
      border: 1px solid rgba(31, 42, 36, 0.08);
      background: rgba(255, 255, 255, 0.72);
      padding: 10px 10px 9px;
      display: grid;
      gap: 4px;
      min-height: 74px;
    }

    .grade-value-label {
      font-size: 11px;
      color: var(--muted);
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .grade-value-main {
      display: inline-flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      line-height: 1;
    }

    .grade-letter {
      font-size: 29px;
      font-weight: 800;
      letter-spacing: -0.04em;
      color: var(--ink);
    }

    .grade-score {
      font-size: 12px;
      color: var(--muted);
      font-weight: 700;
    }

    .grade-card.is-up .grade-value-box.is-current {
      border-color: rgba(47, 125, 77, 0.24);
      background: rgba(244, 252, 246, 0.94);
    }

    .grade-card.is-up .grade-value-box.is-current .grade-letter {
      color: #24623c;
    }

    .grade-card.is-down .grade-value-box.is-current {
      border-color: rgba(125, 96, 84, 0.18);
      background: rgba(250, 245, 243, 0.94);
    }

    .grade-card.is-down .grade-value-box.is-current .grade-letter {
      color: #7d6054;
    }

    .grade-card.is-same .grade-value-box.is-current {
      border-color: var(--grade-card-same-border);
      background: var(--grade-card-same-current-bg);
    }

    .grade-card.is-same .grade-value-box.is-current .grade-letter {
      color: var(--grade-card-same-ink);
    }

    .grade-note {
      font-size: 12px;
      line-height: 1.45;
      color: var(--muted);
    }

    #grade-compare-panel h2,
    .report-picker-panel h2 {
      margin-bottom: 10px;
    }

    .radar-square {
      min-height: 360px;
      aspect-ratio: 4 / 3;
      padding: 4px;
      width: min(100%, 640px);
      margin: 0 auto;
      background: var(--radar-surface-bg);
    }

    .legend {
      margin-top: 10px;
      gap: 8px 12px;
      font-size: 13px;
    }

    .legend-note {
      margin-top: 8px;
      font-size: 12px;
      line-height: 1.45;
    }

    .report-picker-panel {
      background: var(--picker-panel-bg);
    }

    .report-picker-panel-bottom {
      display: grid;
      grid-template-columns: minmax(150px, 220px) minmax(0, 1fr);
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
    }

    .report-picker-panel-bottom h2 {
      margin: 0;
      font-size: 18px;
      line-height: 1.25;
    }

    .report-select {
      margin-top: 0;
      padding: 10px 12px;
      font-size: 14px;
      background: var(--picker-field-bg);
      border-color: var(--picker-field-border);
    }

    .chip-button {
      background: var(--action-button-bg);
      color: var(--action-button-ink);
      border-color: var(--action-button-border);
    }

    .viewer-week-list {
      display: none;
      position: absolute;
      right: 0;
      top: calc(100% + 10px);
      width: min(340px, 72vw);
      max-height: 360px;
      overflow-y: auto;
      padding: 12px;
      gap: 10px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--week-list-bg);
      box-shadow: 0 20px 40px rgba(22, 28, 24, 0.14);
      z-index: 8;
    }

    .viewer-week-list.is-open {
      display: grid;
    }

    .viewer-week-button {
      border: 1px solid var(--week-button-border);
      border-radius: 12px;
      background: var(--week-button-bg);
      color: var(--ink);
      padding: 8px 12px;
      font: inherit;
      font-size: 14px;
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease;
    }

    .viewer-week-button:hover,
    .viewer-week-button.is-active {
      background: var(--week-button-hover-bg);
      border-color: var(--week-button-hover-border);
    }

    .detail-stack {
      display: grid;
      gap: 18px;
    }

    .detail-section {
      display: grid;
      gap: 10px;
    }

    .detail-card {
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.74);
      padding: 16px 18px;
    }

    .detail-diagnosis {
      font-size: 18px;
      line-height: 1.72;
      color: var(--ink);
      margin: 0;
    }

    .detail-type-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .detail-type-card {
      border: 1px solid rgba(31, 42, 36, 0.10);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.64);
      padding: 12px 14px;
      display: grid;
      gap: 8px;
    }

    .detail-type-card.is-reversed {
      border-color: var(--reversed-border);
      background: var(--reversed-bg);
    }

    .detail-mini-label {
      margin: 0;
      color: var(--muted);
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }

    .detail-type-name {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      line-height: 1.25;
    }

    .detail-type-copy {
      margin: 0;
      font-size: 18px;
      line-height: 1.68;
      color: var(--muted);
    }

    .detail-table-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.68);
    }

    .detail-summary-table,
    .detail-evaluation-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    .detail-summary-table th,
    .detail-summary-table td,
    .detail-evaluation-table th,
    .detail-evaluation-table td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      font-size: 18px;
      text-align: left;
    }

    .detail-summary-table tbody tr:last-child th,
    .detail-summary-table tbody tr:last-child td,
    .detail-evaluation-table tbody tr:last-child td {
      border-bottom: none;
    }

    .detail-summary-table th {
      width: 32%;
      color: var(--muted);
      font-size: 18px;
      font-weight: 700;
      background: rgba(15, 118, 110, 0.06);
    }

    .detail-summary-table td {
      width: 68%;
      line-height: 1.65;
      background: rgba(255, 255, 255, 0.70);
    }

    .detail-evaluation-table th {
      background: rgba(15, 118, 110, 0.08);
      color: var(--muted);
      font-size: 18px;
      font-weight: 700;
    }

    .detail-evaluation-table th:nth-child(1),
    .detail-evaluation-table td:nth-child(1) {
      width: 18%;
    }

    .detail-evaluation-table th:nth-child(2),
    .detail-evaluation-table td:nth-child(2) {
      width: 12%;
      text-align: center;
    }

    .detail-evaluation-table th:nth-child(3),
    .detail-evaluation-table td:nth-child(3) {
      width: 12%;
      text-align: center;
    }

    .detail-evaluation-table th:nth-child(4),
    .detail-evaluation-table td:nth-child(4) {
      width: 58%;
    }

    .detail-grade-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 34px;
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--badge-neutral-bg);
      color: var(--badge-neutral-ink);
      font-weight: 700;
    }

    .reason-main,
    .reason-meta {
      display: block;
      line-height: 1.65;
    }

    .reason-meta {
      margin-top: 4px;
      color: var(--muted);
      font-size: 18px;
    }

    .detail-action-list {
      margin: 0;
      padding-left: 20px;
      display: grid;
      gap: 10px;
    }

    .detail-action-list li {
      line-height: 1.7;
      font-size: 18px;
      color: var(--ink);
    }

    .detail-action-main {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
      line-height: 1.55;
      color: var(--ink);
    }

    .detail-action-sub {
      margin: 6px 0 0;
      font-size: 18px;
      line-height: 1.65;
      color: var(--muted);
    }

    .guide-intro {
      margin: 0;
      font-size: 15px;
      line-height: 1.7;
      color: var(--muted);
    }

    .guide-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 16px;
    }

    .guide-card {
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.74);
      padding: 14px 15px;
      display: grid;
      gap: 8px;
    }

    .guide-card h3 {
      margin: 0;
      font-size: 18px;
      line-height: 1.35;
    }

    .guide-card p {
      margin: 0;
      font-size: 15px;
      line-height: 1.65;
      color: var(--muted);
    }

    @media (max-width: 980px) {
      .hero-grid {
        grid-template-columns: 1fr;
      }

      .hero-main {
        gap: 16px;
      }

      .grade-compare-grid {
        grid-template-columns: 1fr;
      }

      .report-picker-panel-bottom {
        grid-template-columns: 1fr;
      }

      .page-title {
        white-space: normal;
      }
    }

    @media (max-width: 640px) {
      .page-title {
        white-space: normal;
        font-size: 36px;
      }

      .page-title span {
        display: block;
        margin-left: 0;
        margin-top: 6px;
      }

      .detail-type-grid,
      .guide-grid {
        grid-template-columns: 1fr;
      }

      .type-detail-grid {
        grid-template-columns: 1fr;
      }

      .radar-square {
        min-height: 300px;
      }

      .viewer-topbar {
        justify-content: flex-start;
      }

      .viewer-week-list {
        width: min(100%, 320px);
        max-height: 300px;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="page-title">Growth Experience Review <span>(G.E.R)</span></div>
      <div class="hero-grid">
        <div class="hero-side">
          <section class="type-card">
            <div class="type-card-head">
              <div class="type-copy">
                <div class="summary-label type-kicker">이번 주 대표 타입</div>
                <h2 class="type-name" id="type-name"></h2>
              </div>
              <span class="status-badge" id="type-status-badge"></span>
            </div>
            <div class="type-detail-grid">
              <div class="detail-panel">
                <p class="type-reason-label">Type Reason</p>
                <p class="type-reason" id="type-reason"></p>
              </div>
              <div class="detail-panel" id="reversed-panel">
                <p class="type-reason-label">Reversed</p>
                <p class="type-reason" id="reversed-reason"></p>
              </div>
            </div>
            <div class="type-actions">
              <button class="chip chip-button" type="button" id="profile-guide-button">타입 기준 참고</button>
            </div>
          </section>

          <section class="panel" id="grade-compare-panel">
            <h2>축별 등급 비교</h2>
            <div class="grade-compare-grid" id="grade-compare-grid"></div>
          </section>
        </div>

        <div class="hero-main">
          <section class="panel radar-panel">
            <div class="panel-head">
              <h2>6축 비교 그래프</h2>
              <div class="radar-actions">
                <button class="toggle-button is-active" type="button" data-overlay="current" aria-pressed="true">이번주</button>
                <button class="toggle-button" type="button" data-overlay="previous" aria-pressed="false">지난주</button>
                <button class="toggle-button" type="button" data-overlay="average" aria-pressed="false">전체평균</button>
                <button class="action-button" type="button" id="details-button">자세히보기</button>
              </div>
            </div>
            <div class="radar-square" id="radar-wrap">
              <svg id="radar-chart" viewBox="0 0 360 360" aria-label="6-axis comparison radar chart"></svg>
              <div class="radar-tooltip" id="radar-tooltip"></div>
            </div>
            <div class="legend" id="radar-legend"></div>
            <p class="legend-note">이번주, 지난주, 전체평균을 각각 켜고 끌 수 있습니다. 축 라벨 툴팁은 축 이름과 의미(description)를, 점 툴팁은 등급·점수와 기준 문장을 보여줍니다.</p>
          </section>

          <section class="panel report-picker-panel report-picker-panel-bottom">
            <h2>과거 리포트</h2>
            <select class="report-select" id="report-select"></select>
          </section>

        </div>
      </div>    </section>
  </div>

  <div class="modal" id="report-modal" aria-hidden="true">
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="viewer-title">
      <div class="viewer-topbar">
        <div class="modal-actions">
          <div class="viewer-week-popover">
            <button class="chip chip-button" type="button" id="viewer-week-toggle" aria-expanded="false">과거자료보기</button>
            <div class="viewer-week-list" id="viewer-week-list"></div>
          </div>
          <button class="modal-close" type="button" id="details-close">닫기</button>
        </div>
      </div>
      <div class="viewer-head">
        <div>
          <h2 class="viewer-title" id="viewer-title"></h2>
          <p class="viewer-subtitle" id="viewer-subtitle"></p>
        </div>
      </div>
      <article class="markdown-body modal-body" id="report-viewer"></article>
    </div>
  </div>

  <div class="modal" id="profile-guide-modal" aria-hidden="true">
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="profile-guide-title">
      <div class="viewer-topbar">
        <div class="modal-actions">
          <button class="modal-close" type="button" id="profile-guide-close">닫기</button>
        </div>
      </div>
      <div class="viewer-head">
        <div>
          <h2 class="viewer-title" id="profile-guide-title">타입 기준 참고</h2>
          <p class="viewer-subtitle">대표 타입은 요약 레이블이고, Reversed는 경고 상태입니다.</p>
        </div>
      </div>
      <article class="markdown-body modal-body" id="profile-guide-viewer"></article>
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

    function gradeRank(grade) {
      return { E: 0, D: 1, C: 2, B: 3, A: 4 }[grade] ?? 0;
    }

    function resolveMarkdownUrl(url, basePath = '') {
      const raw = String(url ?? '').trim();

      if (!raw || /^(?:[a-z]+:)?\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('/')) {
        return raw;
      }

      const segments = String(basePath ?? '')
        .split('/')
        .slice(0, -1)
        .filter(Boolean);

      for (const part of raw.split('/')) {
        if (!part || part === '.') {
          continue;
        }

        if (part === '..') {
          segments.pop();
          continue;
        }

        segments.push(part);
      }

      return segments.join('/');
    }

    function inlineMarkdown(text, basePath = '') {
      const codeToken = String.fromCharCode(96);
      return escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(new RegExp(codeToken + '([^' + codeToken + ']+)' + codeToken, 'g'), '<code>$1</code>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => '<a href="' + escapeHtml(resolveMarkdownUrl(url, basePath)) + '">' + label + '</a>');
    }

    function renderMarkdown(markdown, basePath = '') {
      const lines = markdown.replace(/\r\n/g, '\n').split('\n');
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
          .map((line) => line.split('|').slice(1, -1).map((cell) => inlineMarkdown(cell.trim(), basePath)));

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
          html += '<p>' + inlineMarkdown(paragraph.join(' '), basePath) + '</p>';
          paragraph = [];
        }
      };

      const flushList = () => {
        if (listItems.length) {
          html += '<' + listType + '>' + listItems.map((item) => '<li>' + inlineMarkdown(item, basePath) + '</li>').join('') + '</' + listType + '>';
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
          html += '<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>';
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

        const image = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (image) {
          flushParagraph();
          flushList();

          continue;
        }

        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
          flushParagraph();
          flushList();
          html += '<h' + heading[1].length + '>' + inlineMarkdown(heading[2].trim(), basePath) + '</h' + heading[1].length + '>';
          continue;
        }

        const bullet = line.match(/^-\s+(.+)$/);
        if (bullet) {
          flushParagraph();
          if (listType && listType !== 'ul') {
            flushList();
          }
          listType = 'ul';
          listItems.push(bullet[1].trim());
          continue;
        }

        const ordered = line.match(/^\d+\.\s+(.+)$/);
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

    function findReportSection(report, headingCandidates) {
      return (report.sections ?? []).find((section) => headingCandidates.includes(section.heading));
    }

    function getStrengthActionByAxis(axisKey) {
      const map = {
        clarity: '요청 시작 문장을 "목표·완료조건·제약" 3요소로 고정해 같은 수준의 명확성을 반복 재현합니다.',
        context_provision: '작업 시작 전에 경로·참고파일·현재상태를 체크리스트로 고정해 재설명 비용을 줄입니다.',
        procedure_design: '작업을 단계화하고 각 단계 종료 기준을 먼저 선언해 안정적인 실행 흐름을 유지합니다.',
        verifiability: '완료 보고를 "검증완료/미검증/잔여리스크" 3단 구조로 고정해 검증 품질을 끌어올립니다.',
        recovery: '막힘 발생 시 원인 1줄, 대안 2개, 선택 1개 형식으로 복구 루프를 짧게 반복합니다.',
        retrospective_continuity: '주간 회고 루틴을 고정 시간에 실행하고 전주 대비 개선 지표를 1~2개 추적합니다.',
      };

      return map[axisKey] ?? '현재 강점을 유지할 수 있도록 동일한 작업 템플릿과 점검 루틴을 반복 적용합니다.';
    }

    function getImprovementActionByAxis(axisKey) {
      const map = {
        clarity: '요청문 첫 줄에 산출물 형식과 완료 조건을 함께 명시해 해석 오차를 줄입니다.',
        context_provision: '참고 파일·환경 정보·현 상태를 함께 제공해 초기 탐색 시간을 단축합니다.',
        procedure_design: '수정 전 계획(읽기→수정→검증)을 짧게 선언하고 단계별 결과를 확인합니다.',
        verifiability: '검증 명령, 기대 결과, 실패 시 해석 기준을 세트로 제시해 검증력을 높입니다.',
        recovery: '실패 시 즉시 우회안을 병렬로 제시하고 다음 선택을 빠르게 확정합니다.',
        retrospective_continuity: '주차별 개선 목표를 하나로 좁혀 누적 개선이 끊기지 않도록 운영합니다.',
      };

      return map[axisKey] ?? '낮은 축은 작은 실험 단위로 쪼개어 매주 반복 개선하는 방식으로 보완합니다.';
    }

    function renderSummaryTable(report) {
      const items = report.summaryItems ?? [];

      if (!items.length) {
        return '';
      }

      return '<section class="detail-section">' +
        '<h2>이번 주 활동 요약</h2>' +
        '<div class="detail-table-wrap">' +
          '<table class="detail-summary-table"><tbody>' +
            items.map((item) =>
              '<tr>' +
                '<th>' + escapeHtml(item.label) + '</th>' +
                '<td>' + inlineMarkdown(item.value, report.filePath) + '</td>' +
              '</tr>'
            ).join('') +
          '</tbody></table>' +
        '</div>' +
      '</section>';
    }

    function renderDetailTypeSection(report) {
      const profile = report.compositeType ?? {};
      const statusLabel = profile.reversedActive ? (profile.reversedLabel ?? 'Reversed') : 'Normal';
      const reversedClass = profile.reversedActive ? ' is-reversed' : '';

      return '<section class="detail-section">' +
        '<h2>타입 판정</h2>' +
        '<div class="detail-type-grid">' +
          '<div class="detail-card">' +
            '<p class="detail-mini-label">대표 타입</p>' +
            '<p class="detail-type-name">' + escapeHtml((profile.name ?? 'Fool') + (profile.subtitle ? ' - ' + profile.subtitle : '')) + '</p>' +
            '<p class="detail-type-copy">' + escapeHtml(profile.typeReason ?? '타입 판정 근거가 없습니다.') + '</p>' +
          '</div>' +
          '<div class="detail-type-card' + reversedClass + '">' +
            '<p class="detail-mini-label">Reversed</p>' +
            '<p class="detail-type-name">' + escapeHtml(statusLabel) + '</p>' +
            '<p class="detail-type-copy">' + escapeHtml(profile.reversedReason ?? '해당 없음') + '</p>' +
          '</div>' +
        '</div>' +
      '</section>';
    }

    function renderEvaluationTable(report) {
      return '<section class="detail-section">' +
        '<h2>6축 평가 결과</h2>' +
        '<div class="detail-table-wrap">' +
          '<table class="detail-evaluation-table">' +
            '<thead><tr><th>평가축</th><th>점수</th><th>등급</th><th>판정 사유</th></tr></thead>' +
            '<tbody>' +
              (report.scores ?? []).map((axis) => {
                const reasonText = axis.meaning || axis.criterion || '';
                return '<tr>' +
                  '<td>' + escapeHtml(axis.label) + '</td>' +
                  '<td>' + escapeHtml(String(axis.score)) + '</td>' +
                  '<td><span class="detail-grade-badge">' + escapeHtml(axis.grade) + '</span></td>' +
                  '<td>' +
                    '<span class="reason-main">' + escapeHtml(reasonText) + '</span>' +
                  '</td>' +
                '</tr>';
              }).join('') +
            '</tbody>' +
          '</table>' +
        '</div>' +
      '</section>';
    }

    function renderStrengthDetail(report) {
      const strongest = [...(report.scores ?? [])]
        .sort((left, right) => right.score - left.score)
        .slice(0, 3);

      if (!strongest.length) {
        return '';
      }

      return '<section class="detail-section">' +
        '<h2>강점축 상세</h2>' +
        '<div class="detail-card">' +
          '<ol class="detail-action-list">' +
            strongest.map((axis) =>
              '<li>' +
                '<p class="detail-action-main"><strong>' + escapeHtml(axis.label) + '</strong> (' + escapeHtml(axis.grade) + ', ' + escapeHtml(String(axis.score)) + '점)</p>' +
                '<p class="detail-action-sub">' + escapeHtml('현재 상태: ' + (axis.meaning || axis.description || '데이터 없음')) + '</p>' +
                '<p class="detail-action-sub">' + escapeHtml('강화 전략: ' + getStrengthActionByAxis(axis.key)) + '</p>' +
              '</li>'
            ).join('') +
          '</ol>' +
        '</div>' +
      '</section>';
    }

    function renderWeaknessDetail(report) {
      const weakest = [...(report.scores ?? [])]
        .sort((left, right) => left.score - right.score)
        .slice(0, 3);

      if (!weakest.length) {
        return '';
      }

      return '<section class="detail-section">' +
        '<h2>보완필요축 상세</h2>' +
        '<div class="detail-card">' +
          '<ol class="detail-action-list">' +
            weakest.map((axis) =>
              '<li>' +
                '<p class="detail-action-main"><strong>' + escapeHtml(axis.label) + '</strong> (' + escapeHtml(axis.grade) + ', ' + escapeHtml(String(axis.score)) + '점)</p>' +
                '<p class="detail-action-sub">' + escapeHtml('목표 기준: ' + (axis.criterion || axis.description || '기준 없음')) + '</p>' +
                '<p class="detail-action-sub">' + escapeHtml('보완 전략: ' + getImprovementActionByAxis(axis.key)) + '</p>' +
              '</li>'
            ).join('') +
          '</ol>' +
        '</div>' +
      '</section>';
    }

    function renderRemainingSections(report) {
      const hiddenHeadings = new Set(['한 줄 진단', '이번 주 활동 요약', '타입 판정', '종합 타입', '6축 평가 결과', '타입 기준 참고']);

      return (report.sections ?? [])
        .filter((section) => !hiddenHeadings.has(section.heading))
        .map((section) => {
          if (section.heading === '강점 축 요약' || section.heading === '강점축 상세') {
            return renderStrengthDetail(report);
          }

          if (section.heading === '보완 필요 축 요약' || section.heading === '보완필요축 상세') {
            return renderWeaknessDetail(report);
          }

          return '<section class="detail-section">' +
            '<h2>' + escapeHtml(section.heading) + '</h2>' +
            renderMarkdown(section.body, report.filePath) +
          '</section>';
        })
        .join('');
    }

    function renderReportDetail(report) {
      return '<div class="detail-stack">' +
        '<section class="detail-section">' +
          '<h2>한 줄 진단</h2>' +
          '<div class="detail-card">' +
            '<p class="detail-diagnosis">' + escapeHtml(report.headline || '주간 상세 진단이 없습니다.') + '</p>' +
          '</div>' +
        '</section>' +
        renderDetailTypeSection(report) +
        renderSummaryTable(report) +
        renderEvaluationTable(report) +
        renderRemainingSections(report) +
      '</div>';
    }

    function renderProfileGuide() {
      const viewer = document.getElementById('profile-guide-viewer');
      const guide = data.profileGuide ?? { intro: [], reversed: {}, types: [] };

      viewer.innerHTML =
        guide.intro.map((line) => '<p class="guide-intro">' + escapeHtml(line) + '</p>').join('') +
        '<div class="detail-card">' +
          '<p class="detail-mini-label">' + escapeHtml(guide.reversed?.label ?? 'Reversed') + '</p>' +
          '<p class="detail-type-copy">' + escapeHtml(guide.reversed?.description ?? '') + '</p>' +
        '</div>' +
        '<div class="guide-grid">' +
          (guide.types ?? []).map((type) =>
            '<article class="guide-card">' +
              '<h3>' + escapeHtml(type.name + ' - ' + type.subtitle) + '</h3>' +
              '<p>' + escapeHtml(type.description) + '</p>' +
            '</article>'
          ).join('') +
        '</div>';
    }

        const state = {
      selectedWeek: data.latestWeek || data.reports[0]?.weekKey || '',
      showCurrent: true,
      showPrevious: false,
      showAverage: false,
    };

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


    function getWeekRange(weekKey) {
      const match = String(weekKey).match(/^(\d{4})-W(\d{2})$/);
      if (!match) {
        return null;
      }

      const year = Number.parseInt(match[1], 10);
      const week = Number.parseInt(match[2], 10);
      const jan4 = new Date(Date.UTC(year, 0, 4));
      const jan4Day = jan4.getUTCDay() || 7;
      const start = new Date(jan4);
      start.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + ((week - 1) * 7));
      const end = new Date(start);
      end.setUTCDate(start.getUTCDate() + 6);
      return { start, end };
    }

    function formatShortDate(date) {
      const year = String(date.getUTCFullYear()).slice(-2);
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return year + month + day;
    }

    function getWeekRangeLabel(weekKey) {
      const range = getWeekRange(weekKey);
      if (!range) {
        return '';
      }
      return formatShortDate(range.start) + '~' + formatShortDate(range.end);
    }

    function formatWeekLabel(weekKey) {
      const rangeLabel = getWeekRangeLabel(weekKey);
      return rangeLabel ? weekKey + ' (' + rangeLabel + ')' : weekKey;
    }

    function getThemeKey(profileName) {
      const normalized = String(profileName ?? '').trim().toLowerCase();

      if (normalized === 'hierophant') {
        return 'hierophant';
      }

      if (normalized === 'magician') {
        return 'magician';
      }

      if (normalized === 'star') {
        return 'star';
      }

      if (normalized === 'hermit') {
        return 'hermit';
      }

      if (normalized === 'chariot') {
        return 'chariot';
      }

      return 'fool';
    }

    function applyPageTheme(report) {
      const profile = report.compositeType ?? {};
      const themeKey = getThemeKey(profile.name);
      document.body.setAttribute('data-profile-theme', themeKey);
    }

    function renderTypeCard(report) {
      const profile = report.compositeType ?? {};
      const typeNameNode = document.getElementById('type-name');
      const reasonNode = document.getElementById('type-reason');
      const badgeNode = document.getElementById('type-status-badge');
      const reversedPanel = document.getElementById('reversed-panel');
      const reversedReasonNode = document.getElementById('reversed-reason');

      const typeName = profile.name ?? 'Fool';
      const typeSubtitle = profile.subtitle ? ' - ' + profile.subtitle : '';
      typeNameNode.textContent = typeName + typeSubtitle;

      reasonNode.textContent = profile.typeReason ?? '타입 판정 근거가 없습니다.';

      const statusLabel = profile.reversedActive ? (profile.reversedLabel ?? 'Reversed') : 'Normal';
      badgeNode.textContent = statusLabel;
      badgeNode.classList.toggle('is-reversed', Boolean(profile.reversedActive));

      reversedReasonNode.textContent = profile.reversedReason ?? '해당 없음';
      reversedPanel.classList.toggle('is-reversed', Boolean(profile.reversedActive));
    }

    function renderGradeCompare(report, previousReport) {
      const grid = document.getElementById('grade-compare-grid');
      const previousByKey = Object.fromEntries((previousReport?.scores ?? []).map((axis) => [axis.key, axis]));

      grid.innerHTML = report.scores.map((axis) => {
        const previous = previousByKey[axis.key];
        const delta = previous ? gradeRank(axis.grade) - gradeRank(previous.grade) : 0;
        const trendClass = previous ? (delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : 'is-same') : 'is-same';
        const deltaText = previous
          ? (delta > 0 ? '상승' : delta < 0 ? '하락' : '유지')
          : '신규';

        const currentBlock = '<div class="grade-value-box is-current">' +
          '<div class="grade-value-label">이번 주</div>' +
          '<div class="grade-value-main">' +
            '<div class="grade-letter">' + escapeHtml(axis.grade) + '</div>' +
            '<div class="grade-score">(' + escapeHtml(String(axis.score)) + ')</div>' +
          '</div>' +
        '</div>';

        const previousBlock = '<div class="grade-value-box">' +
          '<div class="grade-value-label">지난주</div>' +
          '<div class="grade-value-main">' +
            '<div class="grade-letter">' + escapeHtml(previous ? previous.grade : '-') + '</div>' +
            '<div class="grade-score">(' + escapeHtml(previous ? String(previous.score) : '-') + ')</div>' +
          '</div>' +
        '</div>';

        return '<article class="grade-card ' + trendClass + '">' +
          '<div class="grade-head">' +
            '<div class="grade-axis">' + escapeHtml(axis.label) + '</div>' +
            '<div class="grade-delta">' + escapeHtml(deltaText) + '</div>' +
          '</div>' +
          '<div class="grade-values">' +
            currentBlock +
            previousBlock +
          '</div>' +
        '</article>';
      }).join('');
    }

    function setReportPickerOpen(isOpen) {
      return isOpen;
    }

    function renderReportPicker() {
      const select = document.getElementById('report-select');
      const activeReport = getReportByWeek(state.selectedWeek);

      select.innerHTML = data.reports.map((report) =>
        '<option value="' + escapeHtml(report.weekKey) + '">' + escapeHtml(formatWeekLabel(report.weekKey)) + '</option>'
      ).join('');
      select.value = activeReport.weekKey;
    }

    function renderLegend(report, hasPrevious) {
      const container = document.getElementById('radar-legend');
      const items = [
        { label: '이번주', color: 'var(--compare-current)', hidden: !state.showCurrent },
        { label: '지난주', color: 'var(--compare-previous)', hidden: !(hasPrevious && state.showPrevious) },
        { label: '전체평균', color: 'var(--compare-average)', hidden: !state.showAverage },
      ];

      container.innerHTML = items.map((item) =>
        '<span class="legend-item' + (item.hidden ? ' is-hidden' : '') + '">' +
          '<span class="legend-dot" style="background:' + item.color + ';"></span>' +
          escapeHtml(item.label) +
        '</span>'
      ).join('');
    }

    function syncOverlayButtons(hasPrevious) {
      if (!hasPrevious) {
        state.showPrevious = false;
      }

      document.querySelectorAll('.toggle-button').forEach((button) => {
        const overlay = button.getAttribute('data-overlay');
        const isPrevious = overlay === 'previous';
        const isDisabled = isPrevious && !hasPrevious;
        const isActive = overlay === 'current'
          ? state.showCurrent
          : overlay === 'previous'
            ? state.showPrevious
            : state.showAverage;
        button.disabled = isDisabled;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-pressed', String(isActive && !isDisabled));
      });
    }

    function getRadarGeometry() {
      return { center: 180, radius: 110 };
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

    function showTooltip(payload) {
      const tooltip = document.getElementById('radar-tooltip');

      if (payload.mode === 'label') {
        tooltip.innerHTML =
          '<div class="tooltip-title">' + escapeHtml(payload.label) + '</div>' +
          '<div class="tooltip-sub">' + escapeHtml(payload.description || '') + '</div>';
      } else {
        tooltip.innerHTML =
          '<div class="tooltip-title">' + escapeHtml(payload.series) + '</div>' +
          '<div class="tooltip-score">' + escapeHtml(payload.grade || '-') + ' / ' + escapeHtml(String(payload.score)) + '점</div>' +
          '<div class="tooltip-text">' + escapeHtml(payload.criterion || '') + '</div>';
      }
      tooltip.classList.add('is-visible');
    }

    function hideTooltip() {
      document.getElementById('radar-tooltip').classList.remove('is-visible');
    }

    function renderRadarChart(report, previousReport) {
      const svg = document.getElementById('radar-chart');
      const currentScores = report.scores;
      const previousScores = previousReport?.scores ?? [];
      const averageScores = data.overallAverageScores;
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
        const point = polarToCartesian(center, radius + 14, index, total);
        return '<g class="radar-label-group">' +
          '<text class="radar-label" data-label="' + escapeHtml(item.label) + '" data-description="' + escapeHtml(item.description || item.meaning || '') + '" data-criterion="' + escapeHtml(item.criterion || item.meaning || '') + '" x="' + point.x.toFixed(2) + '" y="' + point.y.toFixed(2) + '">' + escapeHtml(item.label) + '</text>' +
          '<text class="radar-grade-label" x="' + point.x.toFixed(2) + '" y="' + (point.y + 13).toFixed(2) + '">' + escapeHtml(item.grade || '-') + '</text>' +
        '</g>';
      }).join('');

      const levelLabels = levels.map((level, index) => {
        const y = center - radius * (level / 100);
        return '<text class="radar-level" x="' + (center + 8).toFixed(2) + '" y="' + (y + 4).toFixed(2) + '">' + levels[index] + '</text>';
      }).join('');

      const hasPrevious = Array.isArray(previousScores) && previousScores.length === total;
      const datasets = [
        state.showCurrent
          ? { title: '이번주', color: 'var(--compare-current)', scores: currentScores, width: 2.8, fillOpacity: 0.16, pointRadius: 5.5 }
          : null,
        state.showPrevious && hasPrevious
          ? { title: '지난주', color: 'var(--compare-previous)', scores: previousScores, width: 2.2, fillOpacity: 0.10, pointRadius: 4.8 }
          : null,
        state.showAverage
          ? { title: '전체평균', color: 'var(--compare-average)', scores: averageScores, width: 2, fillOpacity: 0.06, pointRadius: 4.4 }
          : null,
      ].filter(Boolean);

      let markup = grid + axes + levelLabels + labels;

      for (const dataset of datasets) {
        const points = polygonPoints(dataset.scores, radius);
        markup += '<polygon class="radar-shape" style="fill:' + dataset.color + ';stroke:' + dataset.color + ';fill-opacity:' + dataset.fillOpacity + ';stroke-width:' + dataset.width + ';" points="' + pointsToString(points) + '"></polygon>';
        markup += points.map((point, index) => {
          const item = dataset.scores[index];
          return '<circle class="radar-point" data-series="' + escapeHtml(dataset.title) + '" data-score="' + escapeHtml(String(item.score)) + '" data-grade="' + escapeHtml(item.grade || '') + '" data-criterion="' + escapeHtml(item.criterion || item.meaning || '') + '" cx="' + point.x.toFixed(2) + '" cy="' + point.y.toFixed(2) + '" r="' + dataset.pointRadius + '" fill="' + dataset.color + '" stroke="#ffffff" stroke-width="2"></circle>';
        }).join('');
      }

      svg.innerHTML = markup;
      renderLegend(report, hasPrevious);
      syncOverlayButtons(hasPrevious);

      svg.querySelectorAll('.radar-label').forEach((node) => {
        const payload = {
          mode: 'label',
          label: node.getAttribute('data-label'),
          description: node.getAttribute('data-description'),
          criterion: node.getAttribute('data-criterion'),
        };

        node.addEventListener('mouseenter', () => showTooltip(payload));
        node.addEventListener('mousemove', () => showTooltip(payload));
        node.addEventListener('mouseleave', hideTooltip);
      });

      svg.querySelectorAll('.radar-point').forEach((node) => {
        const payload = {
          mode: 'point',
          series: node.getAttribute('data-series'),
          score: node.getAttribute('data-score'),
          grade: node.getAttribute('data-grade'),
          criterion: node.getAttribute('data-criterion'),
        };

        node.addEventListener('mouseenter', () => showTooltip(payload));
        node.addEventListener('mousemove', () => showTooltip(payload));
        node.addEventListener('mouseleave', hideTooltip);
      });
    }

    function renderReportModal(report) {
      const viewer = document.getElementById('report-viewer');
      const title = document.getElementById('viewer-title');
      const subtitle = document.getElementById('viewer-subtitle');
      const toggle = document.getElementById('viewer-week-toggle');

      title.textContent = formatWeekLabel(report.weekKey) + ' 리포트';
      subtitle.textContent = '주간 상세 리포트';
      toggle.textContent = '과거자료보기';
      viewer.innerHTML = renderReportDetail(report);
      renderViewerWeekList();
    }


    function setViewerWeekListOpen(isOpen) {
      const list = document.getElementById('viewer-week-list');
      const toggle = document.getElementById('viewer-week-toggle');
      list.classList.toggle('is-open', isOpen);
      toggle.setAttribute('aria-expanded', String(isOpen));
    }

    function renderViewerWeekList() {
      const list = document.getElementById('viewer-week-list');
      list.innerHTML = data.reports.map((report) =>
        '<button class="viewer-week-button' + (report.weekKey === state.selectedWeek ? ' is-active' : '') + '" type="button" data-week="' + escapeHtml(report.weekKey) + '">' +
          escapeHtml(formatWeekLabel(report.weekKey)) +
        '</button>'
      ).join('');

      list.querySelectorAll('.viewer-week-button').forEach((button) => {
        button.addEventListener('click', () => {
          renderReport(button.getAttribute('data-week'));
          setViewerWeekListOpen(false);
          openModal();
        });
      });
    }
    function openModal(modalId = 'report-modal') {
      const modal = document.getElementById(modalId);
      modal.classList.add('is-open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('is-modal-open');
    }

    function closeModal(modalId = 'report-modal') {
      const modal = document.getElementById(modalId);
      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
      const anyModalOpen = Array.from(document.querySelectorAll('.modal')).some((item) => item.classList.contains('is-open'));
      document.body.classList.toggle('is-modal-open', anyModalOpen);
    }

    function renderReport(weekKey) {
      const report = getReportByWeek(weekKey);
      const previousReport = getPreviousReport(report.weekKey);
      state.selectedWeek = report.weekKey;

      applyPageTheme(report);
      renderTypeCard(report);
      renderGradeCompare(report, previousReport);
      renderReportPicker();
      renderReportModal(report);
      renderRadarChart(report, previousReport);
    }

        function initInteractions() {
      const reportSelect = document.getElementById('report-select');
      const detailButton = document.getElementById('details-button');
      const detailClose = document.getElementById('details-close');
      const reportModal = document.getElementById('report-modal');
      const guideModal = document.getElementById('profile-guide-modal');
      const viewerWeekToggle = document.getElementById('viewer-week-toggle');
      const profileGuideButton = document.getElementById('profile-guide-button');
      const profileGuideClose = document.getElementById('profile-guide-close');

      reportSelect.addEventListener('change', () => {
        renderReport(reportSelect.value);
      });

      document.querySelectorAll('.toggle-button').forEach((button) => {
        button.addEventListener('click', () => {
          const overlay = button.getAttribute('data-overlay');
          if (overlay === 'current') {
            state.showCurrent = !state.showCurrent;
          }
          if (overlay === 'previous' && !button.disabled) {
            state.showPrevious = !state.showPrevious;
          }
          if (overlay === 'average') {
            state.showAverage = !state.showAverage;
          }
          renderReport(state.selectedWeek);
        });
      });

      detailButton.addEventListener('click', () => {
        renderReportModal(getReportByWeek(state.selectedWeek));
        setViewerWeekListOpen(false);
        openModal('report-modal');
      });

      viewerWeekToggle.addEventListener('click', () => {
        const list = document.getElementById('viewer-week-list');
        setViewerWeekListOpen(!list.classList.contains('is-open'));
      });

      detailClose.addEventListener('click', () => {
        setViewerWeekListOpen(false);
        closeModal('report-modal');
      });

      profileGuideButton.addEventListener('click', () => {
        renderProfileGuide();
        openModal('profile-guide-modal');
      });

      profileGuideClose.addEventListener('click', () => {
        closeModal('profile-guide-modal');
      });

      reportModal.addEventListener('click', (event) => {
        if (event.target === reportModal) {
          setViewerWeekListOpen(false);
          closeModal('report-modal');
        }
      });

      guideModal.addEventListener('click', (event) => {
        if (event.target === guideModal) {
          closeModal('profile-guide-modal');
        }
      });

      document.addEventListener('click', (event) => {
        const list = document.getElementById('viewer-week-list');
        const weekPopover = document.querySelector('.viewer-week-popover');
        if (list.classList.contains('is-open') && weekPopover && !weekPopover.contains(event.target)) {
          setViewerWeekListOpen(false);
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          setViewerWeekListOpen(false);
          closeModal('report-modal');
          closeModal('profile-guide-modal');
        }
      });
    }

    initInteractions();
    renderReport(state.selectedWeek);</script>
</body>
</html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evaluationConfig = await loadEvaluationConfig(projectDir);
  const data = await loadReports(options.reportsDir, evaluationConfig);
  const html = buildHtml(data);
  const outputPath = path.join(options.reportsDir, 'index.html');

  await fs.writeFile(outputPath, html, 'utf8');
  console.log(`Generated mentoring dashboard at ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});


























