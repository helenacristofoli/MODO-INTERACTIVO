import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from datetime import datetime

RUTA_CODIGOS = "codes/codes.json"

def validar_codigo(codigo):
    """
    Verifica si un código es válido.
    Retorna True si existe, no expiró y no fue usado.
    Similar a buscar un elemento en un array de structs en C.
    """
    if not os.path.exists(RUTA_CODIGOS):
        return False
    
    with open(RUTA_CODIGOS, "r") as f:
        codigos = json.load(f)
    
    # ¿Existe el código?
    if codigo not in codigos:
        return False
    
    datos = codigos[codigo]
    
    # ¿Ya fue usado?
    if datos["usado"]:
        return False
    
    # ¿Expiró?
    expiracion = datetime.strptime(datos["expira"], "%Y-%m-%d %H:%M:%S")
    if datetime.now() > expiracion:
        return False
    
    return True

def marcar_usado(codigo):
    """
    Marca el código como usado para que no pueda usarse de nuevo.
    """
    with open(RUTA_CODIGOS, "r") as f:
        codigos = json.load(f)
    
    codigos[codigo]["usado"] = True
    
    with open(RUTA_CODIGOS, "w") as f:
        json.dump(codigos, f, indent=4)

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
            
            if validar_codigo(codigo):
                marcar_usado(codigo)
                self._responder(200, "válido")
            else:
                self._responder(200, "inválido")
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