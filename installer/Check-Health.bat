@echo off
rem AHWR-150 EDGE: re-runs the installer self-test.
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Check-Health.ps1" 
echo.
pause
