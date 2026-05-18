@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "SERVER_DIR=%PROJECT_ROOT%\server"
set "LOG_FILE=%SCRIPT_DIR%server.log"
set "NODE_ENV=production"

set "NODE_EXE="
for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"

if not defined NODE_EXE (
    echo [%date% %time%] ERRO: node.exe nao encontrado no PATH nem em Program Files. >> "%LOG_FILE%"
    exit /b 1
)

cd /d "%SERVER_DIR%"
echo. >> "%LOG_FILE%"
echo [%date% %time%] Iniciando servidor com %NODE_EXE% >> "%LOG_FILE%"
"%NODE_EXE%" index.js >> "%LOG_FILE%" 2>&1
