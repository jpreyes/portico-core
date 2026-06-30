"""Servidor de desarrollo sin caché para PÓRTICO (análisis estructural 3D).
Uso: python serve.py [puerto]   (puerto por defecto: 8765)
"""
import http.server, socketserver, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        # Manifest PWA: tipo correcto para que el navegador lo acepte
        if str(path).endswith('.webmanifest'):
            return 'application/manifest+json; charset=UTF-8'
        ctype = super().guess_type(path)
        if isinstance(ctype, str):
            if ctype in ('text/javascript', 'application/javascript', 'text/css', 'text/html'):
                ctype = ctype + '; charset=UTF-8'
        return ctype

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # silenciar logs de acceso

# Servidor MULTIHILO (#7): con un solo hilo (TCPServer), al cargar la página se piden
# muchos módulos ES en paralelo (three.module.js ~1 MB + decenas de .js); el servidor
# serializaba las peticiones, abortaba conexiones (WinError 10053) y rechazaba las nuevas
# (ERR_CONNECTION_REFUSED) → la página no cargaba de forma intermitente. Atender cada
# petición en su hilo lo resuelve.
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

os.chdir(os.path.dirname(os.path.abspath(__file__)))
with Server(('', PORT), NoCacheHandler) as httpd:
    print(f'PORTICO -> http://localhost:{PORT}')
    httpd.serve_forever()
