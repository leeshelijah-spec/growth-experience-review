# Growth Experience Review (G.E.R)

Growth Experience Review (G.E.R) is a small standalone project for non-developers who use Codex regularly and want a weekly mentoring view of their work.

It does three things:

1. Converts Codex archived session `.jsonl` files into readable Markdown.
2. Analyzes those Markdown files into weekly mentoring reports.
3. Builds an HTML dashboard so the latest report, growth trend, and past reports are easy to review in one place.

## Why this project exists

This repository is meant to be portable. You can move the entire folder out of `omo` and keep using it as a separate project.

Personal output files are not included in version control by default. The generated reports stay in `generated/` on your machine so you can publish the tool without publishing your private session history.

## Folder structure

- `scripts/`: the Node.js scripts that run the workflow
- `generated/archived_sessions_md/`: exported Markdown sessions
- `generated/reports/`: generated weekly reports and dashboard
- `run-weekly-review.cmd`: double-click entry point for Windows
- `RELEASING.md`: practical GitHub release checklist

## Requirements

- Windows
- Node.js 20 or newer
- Codex archived sessions stored in `C:\Users\<you>\.codex\archived_sessions`

## Quick start

If you prefer the easiest path, double-click:

```cmd
run-weekly-review.cmd
```

Or run the steps manually:

```powershell
npm run export
npm run report
npm run dashboard
```

Or all at once:

```powershell
npm run weekly
```

## What gets generated

After a run, you can open:

- `generated/reports/LATEST.md`
- `generated/reports/TIMELINE.md`
- `generated/reports/weekly/YYYY-Www.md`
- `generated/reports/index.html`

## Mentoring focus

G.E.R scores six habits that matter for practical Codex usage:

- request clarity
- background/context sharing
- step-by-step workflow
- verification habit
- recovery when blocked
- weekly review habit

The dashboard compares:

- selected week
- previous week
- overall average

## GitHub-ready notes

- This project is separated from `omo` so it can become its own repository.
- Generated reports are ignored by default to protect private history.
- A public license has not been chosen yet. Pick one before publishing publicly.
- Release steps are documented in [RELEASING.md](RELEASING.md).
