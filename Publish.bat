@echo off
setlocal
title SVMS Mobile Publish

cd /d "%~dp0"

echo ============================================
echo SVMS Mobile - One Click Publish
echo ============================================
echo.
echo Project:
echo %CD%
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git was not found.
  echo Please make sure Git is installed.
  echo.
  pause
  exit /b 1
)

if not exist ".git" (
  echo [ERROR] This folder is not a Git project.
  echo Put Publish.bat in the same folder as app.js and index.html.
  echo.
  pause
  exit /b 1
)

echo [1/4] Adding files...
git add .
if errorlevel 1 goto :error

echo.
echo [2/4] Creating commit...
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Update SVMS Mobile"
  if errorlevel 1 goto :error
) else (
  echo No new local changes to commit.
)

echo.
echo [3/4] Syncing remote...
git pull --rebase origin main
if errorlevel 1 goto :pullerror

echo.
echo [4/4] Pushing...
git push origin main
if errorlevel 1 goto :error

echo.
echo ============================================
echo SUCCESS - SVMS Mobile published
echo ============================================
echo.
echo Cloudflare Pages will deploy automatically:
echo https://svms-mobile.pages.dev/
echo.
echo Wait a moment, then reopen the Mobile page.
echo.
pause
exit /b 0

:pullerror
echo.
echo ============================================
echo STOPPED - Git pull/rebase failed
echo ============================================
echo.
echo If you see CONFLICT, do not force push.
echo Take a screenshot of this window for checking.
echo.
pause
exit /b 1

:error
echo.
echo ============================================
echo FAILED - Publish did not complete
echo ============================================
echo.
echo Take a screenshot of this window for checking.
echo.
pause
exit /b 1
