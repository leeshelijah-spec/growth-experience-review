# Growth Experience Review (G.E.R)

[한국어 문서 보기](./README.ko.md)

### *"This story is the tale of me starting to walk the path of vibe coding."*

Growth Experience Review analyzes archived Codex sessions by week and produces reports plus a dashboard that combine six evaluation axes, internal scores, A-E grades, a single representative profile type, and an optional `Reversed` warning layer.

## Overview

- The evaluation axes are fixed at six:
  - `Clarity`
  - `Context Provision`
  - `Procedure Design`
  - `Verifiability`
  - `Recovery`
  - `Retrospective Continuity`
- Each axis is scored on a `0-100` internal scale and then mapped to an `A-E` display grade.
- The representative type is selected by explicit rule-based logic, not free-form interpretation.
- `Reversed` is not a separate type. It is a warning state layered on top of the current type when structural risk is detected.

## The Six Fixed Types(Tarot cards based)

- `Fool`: exploratory mode with active trial-and-error and direction finding
- `Magician`: execution mode that turns requests into concrete output
- `Chariot`: drive-oriented mode with speed and momentum, but possible verification gaps
- `Hermit`: reflective mode with stronger analysis, review, and depth
- `Hierophant`: systemizing mode focused on rules, standards, reusable process, and operating structure
- `Star`: growth-oriented mode that emphasizes long-term improvement, direction, and sustained progress

The system does not expand the taxonomy into twelve reversed types. The type always describes the main working style of the week.

## Reversed

- `Reversed` is a warning layer, not a profile category.
- It signals structural weakness, redesign pressure, or a high risk of continuing the same approach unchanged.
- Results should be read as `type + reversed state + reasoning`.

Examples:

- `Magician`
- `Magician (Reversed)`

## Rule Sources

- Axis labels, descriptions, grade criteria, and score bands:
  - [config/ratings.json](./config/ratings.json)
- Fixed type list, descriptions, priority order, and type classification rules:
  - [config/profile-rules.json](./config/profile-rules.json)
- `Reversed` description and trigger conditions:
  - [config/profile-rules.json](./config/profile-rules.json)
- Shared scoring and profile evaluation engine:
  - [scripts/lib/evaluation-config.mjs](./scripts/lib/evaluation-config.mjs)

## Outputs

- Weekly report generator:
  - [scripts/generate-weekly-review.mjs](./scripts/generate-weekly-review.mjs)
- HTML dashboard generator:
  - [scripts/build-dashboard.mjs](./scripts/build-dashboard.mjs)
- Generated artifacts:
  - [generated/reports/LATEST.md](./generated/reports/LATEST.md)
  - [generated/reports/TIMELINE.md](./generated/reports/TIMELINE.md)
  - [generated/reports/index.html](./generated/reports/index.html)
  - [generated/reports/weekly](./generated/reports/weekly)

## Dashboard Notes

- The top card separates the representative type from the `Reversed` warning state.
- The page theme changes by representative type.
- Axis labels on the radar chart expose grade-building criteria through tooltips.
- Radar tooltips are fixed at the visual center of the chart area and use larger typography for quicker reading.
- The detail modal reorganizes each weekly report into a cleaner dashboard-oriented layout.
- Type reference guidance is shown from the main dashboard through a dedicated popup instead of being repeated in every weekly report.

## Run

```powershell
npm run export
npm run report
npm run dashboard
```

Run everything in sequence:

```powershell
npm run weekly
```

Double-click entry point on Windows:

```powershell
run-weekly-review.cmd
```

- On success, the dashboard (`generated/reports/index.html`) opens automatically in your default browser.
- To generate reports without opening the browser, use `run-weekly-review.cmd --no-open`.

## Verification

1. Run `npm run report`.
2. Run `npm run dashboard`.
3. Check the following:

- Every week resolves to one of the six fixed types.
- `Reversed` appears only as a warning layer.
- Weekly reports include type reasoning and reversed reasoning.
- The dashboard keeps type, warning state, and evidence visually separated.
- Timeline and week-to-week comparisons continue to work.

## Change History

- See [CHANGELOG.md](./CHANGELOG.md) for date-based changes through April 10, 2026.

## Special thanks 

- [fivetaku/vibe-sunsang](https://github.com/fivetaku/vibe-sunsang) for the inspiration.
