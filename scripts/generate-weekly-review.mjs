#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateProfile,
  getAxisByKey,
  loadEvaluationConfig,
  scoreToGrade,
  scoreToGradeDetail,
} from './lib/evaluation-config.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const DEFAULT_SOURCE_DIR = path.join(projectDir, 'generated', 'archived_sessions_md');
const DEFAULT_OUTPUT_DIR = path.join(projectDir, 'generated', 'reports');
const DEFAULT_TIMEZONE = 'Asia/Seoul';

function parseArgs(argv) {
  const options = {
    sourceDir: DEFAULT_SOURCE_DIR,
    outputDir: DEFAULT_OUTPUT_DIR,
    timezone: DEFAULT_TIMEZONE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--source-dir') {
      options.sourceDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--output-dir') {
      options.outputDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--timezone') {
      options.timezone = argv[index + 1];
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
  console.log(`Usage: node scripts/generate-weekly-review.mjs [options]

Options:
  --source-dir <path>   Source directory with exported session Markdown files
  --output-dir <path>   Destination directory for weekly review reports
  --timezone <iana>     Timezone for week grouping (default: Asia/Seoul)
  -h, --help            Show this help
`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeDivide(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function toPercent(value) {
  return Math.round(clamp(value, 0, 1) * 100);
}

function getZonedDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
  };
}

function getIsoWeekParts(date, timeZone) {
  const { year, month, day } = getZonedDateParts(date, timeZone);
  const localDate = new Date(Date.UTC(year, month - 1, day));
  const dayNumber = localDate.getUTCDay() || 7;
  localDate.setUTCDate(localDate.getUTCDate() + 4 - dayNumber);
  const isoYear = localDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((localDate - yearStart) / 86400000) + 1) / 7);

  return {
    isoYear,
    isoWeek: week,
    key: `${isoYear}-W${String(week).padStart(2, '0')}`,
  };
}

function normalizeText(text) {
  return text.replace(/\r\n/g, '\n').trim();
}

function isLikelyCorruptedText(text) {
  const trimmed = text.trim();

  if (!trimmed) {
    return false;
  }

  if (trimmed.includes('占') || /\?{3,}/.test(trimmed)) {
    return true;
  }

  const questionRatio = (trimmed.match(/\?/g) ?? []).length / Math.max(trimmed.length, 1);
  return questionRatio > 0.08;
}

