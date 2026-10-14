@echo off
rem AHWR-150 EDGE: zips logs and reports for support (passwords left out) to the desktop.
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Collect-Logs.ps1" 
echo.
pause
