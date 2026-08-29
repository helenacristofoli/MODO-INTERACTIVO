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

// ── Cámara en vivo ───────────────────────────────────────────
// Es un 5° "visual" más — vive en el mismo layer/clip family que
// Estadio/Preset2/3/4 en Resolume (Clip 5), aunque en la UI el botón
// está separado del grid de VISUALES. Por eso PRESET_ON no vive dentro
// de PRESETS.visual: es una clave fija, igual que PRESET_IDLE.
const CAMARA_VIVA = {
    PRESET_ON:    "camera_live", // clave que debe existir en config.json del bridge → mapeada al Clip 5
    INTERVALO_MS: 150,           // cada cuánto se manda un frame, EN CONDICIONES NORMALES (~6-7 fps)
    INTERVALO_MAX_MS: 500,       // tope al que se puede alargar el intervalo si el dispositivo viene exigido (~2 fps)
    CALIDAD_JPEG: 0.6,           // 0 a 1 — más alto = mejor calidad, más peso por frame

    // Backpressure: si el WebSocket ya tiene más de esto (en bytes) sin
    // terminar de mandar, este tick se descarta en vez de sumarse a la
    // cola. Con wifi lenta, sin este límite la latencia crecería sin
    // parar porque cada frame nuevo se apilaría atrás de los anteriores
    // — mejor perder un frame puntual que ir cada vez más atrasado
    // respecto de lo que está pasando en vivo.
    MAX_BUFFER_BYTES: 200000, // ~200KB, unos pocos frames de margen
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

// Estado de la cámara en vivo — separado de "estado" porque no es un
// índice dentro de un array de presets, es un simple on/off.
let camaraActiva = false;

// false cuando ya intentamos reconectar la cámara y falló — evita que
// alguien siga tocando el botón de cámara en vivo sabiendo que está roto.
let camaraDisponible = true;

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

// Canvas dedicado a la cámara en vivo — separado del canvas del
// escáner QR a propósito, aunque el loop de lectura de QR ya está
// detenido cuando este se usa. Mantenerlos separados evita que un
// cambio futuro en uno pise al otro por accidente.
const elementoCanvasCamara = document.getElementById("canvas-camara");
const ctxCamara            = elementoCanvasCamara.getContext("2d");

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

// iniciarLecturaQR: true arranca (o reanuda) el loop de leerFrames()
// apenas el video esté listo. Tiene que ser false cuando esta función
// se llama para RECONECTAR la cámara a mitad de una sesión ya
// validada — si no, se reactivaría el escaneo de QR encima de una
// sesión en curso, que es un estado que el resto del código no espera.
//
// Lanza (throw) el error en vez de solo loguearlo, porque
// manejarCamaraCaida() necesita saber si el intento de reconexión
// automática funcionó o no para decidir qué hacer después.
async function iniciarCamara(iniciarLecturaQR = true) {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: "user", // cámara frontal (selfie)
        }
    });

    elementoVideo.srcObject = stream;

    // Detecta si la pista de video termina sola -- dispositivo
    // desconectado, permiso revocado en caliente, etc. { once: true }
    // porque cada reconexión exitosa vuelve a registrar este mismo
    // listener sobre el nuevo stream; sin once, en reconexiones
    // repetidas se irían acumulando listeners viejos sobre streams
    // que ya no existen.
    const trackVideo = stream.getVideoTracks()[0];
    trackVideo.addEventListener("ended", manejarCamaraCaida, { once: true });

    // { once: true } acá también evita acumular un listener nuevo de
    // "loadedmetadata" cada vez que se llama iniciarCamara() de nuevo.
    elementoVideo.addEventListener("loadedmetadata", () => {
        elementoVideo.play();
        if (iniciarLecturaQR) {
            leerFrames();
        }
    }, { once: true });
}

