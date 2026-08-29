// bridge.js
// Nodo 3 — PC del operador
// Recibe mensajes WebSocket de la tablet y los convierte a OSC para Resolume Arena
// También expone un servidor MJPEG (puerto 9000) para el preset de cámara en vivo

// ─── Imports ────────────────────────────────────────────────────────────────
// En Node.js, "require" es equivalente a #include en C
const WebSocket = require("ws");
const osc = require("osc");
const config = require("./config.json");
const http = require("http");

// ─── Cliente OSC (UDP hacia Resolume) ───────────────────────────────────────
// Piénsalo como un socket UDP ya configurado con la IP y puerto de destino.
// udpPort es el objeto que usaremos para enviar paquetes OSC a Resolume.
const udpPort = new osc.UDPPort({
    localAddress: "0.0.0.0",       // escucha en todas las interfaces locales
    localPort: 57121,              // puerto local de salida (puede ser cualquiera libre)
    remoteAddress: config.resolume.ip,
    remotePort: config.resolume.port
});

// Abre el socket UDP — equivalente a socket() + bind() en C
udpPort.open();

udpPort.on("ready", () => {
    console.log(`[OSC] Socket UDP listo → ${config.resolume.ip}:${config.resolume.port}`);
});

udpPort.on("error", (err) => {
    console.error("[OSC] Error en socket UDP:", err.message);
});

// ─── Función: enviar mensaje OSC a Resolume ──────────────────────────────────
//
// Recibe una clave de preset (ej: "visual_2", "efecto_3", "efecto_clear")
// y envía el mensaje OSC correspondiente a Resolume.
//
// Las rutas que terminan en "/clear" son un caso especial: Resolume tiene
// un bug conocido (Arena 7) donde el botón de clear se queda "atascado"
// si solo se manda el valor 1. El fix es simular click + release: mandar
// 1 y después 0 con un pequeño delay — como debounce de un botón físico.

function enviarOSC(clavePreset) {
    // Busca la ruta OSC en config.json usando la clave recibida
    const ruta = config.presets[clavePreset];

    if (!ruta) {
        console.warn(`[OSC] Preset "${clavePreset}" no definido en config.json`);
        return;
    }

    if (ruta.endsWith("/clear")) {
        udpPort.send({ address: ruta, args: [{ type: "i", value: 1 }] });

        setTimeout(() => {
            udpPort.send({ address: ruta, args: [{ type: "i", value: 0 }] });
        }, 50);

        console.log(`[OSC] Clear enviado → ${ruta}`);
        return;
    }

    udpPort.send({
        address: ruta,
        args: [{ type: "i", value: 1 }]
    });

    console.log(`[OSC] Enviado → ${ruta}`);
}

// ============================================================
// VERIFICACIÓN DE SESIÓN ACTIVA (contra Nodo 1)
//
// Antes de ejecutar cualquier preset que venga con un "code", el
// bridge le pregunta a Nodo 1 (PC de caja) si ese código corresponde
// a una sesión real ya validada -- en vez de confiar ciegamente en
// cualquier mensaje WebSocket bien formado. Sin esto, cualquiera
// conectado a la misma wifi podría armar un mensaje a mano y disparar
// presets sin haber escaneado ningún QR.
//
// Fail-open a propósito: si Nodo 1 no responde a tiempo (wifi con
// hipo, PC de caja reiniciando, etc.), se PERMITE el comando en vez
// de bloquearlo. La razón: esto es una capa de seguridad extra sobre
// un riesgo ya de por sí bajo (vandalismo de bajo impacto, no acceso
// a datos), y no vale la pena arriesgar que la demo entera se trabe
// por un problema de red transitorio en Nodo 1.
// ============================================================

