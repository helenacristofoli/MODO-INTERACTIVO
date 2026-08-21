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