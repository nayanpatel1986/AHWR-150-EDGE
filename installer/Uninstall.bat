@echo off
rem AHWR-150 EDGE: removes services and programs, keeps the data. Uninstall.bat /purge also deletes the data.
setlocal
rem Run from %TEMP%: this tools folder is deleted while the uninstaller runs.
cd /d "%TEMP%"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Uninstall.ps1" %* & echo. & pause & exit /b
