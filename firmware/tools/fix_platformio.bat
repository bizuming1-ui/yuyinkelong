@echo off
rem Double-click to repair a polluted PlatformIO framework (see fix_platformio.ps1). Close VSCode first.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix_platformio.ps1" %*
echo.
pause
