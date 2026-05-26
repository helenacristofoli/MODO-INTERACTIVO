// ============================================================
// CONFIGURACIÓN GLOBAL
// ============================================================

const CONFIG = {
    IP_CAJA:      "192.168.100.6",
    PUERTO_CAJA:  8000,
    IP_BRIDGE:    "192.168.100.6",
    PUERTO_BRIDGE: 8080,
};

// ============================================================
// MAPEO DE LAYERS → PRESETS OSC
//
// Cada layer tiene sus clips en Resolume:
//   Layer 01 Visuales  → layer 1, clips 1-4
//   Layer 02 Efectos   → layer 2, clips 5-8
//   Layer 03 Color     → layer 3, clips 9-10
//
// El "preset" que se envía al bridge es el número de clip.
// Análogía C: es como un enum con offset por sección.
// ============================================================

const OSC_MAP = {
    visual:  [1, 2, 3, 4],
    effects: [5, 6, 7, 8],
    color:   [9, 10],
};

const OSC_LAYER = {
    visual:  1,
    effects: 2,
    color:   3,
};

const ETIQUETAS = {
    visual:  ["ESTADIO", "CAMPO",  "TROFEO",  "MULTITUD"],
    effects: ["GLITCH",  "STROBE", "BLUR",    "MIRROR"],
    color:   ["DORADO",  "VERDE"],
};

// Estado de selección — una por layer, null = sin selección
const estado = {
    visual:  null,
    effects: null,
    color:   null,
};

// ============================================================
// REFERENCIAS HTML
// ============================================================

const pantallas = {
    scanner:      document.getElementById("pantalla-scanner"),
    menu:         document.getElementById("pantalla-menu"),
    confirmacion: document.getElementById("pantalla-confirmacion"),
};

const elementoVideo  = document.getElementById("camara");
const elementoCanvas = document.getElementById("canvas");
const mensajeScanner = document.getElementById("mensaje-scanner");
const ctx            = elementoCanvas.getContext("2d");

let codigoActual = null;

// ── Sesión con temporizador ──────────────────────────────────
const DURACION_SESION = 60;   // segundos — cambiá este número para ajustar
let temporizadorSesion = null; // como un file descriptor: null = sin sesión activa
let segundosRestantes  = 0;

const barraProgreso  = document.getElementById("progreso-tiempo");
const contadorTiempo = document.getElementById("contador-tiempo");

// ============================================================
// NAVEGACIÓN ENTRE PANTALLAS
// ============================================================

function mostrarPantalla(nombre) {
    for (const clave in pantallas) {
        pantallas[clave].classList.remove("activa");
    }
    pantallas[nombre].classList.add("activa");
}

// ============================================================
// PARTE 1: CÁMARA Y LECTURA DE QR
// ============================================================

async function iniciarCamara() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: "user", // cámara frontal (selfie)
            }
        });

        elementoVideo.srcObject = stream;

        elementoVideo.addEventListener("loadedmetadata", () => {
            elementoVideo.play();
            leerFrames();
        });

    } catch (error) {
        mensajeScanner.textContent = "Error: no se pudo acceder a la cámara.";
        console.error("Error de cámara:", error);
    }
}

async function leerFrames() {
    if (elementoVideo.readyState === elementoVideo.HAVE_ENOUGH_DATA) {

        elementoCanvas.height = elementoVideo.videoHeight;
        elementoCanvas.width  = elementoVideo.videoWidth;
        ctx.drawImage(elementoVideo, 0, 0);

        const imageData = ctx.getImageData(
            0, 0,
            elementoCanvas.width,
            elementoCanvas.height
        );

        const qrDetectado = jsQR(
            imageData.data,
            imageData.width,
            imageData.height,
            { inversionAttempts: "dontInvert" }
        );

        if (qrDetectado) {
            codigoActual = qrDetectado.data;
            console.log("QR detectado:", codigoActual);

            const resultado = await validarCodigo(codigoActual);

            if (resultado === true) {
                console.log("Código válido, mostrando menú");
                mostrarPantalla("menu");
                iniciarSesion();

            } else if (resultado === false) {
                mensajeScanner.textContent = "Código inválido. Intentá de nuevo.";
                codigoActual = null;
                setTimeout(() => {
                    mensajeScanner.textContent = "Apuntá la cámara al código QR";
                    requestAnimationFrame(leerFrames);
                }, 2000);

            } else {
                // null = error de red
                codigoActual = null;
                setTimeout(() => {
                    mensajeScanner.textContent = "Apuntá la cámara al código QR";
                    requestAnimationFrame(leerFrames);
                }, 3000);
            }

            return;
        }
    }

    requestAnimationFrame(leerFrames);
}

// ============================================================
// PARTE 2: VALIDACIÓN HTTP
// ============================================================

async function validarCodigo(codigo) {
    const url = `http://${CONFIG.IP_CAJA}:${CONFIG.PUERTO_CAJA}/validate?code=${codigo}`;

    try {
        mensajeScanner.textContent = "Validando...";

        const respuesta = await fetch(url);
        const texto     = await respuesta.text();

        if (texto.trim() === "válido") {
            return true;
        } else {
            return false;
        }

    } catch (error) {
        console.error("Error de red al validar:", error);
        mensajeScanner.textContent = "Error: no se pudo conectar con la caja.";
        return null;
    }
}

// ============================================================
// PARTE 3: WEBSOCKET AL BRIDGE
// ============================================================

let ws                = null;
let heartbeatInterval = null;

