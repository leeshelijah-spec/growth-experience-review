#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  --output-dir <path>   Destination directory for weekly mentoring reports
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

  if (trimmed.includes('�') || /\?{3,}/.test(trimmed)) {
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
    trimmed.includes('## Commands') ||
    trimmed.includes('Korean Law MCP Server') ||
    trimmed.includes('General Legal Research')
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
    explicitRequestCount: signal(/해주세요|해줘|해주세요|만들|구현|분석|정리|저장|수정|보완|설계|자동화|리포트|멘토링|원해요|원합니다/i),
    outcomeCount: signal(/결과|출력|저장|보고서|리포트|폴더|파일|형식|프로그램|스크립트|cmd|md/i),
    contextCount: signal(/README|파일|폴더|경로|workdir|cwd|환경|버전|참고|첨부|예시|현재|기존|export|archived_sessions_md|`[^`]+`|[A-Za-z]:\\|\/[A-Za-z0-9._-]+/i),
    verificationCount: signal(/검증|확인|테스트|점검|체크|비교|리뷰|실행해|실행하고|직접 확인|남은 위험|리스크/i),
    sequencingCount: signal(/먼저|다음|이후|마지막|순서|단계|주간|매주|매월|1\.|2\.|3\./i),
    recoveryCount: signal(/안 되|에러|오류|막히|다시|수정|보완|개선|문제|리팩토링|고쳐/i),
    reflectionCount: signal(/회고|멘토링|성장|잘못|아쉬|배우|실력|습관|패턴/i),
    promptPatternCount: signal(/Codex|AI|프롬프트|멘토|사용자인 저|비개발자/i),
    totalChars: joined.length,
  };
}

function buildScorecard(weekStats) {
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
  const workflowCore =
    0.45 * safeDivide(weekStats.signals.sequencingCount, totalUserMessages) +
    0.3 * clamp((averageUserTurns - 1) / 2, 0, 1) +
    0.25 * safeDivide(weekStats.multiTurnSessions, Math.max(weekStats.sessionCount, 1));
  const verifyCore =
    0.55 * safeDivide(weekStats.signals.verificationCount, totalUserMessages) +
    0.3 * clamp(toolEntriesPerSession / 8, 0, 1) +
    0.15 * safeDivide(weekStats.sessionsWithVerificationIntent, Math.max(weekStats.sessionCount, 1));
  const recoveryCore =
    0.45 * safeDivide(weekStats.signals.recoveryCount, totalUserMessages) +
    0.3 * safeDivide(weekStats.signals.reflectionCount, totalUserMessages) +
    0.25 * safeDivide(weekStats.followUpSessions, Math.max(weekStats.sessionCount, 1));
  const habitCore =
    0.45 * activeDaysRatio +
    0.35 * sessionsRatio +
    0.2 * cleanMessageRatio;

  const score = (base, core) => Math.round(clamp(base + core * 55, 25, 100));

  return [
    {
      key: 'goal',
      label: '요청 명확성',
      score: score(35, clarityCore),
      description: '무엇을 원하는지, 결과물이 어떤 모습이어야 하는지를 분명히 말하는 힘',
    },
    {
      key: 'context',
      label: '배경 설명',
      score: score(30, contextCore),
      description: '파일, 폴더, 현재 상태, 참고 자료를 충분히 붙여주는 습관',
    },
    {
      key: 'workflow',
      label: '단계 나누기',
      score: score(30, workflowCore),
      description: '한 번에 다 시키기보다 읽기, 계획, 수정, 확인 순서로 나누는 힘',
    },
    {
      key: 'verify',
      label: '확인 습관',
      score: score(28, verifyCore),
      description: '수정 뒤 무엇을 확인했는지, 아직 남은 위험이 무엇인지 묻는 습관',
    },
    {
      key: 'recovery',
      label: '막힘 대응',
      score: score(32, recoveryCore),
      description: '오류나 애매함이 생겼을 때 다시 정리하고 방향을 바꾸는 힘',
    },
    {
      key: 'habit',
      label: '주간 루틴',
      score: score(30, habitCore),
      description: '한 주 동안 일정하게 Codex를 활용하고 회고로 연결하는 습관',
    },
  ];
}

function roundToHalf(value) {
  return Math.round(value * 2) / 2;
}

function getLevelName(level) {
  const labels = [
    { min: 6.5, name: '멘토형' },
    { min: 5.5, name: '시스템형' },
    { min: 4.5, name: '설계형' },
    { min: 3.5, name: '운영형' },
    { min: 2.5, name: '협업형' },
    { min: 1.5, name: '요청형' },
    { min: 1.0, name: '시작형' },
  ];

  return labels.find((item) => level >= item.min)?.name ?? '시작형';
}

function computeLevel(scorecard) {
  const average = safeDivide(scorecard.reduce((sum, axis) => sum + axis.score, 0), scorecard.length);
  const level = clamp(roundToHalf(1 + (average / 100) * 6), 1, 7);

  return {
    averageScore: Math.round(average),
    level,
    label: getLevelName(level),
  };
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

function summarizeWorkspaces(sessions) {
  const counts = new Map();

  for (const session of sessions) {
    counts.set(session.workspaceName, (counts.get(session.workspaceName) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([workspaceName, count]) => ({ workspaceName, count }));
}

function pickTopAndBottom(scorecard) {
  const sorted = [...scorecard].sort((left, right) => right.score - left.score);
  return {
    strongest: sorted.slice(0, 2),
    weakest: sorted.slice(-2).reverse(),
  };
}

function buildSummaryLine(levelInfo, weekStats, topBottom) {
  const top = topBottom.strongest[0]?.label ?? '요청 명확성';
  const low = topBottom.weakest[0]?.label ?? '주간 루틴';

  return `이번 주는 ${levelInfo.label}(${levelInfo.level.toFixed(1)}) 단계로 보입니다. ${top}은 잘 잡혀 있고, 다음 성장 포인트는 ${low}입니다.`;
}

function buildStrengths(scorecard, weekStats) {
  const strengths = [];

  if (scorecard.find((axis) => axis.key === 'goal')?.score >= 70) {
    strengths.push('무엇을 만들고 싶은지와 결과물 형태를 비교적 또렷하게 말하고 있습니다.');
  }

  if (scorecard.find((axis) => axis.key === 'context')?.score >= 65) {
    strengths.push('파일, 폴더, README 같은 맥락 정보를 함께 주는 습관이 보입니다.');
  }

  if (scorecard.find((axis) => axis.key === 'verify')?.score >= 60) {
    strengths.push('확인, 검증, 남은 위험을 묻는 요청이 있어 결과 품질 관리가 좋아지고 있습니다.');
  }

  if (scorecard.find((axis) => axis.key === 'habit')?.score >= 60) {
    strengths.push('한 주 동안 꾸준히 Codex를 열어 실제 작업 흐름으로 연결하고 있습니다.');
  }

  if (strengths.length < 3 && weekStats.sessionCount >= 3) {
    strengths.push('한 번 쓰고 끝내지 않고 여러 세션으로 이어가며 협업 감각을 만들고 있습니다.');
  }

  if (strengths.length < 3) {
    strengths.push('멘토링 프로그램을 만들겠다는 목표 자체가 이미 회고 중심 습관으로 넘어가는 좋은 신호입니다.');
  }

  return strengths.slice(0, 3);
}

function buildImprovements(scorecard, weekStats) {
  const improvements = [];
  const byKey = Object.fromEntries(scorecard.map((axis) => [axis.key, axis]));

  if (byKey.goal.score < 65) {
    improvements.push('요청마다 "목표, 산출물, 완료 기준"을 한 문단으로 먼저 적어주면 Codex 응답 품질이 더 안정됩니다.');
  }

  if (byKey.context.score < 65) {
    improvements.push('파일 경로, 참고 README, 현재 상태를 같이 주면 다시 설명하는 시간을 크게 줄일 수 있습니다.');
  }

  if (byKey.verify.score < 60) {
    improvements.push('작업 후에는 "무엇을 확인했는지 / 아직 확인 못 한 것은 무엇인지"를 꼭 분리해서 받는 습관이 필요합니다.');
  }

  if (byKey.workflow.score < 60) {
    improvements.push('큰 요청은 "읽기 -> 계획 -> 수정 -> 검증" 4단계로 쪼개면 비개발자 입장에서 훨씬 따라가기 쉬워집니다.');
  }

  if (byKey.habit.score < 55) {
    improvements.push('주 1회라도 고정된 시간에 export와 멘토링 리포트를 생성해 회고 루틴을 만드는 것이 중요합니다.');
  }

  if (weekStats.corruptedUserMessages > 0) {
    improvements.push('일부 예전 세션은 인코딩이 깨져 분석 품질이 떨어집니다. 가능한 새 리포트부터는 현재 UTF-8 흐름을 유지하는 편이 좋습니다.');
  }

  return improvements.slice(0, 3);
}

function buildActionPlan(scorecard, weekStats) {
  const weakest = [...scorecard].sort((left, right) => left.score - right.score).slice(0, 3);
  const actions = [];

  for (const axis of weakest) {
    if (axis.key === 'goal') {
      actions.push('새 요청을 시작할 때 "원하는 결과, 저장 위치, 완료 기준" 3가지를 먼저 적기');
    }

    if (axis.key === 'context') {
      actions.push('README나 참고 파일이 있으면 첫 메시지에 함께 붙이고, 작업 폴더도 같이 적기');
    }

    if (axis.key === 'workflow') {
      actions.push('한 번에 구현을 시키기보다 먼저 읽고 계획만 내달라고 요청한 뒤 수정 단계로 넘어가기');
    }

    if (axis.key === 'verify') {
      actions.push('마지막에는 항상 "검증한 것 / 미검증 항목 / 남은 리스크"를 표기해 달라고 요청하기');
    }

    if (axis.key === 'recovery') {
      actions.push('막히면 "지금 뭐가 문제인지, 다음 선택지는 무엇인지"를 3줄 요약으로 먼저 받기');
    }

    if (axis.key === 'habit') {
      actions.push('매주 같은 요일에 한 번 `run-weekly-review.cmd`를 실행해 회고 리포트 남기기');
    }
  }

  if (actions.length < 3 && weekStats.sessionCount > 0) {
    actions.push('이번 주 가장 중요했던 작업 1건만 골라, 다음 주에는 같은 주제에서 더 구체적인 요청 문장으로 다시 시도해 보기');
  }

  return [...new Set(actions)].slice(0, 3);
}

function buildPromptExamples(scorecard, weekStats) {
  const weakest = [...scorecard].sort((left, right) => left.score - right.score).slice(0, 2);
  const topWorkspace = weekStats.workspaces[0]?.workspaceName ?? '작업폴더';
  const examples = [];

  for (const axis of weakest) {
    if (axis.key === 'context') {
      examples.push(`지금 작업 폴더는 \`${topWorkspace}\`입니다. 참고할 README는 [README.md](절대경로)이고, 제가 원하는 결과는 "주간 멘토링 리포트 생성"입니다. 먼저 현재 구조를 읽고 어떤 파일을 만들지 계획부터 설명해 주세요.`);
    }

    if (axis.key === 'goal') {
      examples.push('저는 비개발자 Codex 사용자입니다. 이번 작업의 목표는 "매주 회고를 쉽게 받는 것"입니다. 최종 결과물은 실행 가능한 프로그램, 생성되는 보고서 예시, 사용 설명서까지 포함이어야 합니다.');
    }

    if (axis.key === 'verify') {
      examples.push('수정 후에는 1) 바뀐 점 2) 직접 확인한 점 3) 아직 제가 수동으로 확인해야 하는 점을 나눠서 알려주세요.');
    }

    if (axis.key === 'workflow') {
      examples.push('이번 작업은 1. 읽기 2. 계획 3. 구현 4. 검증 순서로 진행해 주세요. 각 단계에서 무엇을 하고 있는지 짧게 알려주세요.');
    }

    if (axis.key === 'recovery') {
      examples.push('지금 막힌 이유를 3줄로 요약하고, 바로 시도할 수 있는 해결책 2개만 우선순위대로 제안해 주세요.');
    }

    if (axis.key === 'habit') {
      examples.push('매주 같은 형식으로 볼 수 있게, 이번 주 리포트와 지난주 대비 달라진 점을 함께 적어 주세요.');
    }
  }

  if (examples.length < 3) {
    examples.push('작업 전에 먼저 관련 파일을 읽고, 제가 이해하기 쉽게 "무엇을 바꿀지"를 평이한 한국어로 설명한 뒤 진행해 주세요.');
  }

  return [...new Set(examples)].slice(0, 3);
}

