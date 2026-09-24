@echo off
title Plataforma - Gerar serial de licenca

:: ===========================================================================
:: Gera o serial de licenca de um cliente. USO EXCLUSIVO DO FORNECEDOR.
::
:: So funciona no computador que tem a chave privada
:: (%USERPROFILE%\.doki-licencas\chave-privada.pem). Na primeira vez, cria
:: essa chave: FACA UMA COPIA DE SEGURANCA DELA. Sem ela, nao ha como
:: renovar a licenca de nenhum cliente.
::
:: NAO envie este arquivo nem a pasta .doki-licencas para clientes.
::
:: Como usar: o cliente le o "codigo da instalacao" que aparece na tela de
:: licenca dele; voce roda este .bat, informa o codigo, o nome e a validade
:: (ou P para permanente) e manda o serial gerado por WhatsApp.
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

call npm run licenca:gerar --silent

echo.
pause
