@echo off
REM Duplo-clique para o assistente de bandeja subir sozinho a cada logon.
REM Nao requer Administrador.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-bandeja.ps1"
echo.
pause
