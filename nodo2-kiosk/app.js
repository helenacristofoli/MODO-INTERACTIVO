// ============================================================
// CONFIGURACIÓN GLOBAL
// ============================================================

const CONFIG = {
    IP_CAJA:      "192.168.100.6",
    PUERTO_CAJA:  8000,
    IP_BRIDGE:    "192.168.100.6",
    PUERTO_BRIDGE: 8080,
};

// Clave del preset idle en config.json del bridge — no es un preset
// seleccionable desde la UI, por eso vive aparte de PRESETS.
const PRESET_IDLE = "visual_idle";

// Claves de "clear" por layer — apagan la capa completa en Resolume
const CLAVES_CLEAR = {
    effects: "efecto_clear",
    color:   "color_clear",
};

// ============================================================
// PRESETS — cargados dinámicamente desde config.json
//
// Antes esto era dos arrays fijos (ETIQUETAS y OSC_MAP) escritos
// a mano en este archivo. Ahora se llenan en runtime leyendo
// config.json, igual que llenarías un array de structs con
// fread() en vez de inicializarlo en el código fuente.
//
// Estructura resultante, por layer:
//   PRESETS.visual[idx] = { id, label, thumbnail }
// ============================================================

let PRESETS = {
    visual:  [],
    effects: [],
    color:   [],
};

// IDs de los contenedores HTML donde se inyecta cada fila de botones
const CONTENEDORES = {
    visual:  "row-visual",
    effects: "row-effects",
    color:   "row-color",
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
    despedida:    document.getElementById("pantalla-despedida"),
};

const elementoVideo  = document.getElementById("camara");
const elementoCanvas = document.getElementById("canvas");
const mensajeScanner = document.getElementById("mensaje-scanner");
const ctx            = elementoCanvas.getContext("2d");

let codigoActual = null;

// ── Sesión con temporizador ──────────────────────────────────
const DURACION_SESION = 60;   // segundos — cambiá este número para ajustar
const DURACION_DESPEDIDA = 4; // TEMPORAL para diagnóstico — volver a 4 después
let temporizadorSesion = null; // como un file descriptor: null = sin sesión activa
let segundosRestantes  = 0;

const barraProgreso  = document.getElementById("progreso-tiempo");
const contadorTiempo = document.getElementById("contador-tiempo");

// ============================================================
// PARTE 0: CARGA DE CONFIG.JSON Y GENERACIÓN DE BOTONES
// ============================================================

async function cargarPresets() {
    try {
        const respuesta = await fetch("config.json");
        const datos     = await respuesta.json();

        PRESETS.visual  = datos.visual  || [];
        PRESETS.effects = datos.effects || [];
        PRESETS.color   = datos.color   || [];

        console.log("Presets cargados:", PRESETS);
        return true;

    } catch (error) {
        console.error("Error cargando config.json:", error);
        mensajeScanner.textContent = "Error de configuración. Avisa al personal.";
        return false;
    }
}

