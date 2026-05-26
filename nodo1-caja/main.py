import tkinter as tk
from tkinter import messagebox
import threading
import json
import os
from datetime import datetime
from generator import generar_codigo, generar_qr
from server import iniciar_servidor

# ── Configuración ──────────────────────────────────────────
RUTA_CODIGOS = "codes/codes.json"

# ── Funciones de soporte ────────────────────────────────────

def contar_tickets_hoy():
    """
    Cuenta cuántos tickets se generaron hoy.
    Lee el codes.json y filtra por fecha de creación.
    """
    if not os.path.exists(RUTA_CODIGOS):
        return 0
    
    with open(RUTA_CODIGOS, "r") as f:
        codigos = json.load(f)
    
    hoy = datetime.now().strftime("%Y-%m-%d")
    count = 0
    
    for datos in codigos.values():
        if datos["creado"].startswith(hoy):
            count += 1
    
    return count

def emitir_ticket():
    """
    Genera el código UUID, crea el QR e imprime.
    Esta función se llama cuando el cajero presiona el botón.
    """
    try:
        # Genera el código y el QR
        codigo = generar_codigo()
        ruta_qr = generar_qr(codigo)
        
        # Actualiza la interfaz con el nuevo código
        lbl_codigo.config(text=f"{codigo[:35]}...")
        
        expiracion = datetime.now().strftime("%Y-%m-%d") + " (mañana)"
        lbl_expira.config(text=f"Expira: {expiracion}")
        
        # Actualiza el contador de tickets
        lbl_contador.config(text=f"tickets hoy: {contar_tickets_hoy()}")
        
        messagebox.showinfo(
            "Ticket generado",
            f"QR generado exitosamente.\nCódigo: {codigo[:20]}...\nArchivo: {ruta_qr}"
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
    iniciar_servidor_hilo()
    
    ventana = tk.Tk()
    construir_ui(ventana)
    ventana.mainloop()