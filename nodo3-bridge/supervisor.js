// supervisor.js
// Lanza bridge.js y servidor.js como procesos hijos y los reinicia
// automáticamente si alguno se cae inesperadamente.
//
// Es el mismo patrón que un proceso padre en C: fork() + waitpid(),
// y si el hijo termina solo (no porque el padre lo mató), se vuelve
// a lanzar. Acá "child_process.spawn" hace de fork(), y el evento
// "exit" hace de waitpid().
//
// Uso: node supervisor.js
// (reemplaza correr "node bridge.js" y "node servidor.js" en dos
// terminales separadas -- ahora es UNA terminal, este archivo)
//
// Para parar todo: Ctrl+C en esta terminal. El supervisor se encarga
// de matar a los dos hijos antes de cerrar.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// ── Configuración ────────────────────────────────────────────────
// Cuántas veces puede reiniciarse un proceso en VENTANA_MS antes de
// que el supervisor se rinda con ese proceso. Sin este límite, un
// proceso que crashea apenas arranca (ej. error de sintaxis, config
// mal escrita) reiniciaría en loop infinito sin que nadie se entere
// de que hay un problema real de fondo.
const MAX_REINICIOS = 5;
const VENTANA_MS = 60000; // 1 minuto
const ESPERA_ANTES_DE_REINICIAR_MS = 2000;

// Cuánto esperar después de detectar un cambio en config.json antes de
// reiniciar -- algunos editores (VS Code incluido, a veces) disparan
// varios eventos "change" seguidos al guardar un solo archivo. Sin este
// debounce, un solo Ctrl+S podría disparar 2-3 reinicios pisándose.
const DEBOUNCE_CONFIG_MS = 500;

// Los procesos a supervisar. "nombre" es solo para los logs.
const PROCESOS = [
    { nombre: "BRIDGE", script: "bridge.js" },
    { nombre: "SERVIDOR", script: "servidor.js" },
];

// ── Estado interno ───────────────────────────────────────────────
// Por cada proceso, guardamos el handle del child y el historial de
// timestamps de reinicios recientes (para el límite de arriba).
const estado = new Map();

let cerrandoTodo = false; // true cuando el supervisor mismo está terminando (Ctrl+C)

function logConPrefijo(nombre, linea) {
    // Cada línea que imprime el hijo sale con su nombre adelante,
    // así en una sola terminal se distingue qué proceso dijo qué.
    process.stdout.write(`[${nombre}] ${linea}`);
}

function lanzarProceso(config) {
    const { nombre, script } = config;

    const hijo = spawn("node", [script], {
        cwd: __dirname, // corre siempre desde la carpeta de este archivo (C:\bridge)
    });

    // Guardamos/actualizamos el estado de este proceso
    if (!estado.has(nombre)) {
        estado.set(nombre, { historialReinicios: [] });
    }
    estado.get(nombre).handle = hijo;

    console.log(`[SUPERVISOR] ${nombre} iniciado (pid ${hijo.pid})`);

    // Reenviar stdout/stderr del hijo con su prefijo, línea por línea
    hijo.stdout.on("data", (datos) => {
        datos.toString().split("\n").forEach((linea) => {
            if (linea.trim() !== "") logConPrefijo(nombre, linea + "\n");
        });
    });

    hijo.stderr.on("data", (datos) => {
        datos.toString().split("\n").forEach((linea) => {
            if (linea.trim() !== "") logConPrefijo(nombre, linea + "\n");
        });
    });

    // Acá es donde pasa la magia: si el proceso termina y NO fue
    // porque el supervisor lo estaba cerrando a propósito, lo
    // reiniciamos -- salvo que se haya pasado del límite.
    hijo.on("exit", (codigo, señal) => {
        if (cerrandoTodo) return; // el supervisor está cerrando todo, no reiniciar nada

        console.warn(
            `[SUPERVISOR] ${nombre} se cerró (código ${codigo}, señal ${señal}). ` +
            `Reintentando en ${ESPERA_ANTES_DE_REINICIAR_MS / 1000}s...`
        );

        const info = estado.get(nombre);
        const ahora = Date.now();

        // Descartamos reinicios viejos (fuera de la ventana de tiempo)
        info.historialReinicios = info.historialReinicios.filter(
            (t) => ahora - t < VENTANA_MS
        );
        info.historialReinicios.push(ahora);

        if (info.historialReinicios.length > MAX_REINICIOS) {
            console.error(
                `\n[SUPERVISOR] ${nombre} se cayó ${MAX_REINICIOS} veces en menos de ` +
                `${VENTANA_MS / 1000}s. Algo está mal de fondo (config, certificado, ` +
                `puerto ocupado, etc.) -- dejo de reintentar. Revisá los logs de arriba ` +
                `y arrancalo a mano cuando esté resuelto: node ${config.script}\n`
            );
            return; // no reintenta más -- el otro proceso sigue corriendo igual
        }

        setTimeout(() => lanzarProceso(config), ESPERA_ANTES_DE_REINICIAR_MS);
    });
}

// ── Arranque ──────────────────────────────────────────────────────
console.log("[SUPERVISOR] Iniciando bridge.js y servidor.js...\n");
PROCESOS.forEach(lanzarProceso);

// ── Vigilar config.json y reiniciar solo cuando cambia ────────────
// Resuelve el "gotcha" de que bridge.js y servidor.js leen config.json
// una sola vez al arrancar (require() lo cachea) -- antes había que
// acordarse de reiniciar a mano cada vez que se editaba. Ahora, editar
// y guardar config.json alcanza: el supervisor lo nota y reinicia los
// dos procesos solo, ellos vuelven a leer el archivo actualizado.
const RUTA_CONFIG_VIGILADA = path.join(__dirname, "config.json");
let debounceConfig = null;

function reiniciarTodosPorCambioDeConfig() {
    console.log("\n[SUPERVISOR] config.json cambió -- reiniciando bridge.js y servidor.js para aplicar los cambios...\n");
    for (const [, info] of estado) {
        if (info.handle && !info.handle.killed) {
            // No marcamos cerrandoTodo=true: esto NO es un apagado del
            // supervisor, es un reinicio intencional. El listener "exit"
            // de cada proceso ya se encarga de relanzarlo solo (mismo
            // camino que un crash normal).
            info.handle.kill();
        }
    }
}

fs.watch(RUTA_CONFIG_VIGILADA, (tipoEvento) => {
    if (tipoEvento !== "change") return;
    clearTimeout(debounceConfig);
    debounceConfig = setTimeout(reiniciarTodosPorCambioDeConfig, DEBOUNCE_CONFIG_MS);
});

console.log(`[SUPERVISOR] Vigilando cambios en ${RUTA_CONFIG_VIGILADA}`);

// ── Apagado prolijo con Ctrl+C ──────────────────────────────────
// Sin esto, Ctrl+C mataría el supervisor pero podría dejar a los
// hijos corriendo huérfanos en segundo plano.
process.on("SIGINT", () => {
    cerrandoTodo = true;
    console.log("\n[SUPERVISOR] Cerrando bridge.js y servidor.js...");

    for (const [nombre, info] of estado) {
        if (info.handle && !info.handle.killed) {
            info.handle.kill();
        }
    }

    setTimeout(() => process.exit(0), 500);
});