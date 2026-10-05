"""區網測試用靜態伺服器：python server.py [port]

- 綁定 0.0.0.0，同一個 Wi-Fi 的手機可以連線
- 強制正確的 MIME（Windows 登錄檔有時把 .js 設成 text/plain，ES module 會載不起來）
- 關閉快取，改完檔案手機重新整理就是最新版
"""
import http.server
import os
import socket
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.webmanifest': 'application/manifest+json',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print(f'電腦： http://localhost:{PORT}')
    print(f'手機： http://{lan_ip()}:{PORT}', flush=True)
    server.serve_forever()
