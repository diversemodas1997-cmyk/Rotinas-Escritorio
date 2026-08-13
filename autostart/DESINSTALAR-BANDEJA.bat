@echo off
REM Duplo-clique para desativar o assistente de bandeja e encerra-lo agora.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0desinstalar-bandeja.ps1"
echo.
pause
