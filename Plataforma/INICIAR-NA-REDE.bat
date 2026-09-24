@echo off
setlocal
title Plataforma de Atendimento (acesso pela rede)

:: ===========================================================================
:: Liga o sistema e deixa o PAINEL acessivel pelos outros aparelhos do mesmo
:: Wi-Fi (celular, notebook da recepcao...). Ex: http://192.168.0.10:5173
::
:: So as telas (porta 5173) ficam abertas para a rede. A API continua
:: aceitando conexao apenas deste computador: quem fala com ela e o proprio
:: servidor das telas. Todo acesso continua pedindo login.
::
:: Sem acentos de proposito: .bat no Windows exibe acento errado.
:: ===========================================================================

cd /d "%~dp0"

set REGRA=Plataforma-Atendimento-Rede-5173

:: --- Firewall: libera a porta 5173 so em rede PRIVADA (uma vez so) ---
netsh advfirewall firewall show rule name=%REGRA% >nul 2>nul
if errorlevel 1 (
    echo.
    echo  Liberando a porta 5173 no firewall do Windows, so para redes privadas.
    echo  O Windows vai pedir permissao de administrador: clique em SIM.
    powershell -NoProfile -Command "Start-Process netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList 'advfirewall firewall add rule name=%REGRA% dir=in action=allow protocol=TCP localport=5173 profile=private,domain'"
    netsh advfirewall firewall show rule name=%REGRA% >nul 2>nul
    if errorlevel 1 (
        echo.
        echo  [AVISO] A porta nao foi liberada. O sistema vai ligar, mas outros
        echo          aparelhos podem nao conseguir abrir. Rode este arquivo de
        echo          novo e clique em SIM na permissao do Windows.
        echo.
    ) else (
        echo  Porta liberada.
    )
)

:: O resto e o INICIAR.bat de sempre, com o acesso pela rede ligado.
set ACESSO_REDE=1
call "%~dp0INICIAR.bat"
