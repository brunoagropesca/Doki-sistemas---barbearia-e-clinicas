@echo off
setlocal
title Plataforma de Atendimento (desenvolvimento)

:: ===========================================================================
:: Liga o sistema para quem PROGRAMA: a API com recarga automatica (--watch)
:: e as telas pelo servidor de desenvolvimento do Vite, que recarrega a tela
:: a cada arquivo salvo. E como o INICIAR.bat funcionava antes.
::
:: Na loja use o INICIAR.bat (ou o INICIAR-NA-REDE.bat): as telas ja compiladas,
:: servidas pela propria API, sem nada de desenvolvimento rodando.
::
:: Para desenvolver com acesso pela rede, rode antes: set ACESSO_REDE=1
::
:: Sem acentos de proposito: .bat no Windows exibe acento errado.
:: ===========================================================================

cd /d "%~dp0"
set MODO_DESENVOLVIMENTO=1
call "%~dp0INICIAR.bat"
