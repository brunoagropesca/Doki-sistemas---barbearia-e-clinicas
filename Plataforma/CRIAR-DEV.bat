@echo off
title Plataforma - Criar usuario DEV

:: ===========================================================================
:: Cria o usuario DEV: um acesso TEMPORARIO para configurar as opcoes
:: especiais do sistema (por exemplo, adicionar e remover contas de WhatsApp).
::
:: Regras do DEV:
::   - Invisivel para a empresa: nao aparece em lista nenhuma.
::   - So entra enquanto ESTE ARQUIVO estiver na pasta da Plataforma. Ele e a
::     chave: apagar ou mover o CRIAR-DEV.bat tranca o DEV na hora, inclusive
::     derrubando quem ja estiver dentro.
::   - Ao clicar em "Sair", o DEV e APAGADO do banco, como se nunca tivesse
::     existido. Para configurar de novo, rode este .bat outra vez.
::   - Se o navegador for fechado sem "Sair", ele e apagado no proximo inicio
::     do sistema (depois de 1 dia sem uso).
::
:: Rodar de novo com o mesmo login, enquanto o DEV existe, so troca a senha.
:: ===========================================================================

cd /d "%~dp0api"

if not exist "node_modules\" (
    echo.
    echo  [ERRO] O sistema ainda nao foi instalado.
    echo  Rode o INICIAR.bat uma vez e depois volte aqui.
    echo.
    pause
    exit /b 1
)

:: Segredo proprio desta instalacao (o .env de fabrica e igual em todas).
:: Nao faz nada se ja foi feito. Ver api/src/db/preparar-env.js.
call npm run env:preparar --silent
if errorlevel 1 (
    pause
    exit /b 1
)

call npm run usuario:dev --silent

echo.
pause