function verificarSesionActiva(codigo) {
    return new Promise((resolve) => {
        const url = `http://${config.red.ip_caja}:${config.red.puerto_caja}/session-activa?code=${encodeURIComponent(codigo)}`;

        const peticion = http.get(url, { timeout: 1500 }, (res) => {
            let cuerpo = "";
            res.on("data", (chunk) => { cuerpo += chunk; });
            res.on("end", () => {
                resolve(cuerpo.trim() === "activo");
            });
        });

        peticion.on("timeout", () => {
            peticion.destroy();
            console.warn("[SESIÓN] Timeout consultando a Nodo 1 -- se permite el comando (fail-open).");
            resolve(true);
        });

        peticion.on("error", (err) => {
            console.warn(`[SESIÓN] Error consultando a Nodo 1 (${err.message}) -- se permite el comando (fail-open).`);
            resolve(true);
        });
    });
}

// ============================================================
// SERVIDOR MJPEG (cámara en vivo)
//
// OBS Studio va a apuntar su "Media Source" a http://<IP_BRIDGE>:9000/stream
// Este servidor mantiene la conexión HTTP abierta indefinidamente y le va
// empujando frames JPEG uno tras otro. No hay codec de video real: es
// literalmente "acá va una foto, acá va otra foto", separadas por un
// boundary — como mandar paquetes con un delimitador fijo en vez de un
// framing con longitud, en un protocolo serie por ejemplo.
//
// clientesMJPEG guarda las respuestas HTTP abiertas (una por cada OBS
// conectado — normalmente será solo una). Es un Set en vez de un array
// porque no nos importa el orden y evita duplicados.
// ============================================================

const clientesMJPEG = new Set();
const BOUNDARY = "framemodo"; // delimitador arbitrario, debe ser consistente en headers y body

const servidorMJPEG = http.createServer((req, res) => {
    if (req.url !== "/stream") {
        res.writeHead(404);
        res.end("No encontrado. Usa /stream");
        return;
    }

    // Cabecera especial que le dice al cliente (OBS): "esta conexión no se
    // cierra nunca, te voy a ir mandando partes separadas por boundary".
    // Es el mismo mecanismo que usan las cámaras IP baratas.
    res.writeHead(200, {
        "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        "Cache-Control": "no-cache",
        "Connection": "close",
        "Pragma": "no-cache",
    });

    clientesMJPEG.add(res);
    console.log(`[MJPEG] Cliente conectado (${clientesMJPEG.size} activo(s))`);

    // Si OBS cierra la conexión (se detiene la fuente, se cierra OBS, etc.)
    // hay que sacarlo del Set — si no, seguiríamos escribiendo en un socket
    // muerto y eventualmente tirar un error.
    req.on("close", () => {
        clientesMJPEG.delete(res);
        console.log(`[MJPEG] Cliente desconectado (${clientesMJPEG.size} activo(s))`);
    });
});

servidorMJPEG.listen(9000, () => {
    console.log("[MJPEG] Servidor de cámara en vivo escuchando en puerto 9000");
});

// ─── Función: reenviar un frame JPEG a todos los clientes MJPEG ─────────────
//
// bufferJPEG es un Buffer de Node (equivalente a un uint8_t* con su tamaño
// asociado en C). Por cada cliente conectado escribimos:
//   boundary + headers de la "parte" + los bytes del JPEG + salto de línea
//
// Esto se repite en cada frame, indefinidamente, mientras haya clientes.

function reenviarFrameMJPEG(bufferJPEG) {
    if (clientesMJPEG.size === 0) return; // nadie mirando, no perdemos tiempo

    const cabeceraParte =
        `\r\n--${BOUNDARY}\r\n` +
        `Content-Type: image/jpeg\r\n` +
        `Content-Length: ${bufferJPEG.length}\r\n\r\n`;

    for (const cliente of clientesMJPEG) {
        // write() puede fallar si el socket ya se cerró de golpe (ej. se
        // apagó OBS) — lo envolvemos para que un cliente roto no tumbe
        // a los demás ni al proceso entero.
        try {
            cliente.write(cabeceraParte);
            cliente.write(bufferJPEG);
        } catch (err) {
            console.warn("[MJPEG] Error escribiendo a un cliente, se descarta:", err.message);
            clientesMJPEG.delete(cliente);
        }
    }
}

