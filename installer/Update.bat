@echo off
rem AHWR-150 EDGE: installs this newer version over an installed edge, keeping all data. Run from the NEW installer folder.
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Update.ps1" 
echo.
pause
