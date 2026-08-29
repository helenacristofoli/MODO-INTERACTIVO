"""
cleanup_codes.py

Limpieza de codes.json, pensada para llamarse UNA VEZ al arrancar main.py
(no como tarea programada aparte). Es una función normal, no un script demonio:
main.py la importa y la ejecuta antes de levantar la ventana de tkinter.

Elimina del registro:
  - Códigos ya canjeados (usado == true)
  - Códigos sin canjear con más de 30 días desde 'creado'

Antes de borrar nada, hace un backup completo del archivo actual.

Uso desde main.py:
    from cleanup_codes import limpiar_codigos
    limpiar_codigos()   # llamar antes de crear la ventana principal

Uso manual (para probar sin tocar main.py):
    python cleanup_codes.py
"""

import os
import shutil
from datetime import datetime, timedelta

import codes_store

# ---------- Configuración ----------
CARPETA_CODIGOS = "codes"          # ahí viven codes.json Y los .png (codes/<uuid>.png)
BACKUP_DIR = "codes/backups"
DIAS_EXPIRACION = 30
DIAS_RETENCION_BACKUPS = 60
FORMATO_FECHA = "%Y-%m-%d %H:%M:%S"
# ------------------------------------


def hacer_backup():
    """
    Copia el archivo actual a codes/backups/codes_YYYYMMDD_HHMMSS.json.
    Es una copia directa del archivo en disco (no pasa por codes_store)
    porque acá solo necesitamos un snapshot tal cual está, no leer/parsear.
    """
    if not os.path.exists(codes_store.RUTA_CODIGOS):
        return None
    os.makedirs(BACKUP_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, f"codes_{timestamp}.json")
    shutil.copy2(codes_store.RUTA_CODIGOS, backup_path)
    return backup_path


def limpiar_backups_viejos():
    """
    Borra archivos de codes/backups/ con más de DIAS_RETENCION_BACKUPS días,
    usando la fecha de modificación del archivo (no su nombre).
    Devuelve la cantidad de backups borrados.
    """
    if not os.path.isdir(BACKUP_DIR):
        return 0

    limite = datetime.now() - timedelta(days=DIAS_RETENCION_BACKUPS)
    borrados = 0

    for nombre in os.listdir(BACKUP_DIR):
        ruta = os.path.join(BACKUP_DIR, nombre)
        if not os.path.isfile(ruta):
            continue
        modificado = datetime.fromtimestamp(os.path.getmtime(ruta))
        if modificado < limite:
            os.remove(ruta)
            borrados += 1

    return borrados


def debe_conservarse(codigo, datos, ahora):
    """
    Devuelve True si el código debe quedarse en el archivo.
    Se conserva si NO está usado Y no pasaron más de DIAS_EXPIRACION
    desde su creación.
    """
    usado = datos.get("usado", False)
    if usado:
        return False  # se borra: ya cumplió su función

    creado_str = datos.get("creado")
    if not creado_str:
        # Si no tiene fecha registrada, lo conservamos para no perder
        # datos por error de formato en vez de borrar por las dudas.
        print(f"[AVISO] Código {codigo} sin 'creado', se conserva.")
        return True

    try:
        creado = datetime.strptime(creado_str, FORMATO_FECHA)
    except ValueError:
        print(f"[AVISO] Código {codigo} con fecha inválida ({creado_str}), se conserva.")
        return True

    limite = ahora - timedelta(days=DIAS_EXPIRACION)
    return creado >= limite  # True = todavía vigente, se conserva


def borrar_imagen(codigo):
    """
    Borra el archivo de imagen QR asociado a un código, si existe.
    generator.py guarda cada ticket como codes/<uuid>.png (emitir_ticket()),
    así que el nombre es directo: el código es el nombre del archivo.
    """
    ruta_imagen = os.path.join(CARPETA_CODIGOS, f"{codigo}.png")
    if os.path.exists(ruta_imagen):
        os.remove(ruta_imagen)
        return True
    return False


def limpiar_codigos():
    """
    Punto de entrada principal. Llamar desde main.py al arrancar,
    antes de crear la ventana de tkinter.
    """
    print(f"--- Limpieza de codes.json | {datetime.now().isoformat()} ---")

    # Antes: cargar_codigos(CODES_PATH) local, con open()/json.load() directo.
    # Ahora: codes_store.leer_codigos() -- mismo lock que usan generator.py
    # y server.py, así esta lectura tampoco puede pisarse con una escritura
    # concurrente (aunque en la práctica esto corre una sola vez, antes de
    # que arranque el hilo del servidor -- pero mejor no depender de eso).
    codigos = codes_store.leer_codigos()
    total_antes = len(codigos)

    if total_antes == 0:
        print("No hay códigos registrados. Nada que hacer.")
        return

    backup_path = hacer_backup()
    if backup_path:
        print(f"Backup creado: {backup_path}")

    ahora = datetime.now()
    codigos_filtrados = {}
    imagenes_borradas = 0

    for codigo, datos in codigos.items():
        if debe_conservarse(codigo, datos, ahora):
            codigos_filtrados[codigo] = datos
        else:
            if borrar_imagen(codigo):
                imagenes_borradas += 1

    total_despues = len(codigos_filtrados)
    eliminados = total_antes - total_despues

    # Antes: open(..., "w") + json.dump() directo.
    # Ahora: codes_store.escribir_codigos() -- escritura atómica (archivo
    # temporal + os.replace()), igual que el resto del sistema.
    codes_store.escribir_codigos(codigos_filtrados)

    backups_borrados = limpiar_backups_viejos()

    print(f"Códigos antes:     {total_antes}")
    print(f"Códigos borrados:  {eliminados}")
    print(f"Imágenes borradas: {imagenes_borradas}")
    print(f"Códigos restantes: {total_despues}")
    print(f"Backups viejos borrados (>{DIAS_RETENCION_BACKUPS}d): {backups_borrados}")
    print("--- Limpieza terminada ---\n")


if __name__ == "__main__":
    limpiar_codigos()