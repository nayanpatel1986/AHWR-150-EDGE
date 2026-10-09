@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-AHWR-EDGE.ps1"
if errorlevel 1 (
  echo.
  echo AHWR-EDGE could not start. Review the message above and logs folder.
  pause
)
