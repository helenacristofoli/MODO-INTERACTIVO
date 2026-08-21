@echo off
:: ============================================================
:: INICIAR_BRIDGE.bat
:: Arranca el bridge WebSocket y el servidor HTTPS de la tablet.
:: Doble clic para iniciar. Cerrar las ventanas para detener.
:: ============================================================

title MODO Kiosk — Iniciando...
color 0A

echo.
echo  ██████████████████████████████████████
echo        MODO Kiosk — Sistema Bridge
echo  ██████████████████████████████████████
echo.
echo  Iniciando servicios...
echo.

:: ── Verificar que Node.js esté instalado ──────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  [ERROR] Node.js no está instalado.
    echo  Descargalo desde: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: ── Ir a la carpeta del bridge ────────────────────────────────
cd /d C:\bridge

:: ── Verificar que node_modules exista ────────────────────────
if not exist "node_modules\" (
    echo  [INFO] Primera vez: instalando dependencias...
    echo  (Esto solo pasa una vez, toma un minuto)
    echo.
    npm install
    if %errorlevel% neq 0 (
        color 0C
        echo  [ERROR] Fallo npm install. Verifica tu conexion a internet.
        pause
        exit /b 1
    )
)

:: ── Abrir bridge.js en su propia ventana ──────────────────────
echo  [OK] Abriendo Bridge WebSocket...
start "MODO Bridge WebSocket" cmd /k "cd /d C:\bridge && color 0B && title MODO — Bridge WebSocket && node bridge.js"

:: Esperar 2 segundos para que el bridge arranque primero
timeout /t 2 /nobreak >nul

:: ── Abrir servidor.js en su propia ventana ───────────────────
echo  [OK] Abriendo Servidor HTTPS (tablet)...
start "MODO Servidor HTTPS" cmd /k "cd /d C:\bridge && color 0E && title MODO — Servidor HTTPS Tablet && node servidor.js"

:: ── Mensaje final ─────────────────────────────────────────────
echo.
echo  ████████████████████████████████████████████████
echo   Sistema iniciado. Puedes cerrar esta ventana.
echo.
echo   Para DETENER: cierra las otras dos ventanas
echo   (Bridge WebSocket y Servidor HTTPS Tablet)
echo  ████████████████████████████████████████████████
echo.

timeout /t 4 /nobreak >nul
exit