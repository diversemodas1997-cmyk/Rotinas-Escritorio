@echo off
REM Duplo-clique para ligar AGORA o assistente de bandeja (icone roxo "R"
REM ao lado do relogio). Ele traz a janela do quadro para a frente quando
REM houver alteracao. Nao requer Administrador.
wscript.exe "%~dp0tray-helper.vbs"
