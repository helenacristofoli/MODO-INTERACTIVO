"""
codes_store.py

Punto único de acceso a codes/codes.json. Antes, generator.py, server.py
y cleanup_codes.py cada uno abría y escribía el archivo por su cuenta —
eso permitía dos problemas:

  1. Escritura no atómica: si el proceso moría (corte de luz, crash,
     reinicio forzado de Windows) justo en medio de un open(..., "w"),
     el archivo quedaba truncado/corrupto, y json.load() en el próximo
     arranque tira una excepción sin poder recuperarse solo.

  2. Race condition entre hilos: server.py corre en un hilo aparte
     (threading.Thread) mientras main.py corre en el hilo principal
     de tkinter. Sin coordinación, dos escrituras casi simultáneas
     podían pisarse una a la otra.

Este módulo resuelve los dos problemas:

  - _lock (threading.Lock) — como un mutex en C (pthread_mutex_lock/
    unlock), asegura que solo un hilo a la vez esté leyendo o
    escribiendo el archivo.

  - _escribir_atomico() — en vez de escribir directo sobre codes.json,
    escribe a un archivo temporal (codes.json.tmp) y recién al final
    hace os.replace() para reemplazar el original. os.replace() es
    atómico a nivel de sistema operativo: o se completa entero, o no
    pasa nada — nunca queda un archivo a medio escribir.

Todo el resto del código (generator.py, server.py, cleanup_codes.py)
debe usar las funciones de acá en vez de abrir codes.json directamente.
"""

import json
import os
import threading
from datetime import datetime, timedelta

RUTA_CODIGOS = "codes/codes.json"

# Un solo lock para todo el módulo — todas las operaciones de
# lectura/escritura pasan por acá, así quedan serializadas entre sí
# sin importar desde qué hilo se llamen.
_lock = threading.Lock()


def inicializar_archivo():
    """Crea codes/codes.json vacío si todavía no existe."""
    os.makedirs("codes", exist_ok=True)
    if not os.path.exists(RUTA_CODIGOS):
        with _lock:
            _escribir_atomico({})


def _leer_sin_lock():
    """
    Lectura interna, SIN adquirir el lock — para usar solo desde
    funciones de este módulo que ya lo tienen tomado. Si se llama
    desde afuera sin lock, hay riesgo de leer a mitad de una escritura.
    """
    if not os.path.exists(RUTA_CODIGOS):
        return {}
    with open(RUTA_CODIGOS, "r", encoding="utf-8") as f:
        contenido = f.read().strip()
        if not contenido:
            return {}
        return json.loads(contenido)


def _escribir_atomico(codigos):
    """
    Escritura atómica. Escribe a un archivo temporal en la MISMA
    carpeta (importante: os.replace() solo es atómico si origen y
    destino están en el mismo disco/partición) y recién al final
    reemplaza el archivo real.
    """
    ruta_temp = RUTA_CODIGOS + ".tmp"
    with open(ruta_temp, "w", encoding="utf-8") as f:
        json.dump(codigos, f, indent=2, ensure_ascii=False)
    os.replace(ruta_temp, RUTA_CODIGOS)  # atómico — todo o nada


def leer_codigos():
    """Lectura pública, thread-safe. Devuelve una copia del dict completo."""
    inicializar_archivo()
    with _lock:
        return _leer_sin_lock()


def escribir_codigos(codigos):
    """Escritura pública, thread-safe y atómica."""
    with _lock:
        _escribir_atomico(codigos)


def registrar_codigo(codigo):
    """
    Registra un código nuevo como válido. Reemplaza la lógica que antes
    vivía directo en generator.py.
    """
    inicializar_archivo()
    ahora = datetime.now()
    expiracion = ahora + timedelta(days=1)

    with _lock:
        codigos = _leer_sin_lock()
        codigos[codigo] = {
            "creado": ahora.strftime("%Y-%m-%d %H:%M:%S"),
            "expira": expiracion.strftime("%Y-%m-%d %H:%M:%S"),
            "usado": False,
        }
        _escribir_atomico(codigos)

    print(f"Código registrado: {codigo}")


def validar_y_marcar_usado(codigo):
    """
    Reemplaza lo que antes eran DOS funciones separadas en server.py
    (validar_codigo + marcar_usado), llamadas una después de la otra
    SIN lock entre medio. Acá el chequeo y la marca pasan a ser una
    sola operación atómica bajo el mismo lock — ningún otro hilo puede
    colarse entre "verificar que es válido" y "marcarlo como usado".

    Devuelve True si el código era válido y quedó marcado como usado.
    Devuelve False si no existe, ya estaba usado, o expiró.
    """
    inicializar_archivo()

    with _lock:
        codigos = _leer_sin_lock()

        if codigo not in codigos:
            return False

        datos = codigos[codigo]

        if datos["usado"]:
            return False

        expiracion = datetime.strptime(datos["expira"], "%Y-%m-%d %H:%M:%S")
        if datetime.now() > expiracion:
            return False

        # Válido — lo marcamos usado en la misma operación, sin soltar
        # el lock, así queda garantizado que nadie más lo valida de nuevo.
        datos["usado"] = True
        _escribir_atomico(codigos)
        return True


def esta_activo(codigo):
    """
    Consulta de SOLO LECTURA: True si el código existe y ya fue
    validado en algún momento (usado == True).

    A diferencia de validar_y_marcar_usado(), esta función no modifica
    nada -- se puede llamar todas las veces que haga falta sin efectos
    secundarios. Pensada para que el bridge (Nodo 3) confirme que un
    "code" que le llega por WebSocket corresponde a una sesión real
    antes de ejecutar un preset en Resolume, en vez de confiar
    ciegamente en cualquier mensaje.

    Limitación conocida (aceptada, no se resuelve acá): un código
    queda "activo" para siempre una vez usado -- no hay una expiración
    server-side atada a la duración de la sesión de 60s en la tablet.
    """
    codigos = leer_codigos()
    datos = codigos.get(codigo)
    if datos is None:
        return False
    return bool(datos.get("usado", False))