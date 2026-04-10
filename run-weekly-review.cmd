@echo off
setlocal
cd /d "%~dp0"

set "DASHBOARD_PATH=%~dp0generated\reports\index.html"
set "OPEN_DASHBOARD=1"

if /I "%~1"=="--no-open" (
  set "OPEN_DASHBOARD=0"
)

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
echo Dashboard: "%DASHBOARD_PATH%"

if "%OPEN_DASHBOARD%"=="1" (
  if exist "%DASHBOARD_PATH%" (
    echo Opening dashboard in your default browser...
    start "" "%DASHBOARD_PATH%"
  ) else (
    echo Dashboard file not found, skipping browser launch.
  )
) else (
  echo Dashboard auto-open is disabled: --no-open
)

goto :success

:fail
echo.
echo The G.E.R run stopped because one of the steps failed.
pause
exit /b 1

:success
exit /b 0
