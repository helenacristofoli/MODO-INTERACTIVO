// bridge.js
// Nodo 3 — PC del operador
// Recibe mensajes WebSocket de la tablet y los convierte a OSC para Resolume Arena

// ─── Imports ────────────────────────────────────────────────────────────────
// En Node.js, "require" es equivalente a #include en C
const WebSocket = require("ws");
const osc = require("osc");
const config = require("./config.json");

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
// Recibe el número de preset (ej: 3) y envía el mensaje OSC correspondiente.
// Equivalente en C a: llenar un struct con la ruta y el valor, y llamar sendto()
function enviarOSC(numeroPreset) {
    // Busca la ruta OSC en config.json según el número de preset
    const ruta = config.presets[String(numeroPreset)];

    if (!ruta) {
        // Si el preset no existe en config.json, lo ignoramos
        console.warn(`[OSC] Preset "${numeroPreset}" no definido en config.json`);
        return;
    }

    // Construye y envía el paquete OSC
    // address: la ruta OSC (ej: "/composition/clips/3/connect")
    // args: argumento entero con valor 1 — Resolume lo interpreta como "activar"
    udpPort.send({
        address: ruta,
        args: [{ type: "i", value: 1 }]
    });

    console.log(`[OSC] Enviado → ${ruta}`);
}

// ─── Servidor WebSocket (escucha mensajes de la tablet) ──────────────────────
// Equivalente a abrir un socket TCP en modo servidor en C.
// La tablet se conecta a este servidor y manda mensajes JSON.
// Carga el certificado SSL — mismo que usa el servidor HTTPS
const https = require("https");
const fs    = require("fs");

const opciones = {
    cert: fs.readFileSync("C:\\bridge\\192.168.100.6.pem"),
    key:  fs.readFileSync("C:\\bridge\\192.168.100.6-key.pem"),
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
    socket.on("message", (datos) => {
        console.log("[WS] Mensaje recibido:", datos.toString());

        // Intenta parsear el JSON recibido
        // Equivalente en C a deserializar un buffer en un struct
        let mensaje;
        try {
            mensaje = JSON.parse(datos);
        } catch (e) {
            console.error("[WS] Error: mensaje no es JSON válido");
            return; // Descarta el mensaje malformado
        }

        // Valida que el mensaje tenga el campo "preset"
        // Ignora mensajes de heartbeat
        if (mensaje.type === "ping") {
        console.log("[WS] Heartbeat recibido");
         return;
        }

        if (!mensaje.preset) {
        console.warn("[WS] Mensaje sin campo 'preset', ignorado");
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