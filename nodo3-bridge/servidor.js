// servidor.js
// Servidor HTTPS para servir los archivos de la tablet kiosk
// Usa el certificado generado con mkcert

const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ─── Configuración ───────────────────────────────────────────────────────────
// Cambia esta ruta a la carpeta donde tienes index.html, app.js y style.css
const CARPETA_TABLET = "C:\\Users\\helen\\Documents\\MODO_Kiosk";
const PUERTO         = 8443;

// ─── Certificado SSL ─────────────────────────────────────────────────────────
const opciones = {
    cert: fs.readFileSync("C:\\bridge\\192.168.100.6.pem"),
    key:  fs.readFileSync("C:\\bridge\\192.168.100.6-key.pem"),
};

// ─── Mapa de tipos de archivo ─────────────────────────────────────────────────
// El servidor necesita decirle al browser qué tipo de archivo está enviando
const tiposMIME = {
    ".html": "text/html",
    ".js":   "application/javascript",
    ".css":  "text/css",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".json": "application/json",
};

// ─── Servidor HTTPS ───────────────────────────────────────────────────────────
const servidor = https.createServer(opciones, (req, res) => {
    // Si piden la raíz, servimos index.html
    let rutaRelativa = req.url === "/" ? "/index.html" : req.url;
    let rutaCompleta = path.join(CARPETA_TABLET, rutaRelativa);

    fs.readFile(rutaCompleta, (err, datos) => {
        if (err) {
            res.writeHead(404);
            res.end("Archivo no encontrado: " + rutaRelativa);
            return;
        }

        // Detecta el tipo de archivo por su extensión
        const extension = path.extname(rutaCompleta);
        const tipoContenido = tiposMIME[extension] || "application/octet-stream";

        res.writeHead(200, { "Content-Type": tipoContenido });
        res.end(datos);
    });
});

servidor.listen(PUERTO, () => {
    console.log(`[HTTPS] Servidor corriendo en https://192.168.100.6:${PUERTO}`);
});