function formatScoreTable(scorecard) {
  const lines = [
    '| 항목 | 점수 | 의미 |',
    '| --- | ---: | --- |',
  ];

  for (const axis of scorecard) {
    lines.push(`| ${axis.label} | ${axis.score} | ${axis.description} |`);
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

function buildWeeklyReport(weekKey, weekStats, scorecard, levelInfo) {
  const topBottom = pickTopAndBottom(scorecard);
  const summaryLine = buildSummaryLine(levelInfo, weekStats, topBottom);
  const strengths = buildStrengths(scorecard, weekStats);
  const improvements = buildImprovements(scorecard, weekStats);
  const actionPlan = buildActionPlan(scorecard, weekStats);
  const promptExamples = buildPromptExamples(scorecard, weekStats);

  return `# Growth Experience Review Report - ${weekKey}

## 한 줄 진단

${summaryLine}

## 이번 주 활동 요약

- 분석한 세션 수: ${weekStats.sessionCount}
- 활동한 날짜 수: ${weekStats.activeDays.size}
- 사용자 메시지 수: ${weekStats.totalUserMessages}
- Assistant 메시지 수: ${weekStats.totalAssistantMessages}
- Tool activity 수: ${weekStats.totalToolEntries}
- 주요 작업공간: ${weekStats.workspaces.slice(0, 3).map((item) => `${item.workspaceName}(${item.count})`).join(', ') || '없음'}
- 현재 레벨: ${levelInfo.label} ${levelInfo.level.toFixed(1)} / 7.0
- 평균 점수: ${levelInfo.averageScore} / 100

## 6축 점수

${formatScoreTable(scorecard)}

## 잘하고 있는 점

${strengths.map((item) => `- ${item}`).join('\n')}

## 보완하면 좋은 점

${improvements.map((item) => `- ${item}`).join('\n')}

## 다음 주 실천 3가지

${actionPlan.map((item, index) => `${index + 1}. ${item}`).join('\n')}

## Codex에게 이렇게 말해보세요

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
    '| Week | Level | Avg Score | Sessions | Focus |',
    '| --- | --- | ---: | ---: | --- |',
  ];

  for (const summary of weeklySummaries) {
    lines.push(
      `| ${summary.weekKey} | ${summary.levelLabel} ${summary.level.toFixed(1)} | ${summary.averageScore} | ${summary.sessionCount} | ${summary.focus} |`
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

  for (const weekKey of weeklyKeys) {
    const weekSessions = weeklyMap.get(weekKey).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const weekStats = buildWeeklyStats(weekSessions, options.timezone);
    const scorecard = buildScorecard(weekStats);
    const levelInfo = computeLevel(scorecard);
    const weakest = [...scorecard].sort((left, right) => left.score - right.score)[0];
    const content = buildWeeklyReport(weekKey, weekStats, scorecard, levelInfo);

    weeklyReports.push({
      weekKey,
      content,
      levelInfo,
      weekStats,
      weakest,
    });

    weeklySummaries.push({
      weekKey,
      level: levelInfo.level,
      levelLabel: levelInfo.label,
      averageScore: levelInfo.averageScore,
      sessionCount: weekStats.sessionCount,
      focus: weakest?.label ?? '요청 명확성',
    });
  }

  const timeline = buildTimeline(weeklySummaries);
  const latestWeek = weeklyReports.at(-1);
  const latest = buildLatestReport(latestWeek.weekKey, latestWeek.content, timeline);

  await writeReports(options, {
    weekly: weeklyReports,
    timeline,
    latest,
  });

  console.log(`Generated ${weeklyReports.length} weekly mentoring reports in ${options.outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