function renderizarBotones() {
    for (const layer in CONTENEDORES) {
        const contenedor = document.getElementById(CONTENEDORES[layer]);
        contenedor.innerHTML = ""; // limpia por si se vuelve a renderizar

        PRESETS[layer].forEach((preset, idx) => {
            const boton = document.createElement("button");
            boton.className = "btn-preset";
            boton.dataset.layer = layer;
            boton.dataset.idx   = idx;

            boton.innerHTML = `
                <div class="btn-frame-wrap">
                    <div class="btn-thumb" style="background-image: url('${preset.thumbnail}');"></div>
                    <img class="btn-frame" src="assets/btn_frame.png" alt="">
                </div>
                <span class="btn-label">${preset.label}</span>
            `;

            contenedor.appendChild(boton);
        });
    }
}

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
                mensajeScanner.textContent = "Este código ya fue usado";
                codigoActual = null;
                setTimeout(() => {
                    mensajeScanner.textContent = "Escanea tu Qr";
                    requestAnimationFrame(leerFrames);
                }, 2000);

            } else {
                // null = error de red
                codigoActual = null;
                mensajeScanner.textContent = "No se pudo conectar, intenta de nuevo";
                setTimeout(() => {
                    mensajeScanner.textContent = "Escanea otro código";
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
// enviarPresetDirecto() manda cualquier clave de preset tal cual
// (se usa para el idle y los clear, que no viven en PRESETS).
// enviarPreset() arma la clave a partir de PRESETS[layer][idx].id
// y delega en enviarPresetDirecto().

function enviarPresetDirecto(clavePreset) {
    const mensaje = JSON.stringify({
        preset: clavePreset,
        code:   codigoActual,
    });

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(mensaje);
        console.log("Preset enviado:", mensaje);
    } else {
        console.warn("Bridge no conectado — preset no enviado:", clavePreset);
    }
}

function enviarPreset(layer, idx) {
    const clavePreset = PRESETS[layer][idx].id;
    enviarPresetDirecto(clavePreset);
}

// ============================================================
// PARTE 4: LÓGICA DE SELECCIÓN DE LAYERS
//
// Cada layer es independiente: el usuario elige uno por fila.
// Tap en el mismo botón lo deselecciona y apaga la capa en Resolume
// (clear) — excepto en "visual", que siempre debe quedar con uno activo.
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

    // Toggle: si ya estaba seleccionado, deseleccionar Y avisarle a
    // Resolume que apague la capa (clear). El layer "visual" queda
    // afuera de esta regla — siempre debe quedar uno activo.
    if (layer !== "visual" && estado[layer] === idx) {
        estado[layer] = null;
        actualizarStatus(layer, null);
        enviarPresetDirecto(CLAVES_CLEAR[layer]);
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
        el.textContent = "● " + PRESETS[layer][idx].label;
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

    // Visual por defecto al desbloquear — siempre la primera del array
    seleccionarVisualPorDefecto();

    // Dispara cada 1 segundo
    temporizadorSesion = setInterval(() => {
        segundosRestantes -= 1;
        actualizarBarraTiempo();

        if (segundosRestantes <= 0) {
            finalizarSesion();
        }
    }, 1000);
}

function seleccionarVisualPorDefecto() {
    const idxDefault = 0;

    estado.visual = idxDefault;
    actualizarStatus("visual", idxDefault);
    enviarPreset("visual", idxDefault);

    const boton = document.querySelector(`[data-layer="visual"][data-idx="${idxDefault}"]`);
    if (boton) {
        boton.classList.add("sel-visual");
    }
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

    // Visual idle — directo, sin pasar por PRESETS ni por estado,
    // porque no es un preset seleccionable desde la UI.
    enviarPresetDirecto(PRESET_IDLE);

    // Apagar efectos y color — deja solo el visual (idle) activo.
    enviarPresetDirecto(CLAVES_CLEAR.effects);
    enviarPresetDirecto(CLAVES_CLEAR.color);

    // Limpiar toda la selección de los 3 layers
    estado.visual  = null;
    estado.effects = null;
    estado.color   = null;

    document.querySelectorAll(".btn-preset").forEach(b => {
        b.classList.remove("sel-visual", "sel-effects", "sel-color");
    });

    ["visual", "effects", "color"].forEach(l => actualizarStatus(l, null));

    // Limpiar el código validado
    codigoActual = null;

    // Mostrar "Gracias por interactuar" unos instantes antes de volver
    // al scanner — como un setTimeout que hace de pausa entre pantallas,
    // igual que un sleep() no bloqueante en C (el resto del programa
    // sigue corriendo mientras espera).
    mostrarPantalla("despedida");

    setTimeout(() => {
        mensajeScanner.textContent = "Escanea tu Qr";
        mostrarPantalla("scanner");
        requestAnimationFrame(leerFrames);
    }, DURACION_DESPEDIDA * 1000);
}

// ============================================================
// REGISTRO DE EVENTOS
// ============================================================

function registrarBotones() {
    // Botones de preset — los 3 layers
    // (se llama DESPUÉS de renderizarBotones(), una vez que existen en el DOM)
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
//
// Antes: registrarBotones() se llamaba directo, porque los botones
// ya existían escritos en el HTML.
// Ahora: hay que esperar a que config.json cargue y los botones se
// generen ANTES de poder registrar sus eventos de click. Por eso
// todo el arranque queda encadenado dentro de esta función async.
// ============================================================

async function iniciar() {
    const cargoOk = await cargarPresets();

    if (!cargoOk) {
        return; // sin presets no tiene sentido seguir — ya se muestra el error en pantalla
    }

    renderizarBotones();
    registrarBotones();
    conectarBridge();
    iniciarCamara();
}

iniciar();