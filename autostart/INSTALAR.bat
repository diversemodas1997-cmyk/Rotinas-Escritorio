@echo off
REM Double-clique para registrar o auto-start no Windows.
REM Nao requer Administrador.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-autostart.ps1"
echo.
pause