function tokenize(text) {
  return text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function truncate(text, maxLength = 90) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function isBoilerplateUserMessage(text) {
  const trimmed = text.trim();

  return (
    !trimmed ||
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('# AGENTS.md instructions') ||
    trimmed.includes('<INSTRUCTIONS>') ||
    trimmed.includes('## Structure') ||
    trimmed.includes('## Commands')
  );
}

function extractWorkspaceName(cwd) {
  if (!cwd) {
    return 'unknown';
  }

  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

function parseSessionMarkdown(text, fileName, timeZone) {
  const startedAt = text.match(/^- Started At: (.+)$/m)?.[1]?.trim() ?? null;
  const cwd = text.match(/^- CWD: `([^`]+)`$/m)?.[1]?.trim() ?? '';
  const sessionId = text.match(/^- Session ID: `([^`]+)`$/m)?.[1]?.trim() ?? fileName.replace(/\.md$/i, '');
  const startedDate = startedAt ? new Date(startedAt) : null;
  const weekParts = startedDate ? getIsoWeekParts(startedDate, timeZone) : null;

  const boundaryMatch = text.match(/## Conversation\s*([\s\S]*?)(?:\n## Tool Activity|\s*$)/);
  const conversationBody = boundaryMatch?.[1] ?? '';
  const messageRegex =
    /### \d+\. (User|Assistant)\n- Timestamp: ([^\n]+)(?:\n- Phase: ([^\n]+))?\n\n~~~text\n([\s\S]*?)\n~~~/g;
  const messages = [];

  for (const match of conversationBody.matchAll(messageRegex)) {
    const [, role, timestamp, phase = '', body] = match;
    const normalizedBody = normalizeText(body);

    messages.push({
      role: role.toLowerCase(),
      timestamp: timestamp.trim(),
      phase: phase.trim(),
      text: normalizedBody,
      corrupted: isLikelyCorruptedText(normalizedBody),
      tokens: tokenize(normalizedBody),
    });
  }

  const toolEntries = (text.match(/^### Tool (?:Call|Output)$/gm) ?? []).length;
  const userMessages = messages.filter((message) => message.role === 'user');
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const firstUsefulUserMessage = userMessages.find(
    (message) => !message.corrupted && !isBoilerplateUserMessage(message.text)
  )?.text
    ?? userMessages.find((message) => !isBoilerplateUserMessage(message.text))?.text
    ?? userMessages.find((message) => !message.corrupted)?.text
    ?? userMessages[0]?.text
    ?? '';

  return {
    fileName,
    sessionId,
    startedAt,
    startedDate,
    cwd,
    workspaceName: extractWorkspaceName(cwd),
    weekKey: weekParts?.key ?? 'unknown-week',
    weekParts,
    messages,
    userMessages,
    assistantMessages,
    toolEntries,
    firstUsefulUserMessage,
  };
}

function collectSignals(messages) {
  const joined = messages.map((message) => message.text).join('\n');
  const signal = (regex) => messages.filter((message) => regex.test(message.text)).length;

  return {
    explicitRequestCount: signal(/해주세요|해줘|만들|구현|분석|정리|저장|수정|보완|설계|자동화|리포트|원해요|원합니다/i),
    outcomeCount: signal(/결과|출력|보고서|리포트|폴더|파일|형식|프로그램|스크립트|cmd|md/i),
    contextCount: signal(/README|파일|폴더|경로|workdir|cwd|환경|버전|참고|첨부|예시|현재|기존|export|archived_sessions_md|`[^`]+`|[A-Za-z]:\\|\/[A-Za-z0-9._-]+/i),
    verificationCount: signal(/검증|확인|테스트|점검|체크|비교|리뷰|실행해|실행하고|직접 확인|남은 위험|리스크/i),
    sequencingCount: signal(/먼저|다음|이후|마지막|순서|단계|주간|매주|매월|1\.|2\.|3\./i),
    recoveryCount: signal(/안 되|에러|오류|막히|다시|수정|보완|개선|문제|리팩토링|고쳐/i),
    reflectionCount: signal(/회고|멘토링|성장|잘못|아쉬|배우|실력|습관|패턴/i),
    totalChars: joined.length,
  };
}

function summarizeWorkspaces(sessions) {
  const counts = new Map();

  for (const session of sessions) {
    counts.set(session.workspaceName, (counts.get(session.workspaceName) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([workspaceName, count]) => ({ workspaceName, count }));
}

function buildWeeklyStats(sessions, timeZone) {
  const activeDays = new Set();
  const allUserMessages = sessions.flatMap((session) => session.userMessages);
  const cleanUserMessages = allUserMessages.filter((message) => !message.corrupted);
  const signals = collectSignals(cleanUserMessages);

  const sessionsWithVerificationIntent = sessions.filter((session) =>
    session.userMessages.some((message) => /검증|확인|테스트|체크|비교|리뷰/i.test(message.text))
  ).length;

  const followUpSessions = sessions.filter((session) => session.userMessages.length >= 2).length;
  const multiTurnSessions = sessions.filter((session) => session.userMessages.length >= 2).length;

  for (const session of sessions) {
    if (!session.startedDate) {
      continue;
    }

    const parts = getZonedDateParts(session.startedDate, timeZone);
    activeDays.add(`${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`);
  }

  return {
    sessions,
    activeDays,
    sessionCount: sessions.length,
    totalMessages: sessions.reduce((sum, session) => sum + session.messages.length, 0),
    totalUserMessages: allUserMessages.length,
    totalAssistantMessages: sessions.reduce((sum, session) => sum + session.assistantMessages.length, 0),
    totalUserTokens: cleanUserMessages.reduce((sum, message) => sum + message.tokens.length, 0),
    totalToolEntries: sessions.reduce((sum, session) => sum + session.toolEntries, 0),
    corruptedUserMessages: allUserMessages.filter((message) => message.corrupted).length,
    sessionsWithCwd: sessions.filter((session) => session.cwd).length,
    sessionsWithVerificationIntent,
    followUpSessions,
    multiTurnSessions,
    workspaces: summarizeWorkspaces(sessions),
    snapshots: sessions.map((session) => ({
      fileName: session.fileName,
      startedAt: session.startedAt,
      workspaceName: session.workspaceName,
      summary: session.firstUsefulUserMessage,
      corrupted: !session.firstUsefulUserMessage || isLikelyCorruptedText(session.firstUsefulUserMessage),
    })),
    signals,
  };
}

function buildRawScoreMap(weekStats) {
  const totalUserMessages = Math.max(weekStats.totalUserMessages, 1);
  const averageUserTokens = safeDivide(weekStats.totalUserTokens, totalUserMessages);
  const averageUserTurns = safeDivide(weekStats.totalUserMessages, Math.max(weekStats.sessionCount, 1));
  const toolEntriesPerSession = safeDivide(weekStats.totalToolEntries, Math.max(weekStats.sessionCount, 1));
  const activeDaysRatio = clamp(weekStats.activeDays.size / 5, 0, 1);
  const sessionsRatio = clamp(weekStats.sessionCount / 5, 0, 1);
  const cleanMessageRatio = clamp(1 - safeDivide(weekStats.corruptedUserMessages, totalUserMessages), 0, 1);

  const clarityCore =
    0.35 * safeDivide(weekStats.signals.explicitRequestCount, totalUserMessages) +
    0.25 * safeDivide(weekStats.signals.outcomeCount, totalUserMessages) +
    0.2 * clamp(averageUserTokens / 20, 0, 1) +
    0.2 * cleanMessageRatio;

  const contextCore =
    0.55 * safeDivide(weekStats.signals.contextCount, totalUserMessages) +
    0.25 * safeDivide(weekStats.sessionsWithCwd, Math.max(weekStats.sessionCount, 1)) +
    0.2 * safeDivide(weekStats.signals.outcomeCount, totalUserMessages);

  const procedureCore =
    0.45 * safeDivide(weekStats.signals.sequencingCount, totalUserMessages) +
    0.3 * clamp((averageUserTurns - 1) / 2, 0, 1) +
    0.25 * safeDivide(weekStats.multiTurnSessions, Math.max(weekStats.sessionCount, 1));

  const verifiabilityCore =
    0.55 * safeDivide(weekStats.signals.verificationCount, totalUserMessages) +
    0.3 * clamp(toolEntriesPerSession / 8, 0, 1) +
    0.15 * safeDivide(weekStats.sessionsWithVerificationIntent, Math.max(weekStats.sessionCount, 1));

  const recoveryCore =
    0.45 * safeDivide(weekStats.signals.recoveryCount, totalUserMessages) +
    0.3 * safeDivide(weekStats.signals.reflectionCount, totalUserMessages) +
    0.25 * safeDivide(weekStats.followUpSessions, Math.max(weekStats.sessionCount, 1));

  const retrospectiveCore =
    0.45 * activeDaysRatio +
    0.35 * sessionsRatio +
    0.2 * cleanMessageRatio;

  const score = (base, core) => Math.round(clamp(base + core * 55, 25, 100));

  return {
    clarity: score(35, clarityCore),
    context_provision: score(30, contextCore),
    procedure_design: score(30, procedureCore),
    verifiability: score(28, verifiabilityCore),
    recovery: score(32, recoveryCore),
    retrospective_continuity: score(30, retrospectiveCore),
  };
}

function smoothScores(rawScores, previousScoreByKey) {
  if (!previousScoreByKey) {
    return rawScores;
  }

  const smoothed = {};

  for (const [key, raw] of Object.entries(rawScores)) {
    const previous = previousScoreByKey[key];
    if (typeof previous !== 'number') {
      smoothed[key] = raw;
      continue;
    }

    const blended = Math.round(raw * 0.85 + previous * 0.15);
    smoothed[key] = clamp(blended, previous - 12, previous + 12);
  }

  return smoothed;
}

function buildAxisReason(axisKey, weekStats, grade, criterion) {
  const totalUserMessages = Math.max(weekStats.totalUserMessages, 1);
  const sessionCount = Math.max(weekStats.sessionCount, 1);
  const signalRate = {
    clarity: toPercent(safeDivide(weekStats.signals.explicitRequestCount + weekStats.signals.outcomeCount, totalUserMessages)),
    context_provision: toPercent(safeDivide(weekStats.signals.contextCount, totalUserMessages)),
    procedure_design: toPercent(safeDivide(weekStats.signals.sequencingCount, totalUserMessages)),
    verifiability: toPercent(safeDivide(weekStats.signals.verificationCount, totalUserMessages)),
    recovery: toPercent(safeDivide(weekStats.signals.recoveryCount, totalUserMessages)),
    retrospective_continuity: toPercent(clamp(weekStats.activeDays.size / 5, 0, 1)),
  };

  const auxiliary = {
    context_provision: `${toPercent(safeDivide(weekStats.sessionsWithCwd, sessionCount))}% 세션에서 작업 경로 공유`,
    procedure_design: `${toPercent(safeDivide(weekStats.multiTurnSessions, sessionCount))}% 세션이 다중 턴으로 진행`,
    verifiability: `${toPercent(safeDivide(weekStats.sessionsWithVerificationIntent, sessionCount))}% 세션에서 검증 의도 확인`,
    recovery: `${toPercent(safeDivide(weekStats.followUpSessions, sessionCount))}% 세션이 후속 대응으로 연결`,
    retrospective_continuity: `활동일 ${weekStats.activeDays.size}일 / 세션 ${weekStats.sessionCount}건`,
  };

  if (axisKey === 'clarity') {
    return `요청 목적·산출물 신호가 사용자 메시지 대비 ${signalRate.clarity}%로 관찰되어 ${grade} 기준으로 판정했습니다.`;
  }

  return `${criterion} (관찰 신호 ${signalRate[axisKey]}%, ${auxiliary[axisKey] ?? '행동 패턴 기준'}).`;
}

function buildScorecard(weekStats, evaluationConfig, previousScoreByKey) {
  const rawScores = buildRawScoreMap(weekStats);
  const finalScores = smoothScores(rawScores, previousScoreByKey);
  const axisByKey = getAxisByKey(evaluationConfig);

  const scorecard = evaluationConfig.axes.map((axis) => {
    const score = Math.round(finalScores[axis.key] ?? 0);
    const gradeDetail = scoreToGradeDetail(score, evaluationConfig);
    const criterion = axis.gradeCriteria?.[gradeDetail.grade] ?? '';

    return {
      key: axis.key,
      label: axis.name,
      description: axis.description,
      score,
      grade: gradeDetail.grade,
      gradeSummary: gradeDetail.summary,
      criterion,
      reason: buildAxisReason(axis.key, weekStats, gradeDetail.grade, criterion),
      gradeCriteria: axisByKey[axis.key]?.gradeCriteria ?? {},
    };
  });

  return {
    rawScores,
    finalScores,
    scorecard,
  };
}

function computeAverage(scorecard, evaluationConfig) {
  const averageScore = Math.round(
    safeDivide(scorecard.reduce((sum, axis) => sum + axis.score, 0), Math.max(scorecard.length, 1))
  );

  return {
    averageScore,
    averageGrade: scoreToGrade(averageScore, evaluationConfig),
  };
}

function pickTopAndBottom(scorecard) {
  const sorted = [...scorecard].sort((left, right) => right.score - left.score);
  return {
    strongest: sorted.slice(0, 2),
    weakest: sorted.slice(-2).reverse(),
  };
}

function buildSummaryLine(profile, topBottom) {
  const top = topBottom.strongest[0]?.label ?? '명확성';
  const low = topBottom.weakest[0]?.label ?? '검증성';
  const warningPhrase = profile.reversed.active ? ' 구조 경고가 함께 감지되었습니다.' : '';
  return `이번 주 대표 타입은 ${profile.displayName}입니다. ${top} 축이 가장 강하고, 다음 보완 우선순위는 ${low}입니다.${warningPhrase}`;
}

function buildStrengths(scorecard) {
  const topAxes = [...scorecard].sort((a, b) => b.score - a.score).slice(0, 3);
  return topAxes.map((axis) => `${axis.label}: ${axis.grade} 등급 (${axis.reason})`);
}

function buildImprovements(scorecard) {
  const weakest = [...scorecard].sort((a, b) => a.score - b.score).slice(0, 3);
  return weakest.map((axis) => `${axis.label}: ${axis.grade} 등급으로 판정되어, ${axis.gradeCriteria.C ?? axis.criterion}`);
}

function buildActionPlan(scorecard) {
  const byKey = Object.fromEntries(scorecard.map((axis) => [axis.key, axis]));
  const plans = [];

  if ((byKey.clarity?.score ?? 0) < 75) {
    plans.push('요청 시작 시 "목표, 산출물, 제약조건" 3요소를 한 문단으로 먼저 고정합니다.');
  }

  if ((byKey.context_provision?.score ?? 0) < 75) {
    plans.push('첫 메시지에 작업 경로, 참고 파일, 현재 상태를 함께 제시해 맥락 재수집을 줄입니다.');
  }

  if ((byKey.procedure_design?.score ?? 0) < 75) {
    plans.push('작업을 "읽기 → 계획 → 수정 → 검증" 순서로 분리해 단계별 산출을 확인합니다.');
  }

  if ((byKey.verifiability?.score ?? 0) < 75) {
    plans.push('작업 종료 시 "검증 완료 / 미검증 / 남은 리스크" 3항목을 고정 포맷으로 요청합니다.');
  }

  if ((byKey.recovery?.score ?? 0) < 75) {
    plans.push('막힘 발생 시 원인 1줄 + 대안 2개 + 다음 선택 1개를 즉시 정리하도록 요청합니다.');
  }

  if ((byKey.retrospective_continuity?.score ?? 0) < 75) {
    plans.push('주 1회 고정 시간에 `npm run weekly`를 실행해 회고 루틴을 끊기지 않게 유지합니다.');
  }

  if (plans.length === 0) {
    plans.push('현재 강점 축은 유지하고, 상대적으로 낮은 1개 축만 선택해 다음 주 실험 항목으로 설정합니다.');
  }

  return [...new Set(plans)].slice(0, 3);
}

function buildPromptExamples(scorecard) {
  const weakest = [...scorecard].sort((left, right) => left.score - right.score).slice(0, 2);
  const examples = [];

  for (const axis of weakest) {
    if (axis.key === 'clarity') {
      examples.push('이번 요청의 목표, 산출물, 제약조건을 먼저 고정합니다. 이 조건으로 실행 가능한 작업 단위로 나눠 주세요.');
    }

    if (axis.key === 'context_provision') {
      examples.push('작업 폴더와 참고 파일은 아래와 같습니다. 이 맥락을 기준으로 먼저 수정 대상 파일을 정리해 주세요.');
    }

    if (axis.key === 'procedure_design') {
      examples.push('이번 작업은 1) 구조 파악 2) 변경 계획 3) 구현 4) 검증 순서로 진행하고 단계별 결과를 보여 주세요.');
    }

    if (axis.key === 'verifiability') {
      examples.push('변경 후에는 검증한 항목, 미검증 항목, 남은 리스크를 분리해서 보고해 주세요.');
    }

    if (axis.key === 'recovery') {
      examples.push('현재 막힌 원인을 요약하고 우회안 2개를 장단점과 함께 제시해 주세요.');
    }

    if (axis.key === 'retrospective_continuity') {
      examples.push('이번 주 결과를 지난주와 비교해 유지할 점 1개, 개선할 점 2개로 정리해 주세요.');
    }
  }

  if (examples.length < 3) {
    examples.push('작업 전에는 현재 상태를 요약하고, 수정 후에는 변화와 검증 결과를 같은 형식으로 비교해 주세요.');
  }

  return [...new Set(examples)].slice(0, 3);
}

function formatSummaryTable(rows) {
  const lines = [
    '| 항목 | 값 |',
    '| --- | --- |',
  ];

  for (const row of rows) {
    lines.push(`| ${row.label} | ${row.value} |`);
  }

  return lines.join('\n');
}

function formatEvaluationReason(reason) {
  const raw = String(reason ?? '').trim();
  const match = raw.match(/^(.*?)(\s+\([^()]+\)\.?)$/);

  if (!match) {
    return raw;
  }

  return `${match[1].trim()}<br>${match[2].trim()}`;
}

function formatEvaluationTable(scorecard) {
  const lines = [
    '| 평가축 | 내부 점수(0~100) | 표시 등급 | 판정 사유 |',
    '| --- | ---: | :---: | --- |',
  ];

  for (const axis of scorecard) {
    lines.push(`| ${axis.label} | ${axis.score} | ${axis.grade} | ${formatEvaluationReason(axis.reason)} |`);
  }

  return lines.join('\n');
}

function formatSnapshots(snapshots) {
  return snapshots
    .slice(0, 8)
    .map((snapshot) => {
      const summary = snapshot.corrupted
        ? '원문 인코딩 문제로 핵심 요청 요약이 어렵습니다.'
        : truncate(snapshot.summary.replace(/\s+/g, ' '), 100);
      return `- ${snapshot.startedAt ?? 'unknown'} | ${snapshot.workspaceName} | ${summary}`;
    })
    .join('\n');
}

function buildWeeklyReport(weekKey, weekStats, evaluation, previousEvaluation, evaluationConfig) {
  const { scorecard, average, profile } = evaluation;
  const topBottom = pickTopAndBottom(scorecard);
  const summaryLine = buildSummaryLine(profile, topBottom);
  const strengths = buildStrengths(scorecard);
  const improvements = buildImprovements(scorecard);
  const actionPlan = buildActionPlan(scorecard);
  const promptExamples = buildPromptExamples(scorecard);

  const previousType = previousEvaluation?.profile?.displayName ?? '없음';
  const previousAverage = previousEvaluation?.average?.averageScore;
  const averageDelta = typeof previousAverage === 'number'
    ? `${average.averageScore - previousAverage >= 0 ? '+' : ''}${average.averageScore - previousAverage}`
    : '신규';
  const summaryRows = [
    { label: '분석한 세션 수', value: String(weekStats.sessionCount) },
    { label: '활동한 날짜 수', value: String(weekStats.activeDays.size) },
    { label: '사용자 메시지 수', value: String(weekStats.totalUserMessages) },
    { label: 'Assistant 메시지 수', value: String(weekStats.totalAssistantMessages) },
    { label: 'Tool activity 수', value: String(weekStats.totalToolEntries) },
    { label: '주요 작업공간', value: weekStats.workspaces.slice(0, 3).map((item) => `${item.workspaceName}(${item.count})`).join(', ') || '없음' },
    { label: '평균 내부 점수', value: `${average.averageScore} / 100 (${averageDelta})` },
    { label: '평균 표시 등급', value: average.averageGrade },
    { label: '대표 타입', value: profile.type.name },
    { label: 'Reversed 상태', value: profile.reversed.active ? profile.reversed.label : 'Normal' },
    { label: '전주 대표 타입', value: previousType },
  ];

  return `# Growth Experience Review (G.E.R) - ${weekKey}

## 한 줄 진단

${summaryLine}

## 타입 판정

- 대표 타입: ${profile.type.name}
- 타입 의미: ${profile.type.subtitle}
- Reversed 상태: ${profile.reversed.active ? profile.reversed.label : 'Normal'}
- 타입 판정 근거: ${profile.type.reason}
- Reversed 판정 근거: ${profile.reversed.reason}

## 이번 주 활동 요약

${formatSummaryTable(summaryRows)}

## 6축 평가 결과

${formatEvaluationTable(scorecard)}

## 강점 축 요약

${strengths.map((item) => `- ${item}`).join('\n')}

## 보완 필요 축 요약

${improvements.map((item) => `- ${item}`).join('\n')}

## 다음 주 개선 포인트 (1~3개)

${actionPlan.map((item, index) => `${index + 1}. ${item}`).join('\n')}

## Codex 요청 문장 예시

${promptExamples.map((item) => `- ${item}`).join('\n')}

## 이번 주 대표 세션

${formatSnapshots(weekStats.snapshots)}
`;
}

function buildLatestReport(latestWeekKey, weeklyReport, timelineText) {
  return `# Latest Growth Experience Review

- Latest Week: ${latestWeekKey}

${weeklyReport.trim()}

## Timeline Snapshot

${timelineText.trim()}
`;
}

function buildTimeline(weeklySummaries) {
  const lines = [
    '# Growth Experience Review Timeline',
    '',
    '| Week | Type | Reversed | Avg Grade | Avg Score | Sessions | Focus |',
    '| --- | --- | :---: | :---: | ---: | ---: | --- |',
  ];

  for (const summary of weeklySummaries) {
    lines.push(
      `| ${summary.weekKey} | ${summary.typeName} | ${summary.reversedState} | ${summary.averageGrade} | ${summary.averageScore} | ${summary.sessionCount} | ${summary.focus} |`
    );
  }

  lines.push('');
  return lines.join('\n');
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readSessions(sourceDir, timeZone) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const sessionFiles = entries
    .filter((entry) => entry.isFile() && /^rollout-.*\.md$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const sessions = [];

  for (const fileName of sessionFiles) {
    const filePath = path.join(sourceDir, fileName);
    const text = await fs.readFile(filePath, 'utf8');
    sessions.push(parseSessionMarkdown(text, fileName, timeZone));
  }

  return sessions.filter((session) => session.weekKey !== 'unknown-week');
}

async function writeReports(options, reports) {
  const weeklyDir = path.join(options.outputDir, 'weekly');
  await ensureDirectory(weeklyDir);

  for (const report of reports.weekly) {
    await fs.writeFile(path.join(weeklyDir, `${report.weekKey}.md`), report.content, 'utf8');
  }

  await fs.writeFile(path.join(options.outputDir, 'TIMELINE.md'), reports.timeline, 'utf8');
  await fs.writeFile(path.join(options.outputDir, 'LATEST.md'), reports.latest, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evaluationConfig = await loadEvaluationConfig(projectDir);
  const sessions = await readSessions(options.sourceDir, options.timezone);

  if (sessions.length === 0) {
    throw new Error(`No exported session Markdown files were found in ${options.sourceDir}`);
  }

  const weeklyMap = new Map();

  for (const session of sessions) {
    if (!weeklyMap.has(session.weekKey)) {
      weeklyMap.set(session.weekKey, []);
    }

    weeklyMap.get(session.weekKey).push(session);
  }

  const weeklyKeys = [...weeklyMap.keys()].sort((left, right) => left.localeCompare(right));
  const weeklyReports = [];
  const weeklySummaries = [];

  let previousEvaluation = null;

  for (const weekKey of weeklyKeys) {
    const weekSessions = weeklyMap.get(weekKey).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const weekStats = buildWeeklyStats(weekSessions, options.timezone);

    const scoreBuild = buildScorecard(weekStats, evaluationConfig, previousEvaluation?.scoreByKey ?? null);
    const average = computeAverage(scoreBuild.scorecard, evaluationConfig);
    const axisGrades = Object.fromEntries(scoreBuild.scorecard.map((axis) => [axis.key, axis.grade]));
    const profile = evaluateProfile(
      {
        axisGrades,
        scoreByKey: scoreBuild.finalScores,
        averageScore: average.averageScore,
        previousEvaluation,
      },
      evaluationConfig
    );

    const evaluation = {
      scorecard: scoreBuild.scorecard,
      scoreByKey: scoreBuild.finalScores,
      axisGrades,
      average,
      profile,
    };

    const weakest = [...evaluation.scorecard].sort((left, right) => left.score - right.score)[0];
    const content = buildWeeklyReport(
      weekKey,
      weekStats,
      evaluation,
      previousEvaluation,
      evaluationConfig
    );

    weeklyReports.push({
      weekKey,
      content,
      weekStats,
      evaluation,
      weakest,
    });

    weeklySummaries.push({
      weekKey,
      typeName: profile.type.name,
      reversedState: profile.reversed.active ? profile.reversed.label : 'Normal',
      averageGrade: average.averageGrade,
      averageScore: average.averageScore,
      sessionCount: weekStats.sessionCount,
      focus: weakest?.label ?? '명확성',
    });

    previousEvaluation = evaluation;
  }

  const timeline = buildTimeline(weeklySummaries);
  const latestWeek = weeklyReports.at(-1);
  const latest = buildLatestReport(latestWeek.weekKey, latestWeek.content, timeline);

  await writeReports(options, {
    weekly: weeklyReports,
    timeline,
    latest,
  });

  console.log(`Generated ${weeklyReports.length} weekly review reports in ${options.outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});




