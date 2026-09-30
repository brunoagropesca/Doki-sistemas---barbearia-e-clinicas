@echo off
setlocal enabledelayedexpansion
title Plataforma de Atendimento

:: ===========================================================================
:: Liga o sistema inteiro: a API (servidor) e as telas.
::
:: Na primeira vez ele instala tudo e cria o banco, o que demora alguns
:: minutos. Nas proximas, sobe em segundos.
::
:: Sem acentos de proposito: arquivos .bat no Windows costumam exibir
:: caracteres errados quando tem acentuacao.
:: ===========================================================================

cd /d "%~dp0"

echo.
echo  ===============================================================
echo    PLATAFORMA DE ATENDIMENTO
echo  ===============================================================
echo.

:: --- 1. O Node.js esta instalado? ---
where node >nul 2>nul
if errorlevel 1 (
    echo  [ERRO] O Node.js nao foi encontrado neste computador.
    echo.
    echo  Baixe e instale a versao LTS em: https://nodejs.org
    echo  Depois FECHE esta janela e abra o INICIAR.bat de novo.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo  Node.js !NODEVER! encontrado.
echo.

:: --- 2. Libera as portas, caso tenham ficado presas ---
:: Acontece quando a janela anterior foi fechada no X em vez de Ctrl+C.
echo  [1/5] Liberando as portas 3333 e 5173...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3333" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>nul
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5173" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>nul

:: --- 3. Instala as dependencias, se ainda nao existirem ---
echo  [2/5] Conferindo as dependencias do servidor...
if not exist "api\node_modules\" (
    echo         Primeira execucao: instalando. Isso demora alguns minutos...
    pushd api
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo  [ERRO] Falha ao instalar as dependencias do servidor.
        popd
        pause
        exit /b 1
    )
    popd
) else (
    echo         Ja instaladas.
)

echo  [3/5] Conferindo as dependencias das telas...
if not exist "web\node_modules\" (
    echo         Primeira execucao: instalando...
    pushd web
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo  [ERRO] Falha ao instalar as dependencias das telas.
        popd
        pause
        exit /b 1
    )
    popd
) else (
    echo         Ja instaladas.
)

:: --- 4. Prepara o banco de dados ---
echo  [4/5] Preparando o banco de dados...
pushd api

:: O .env guarda as configuracoes. Na primeira vez ele nasce do modelo, ja com
:: um segredo PROPRIO desta maquina (o do modelo e igual em toda instalacao e
:: cifra as chaves de IA). Instalacao antiga com o segredo de fabrica: troca e
:: recifra as chaves, com backup antes. Ver api/src/db/preparar-env.js.
call npm run env:preparar --silent
if errorlevel 1 (
    echo.
    echo  [ERRO] Falha ao preparar a configuracao do .env - veja a mensagem acima.
    popd
    pause
    exit /b 1
)

if not exist "data\plataforma.db" (
    echo         Criando o banco e a empresa de demonstracao...
    call npm run db:seed
    if errorlevel 1 (
        echo.
        echo  [ERRO] Falha ao criar o banco de dados.
        popd
        pause
        exit /b 1
    )
) else (
    :: Banco ja existe: so aplica mudancas de estrutura, sem tocar nos dados.
    call npm run db:migrate >nul 2>nul
    echo         Banco ja existe e esta atualizado.
)
popd

:: --- 5. Sobe o sistema, numa unica janela com o painel de atividade ---
:: `painel.mjs` liga a API e as telas como dois processos filhos desta mesma
:: janela: a API narra cada acao (mensagem recebida, modelo que respondeu,
:: Sofia falando com a Atena) e abre o navegador sozinho quando os dois
:: estiverem no ar. Ver painel.mjs e api/src/core/painel.js.
echo  [5/5] Ligando o sistema...
echo.

node "%~dp0painel.mjs"

echo.
echo  Sistema desligado. Pode fechar esta janela.
echo.
pause
