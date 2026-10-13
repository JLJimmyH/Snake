"""Fake Google for the smoke tests: Drive v3 (files, folders, resumable uploads, revisions, permissions) plus the OAuth
endpoints the Worker calls. Each account sees its own files; a file shared with another account (permissions) is visible
to it only after it was granted to the app (drive.file: picked in the Google Picker), like real Drive.
The same object answers the browser (Playwright routes) and the Worker (serve() starts a local HTTP server)."""
import json, re, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote, urlencode

CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type,x-upload-content-type',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'Access-Control-Expose-Headers': 'Location'}
DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file'
NAMES = {'alice': 'Alice', 'bob': 'Bob', 'carol': 'Carol'}

class FakeDrive:
    def __init__(self):
        self.files = {}; self.folders = {}; self.sessions = {}; self.next = 0; self.uploads = 0; self.fail_list = False
        self.inject = None      # 下一次上傳前，先插進一版（模擬別台裝置剛好同時存檔）
        self.next_user = 'alice'  # 假的 Google 登入畫面讓誰登入
        self.lock = threading.RLock()

    def store(self, file, data):
        self.next += 1
        rev = 'rev-' + str(self.next)
        file.setdefault('revisions', []).append((rev, data))
        file.update({'data': data, 'size': str(len(data)), 'headRevisionId': rev, 'modifiedTime': '2026-10-06T00:00:%02dZ' % (self.next % 60)})

    # account 看得到的檔案：自己的，或別人共用給他、而且他在檔案選擇器選過的
    def find(self, account, file_id):
        own = self.files.setdefault(account, {})
        if file_id in own: return own[file_id], 'owner'
        for owner, files in self.files.items():
            file = files.get(file_id)
            if file and account in file.get('granted', set()):
                role = file.get('perms', {}).get(account) or file.get('anyone')
                if role: return file, role
        return None, None

    def grant(self, account, file_id):
        """The account picked this file in the Google Picker."""
        for files in self.files.values():
            if file_id in files: files[file_id].setdefault('granted', set()).add(account)

    def fields(self, file, account=None, role='owner'):
        out = {k: v for k, v in file.items() if k not in ('data', 'revisions', 'perms', 'granted', 'anyone', 'owner')}
        owner = file.get('owner', account)
        out.update({'ownedByMe': role == 'owner', 'owners': [{'displayName': NAMES.get(owner, owner), 'emailAddress': owner + '@example.test'}],
                    'capabilities': {'canEdit': role in ('owner', 'writer'), 'canShare': role == 'owner'}})
        # 像真的 Drive：能管理共用的人（擁有者）才拿得到 permissions
        if role == 'owner':
            out['permissions'] = [{'id': owner, 'type': 'user', 'role': 'owner'}] + [{'id': who, 'type': 'user', 'role': r} for who, r in file.get('perms', {}).items()]
            if file.get('anyone'): out['permissions'].append({'id': 'anyoneWithLink', 'type': 'anyone', 'role': file['anyone']})
        return out

    # ---------- Playwright route（瀏覽器）----------
    def route(self, route):
        req = route.request
        status, headers, body = self.handle(req.method, req.url, req.headers, req.post_data_buffer)
        route.fulfill(status=status, headers={**CORS, **headers}, body=body)

    def handle(self, method, raw_url, headers, body):
        with self.lock:
            return self._handle(method, raw_url, {k.lower(): v for k, v in headers.items()}, body or b'')

    def _handle(self, method, raw_url, headers, body):
        url = urlparse(raw_url); q = parse_qs(url.query)
        def reply(status, data, extra={}):
            return status, {'content-type': 'application/json', **extra}, json.dumps(data).encode()
        def media(data):
            return 200, {'content-type': 'application/zip'}, data
        if method == 'OPTIONS': return reply(200, {})
        # ---- OAuth（Worker 呼叫）----
        if url.path == '/o/oauth2/v2/auth':
            back = q['redirect_uri'][0] + '?' + urlencode({'code': 'code-' + self.next_user, 'state': q['state'][0]})
            return 302, {'location': back}, b''
        if url.path == '/token':
            form = parse_qs(body.decode())
            if form['grant_type'][0] == 'authorization_code': account = form['code'][0].removeprefix('code-')
            else: account = form['refresh_token'][0].removeprefix('r-')
            return reply(200, {'access_token': 'token-' + account, 'refresh_token': 'r-' + account, 'expires_in': 3600, 'scope': DRIVE_FILE})
        if url.path == '/revoke': return reply(200, {})
        account = headers.get('authorization', '').removeprefix('Bearer token-')
        files = self.files.setdefault(account, {}); folders = self.folders.setdefault(account, {})
        if url.path == '/test/grant':  # 假的檔案選擇器：使用者選了這個檔案
            self.grant(account, q['file'][0]); return reply(200, {})
        # ---- 上傳 ----
        if url.path.startswith('/upload/drive/v3/files'):
            if 'upload_id' in q:
                session = self.sessions.pop(q['upload_id'][0])
                self.next += 1; self.uploads += 1
                if session['id']:
                    file, role = self.find(account, session['id'])
                else:
                    file_id = 'file-' + str(self.next)
                    file = files.setdefault(file_id, {'id': file_id, 'owner': account}); role = 'owner'
                file.update(session['meta'])
                if self.inject and session['id']:
                    self.store(file, self.inject(file['data'])); self.inject = None
                self.store(file, body)
                return reply(200, self.fields(file, account, role))
            file_id = unquote(url.path[len('/upload/drive/v3/files/'):]) if method == 'PATCH' else None
            if file_id:
                file, role = self.find(account, file_id)
                if not file or role not in ('owner', 'writer'): return reply(404, {'error': 'missing'})
            self.next += 1; sid = str(self.next)
            self.sessions[sid] = {'id': file_id, 'meta': json.loads(body)}
            return reply(200, {}, {'location': 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=' + sid})
        path = url.path.split('/drive/v3/')[-1]
        if path == 'about': return reply(200, {'user': {'permissionId': account, 'emailAddress': account + '@example.test', 'displayName': NAMES.get(account, account)}})
        if path == 'files' and method == 'POST':
            self.next += 1; folder = {'id': 'folder-' + str(self.next), **json.loads(body)}
            assert folder['mimeType'] == 'application/vnd.google-apps.folder', folder
            folders[folder['id']] = folder
            return reply(200, {'id': folder['id']})
        if path == 'files':
            query = q['q'][0]
            if 'vnd.google-apps.folder' in query:
                name = re.search(r"name = '([^']+)'", query).group(1)
                return reply(200, {'files': [{'id': f['id']} for f in folders.values() if f['name'] == name]})
            if self.fail_list: return reply(500, {'error': 'boom'})
            if "key='kind' and value='page'" in query:
                seen = []
                for owner, owned in self.files.items():
                    for file in owned.values():
                        found, role = self.find(account, file['id'])
                        if found and found.get('appProperties', {}).get('kind') == 'page' and not found.get('trashed'): seen.append(self.fields(found, account, role))
                return reply(200, {'files': seen})
            app = re.search(r"key='app' and value='([^']+)'", query).group(1)
            parents = set(re.findall(r"'([^']+)' in parents", query))
            return reply(200, {'files': [self.fields(f, account) for f in files.values()
                                         if f.get('appProperties', {}).get('app') == app and parents & set(f.get('parents', [])) and not f.get('trashed')]})
        parts = [unquote(x) for x in path[len('files/'):].split('/')]
        file, role = self.find(account, parts[0])
        if not file: return reply(404, {'error': 'missing'})
        if len(parts) >= 2 and parts[1] == 'permissions':
            if role != 'owner': return reply(403, {'error': 'forbidden'})
            perms = file.setdefault('perms', {})
            if method == 'GET':
                people = [{'id': file['owner'], 'type': 'user', 'role': 'owner', 'emailAddress': file['owner'] + '@example.test', 'displayName': NAMES.get(file['owner'])}]
                people += [{'id': who, 'type': 'user', 'role': r, 'emailAddress': who + '@example.test', 'displayName': NAMES.get(who)} for who, r in perms.items()]
                if file.get('anyone'): people.append({'id': 'anyoneWithLink', 'type': 'anyone', 'role': file['anyone']})
                return reply(200, {'permissions': people})
            if method == 'POST':
                data = json.loads(body)
                if data['type'] == 'anyone': file['anyone'] = data['role']; return reply(200, {'id': 'anyoneWithLink'})
                who = data['emailAddress'].split('@')[0]
                perms[who] = data['role']
                file.setdefault('invites', []).append({'to': data['emailAddress'], 'notify': q.get('sendNotificationEmail'), 'message': q.get('emailMessage', [''])[0]})
                return reply(200, {'id': who})
            pid = parts[2]
            if method == 'PATCH': perms[pid] = json.loads(body)['role']; return reply(200, {'id': pid})
            if method == 'DELETE':
                if pid == 'anyoneWithLink': file.pop('anyone', None)
                else: perms.pop(pid, None)
                return 204, {}, b''
        if len(parts) == 2: return reply(200, {'revisions': [{'id': rev} for rev, _ in file['revisions']]})
        if len(parts) == 3:
            data = dict(file['revisions']).get(parts[2])
            return media(data) if data else reply(404, {'error': 'missing'})
        if q.get('alt') == ['media']: return media(file['data'])
        if method == 'PATCH':  # 只改中繼資料（目前只用在移到垃圾桶）
            if role not in ('owner', 'writer'): return reply(403, {'error': 'forbidden'})
            file.update(json.loads(body))
        return reply(200, self.fields(file, account, role))

    # ---------- 本機 HTTP 伺服器（給 wrangler dev 裡的 Worker 呼叫）----------
    def serve(self, port):
        fake = self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'  # workerd 會重複使用連線；HTTP/1.0 回完就關，下一個請求會失敗
            def _any(self):
                length = int(self.headers.get('content-length') or 0)
                body = self.rfile.read(length) if length else b''
                status, headers, data = fake.handle(self.command, 'http://fake' + self.path, dict(self.headers), body)
                self.send_response(status)
                for k, v in headers.items(): self.send_header(k, v)
                self.send_header('content-length', str(len(data)))
                self.end_headers(); self.wfile.write(data)
            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _any
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server