function conectarBridge() {
    const url = `wss://${CONFIG.IP_BRIDGE}:${CONFIG.PUERTO_BRIDGE}`;
    console.log("Conectando al bridge:", url);

    ws = new WebSocket(url);

    ws.onopen = () => {
        console.log("Bridge conectado");
        clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "ping" }));
                console.log("Heartbeat enviado");
            }
        }, 30000);
    };

    ws.onerror = (error) => {
        console.warn("Bridge no disponible:", error);
    };

    ws.onclose = () => {
        console.log("Bridge desconectado — reconectando en 5 segundos...");
        clearInterval(heartbeatInterval);
        setTimeout(conectarBridge, 5000);
    };
}

// -- Enviar preset al bridge --
//
// Ahora el payload incluye layer y ruta OSC además del código,
// para que el bridge sepa exactamente qué clip activar en Resolume.

function enviarPreset(layer, idx) {
    const clip     = OSC_MAP[layer][idx];
    const numLayer = OSC_LAYER[layer];
    const rutaOSC  = `/layer/${numLayer}/clip/${clip}/connect`;

    const mensaje = JSON.stringify({
        preset:  clip,
        layer:   numLayer,
        osc:     rutaOSC,
        code:    codigoActual,
    });

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(mensaje);
        console.log("Preset enviado:", mensaje);
    } else {
        // Bridge no conectado — funciona igual durante desarrollo
        console.warn("Bridge no conectado — preset no enviado:", rutaOSC);
    }
}

// ============================================================
// PARTE 4: LÓGICA DE SELECCIÓN DE LAYERS
//
// Cada layer es independiente: el usuario elige uno por fila.
// Tap en el mismo botón lo deselecciona.
// La activación es inmediata — sin botón de confirmar.
// ============================================================

function manejarBoton(btn) {
    const layer = btn.dataset.layer;
    const idx   = parseInt(btn.dataset.idx);
    const clase = `sel-${layer}`;

    // Quitar selección anterior de este layer
    document.querySelectorAll(`[data-layer="${layer}"]`).forEach(b => {
        b.classList.remove(clase);
    });

    // Toggle: si ya estaba seleccionado, deseleccionar sin enviar OSC
    if (estado[layer] === idx) {
        estado[layer] = null;
        actualizarStatus(layer, null);
        return;
    }

    // Nueva selección: marcar, actualizar status y enviar
    estado[layer] = idx;
    btn.classList.add(clase);
    actualizarStatus(layer, idx);
    enviarPreset(layer, idx);
}

function actualizarStatus(layer, idx) {
    const el = document.getElementById(`status-${layer}`);

    if (idx === null) {
        el.textContent = "SIN SELECCIÓN";
        el.classList.remove("activo");
    } else {
        el.textContent = "● " + ETIQUETAS[layer][idx];
        el.classList.add("activo");
    }
}


// ============================================================
// SESIÓN CON TEMPORIZADOR
//
// Equivale a un alarm() en C — dispara una acción después de N segundos.
// setInterval() llama a la función cada 1000 ms (1 segundo).
// clearInterval() cancela el interval, como cancelar un alarm().
// ============================================================

function iniciarSesion() {
    segundosRestantes = DURACION_SESION;
    actualizarBarraTiempo();

    // Cancela cualquier sesión previa que pueda estar corriendo
    if (temporizadorSesion !== null) {
        clearInterval(temporizadorSesion);
    }

    // Dispara cada 1 segundo
    temporizadorSesion = setInterval(() => {
        segundosRestantes -= 1;
        actualizarBarraTiempo();

        if (segundosRestantes <= 0) {
            finalizarSesion();
        }
    }, 1000);
}

function actualizarBarraTiempo() {
    // Porcentaje restante — igual que calcular un porcentaje en C
    const porcentaje = (segundosRestantes / DURACION_SESION) * 100;
    barraProgreso.style.width = porcentaje + "%";
    contadorTiempo.textContent = segundosRestantes + "s";

    // Últimos 10 segundos: barra roja como advertencia
    if (segundosRestantes <= 10) {
        barraProgreso.classList.add("urgente");
    } else {
        barraProgreso.classList.remove("urgente");
    }
}

function finalizarSesion() {
    // Detener el interval
    clearInterval(temporizadorSesion);
    temporizadorSesion = null;

    // Limpiar toda la selección de los 3 layers
    estado.visual  = null;
    estado.effects = null;
    estado.color   = null;

    document.querySelectorAll(".btn-preset").forEach(b => {
        b.classList.remove("sel-visual", "sel-effects", "sel-color");
    });

    ["visual", "effects", "color"].forEach(l => actualizarStatus(l, null));

    // Limpiar el código validado y volver al scanner
    codigoActual = null;
    mensajeScanner.textContent = "Apuntá la cámara al código QR";
    mostrarPantalla("scanner");
    requestAnimationFrame(leerFrames);
}

// ============================================================
// REGISTRO DE EVENTOS
// ============================================================

function registrarBotones() {
    // Botones de preset — los 3 layers
    document.querySelectorAll(".btn-preset").forEach(btn => {
        btn.addEventListener("click", () => manejarBoton(btn));
    });

    // Botón de reinicio en pantalla de confirmación
document.getElementById("btn-reiniciar").addEventListener("click", () => {
    finalizarSesion();
});
}

// ============================================================
// PUNTO DE ENTRADA
// ============================================================

registrarBotones();
conectarBridge();
iniciarCamara();