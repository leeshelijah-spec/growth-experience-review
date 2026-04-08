import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_RATINGS_CONFIG_RELATIVE_PATH = path.join('config', 'ratings.json');
export const DEFAULT_PROFILE_RULES_RELATIVE_PATH = path.join('config', 'profile-rules.json');

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function assertArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid evaluation config: ${label} is required.`);
  }
}

export async function loadEvaluationConfig(projectDir) {
  const ratingsPath = path.join(projectDir, DEFAULT_RATINGS_CONFIG_RELATIVE_PATH);
  const profileRulesPath = path.join(projectDir, DEFAULT_PROFILE_RULES_RELATIVE_PATH);

  const [ratingsRaw, profileRulesRaw] = await Promise.all([
    fs.readFile(ratingsPath, 'utf8'),
    fs.readFile(profileRulesPath, 'utf8'),
  ]);

  const ratings = JSON.parse(ratingsRaw);
  const profileRules = JSON.parse(profileRulesRaw);

  assertArray(ratings.axes, 'axes');
  assertArray(ratings.gradeScale, 'gradeScale');
  assertArray(profileRules.types, 'profileRules.types');
  assertArray(profileRules.priority, 'profileRules.priority');
  assertArray(profileRules.reversed?.rules, 'profileRules.reversed.rules');

  return {
    ...ratings,
    profileRules,
  };
}

export function gradeRank(grade) {
  const order = ['E', 'D', 'C', 'B', 'A'];
  const index = order.indexOf(grade);
  return index < 0 ? -1 : index;
}

export function isGradeAtLeast(grade, threshold) {
  return gradeRank(grade) >= gradeRank(threshold);
}

export function isGradeAtMost(grade, threshold) {
  return gradeRank(grade) <= gradeRank(threshold);
}

export function scoreToGradeDetail(score, config) {
  const numericScore = clamp(Number(score) || 0, 0, 100);
  const matched = config.gradeScale.find((item) => numericScore >= item.min && numericScore <= item.max);

  if (matched) {
    return {
      grade: matched.grade,
      summary: matched.summary,
      min: matched.min,
      max: matched.max,
    };
  }

  const fallback = [...config.gradeScale].sort((a, b) => b.min - a.min)[0];
  return {
    grade: fallback?.grade ?? 'C',
    summary: fallback?.summary ?? '',
    min: fallback?.min ?? 60,
    max: fallback?.max ?? 74,
  };
}

export function scoreToGrade(score, config) {
  return scoreToGradeDetail(score, config).grade;
}

function interpolate(template, metrics) {
  if (!template) {
    return '';
  }

  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => {
    const value = metrics[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function resolveAxes(condition, axisGrades) {
  if (condition.axes === 'ALL') {
    return Object.keys(axisGrades);
  }

  if (Array.isArray(condition.axes)) {
    return condition.axes;
  }

  return [];
}

function resolveGradePredicate(condition, op) {
  if (condition.predicate === 'at_most') {
    return isGradeAtMost;
  }

  if (condition.predicate === 'at_least') {
    return isGradeAtLeast;
  }

  return op === 'count_at_most' || op === 'any_at_most' ? isGradeAtMost : isGradeAtLeast;
}

function countGrades(axisKeys, axisGrades, predicate) {
  return axisKeys.reduce((count, axisKey) => {
    const grade = axisGrades[axisKey];
    return predicate(grade) ? count + 1 : count;
  }, 0);
}

function getScoreDelta(condition, context) {
  if (condition.target === 'overall') {
    if (typeof context.previousAverageScore !== 'number') {
      return null;
    }
    return context.averageScore - context.previousAverageScore;
  }

  const axisKey = condition.axis ?? condition.target;
  const previousScore = context.previousScoreByKey?.[axisKey];
  const currentScore = context.scoreByKey?.[axisKey];

  if (typeof previousScore !== 'number' || typeof currentScore !== 'number') {
    return null;
  }

  return currentScore - previousScore;
}

function countScoreDeltas(axisKeys, context, predicate) {
  return axisKeys.reduce((count, axisKey) => {
    const currentScore = context.scoreByKey?.[axisKey];
    const previousScore = context.previousScoreByKey?.[axisKey];

    if (typeof currentScore !== 'number' || typeof previousScore !== 'number') {
      return count;
    }

    const delta = currentScore - previousScore;
    return predicate(delta) ? count + 1 : count;
  }, 0);
}

function countScores(axisKeys, scoreByKey, predicate) {
  return axisKeys.reduce((count, axisKey) => {
    const score = scoreByKey?.[axisKey];

    if (typeof score !== 'number') {
      return count;
    }

    return predicate(score) ? count + 1 : count;
  }, 0);
}

function getTopAxisKeys(scoreByKey) {
  const entries = Object.entries(scoreByKey ?? {}).filter(([, score]) => typeof score === 'number');

  if (!entries.length) {
    return [];
  }

  const maxScore = Math.max(...entries.map(([, score]) => score));
  return entries
    .filter(([, score]) => score === maxScore)
    .map(([axisKey]) => axisKey);
}

function evaluateCondition(condition, context) {
  const { axisGrades, overallGrade } = context;

  if (condition.op === 'count_at_least' || condition.op === 'count_at_most') {
    const axisKeys = resolveAxes(condition, axisGrades);
    const predicate = resolveGradePredicate(condition, condition.op);
    const matchedCount = countGrades(axisKeys, axisGrades, (grade) => predicate(grade, condition.grade));
    const pass = condition.op === 'count_at_least'
      ? matchedCount >= condition.count
      : matchedCount <= condition.count;
    return { pass, value: matchedCount };
  }

  if (condition.op === 'any_at_least' || condition.op === 'any_at_most') {
    const axisKeys = resolveAxes(condition, axisGrades);
    const predicate = resolveGradePredicate(condition, condition.op);
    const matched = axisKeys.some((axisKey) => predicate(axisGrades[axisKey], condition.grade));
    return { pass: matched };
  }

  if (condition.op === 'axis_at_least') {
    return { pass: isGradeAtLeast(axisGrades[condition.axis], condition.grade) };
  }

  if (condition.op === 'axis_at_most') {
    return { pass: isGradeAtMost(axisGrades[condition.axis], condition.grade) };
  }

  if (condition.op === 'overall_at_least') {
    return { pass: isGradeAtLeast(overallGrade, condition.grade) };
  }

  if (condition.op === 'overall_at_most') {
    return { pass: isGradeAtMost(overallGrade, condition.grade) };
  }

  if (condition.op === 'score_delta_at_least' || condition.op === 'score_delta_at_most') {
    const delta = getScoreDelta(condition, context);

    if (delta === null) {
      return { pass: false, value: null };
    }

    const pass = condition.op === 'score_delta_at_least'
      ? delta >= condition.delta
      : delta <= condition.delta;
    return { pass, value: delta };
  }

  if (condition.op === 'count_score_deltas_at_least' || condition.op === 'count_score_deltas_at_most') {
    const axisKeys = resolveAxes(condition, axisGrades);
    const matchedCount = countScoreDeltas(
      axisKeys,
      context,
      (delta) => (condition.op === 'count_score_deltas_at_least' ? delta >= condition.delta : delta <= condition.delta)
    );
    const pass = condition.op === 'count_score_deltas_at_least'
      ? matchedCount >= condition.count
      : matchedCount <= condition.count;
    return { pass, value: matchedCount };
  }

  if (condition.op === 'axis_score_at_least' || condition.op === 'axis_score_at_most') {
    const score = context.scoreByKey?.[condition.axis];

    if (typeof score !== 'number') {
      return { pass: false, value: null };
    }

    const pass = condition.op === 'axis_score_at_least'
      ? score >= condition.score
      : score <= condition.score;
    return { pass, value: score };
  }

  if (condition.op === 'any_score_at_least' || condition.op === 'any_score_at_most') {
    const axisKeys = resolveAxes(condition, axisGrades);
    const matched = axisKeys.some((axisKey) => {
      const score = context.scoreByKey?.[axisKey];

      if (typeof score !== 'number') {
        return false;
      }

      return condition.op === 'any_score_at_least'
        ? score >= condition.score
        : score <= condition.score;
    });

    return { pass: matched };
  }

  if (condition.op === 'count_scores_at_least' || condition.op === 'count_scores_at_most') {
    const axisKeys = resolveAxes(condition, axisGrades);
    const matchedCount = countScores(
      axisKeys,
      context.scoreByKey,
      (score) => (condition.op === 'count_scores_at_least' ? score >= condition.score : score <= condition.score)
    );
    const pass = condition.op === 'count_scores_at_least'
      ? matchedCount >= condition.count
      : matchedCount <= condition.count;
    return { pass, value: matchedCount };
  }

  if (condition.op === 'top_axis_in') {
    const axisKeys = resolveAxes(condition, axisGrades);
    const topAxisKeys = getTopAxisKeys(context.scoreByKey);
    const matched = topAxisKeys.some((axisKey) => axisKeys.includes(axisKey));
    return {
      pass: matched,
      value: topAxisKeys.join(', '),
    };
  }

  return { pass: false };
}

function getPrioritizedTypes(config) {
  const order = config.profileRules.priority ?? [];
  const types = config.profileRules.types ?? [];

  if (!order.length) {
    return types;
  }

  const byKey = new Map(types.map((type) => [type.key, type]));
  const prioritized = [];

  for (const key of order) {
    if (byKey.has(key)) {
      prioritized.push(byKey.get(key));
    }
  }

  for (const type of types) {
    if (!order.includes(type.key)) {
      prioritized.push(type);
    }
  }

  return prioritized;
}

function evaluateRule(rule, context) {
  const metrics = {
    overallGrade: context.overallGrade,
  };

  const results = (rule.conditions ?? []).map((condition) => {
    const evaluated = evaluateCondition(condition, context);
    if (condition.metric) {
      metrics[condition.metric] = evaluated.value;
    }
    return evaluated.pass;
  });

  return {
    pass: results.length > 0 && results.every(Boolean),
    metrics,
  };
}

export function evaluateProfile({ axisGrades, scoreByKey, averageScore, previousEvaluation }, config) {
  const context = {
    axisGrades,
    scoreByKey,
    averageScore,
    overallGrade: scoreToGrade(averageScore, config),
    previousScoreByKey: previousEvaluation?.scoreByKey ?? null,
    previousAverageScore: previousEvaluation?.average?.averageScore ?? null,
  };

  const prioritizedTypes = getPrioritizedTypes(config);
  const matchedType = prioritizedTypes.find((type) => evaluateRule(type, context).pass);
  const selectedType = matchedType
    ?? prioritizedTypes.find((type) => type.key === config.profileRules.fallbackTypeKey)
    ?? prioritizedTypes.at(-1);
  const typeEvaluation = evaluateRule(selectedType, context);

  const type = {
    key: selectedType.key,
    name: selectedType.name,
    subtitle: selectedType.subtitle,
    description: selectedType.description,
    reason: matchedType
      ? interpolate(selectedType.reasonTemplate, typeEvaluation.metrics)
      : interpolate(selectedType.fallbackReasonTemplate ?? selectedType.reasonTemplate, typeEvaluation.metrics),
  };

  const reversedRule = (config.profileRules.reversed?.rules ?? []).find((rule) => evaluateRule(rule, context).pass);
  const reversedEvaluation = reversedRule ? evaluateRule(reversedRule, context) : null;
  const reversed = {
    active: Boolean(reversedRule),
    label: config.profileRules.reversed?.label ?? 'Reversed',
    description: config.profileRules.reversed?.description ?? '',
    reason: reversedRule ? interpolate(reversedRule.reasonTemplate, reversedEvaluation.metrics) : '해당 없음',
    ruleKey: reversedRule?.key ?? null,
  };

  return {
    type,
    reversed,
    displayName: reversed.active ? `${type.name} (${reversed.label})` : type.name,
  };
}

export function evaluateCompositeType(input, config) {
  return evaluateProfile(input, config).type;
}

export function getAxisByKey(config) {
  return Object.fromEntries(config.axes.map((axis) => [axis.key, axis]));
}

export function getProfileTypeByKey(config) {
  return Object.fromEntries((config.profileRules.types ?? []).map((type) => [type.key, type]));
}
