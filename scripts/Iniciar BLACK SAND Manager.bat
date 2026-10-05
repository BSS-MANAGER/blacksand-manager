@echo off
setlocal
title BLACK SAND Manager
cd /d "%~dp0.."

where pnpm >nul 2>nul
if errorlevel 1 (
    echo No se encontro "pnpm" en este equipo.
    echo Instala Node.js primero: https://nodejs.org
    echo Despues instala pnpm abriendo una terminal y escribiendo: npm install -g pnpm
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Primera vez que se abre la app: instalando dependencias del proyecto...
    echo Esto puede tardar varios minutos, solo pasa una vez.
    echo.
    call pnpm install
    if errorlevel 1 (
        echo.
        echo La instalacion de dependencias fallo. Revisa el mensaje de arriba.
        pause
        exit /b 1
    )
)

echo Iniciando BLACK SAND Manager...
echo (Esta ventana debe quedar abierta mientras uses la app. Cierrala para salir.)
echo.
call pnpm run dev:desktop

if errorlevel 1 (
    echo.
    echo BLACK SAND Manager se cerro con un error. Revisa el mensaje de arriba.
    pause
)

endlocal
