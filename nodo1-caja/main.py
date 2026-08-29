import tkinter as tk
from tkinter import messagebox
import threading
from datetime import datetime
from generator import emitir_ticket as generar_ticket_completo
from server import iniciar_servidor
from cleanup_codes import limpiar_codigos
import codes_store

# Cada cuánto se repite la limpieza mientras la app queda abierta.
# Antes, limpiar_codigos() corría UNA sola vez al arrancar -- si el
# cajero deja main.py corriendo varios días seguidos sin reiniciar
# (nada raro en un evento largo), codes.json podía crecer sin límite
# hasta el próximo arranque. Con esto, se repite sola de fondo.
INTERVALO_LIMPIEZA_MS = 6 * 60 * 60 * 1000  # 6 horas

# ── Funciones de soporte ────────────────────────────────────

def contar_tickets_hoy():
    """
    Cuenta cuántos tickets se generaron hoy.
    Antes: open()/json.load() directo sobre codes.json.
    Ahora: codes_store.leer_codigos() -- mismo punto único de acceso
    que usan generator.py y server.py, así esta lectura tampoco puede
    pisarse con una escritura concurrente.
    """
    codigos = codes_store.leer_codigos()

    hoy = datetime.now().strftime("%Y-%m-%d")
    count = 0

    for datos in codigos.values():
        if datos["creado"].startswith(hoy):
            count += 1

    return count

def emitir_ticket():
    """
    Genera el ticket completo (QR + logo + instrucciones) e imprime
    si la impresora está disponible; si no, queda emitido en digital.
    Esta función se llama cuando el cajero presiona el botón.
    """
    try:
        # Genera el ticket completo -- imprime físico si puede, si no queda en digital
        codigo, impreso_fisico = generar_ticket_completo()

        # Actualiza la interfaz con el nuevo código
        lbl_codigo.config(text=f"{codigo[:35]}...")

        expiracion = datetime.now().strftime("%Y-%m-%d") + " (mañana)"
        lbl_expira.config(text=f"Expira: {expiracion}")

        # Actualiza el contador de tickets
        lbl_contador.config(text=f"tickets hoy: {contar_tickets_hoy()}")

        estado_ticket = (
            "Ticket impreso en papel."
            if impreso_fisico
            else "Ticket emitido en digital (impresora no disponible) — "
                 "mostrale el QR al cliente desde la pantalla."
        )

        messagebox.showinfo(
            "Ticket generado",
            f"{estado_ticket}\nCódigo: {codigo[:20]}...\nArchivo: codes/{codigo}.png"
        )

    except Exception as e:
        messagebox.showerror("Error", f"No se pudo generar el ticket:\n{e}")

def iniciar_servidor_hilo():
    """
    Corre el servidor HTTP en un hilo separado para que
    no bloquee la interfaz gráfica.
    Similar a un pthread en C.
    """
    hilo = threading.Thread(target=iniciar_servidor, daemon=True)
    hilo.start()

def programar_limpieza_periodica(ventana):
    """
    Corre limpiar_codigos() y se reprograma sola cada
    INTERVALO_LIMPIEZA_MS -- mientras main.py siga abierto, la limpieza
    se sigue repitiendo de fondo sin bloquear la interfaz.

    ventana.after(ms, funcion) es el mecanismo propio de tkinter para
    esto: en vez de un thread aparte con time.sleep() (que podría pisar
    la interfaz si no se maneja con cuidado), tkinter mismo agenda la
    llamada dentro de su propio loop de eventos -- el mismo loop que ya
    atiende clicks de botones. Es conceptualmente el mismo patrón que
    setInterval() en app.js, adaptado al mundo de tkinter.
    """
    try:
        limpiar_codigos()
    except Exception as e:
        # Una limpieza fallida no debería tirar abajo la app entera --
        # se loguea y se reintenta en el próximo ciclo igual.
        print(f"[AVISO] Falló la limpieza periódica: {e}")

    ventana.after(INTERVALO_LIMPIEZA_MS, lambda: programar_limpieza_periodica(ventana))

# ── Interfaz gráfica ────────────────────────────────────────

def construir_ui(ventana):
    """
    Construye todos los elementos visuales de la ventana.
    """
    ventana.title("MODO — Estación de caja")
    ventana.geometry("400x320")
    ventana.resizable(False, False)
    ventana.configure(bg="#f5f5f5")

    # Título
    tk.Label(
        ventana,
        text="Emisor de tickets QR",
        font=("Helvetica", 18, "bold"),
        bg="#f5f5f5",
        fg="#1a1a1a"
    ).pack(pady=(24, 4))

    tk.Label(
        ventana,
        text="MODO — estación de caja",
        font=("Helvetica", 10),
        bg="#f5f5f5",
        fg="#888888"
    ).pack(pady=(0, 20))

    # Botón principal
    tk.Button(
        ventana,
        text="Emitir ticket QR",
        font=("Helvetica", 16, "bold"),
        bg="#1D9E75",
        fg="white",
        activebackground="#0F6E56",
        activeforeground="white",
        relief="flat",
        padx=20,
        pady=16,
        cursor="hand2",
        command=emitir_ticket
    ).pack(fill="x", padx=32, pady=(0, 20))

    # Panel de último código
    frame_info = tk.Frame(ventana, bg="#ebebeb", padx=12, pady=10)
    frame_info.pack(fill="x", padx=32, pady=(0, 16))

    tk.Label(
        frame_info,
        text="Último código generado",
        font=("Helvetica", 9),
        bg="#ebebeb",
        fg="#888888"
    ).pack(anchor="w")

    global lbl_codigo, lbl_expira
    lbl_codigo = tk.Label(
        frame_info,
        text="—",
        font=("Courier", 11),
        bg="#ebebeb",
        fg="#1a1a1a"
    )
    lbl_codigo.pack(anchor="w")

    lbl_expira = tk.Label(
        frame_info,
        text="—",
        font=("Helvetica", 9),
        bg="#ebebeb",
        fg="#888888"
    )
    lbl_expira.pack(anchor="w")

    # Barra de estado inferior
    frame_estado = tk.Frame(ventana, bg="#f5f5f5")
    frame_estado.pack(fill="x", padx=32)

    tk.Label(
        frame_estado,
        text="● Servidor activo :8000",
        font=("Helvetica", 10),
        bg="#f5f5f5",
        fg="#1D9E75"
    ).pack(side="left")

    global lbl_contador
    lbl_contador = tk.Label(
        frame_estado,
        text=f"tickets hoy: {contar_tickets_hoy()}",
        font=("Helvetica", 10),
        bg="#f5f5f5",
        fg="#888888"
    )
    lbl_contador.pack(side="right")

# ── Main ────────────────────────────────────────────────────

if __name__ == "__main__":
    limpiar_codigos()          # limpia canjeados/vencidos antes de exponer el servidor
    iniciar_servidor_hilo()

    ventana = tk.Tk()
    construir_ui(ventana)

    # Arranca el ciclo de limpieza periódica -- la primera ejecución
    # programada ocurre recién dentro de INTERVALO_LIMPIEZA_MS (la
    # limpieza de "arranque" ya se hizo arriba, antes de crear la
    # ventana, así que no hace falta duplicarla acá).
    ventana.after(INTERVALO_LIMPIEZA_MS, lambda: programar_limpieza_periodica(ventana))

    ventana.mainloop()