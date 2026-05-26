import uuid
import json
import os
import qrcode
from datetime import datetime, timedelta

# Ruta del archivo donde se guardan los códigos válidos
RUTA_CODIGOS = "codes/codes.json"

def inicializar_archivo():
    """
    Crea la carpeta 'codes' y el archivo codes.json si no existen.
    Similar a verificar si un archivo existe antes de abrirlo en C.
    """
    os.makedirs("codes", exist_ok=True)
    
    if not os.path.exists(RUTA_CODIGOS):
        with open(RUTA_CODIGOS, "w") as f:
            json.dump({}, f)

def generar_codigo():
    """
    Genera un UUID único y lo registra en codes.json.
    Retorna el código como string.
    """
    inicializar_archivo()
    
    # Genera un ID único universal — ej: "a3f8c2d1-9b4e-4f7a-8c3d-1e2f3a4b5c6d"
    codigo = str(uuid.uuid4())
    
    ahora = datetime.now()
    expiracion = ahora + timedelta(days=1)
    
    # Carga el JSON actual (como leer un struct desde archivo en C)
    with open(RUTA_CODIGOS, "r") as f:
        codigos = json.load(f)
    
    # Agrega el nuevo código con sus metadatos
    codigos[codigo] = {
        "creado": ahora.strftime("%Y-%m-%d %H:%M:%S"),
        "expira": expiracion.strftime("%Y-%m-%d %H:%M:%S"),
        "usado": False
    }
    
    # Guarda el JSON actualizado
    with open(RUTA_CODIGOS, "w") as f:
        json.dump(codigos, f, indent=4)
    
    print(f"Código generado: {codigo}")
    return codigo

def generar_qr(codigo):
    """
    Recibe el código UUID y genera una imagen QR en la carpeta 'codes'.
    """
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=10,
        border=4,
    )
    
    qr.add_data(codigo)
    qr.make(fit=True)
    
    imagen = qr.make_image(fill_color="black", back_color="white")
    
    ruta_imagen = f"codes/{codigo}.png"
    imagen.save(ruta_imagen)
    
    print(f"QR guardado en: {ruta_imagen}")
    return ruta_imagen

if __name__ == "__main__":
    codigo = generar_codigo()
    generar_qr(codigo)