import qrcode
from PIL import Image, ImageWin
import win32print
import win32ui

# Nombre EXACTO tal como aparece en "Impresoras y escáneres"
PRINTER_NAME = "MP-POS58"

# Ancho imprimible en píxeles: 48mm de ancho útil a 203 DPI (la resolución
# del cabezal térmico, confirmada en las specs) da aproximadamente 384px.
ANCHO_PAPEL_PX = 384


def generar_qr(data, ancho_px=ANCHO_PAPEL_PX):
    """
    Genera el QR y lo escala EXACTO al ancho del papel.
    Usamos NEAREST (no suavizado) para que los módulos del QR
    queden con bordes duros y nítidos -- un QR "blureado" por
    interpolación puede fallar al escanear.
    """
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(data)
    qr.make(fit=True)

    img = qr.make_image(fill_color="black", back_color="white").convert("1")

    ratio = ancho_px / img.width
    alto_px = int(img.height * ratio)
    img = img.resize((ancho_px, alto_px), Image.NEAREST)
    return img


def imprimir_imagen(img):
    """
    Equivalente a abrir un 'file descriptor' de la impresora,
    escribir en él, y cerrarlo -- como abrir/escribir/cerrar
    un archivo en C, pero el 'archivo' es la cola de impresión.
    """
    hDC = win32ui.CreateDC()
    hDC.CreatePrinterDC(PRINTER_NAME)
    hDC.StartDoc("Ticket QR")
    hDC.StartPage()

    dib = ImageWin.Dib(img)
    ancho, alto = img.size
    dib.draw(hDC.GetHandleOutput(), (0, 0, ancho, alto))

    hDC.EndPage()
    hDC.EndDoc()
    hDC.DeleteDC()


if __name__ == "__main__":
    codigo_prueba = "test-uuid-1234"

    img = generar_qr(codigo_prueba)
    img.save("qr_test_preview.png")  # revisalo antes de imprimir
    print("Preview guardado en qr_test_preview.png -- revisalo antes de imprimir.")

    imprimir_imagen(img)
    print("Enviado a la impresora.")