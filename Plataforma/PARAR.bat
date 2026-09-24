@echo off
title Parar a Plataforma

:: ===========================================================================
:: Desliga o sistema.
::
:: Fechar as janelas no X nem sempre encerra o programa por tras delas - e
:: dai vem o erro "porta ja esta em uso" na proxima vez. Este arquivo
:: encerra pelas portas, que e o jeito que funciona sempre.
:: ===========================================================================

echo.
echo  Desligando a Plataforma...
echo.

set ENCONTROU=0

:: Os parenteses no texto do `echo` precisam ser escapados com ^.
:: Dentro de um bloco `do ( ... )`, um ) solto fecha o bloco antes da hora e
:: o cmd reclama com a mensagem enigmatica "foi inesperado neste momento".
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3333" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>nul
    echo  Servidor ^(porta 3333^) encerrado.
    set ENCONTROU=1
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5173" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>nul
    echo  Telas ^(porta 5173^) encerradas.
    set ENCONTROU=1
)

if "%ENCONTROU%"=="0" echo  Nada estava rodando.

echo.
echo  Pronto. Pode fechar as janelas pretas que sobraram.
echo.
ping -n 4 127.0.0.1 >nul
