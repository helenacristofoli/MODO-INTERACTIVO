// servidor.js
// Servidor HTTPS para servir los archivos de la tablet kiosk
// Usa el certificado generado con mkcert
//
// Ahora también expone un endpoint de administración que permite
// actualizar el label y el thumbnail de un preset sin tocar código:
//   POST /admin/actualizar-preset

const https      = require("https");
const fs          = require("fs");
const path        = require("path");
const { default: formidable } = require("formidable"); // v3 expone la función bajo "default"

// ─── Configuración ───────────────────────────────────────────────────────────
// Cambia esta ruta a la carpeta donde tienes index.html, app.js y style.css
const CARPETA_TABLET   = "C:\\Users\\helen\\Documents\\MODO_Kiosk";
const RUTA_CONFIG      = path.join(CARPETA_TABLET, "config.json");
const CARPETA_THUMBS   = path.join(CARPETA_TABLET, "assets", "thumbnails");
const PUERTO           = 8443;

// Layers válidos — cualquier otro valor en el request se rechaza.
// Evita que un request malformado (o mal intencionado) escriba
// claves nuevas en config.json que app.js no sepa interpretar.
const LAYERS_VALIDOS = ["visual", "effects", "color"];

// Extensiones de imagen que aceptamos para thumbnails
const EXTENSIONES_VALIDAS = [".png", ".jpg", ".jpeg"];

// ─── Certificado SSL ─────────────────────────────────────────────────────────
const opciones = {
    cert: fs.readFileSync("C:\\bridge\\192.168.100.6.pem"),
    key:  fs.readFileSync("C:\\bridge\\192.168.100.6-key.pem"),
};

// ─── Mapa de tipos de archivo (para servir archivos estáticos) ───────────────
const tiposMIME = {
    ".html": "text/html",
    ".js":   "application/javascript",
    ".css":  "text/css",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".json": "application/json",
};

// ============================================================
// UTILIDADES DE CONFIG.JSON
//
// Leer y escribir son operaciones separadas y explícitas —
// como fopen/fread/fclose y fopen/fwrite/fclose en C. Nunca
// mantenemos config.json "abierto" en memoria entre requests,
// así siempre reflejamos el estado real del archivo en disco.
// ============================================================

function leerConfig() {
    const contenido = fs.readFileSync(RUTA_CONFIG, "utf-8");
    return JSON.parse(contenido);
}

function escribirConfig(configObj) {
    const contenido = JSON.stringify(configObj, null, 2); // legible, con indentación
    fs.writeFileSync(RUTA_CONFIG, contenido, "utf-8");
}

// ============================================================
// ENDPOINT: POST /admin/actualizar-preset
//
// Campos esperados (multipart/form-data):
//   layer     -> "visual" | "effects" | "color"
//   idx       -> posición del preset dentro del array (0, 1, 2...)
//   label     -> texto nuevo a mostrar
//   thumbnail -> (opcional) archivo de imagen nuevo
// ============================================================

function manejarActualizarPreset(req, res) {
    const form = formidable({
        maxFileSize: 5 * 1024 * 1024, // 5 MB — suficiente para un thumbnail, evita subidas gigantes por error
    });

    form.parse(req, (err, fields, files) => {
        if (err) {
            console.error("Error parseando el formulario:", err);
            responderJSON(res, 400, { ok: false, error: "Formulario inválido" });
            return;
        }

        try {
            // formidable entrega los campos como arrays — tomamos el primer valor
            const layer = obtenerCampo(fields, "layer");
            const idx   = parseInt(obtenerCampo(fields, "idx"));
            const label = obtenerCampo(fields, "label");

            // ── Validaciones ──────────────────────────────────────
            if (!LAYERS_VALIDOS.includes(layer)) {
                responderJSON(res, 400, { ok: false, error: `Layer inválido: ${layer}` });
                return;
            }

            const config = leerConfig();

            if (!config[layer] || !config[layer][idx]) {
                responderJSON(res, 400, { ok: false, error: `Preset no encontrado: ${layer}[${idx}]` });
                return;
            }

            const preset = config[layer][idx];

            // ── Actualizar label (siempre, si vino) ───────────────
            if (label && label.trim() !== "") {
                preset.label = label.trim();
            }

            // ── Actualizar thumbnail (solo si mandaron archivo nuevo) ──
            const archivoSubido = obtenerArchivo(files, "thumbnail");

            if (archivoSubido) {
                const extension = path.extname(archivoSubido.originalFilename || "").toLowerCase();

                if (!EXTENSIONES_VALIDAS.includes(extension)) {
                    responderJSON(res, 400, { ok: false, error: `Extensión no permitida: ${extension}` });
                    return;
                }

                // Nombre de archivo fijo = id del preset, así siempre queda
                // predecible y no acumulamos archivos viejos sin usar.
                const nombreArchivo   = `${preset.id}${extension}`;
                const rutaDestino     = path.join(CARPETA_THUMBS, nombreArchivo);

                fs.copyFileSync(archivoSubido.filepath, rutaDestino);
                fs.unlinkSync(archivoSubido.filepath); // limpiar el temporal que crea formidable

                preset.thumbnail = `assets/thumbnails/${nombreArchivo}`;
            }

            escribirConfig(config);

            console.log(`[ADMIN] Preset actualizado: ${layer}[${idx}] ->`, preset);
            responderJSON(res, 200, { ok: true, preset: preset });

        } catch (error) {
            console.error("Error actualizando preset:", error);
            responderJSON(res, 500, { ok: false, error: "Error interno del servidor" });
        }
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function obtenerCampo(fields, nombre) {
    const valor = fields[nombre];
    return Array.isArray(valor) ? valor[0] : valor;
}

function obtenerArchivo(files, nombre) {
    const archivo = files[nombre];
    if (!archivo) return null;
    return Array.isArray(archivo) ? archivo[0] : archivo;
}

function responderJSON(res, statusCode, objeto) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(objeto));
}

// ============================================================
// SERVIDOR HTTPS
// ============================================================

const servidor = https.createServer(opciones, (req, res) => {

    // ── Ruta de administración ────────────────────────────────
    if (req.method === "POST" && req.url === "/admin/actualizar-preset") {
        manejarActualizarPreset(req, res);
        return;
    }

    // ── Servir archivos estáticos (comportamiento original) ────
    let rutaRelativa = req.url === "/" ? "/index.html" : req.url;
    let rutaCompleta = path.join(CARPETA_TABLET, rutaRelativa);

    fs.readFile(rutaCompleta, (err, datos) => {
        if (err) {
            res.writeHead(404);
            res.end("Archivo no encontrado: " + rutaRelativa);
            return;
        }

        const extension = path.extname(rutaCompleta);
        const tipoContenido = tiposMIME[extension] || "application/octet-stream";

        res.writeHead(200, { "Content-Type": tipoContenido });
        res.end(datos);
    });
});

servidor.listen(PUERTO, () => {
    console.log(`[HTTPS] Servidor corriendo en https://192.168.100.6:${PUERTO}`);
});