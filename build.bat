@echo off
setlocal
title OSS Quick Upload - Windows Package Builder

pushd "%~dp0"

echo.
echo ============================================================
echo   OSS Quick Upload - Windows Package Builder
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js 20 or newer first.
  goto :failed
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js with npm enabled.
  goto :failed
)

if not exist "package.json" (
  echo [ERROR] package.json was not found in %CD%.
  goto :failed
)

echo [1/3] Installing locked dependencies...
call npm ci --no-audit --no-fund
if errorlevel 1 goto :failed

echo.
echo [2/3] Checking and building the application...
call npm run build
if errorlevel 1 goto :failed

echo.
echo [3/3] Creating Windows installer and portable package...
call npx electron-builder --win
if errorlevel 1 goto :failed

echo.
echo ============================================================
echo   Build completed successfully.
echo   Output: %CD%\release
echo ============================================================
echo.

if /I not "%~1"=="--no-pause" if exist "release" start "" "%CD%\release"
popd
if /I not "%~1"=="--no-pause" pause
exit /b 0

:failed
echo.
echo ============================================================
echo   Build failed. Review the error messages above.
echo ============================================================
echo.
popd
if /I not "%~1"=="--no-pause" pause
exit /b 1
