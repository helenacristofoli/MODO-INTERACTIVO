from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from datetime import datetime

import codes_store


class ManejadorQR(BaseHTTPRequestHandler):
    """
    Maneja las peticiones HTTP que llegan al servidor.
    Piénsalo como un switch-case que reacciona según la URL que llega.
    """
    def do_GET(self):
        # Parsea la URL para extraer el parámetro 'code'
        url = urlparse(self.path)
        params = parse_qs(url.query)
        
        # ¿La petición es para /validate?
        if url.path == "/validate":
            
            # ¿Viene el parámetro code?
            if "code" not in params:
                self._responder(400, "falta el parámetro code")
                return
            
            codigo = params["code"][0]

            # Antes: validar_codigo(codigo) y, si daba True, marcar_usado(codigo)
            # aparte -- dos operaciones separadas, sin lock entre medio.
            # Ahora: codes_store hace las dos cosas en una sola operación
            # atómica (ver codes_store.py), así ningún otro hilo puede
            # colarse entre el chequeo y la marca.
            if codes_store.validar_y_marcar_usado(codigo):
                self._responder(200, "válido")
            else:
                self._responder(200, "inválido")

        # ── Consulta de solo lectura para Nodo 3 (bridge) ──────────
        # El bridge llama acá antes de ejecutar cualquier preset que
        # venga con un "code" por WebSocket, para confirmar que
        # corresponde a una sesión real y no a un mensaje armado a
        # mano por alguien conectado a la misma wifi.
        elif url.path == "/session-activa":

            if "code" not in params:
                self._responder(400, "falta el parámetro code")
                return

            codigo = params["code"][0]

            if codes_store.esta_activo(codigo):
                self._responder(200, "activo")
            else:
                self._responder(200, "inactivo")

        else:
            self._responder(404, "ruta no encontrada")
    
    def _responder(self, status, mensaje):
        """
        Envía la respuesta HTTP al cliente.
        """
        # Permite peticiones desde cualquier origen (necesario para la tablet)
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(mensaje.encode("utf-8"))
    
    def log_message(self, format, *args):
        """
        Personaliza el log para ver qué peticiones llegan.
        """
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {args[0]} → {args[1]}")

def iniciar_servidor(puerto=8000):
    servidor = HTTPServer(("0.0.0.0", puerto), ManejadorQR)
    print(f"Servidor corriendo en puerto {puerto}...")
    print(f"Esperando peticiones en http://0.0.0.0:{puerto}/validate")
    servidor.serve_forever()

if __name__ == "__main__":
    iniciar_servidor()