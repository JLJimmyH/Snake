"""Fake Google Drive v3 for the Playwright smoke tests: files, folders, resumable uploads and revisions."""
import json, re
from urllib.parse import urlparse, parse_qs, unquote

CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type,x-upload-content-type',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,OPTIONS', 'Access-Control-Expose-Headers': 'Location'}

class FakeDrive:
    def __init__(self):
        self.files = {}; self.folders = {}; self.sessions = {}; self.next = 0; self.uploads = 0; self.fail_list = False
        self.inject = None  # 下一次上傳前，先插進一版（模擬別台裝置剛好同時存檔）
    def store(self, file, data):
        self.next += 1
        rev = 'rev-' + str(self.next)
        file.setdefault('revisions', []).append((rev, data))
        file.update({'data': data, 'size': str(len(data)), 'headRevisionId': rev, 'modifiedTime': '2026-10-06T00:00:%02dZ' % (self.next % 60)})
    def fields(self, file):
        return {k: v for k, v in file.items() if k not in ('data', 'revisions')}
    def route(self, route):
        req = route.request; url = urlparse(req.url); q = parse_qs(url.query)
        def reply(status, data, headers={}):
            route.fulfill(status=status, content_type='application/json', headers={**CORS, **headers}, body=json.dumps(data))
        if req.method == 'OPTIONS': return reply(200, {})
        account = req.headers.get('authorization', '').removeprefix('Bearer token-')
        files = self.files.setdefault(account, {}); folders = self.folders.setdefault(account, {})
        if url.path.startswith('/upload/drive/v3/files'):
            if 'upload_id' in q:
                session = self.sessions.pop(q['upload_id'][0])
                self.next += 1; self.uploads += 1
                file = files.setdefault(session['id'] or 'file-' + str(self.next), {'id': session['id'] or 'file-' + str(self.next)})
                file.update(session['meta'])
                if self.inject and session['id']:
                    self.store(file, self.inject(file['data'])); self.inject = None
                self.store(file, req.post_data_buffer)
                return reply(200, self.fields(file))
            file_id = unquote(url.path[len('/upload/drive/v3/files/'):]) if req.method == 'PATCH' else None
            if file_id and file_id not in files: return reply(404, {'error': 'missing'})
            self.next += 1; sid = str(self.next)
            self.sessions[sid] = {'id': file_id, 'meta': json.loads(req.post_data)}
            return reply(200, {}, {'Location': 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=' + sid})
        path = url.path.split('/drive/v3/')[-1]
        if path == 'about': return reply(200, {'user': {'permissionId': account, 'emailAddress': account + '@example.test'}})
        if path == 'files' and req.method == 'POST':
            self.next += 1; folder = {'id': 'folder-' + str(self.next), **json.loads(req.post_data)}
            assert folder['mimeType'] == 'application/vnd.google-apps.folder', folder
            folders[folder['id']] = folder
            return reply(200, {'id': folder['id']})
        if path == 'files':
            query = q['q'][0]
            if 'vnd.google-apps.folder' in query:
                name = re.search(r"name = '([^']+)'", query).group(1)
                return reply(200, {'files': [{'id': f['id']} for f in folders.values() if f['name'] == name]})
            if self.fail_list: return reply(500, {'error': 'boom'})
            app = re.search(r"key='app' and value='([^']+)'", query).group(1)
            parents = set(re.findall(r"'([^']+)' in parents", query))
            return reply(200, {'files': [self.fields(f) for f in files.values()
                                         if f.get('appProperties', {}).get('app') == app and parents & set(f.get('parents', []))]})
        parts = [unquote(x) for x in path[len('files/'):].split('/')]
        file = files.get(parts[0])
        if not file: return reply(404, {'error': 'missing'})
        if len(parts) == 2: return reply(200, {'revisions': [{'id': rev} for rev, _ in file['revisions']]})
        if len(parts) == 3:
            data = dict(file['revisions']).get(parts[2])
            return route.fulfill(status=200, content_type='application/zip', headers=CORS, body=data) if data else reply(404, {'error': 'missing'})
        if q.get('alt') == ['media']: return route.fulfill(status=200, content_type='application/zip', headers=CORS, body=file['data'])
        return reply(200, self.fields(file))