// Se dispara cuando la pista de video termina inesperadamente.
async function manejarCamaraCaida() {
    console.error("[Cámara] La pista de video terminó inesperadamente " +
        "(dispositivo desconectado, permiso revocado, u otra causa de hardware).");

    // Si la cámara en vivo estaba activa, apagarla YA -- si no,
    // Resolume se queda mostrando el último frame congelado sin que
    // nadie se entere de que ya no es una imagen en vivo.
    if (camaraActiva) {
        desactivarCamaraViva({ reseleccionarDefault: true });
    }

    // Solo reanudar el escaneo de QR si esa era la pantalla visible
    // en este momento -- si ya hay una sesión en curso, no queremos
    // que la reconexión dispare el flujo de escaneo por encima.
    const enPantallaScanner = pantallas.scanner.classList.contains("activa");

    try {
        // Intento de recuperación automática, por si fue algo
        // transitorio (la tablet "durmió" la cámara un instante, un
        // cambio de foco de la app, etc.)
        await iniciarCamara(enPantallaScanner);
        console.log("[Cámara] Reconectada automáticamente.");

    } catch (error) {
        // No se pudo recuperar sola. Deshabilitamos el botón de cámara
        // en vivo para que nadie intente usar algo que ya sabemos que
        // está roto, y avisamos donde se pueda.
        camaraDisponible = false;
        btnCamaraViva.disabled = true;
        btnCamaraViva.classList.add("deshabilitado");

        if (enPantallaScanner) {
            mensajeScanner.textContent = "Error: no se pudo reconectar la cámara. Avisa al personal.";
        }

        console.error("[Cámara] No se pudo recuperar automáticamente:", error);
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

    // Si se elige un visual "normal" mientras la cámara en vivo está
    // activa, la cámara pierde el layer (comparten el mismo clip family
    // en Resolume) — hay que apagarla primero, sin volver a seleccionar
    // el visual por defecto porque ya estamos por seleccionar uno nuevo.
    if (layer === "visual" && camaraActiva) {
        desactivarCamaraViva({ reseleccionarDefault: false });
    }

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
// PARTE 5: CÁMARA EN VIVO
//
// Funciona como un 5° visual: al activarse, apaga la selección normal
// del layer visual (misma capa en Resolume, un solo clip a la vez).
// Reutiliza el stream de cámara que ya está corriendo desde
// iniciarCamara() — no pide getUserMedia() de nuevo.
// ============================================================

const btnCamaraViva = document.getElementById("btn-camara-viva");

// Preview visual de la cámara en vivo — mismo MediaStream que ya está
// corriendo en elementoVideo. Un MediaStream se puede asignar como
// srcObject a más de un <video> a la vez sin pedir getUserMedia() de
// nuevo; los dos elementos simplemente reproducen la misma fuente.
const elementoCamaraPreview     = document.getElementById("camara-preview");
const contenedorCamaraPreview   = document.getElementById("camara-preview-wrap");

let intervaloCamaraViva = null; // timeout id del próximo frame programado -- null = no está corriendo.
                                  // El ritmo es adaptativo (ver cicloCapturaFrame), por eso es un
                                  // setTimeout que se reprograma solo, no un setInterval fijo.

function activarCamaraViva() {
    // Apaga cualquier visual normal seleccionado — mismo motivo que en
    // manejarBoton(): comparten layer/clip family en Resolume.
    if (estado.visual !== null) {
        document.querySelectorAll(`[data-layer="visual"]`).forEach(b => {
            b.classList.remove("sel-visual");
        });
        estado.visual = null;
        actualizarStatus("visual", null);
    }

    camaraActiva = true;
    btnCamaraViva.classList.add("activa");

    // Mostrar el preview -- misma fuente de video que ya está corriendo,
    // no hace falta volver a pedir la cámara.
    elementoCamaraPreview.srcObject = elementoVideo.srcObject;
    contenedorCamaraPreview.classList.add("visible");

    enviarPresetDirecto(CAMARA_VIVA.PRESET_ON);
    iniciarCapturaFrames();
}

// opciones.reseleccionarDefault:
//   true  → se apagó la cámara SIN elegir un visual nuevo, así que hay
//           que volver al visual por defecto (el layer nunca queda vacío)
//   false → se apagó porque el usuario ya está eligiendo otro visual,
//           ese código se encarga de dejar el layer en un estado válido
function desactivarCamaraViva(opciones = { reseleccionarDefault: true }) {
    camaraActiva = false;
    btnCamaraViva.classList.remove("activa");
    detenerCapturaFrames();

    // Ocultar el preview y soltar la referencia al stream -- no
    // detiene la cámara real (elementoVideo.srcObject sigue vivo),
    // solo evita que el navegador siga decodificando video de más en
    // un elemento que ya no se ve (un pequeño cuidado extra pensando
    // en el calentamiento de la tablet en sesiones largas).
    contenedorCamaraPreview.classList.remove("visible");
    elementoCamaraPreview.srcObject = null;

    if (opciones.reseleccionarDefault) {
        seleccionarVisualPorDefecto();
    }
}

function iniciarCapturaFrames() {
    // Por las dudas, nunca debería haber dos ciclos corriendo a la vez
    if (intervaloCamaraViva !== null) {
        clearTimeout(intervaloCamaraViva);
    }

    programarSiguienteFrame(CAMARA_VIVA.INTERVALO_MS);
}

function detenerCapturaFrames() {
    if (intervaloCamaraViva !== null) {
        clearTimeout(intervaloCamaraViva);
        intervaloCamaraViva = null;
    }
}

function programarSiguienteFrame(demoraMs) {
    intervaloCamaraViva = setTimeout(cicloCapturaFrame, demoraMs);
}

// Reemplaza el viejo setInterval de ritmo fijo. Acá medimos cuánto tarda
// de verdad capturarYEnviarFrame() (dibujar en canvas + codificar JPEG,
// que es la parte pesada de CPU) y ajustamos el intervalo del PRÓXIMO
// frame según eso:
//
//   - Si tardó poco, seguimos al ritmo normal (INTERVALO_MS).
//   - Si tardó más de lo esperado, es señal de que el dispositivo está
//     exigido (CPU al límite, posible causa de calentamiento en
//     sesiones largas) -- alargamos el próximo intervalo en vez de
//     insistir al mismo ritmo y empeorar la situación.
//   - Nunca se alarga más allá de INTERVALO_MAX_MS.
//
// Es el mismo principio que un control por realimentación: en vez de
// asumir de antemano qué ritmo va a poder sostener el hardware, lo
// medimos en cada vuelta y nos adaptamos.
function cicloCapturaFrame() {
    const inicio = performance.now();
    capturarYEnviarFrame();
    const duracion = performance.now() - inicio;

    const proximaDemora = Math.min(
        CAMARA_VIVA.INTERVALO_MAX_MS,
        Math.max(CAMARA_VIVA.INTERVALO_MS, duracion * 1.5)
    );

    // Solo seguir programando si la cámara sigue activa -- si se apagó
    // durante este mismo frame (ej. el usuario tocó el botón justo en
    // ese instante), no queremos reprogramar un ciclo que ya no debería
    // existir.
    if (camaraActiva) {
        programarSiguienteFrame(proximaDemora);
    }
}

function capturarYEnviarFrame() {
    // Si el video todavía no tiene un frame listo, nos salteamos este
    // tick — no tiene sentido mandar un frame vacío o repetido.
    if (elementoVideo.readyState !== elementoVideo.HAVE_ENOUGH_DATA) {
        return;
    }

    elementoCanvasCamara.width  = elementoVideo.videoWidth;
    elementoCanvasCamara.height = elementoVideo.videoHeight;
    ctxCamara.drawImage(elementoVideo, 0, 0);

    // toDataURL da un string tipo "data:image/jpeg;base64,/9j/4AAQ..."
    // El bridge ya sabe recortar el prefijo antes del "," si está presente.
    const dataUrl = elementoCanvasCamara.toDataURL("image/jpeg", CAMARA_VIVA.CALIDAD_JPEG);

    if (ws && ws.readyState === WebSocket.OPEN) {
        // Backpressure: si ya hay mucho sin enviar todavía, este frame
        // se descarta en vez de sumarse a la cola (ver comentario en
        // CAMARA_VIVA.MAX_BUFFER_BYTES).
        if (ws.bufferedAmount > CAMARA_VIVA.MAX_BUFFER_BYTES) {
            return;
        }

        ws.send(JSON.stringify({
            type: "camera_frame",
            data: dataUrl,
        }));
    }
    // No logueamos cada frame a propósito — a ~7 fps inundaría la consola.
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

    // Visual por defecto al desbloquear — el idle (clip 19), no
    // seleccionable con botón. Distinto del fallback de
    // desactivarCamaraViva(), que sigue cayendo en visual_1.
    activarVisualIdle();

    // Dispara cada 1 segundo
    temporizadorSesion = setInterval(() => {
        segundosRestantes -= 1;
        actualizarBarraTiempo();

        if (segundosRestantes <= 0) {
            finalizarSesion();
        }
    }, 1000);
}

// Se usa SOLO al iniciar sesión (ver iniciarSesion()). Manda el visual
// idle (clip 19, PRESET_IDLE) directo, igual que en finalizarSesion(),
// sin resaltar ningún botón del grid -- el cliente todavía no eligió
// nada, aunque Resolume ya esté mostrando el idle en vez de pantalla
// vacía mientras decide.
function activarVisualIdle() {
    estado.visual = null;
    actualizarStatus("visual", null);
    enviarPresetDirecto(PRESET_IDLE);

    document.querySelectorAll(`[data-layer="visual"]`).forEach((b) => {
        b.classList.remove("sel-visual");
    });
}

// Se usa cuando se apaga la cámara en vivo SIN elegir otro visual (ver
// desactivarCamaraViva()). A diferencia de activarVisualIdle(), acá
// sí cae en un preset seleccionable de verdad (visual_1) y resalta su
// botón -- este caso siempre existió así, antes de que existiera la
// cámara en vivo, y se mantiene igual.
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

    // Si la cámara en vivo quedó activa, apagarla sin reseleccionar
    // ningún visual — la sesión entera se está reseteando igual.
    if (camaraActiva) {
        desactivarCamaraViva({ reseleccionarDefault: false });
    }

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

    // Botón de cámara en vivo — toggle simple, no pasa por manejarBoton()
    // porque no es parte del grid de ningún layer.
    btnCamaraViva.addEventListener("click", () => {
        if (camaraActiva) {
            desactivarCamaraViva({ reseleccionarDefault: true });
        } else {
            activarCamaraViva();
        }
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

    try {
        await iniciarCamara(); // iniciarLecturaQR=true por defecto — arranque normal
    } catch (error) {
        mensajeScanner.textContent = "Error: no se pudo acceder a la cámara.";
        console.error("Error de cámara:", error);
    }
}

iniciar();