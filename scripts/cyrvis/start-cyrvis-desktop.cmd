@echo off
setlocal
rem Resolve repo root from this script: scripts/cyrvis -> ../..
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%\..\.."
if exist "%APPDATA%\npm" set "PATH=%APPDATA%\npm;%PATH%"
if exist "%ProgramFiles%\nodejs" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles%\Git\cmd" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
call pnpm run dev:ui-tars
endlocal
