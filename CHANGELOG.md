# Changelog

## 2026-04-10

- Added dashboard favicon links and bundled [config/favicon.ico](./config/favicon.ico) so browser tabs show a project icon.
- Updated `run-weekly-review.cmd` to auto-open the generated dashboard by default and support `--no-open` for report-only runs.
- Refined radar tooltip behavior so tooltips stay centered inside the chart surface and label tooltips show axis name plus description.
- Increased tooltip readability with larger type, stronger weight, wider container sizing, and spacing tuned for Korean copy.
- Tightened dashboard layout density by adjusting scale, panel spacing, radar area proportions, and report picker placement.
- Expanded detailed report rendering with explicit strength/weakness action sections driven by axis-based guidance helpers.
- Removed outdated [RELEASING.md](./RELEASING.md) release instructions from the repository root.

## 2026-04-06

- Split the mentoring workflow into a standalone project folder.
- Added GitHub-ready packaging files and release notes.
- Renamed the product to Growth Experience Review (G.E.R).
- Kept generated reports local by default through `.gitignore`.

## 2026-04-07

- Reworked the evaluation structure around six fixed axes, internal scores, and A-E display grades.
- Introduced a rule-based representative type system with six fixed profile types.
- Added a dedicated `Reversed` warning layer instead of expanding the taxonomy into twelve types.
- Moved type definitions, priorities, and reversed rules into [config/profile-rules.json](./config/profile-rules.json).
- Moved axis labels, descriptions, and grade criteria into [config/ratings.json](./config/ratings.json).
- Added the shared evaluation engine in [scripts/lib/evaluation-config.mjs](./scripts/lib/evaluation-config.mjs).
- Updated weekly report generation to include representative type, reversed state, and explicit reasoning.
- Updated the dashboard to display the representative type card, reversed state, and timeline integration.
- Tuned type thresholds against actual weekly data to reduce over-classification into `Fool`.

## 2026-04-08

- Refined the dashboard type card to display `Type - Subtitle` in one line and show `Type Reason` plus `Reversed` side by side.
- Added type-specific page themes:
  - `Hierophant`: green
  - `Magician`: red
  - `Star`: platinum
  - `Hermit`: purple
  - `Chariot`: silver
  - `Fool`: gold
- Reworked the axis grade comparison cards into a 2-column comparison layout with grade-first emphasis and score-on-second-line formatting.
- Updated the radar chart so axis labels show the current letter grade and expose grade-building criteria through tooltips.
- Added a `This Week` radar toggle so the current polygon can be turned on and off like other overlays.
- Renamed point tooltip labels to `이번주 / 지난주 / 전체평균` style in the dashboard UI for consistency.
- Rebuilt the detail modal so the action buttons sit above the report title and the week selector opens as a scrollable popup list.
- Reordered the detailed report view to show `한 줄 진단 -> 타입 판정 -> 이번 주 활동 요약 -> 6축 평가 결과`.
- Converted weekly activity summaries into a table format for better readability.
- Reformatted evaluation reasons so parenthetical evidence wraps onto a new line.
- Moved the type reference guide out of weekly reports and into a dedicated dashboard popup launched from the main type card.
- Scaled the overall dashboard layout to 85% while keeping proportions intact.
- Replaced most leftover gold-toned fixed UI colors with theme-driven variables so non-Fool profiles shift the full interface mood more aggressively.