// ─── Servidor WebSocket (escucha mensajes de la tablet) ──────────────────────
// Equivalente a abrir un socket TCP en modo servidor en C.
// La tablet se conecta a este servidor y manda mensajes JSON.
// Carga el certificado SSL — mismo que usa el servidor HTTPS
const https = require("https");
const fs    = require("fs");

// La IP ya no está escrita a mano acá -- se arma a partir de
// config.red.ip_bridge, que es el ÚNICO lugar donde vive ese valor
// para todo nodo3 (bridge.js y servidor.js leen del mismo config.json).
// El día que cambie la red (ej. al venue), se edita una sola vez acá
// y los dos procesos quedan consistentes.
const ipBridge = config.red.ip_bridge;

const opciones = {
    cert: fs.readFileSync(`C:\\bridge\\${ipBridge}.pem`),
    key:  fs.readFileSync(`C:\\bridge\\${ipBridge}-key.pem`),
};

// Servidor HTTPS base para WSS
const servidorHTTPS = https.createServer(opciones);
const wss = new WebSocket.Server({ server: servidorHTTPS });
servidorHTTPS.listen(config.websocket.port);

console.log(`[WS] Servidor WebSocket escuchando en puerto ${config.websocket.port}`);

// Se ejecuta cada vez que una tablet se conecta
wss.on("connection", (socket) => {
    console.log("[WS] Tablet conectada");

    // Se ejecuta cada vez que llega un mensaje de la tablet
    // En C sería el equivalente a recv() en un loop
    socket.on("message", async (datos) => {
        // Intenta parsear el JSON recibido
        // Equivalente en C a deserializar un buffer en un struct
        let mensaje;
        try {
            mensaje = JSON.parse(datos);
        } catch (e) {
            console.error("[WS] Error: mensaje no es JSON válido");
            return; // Descarta el mensaje malformado
        }

        // Ignora mensajes de heartbeat
        if (mensaje.type === "ping") {
            console.log("[WS] Heartbeat recibido");
            return;
        }

        // ── Frame de cámara en vivo ──────────────────────────────────────
        // No lo logueamos con el mensaje completo como los presets: a
        // varios frames por segundo, cada uno con miles de caracteres en
        // base64, inundaríamos la consola en un segundo. Solo un aviso
        // liviano.
        if (mensaje.type === "camera_frame") {
            // mensaje.data llega como "data:image/jpeg;base64,/9j/4AAQ..."
            // o directamente como el base64 puro, según cómo lo mandes
            // desde app.js. Sacamos el prefijo si está presente.
            const base64Puro = mensaje.data.includes(",")
                ? mensaje.data.split(",")[1]
                : mensaje.data;

            const bufferJPEG = Buffer.from(base64Puro, "base64");
            reenviarFrameMJPEG(bufferJPEG);
            return;
        }

        console.log("[WS] Mensaje recibido:", datos.toString());

        if (!mensaje.preset) {
            console.warn("[WS] Mensaje sin campo 'preset', ignorado");
            return;
        }

        // Todo mensaje que ejecuta un preset debe traer un code
        // asociado a una sesión real -- si no trae code, algo anda
        // raro (el flujo normal de app.js siempre lo incluye).
        if (!mensaje.code) {
            console.warn(`[SESIÓN] Mensaje sin 'code' para el preset "${mensaje.preset}", se rechaza.`);
            return;
        }

        const sesionActiva = await verificarSesionActiva(mensaje.code);

        if (!sesionActiva) {
            console.warn(`[SESIÓN] Código no activo (code=${mensaje.code}), se rechaza el preset "${mensaje.preset}"`);
            return;
        }

        // Todo OK — traduce el preset a OSC y lo envía a Resolume
        enviarOSC(mensaje.preset);

        // Responde a la tablet confirmando que se procesó
        socket.send(JSON.stringify({ status: "ok", preset: mensaje.preset }));
    });

    // Se ejecuta cuando la tablet se desconecta
    socket.on("close", () => {
        console.log("[WS] Tablet desconectada");
    });

    // Se ejecuta si hay un error en la conexión WebSocket
    socket.on("error", (err) => {
        console.error("[WS] Error en conexión:", err.message);
    });
});