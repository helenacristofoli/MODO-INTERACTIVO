import uuid
import os
from datetime import datetime, timedelta

import qrcode
from PIL import Image, ImageDraw, ImageFont, ImageWin
import win32print
import win32ui
import pywintypes

import codes_store

# ── Configuración ──────────────────────────────────────────
RUTA_LOGO = "assets/logo.png"
NOMBRE_IMPRESORA = "MP-POS58"
ANCHO_PAPEL_PX = 384  # 48mm útil a 203dpi

FUENTE_INSTRUCCIONES = "arialbd.ttf"  # bold, para que se vea sólido y no gris

# Bits de estado de Windows para impresoras (winspool.h) --
# win32print no los expone como constantes, así que los ponemos a mano.
ESTADO_ERROR = 0x00000002
ESTADO_OFFLINE = 0x00000080


# ── Detección de impresora ───────────────────────────────────

def impresora_disponible(nombre=NOMBRE_IMPRESORA):
    """
    Verifica si la impresora está instalada Y respondiendo
    (no solo instalada -- puede estar apagada o desconectada).
    Como hacer un ping antes de intentar mandar datos por un socket.
    """
    try:
        instaladas = [
            p[2] for p in win32print.EnumPrinters(
                win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
            )
        ]
        if nombre not in instaladas:
            return False

        handle = win32print.OpenPrinter(nombre)
        try:
            info = win32print.GetPrinter(handle, 2)
            estado = info["Status"]
        finally:
            win32print.ClosePrinter(handle)

        if estado & (ESTADO_ERROR | ESTADO_OFFLINE):
            return False

        return True

    except Exception:
        return False


# ── Generación de imágenes ───────────────────────────────────

def generar_qr(codigo, ancho_px=ANCHO_PAPEL_PX):
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(codigo)
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white").convert("1")
    ratio = ancho_px / img.width
    alto_px = int(img.height * ratio)
    return img.resize((ancho_px, alto_px), Image.NEAREST)


def _envolver_texto(draw, texto, fuente, ancho_max):
    """Parte el texto en líneas que entren en el ancho del papel."""
    palabras = texto.split()
    lineas = []
    linea_actual = ""
    for palabra in palabras:
        prueba = (linea_actual + " " + palabra).strip()
        caja = draw.textbbox((0, 0), prueba, font=fuente)
        if caja[2] - caja[0] <= ancho_max:
            linea_actual = prueba
        else:
            lineas.append(linea_actual)
            linea_actual = palabra
    if linea_actual:
        lineas.append(linea_actual)
    return lineas


def armar_ticket(codigo, ancho_px=ANCHO_PAPEL_PX):
    """
    Compone la imagen completa del ticket: logo, QR e instrucciones,
    apilados verticalmente en un solo lienzo listo para imprimir o mostrar.
    """
    margen = 12
    espacio = 14
    instrucciones = "Acércate al stand y escanea tu QR para interactuar con la pantalla"

    logo = None
    if os.path.exists(RUTA_LOGO):
        logo = Image.open(RUTA_LOGO).convert("RGBA")
        ancho_logo = ancho_px - margen * 2
        ratio_logo = ancho_logo / logo.width
        alto_logo = int(logo.height * ratio_logo)
        logo = logo.resize((ancho_logo, alto_logo), Image.LANCZOS)

    fuente_texto = ImageFont.truetype(FUENTE_INSTRUCCIONES, 22)

    qr_img = generar_qr(codigo, ancho_px - margen * 2)

    lienzo_medida = Image.new("RGB", (ancho_px, 10))
    draw_medida = ImageDraw.Draw(lienzo_medida)
    lineas_instrucciones = _envolver_texto(
        draw_medida, instrucciones, fuente_texto, ancho_px - margen * 2
    )

    alto_total = margen
    if logo:
        alto_total += logo.height + espacio
    alto_total += qr_img.height + espacio
    alto_total += len(lineas_instrucciones) * 26 + margen

    ticket = Image.new("L", (ancho_px, alto_total), color=255)
    draw = ImageDraw.Draw(ticket)
    y = margen

    if logo:
        x_logo = (ancho_px - logo.width) // 2
        ticket.paste(logo, (x_logo, y), logo)
        y += logo.height + espacio

    x_qr = (ancho_px - qr_img.width) // 2
    ticket.paste(qr_img, (x_qr, y))
    y += qr_img.height + espacio

    for linea in lineas_instrucciones:
        caja = draw.textbbox((0, 0), linea, font=fuente_texto)
        x_linea = (ancho_px - (caja[2] - caja[0])) // 2
        draw.text((x_linea, y), linea, font=fuente_texto, fill=0)
        y += 26

    # dither=Image.NONE evita el "tramado" que hacía ver el texto
    # chico gris/débil en vez de negro sólido
    return ticket.convert("1", dither=Image.NONE)


# ── Impresión ─────────────────────────────────────────────

def imprimir_imagen(img):
    """
    Manda la imagen a la impresora. Se llama solo cuando ya
    confirmamos que la impresora está disponible -- si falla
    igual acá, es un error genuino (atasco, driver, etc.)
    y lo dejamos propagar.
    """
    hDC = win32ui.CreateDC()
    hDC.CreatePrinterDC(NOMBRE_IMPRESORA)
    hDC.StartDoc("Ticket MODO Interactivo")  # nombre del trabajo en la cola de Windows -- no se imprime en el papel
    hDC.StartPage()

    dib = ImageWin.Dib(img)
    ancho, alto = img.size
    dib.draw(hDC.GetHandleOutput(), (0, 0, ancho, alto))

    hDC.EndPage()
    hDC.EndDoc()
    hDC.DeleteDC()


# ── Flujo principal ───────────────────────────────────────

def emitir_ticket():
    """
    Genera el UUID, arma el ticket, e imprime si la impresora
    está disponible -- si no, queda como emisión digital (PNG).
    En ambos casos el código se registra como válido.

    Retorna (codigo, impreso_fisico: bool).
    """
    codigo = str(uuid.uuid4())
    ticket = armar_ticket(codigo)

    os.makedirs("codes", exist_ok=True)
    ruta_imagen = f"codes/{codigo}.png"
    ticket.save(ruta_imagen)

    impreso_fisico = False

    if impresora_disponible():
        try:
            imprimir_imagen(ticket)
            impreso_fisico = True
        except (pywintypes.error, Exception) as e:
            # Estaba "disponible" pero falló igual al imprimir de verdad
            # (atasco, se apagó justo en ese momento, etc.) -- esto SÍ
            # es un error genuino, no seguimos.
            raise RuntimeError(f"La impresora está conectada pero falló al imprimir: {e}")
    else:
        print(f"[DIGITAL] Impresora no disponible. Ticket guardado en {ruta_imagen}")

    # Antes: registrar_codigo(codigo) local, con open()/json.dump() directo.
    # Ahora: delega en codes_store, que centraliza el lock y la escritura
    # atómica (ver codes_store.py para el porqué).
    codes_store.registrar_codigo(codigo)
    return codigo, impreso_fisico


if __name__ == "__main__":
    codigo, impreso = emitir_ticket()
    estado = "impreso en papel" if impreso else "emitido en digital"
    print(f"Ticket {estado}: {codigo}")