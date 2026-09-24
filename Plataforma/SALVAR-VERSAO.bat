@echo off
setlocal enabledelayedexpansion
title Salvar versao do projeto

:: ===========================================================================
:: Salva uma "foto" do projeto no Git.
::
:: Pense no Git como um album de fotos do seu codigo. Cada vez que voce roda
:: este arquivo, ele tira uma foto de como tudo esta agora. Se amanha algo
:: quebrar, da pra voltar para qualquer foto anterior.
::
:: O que NAO entra nas fotos: suas senhas (.env), o banco de dados e as
:: bibliotecas baixadas. Isso esta definido no arquivo .gitignore.
:: ===========================================================================

cd /d "%~dp0"

:: O Git nem sempre esta no PATH logo apos a instalacao (o terminal precisa
:: ser reaberto para enxergar). Procuramos onde ele costuma ficar e
:: acrescentamos a PASTA ao PATH desta janela.
::
:: Por que a pasta, e nao o caminho do .exe numa variavel: "C:\Program Files"
:: tem espaco no nome, e um caminho entre aspas dentro de `for /f` quebra o
:: comando (o cmd le so ate o espaco). Ajustar o PATH evita isso de vez.
where git >nul 2>nul
if errorlevel 1 (
    if exist "C:\Program Files\Git\cmd\git.exe" (
        set "PATH=C:\Program Files\Git\cmd;%PATH%"
    ) else if exist "C:\Program Files (x86)\Git\cmd\git.exe" (
        set "PATH=C:\Program Files (x86)\Git\cmd;%PATH%"
    ) else if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\Git\cmd;%PATH%"
    ) else (
        echo.
        echo  [ERRO] O Git nao foi encontrado.
        echo  Instale em https://git-scm.com e tente de novo.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo  ===============================================================
echo    SALVAR UMA VERSAO DO PROJETO
echo  ===============================================================
echo.

:: --- O que mudou desde a ultima foto? ---
for /f %%c in ('git status --porcelain ^| find /c /v ""') do set MUDANCAS=%%c

if "%MUDANCAS%"=="0" (
    echo  Nada mudou desde a ultima versao salva.
    echo  Nao ha o que guardar.
    echo.
    pause
    exit /b 0
)

echo  %MUDANCAS% arquivo^(s^) mudaram:
echo.
git status --short
echo.
echo  ---------------------------------------------------------------
echo.

:: --- Descricao da mudanca ---
echo  Descreva em poucas palavras o que voce mudou.
echo  Exemplo: ajustei o preco dos servicos
echo.
set "DESCRICAO="
set /p DESCRICAO="  O que mudou: "

if "%DESCRICAO%"=="" (
    :: Sem descricao a foto fica inutil daqui a um mes: voce ve a data e
    :: nao faz ideia do que era. Melhor uma data do que nada.
    for /f "tokens=*" %%d in ('powershell -NoProfile -Command "Get-Date -Format \"dd/MM/yyyy HH:mm\""') do set DESCRICAO=Ajustes de %%d
)

echo.
echo  Salvando...

git add -A
git commit -q -m "%DESCRICAO%"

if errorlevel 1 (
    echo.
    echo  [ERRO] Nao consegui salvar. A mensagem acima explica o motivo.
    echo.
    pause
    exit /b 1
)

echo.
echo  ===============================================================
echo    VERSAO SALVA
echo  ===============================================================
echo.
echo  Ultimas versoes guardadas:
echo.
git log --oneline -6
echo.
echo  Para VOLTAR para uma versao anterior, me peca - e uma operacao
echo  que apaga trabalho recente se for feita errado.
echo.
pause
