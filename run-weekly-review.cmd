@echo off
setlocal
cd /d "%~dp0"

echo [1/3] Exporting Codex archives...
node scripts\export-codex-archives.mjs
if errorlevel 1 goto :fail

echo.
echo [2/3] Generating weekly G.E.R reports...
node scripts\generate-weekly-review.mjs
if errorlevel 1 goto :fail

echo.
echo [3/3] Building G.E.R dashboard...
node scripts\build-dashboard.mjs
if errorlevel 1 goto :fail

echo.
echo Done.
echo Latest report: "%~dp0generated\reports\LATEST.md"
echo Timeline: "%~dp0generated\reports\TIMELINE.md"
echo Dashboard: "%~dp0generated\reports\index.html"
goto :end

:fail
echo.
echo The G.E.R run stopped because one of the steps failed.

:end
pause
