const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

loadEnv();
const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || `http://localhost:${PORT}/auth/github/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET;
const UNITY_EDITOR_PATH = process.env.UNITY_EDITOR_PATH;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const ROOT = __dirname;
const sessions = new Map();
const oauthStates = new Map();
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const GITHUB_API = 'https://api.github.com';

function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function cookieValue(req, name) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}
function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex'); }
function sessionFor(req) {
  if (!SESSION_SECRET) return null;
  const raw = cookieValue(req, 'forge_session');
  const split = raw.lastIndexOf('.');
  if (split < 0) return null;
  const id = raw.slice(0, split), signature = raw.slice(split + 1);
  const expected = sign(id);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) { sessions.delete(id); return null; }
  session.expiresAt = Date.now() + SESSION_TTL;
  return session;
}
function setSessionCookie(res, id, maxAge = SESSION_TTL / 1000) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `forge_session=${encodeURIComponent(`${id}.${sign(id)}`)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}
function clearSessionCookie(res) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `forge_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`);
}
function redirect(res, location) { res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' }); res.end(); }
function validSlug(value) { return /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..'; }
function githubHeaders(session) {
  return { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Forge-Unity-Workspace' };
}
async function github(session, endpoint, options = {}) {
  const response = await fetch(`${GITHUB_API}${endpoint}`, { ...options, headers: { ...githubHeaders(session), ...(options.headers || {}) } });
  const body = await response.text();
  let data;
  try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  if (!response.ok) {
    const error = new Error(data?.message || `GitHub returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { const error = new Error('Request body too large'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { const error = new Error('Invalid JSON body'); error.status = 400; throw error; }
}
function gitClone(url, branch, directory, token) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
    const child = spawn('git', ['clone', '--depth', '1', '--single-branch', '--branch', branch, url, directory], {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`, GIT_LFS_SKIP_SMUDGE: '1' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 5000) stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`git clone failed: ${stderr.trim() || `exit ${code}`}`)));
  });
}
function runUnity(projectPath) {
  return new Promise((resolve, reject) => {
    const logPath = path.join(projectPath, 'forge-unity-check.log');
    const args = ['-batchmode', '-nographics', '-quit', '-accept-apiupdate', '-projectPath', projectPath, '-logFile', logPath];
    const child = spawn(UNITY_EDITOR_PATH, args, { windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); reject(Object.assign(new Error('Unity check timed out after 5 minutes'), { status: 504 })); } }, 5 * 60 * 1000);
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      let log = '';
      try { log = fs.readFileSync(logPath, 'utf8'); } catch {}
      const errors = [...log.matchAll(/error CS\d+[^\r\n]*/g)].map(match => match[0]).slice(0, 100);
      const warnings = [...log.matchAll(/warning CS\d+[^\r\n]*/g)].map(match => match[0]).slice(0, 100);
      resolve({ ok: code === 0 && errors.length === 0, exitCode: code, errors, warnings, output: log.slice(-12000) });
    });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && pathname === '/auth/github') {
    if (!CLIENT_ID || !CLIENT_SECRET || !SESSION_SECRET) return redirect(res, '/?setup=github');
    const state = crypto.randomBytes(24).toString('hex');
    oauthStates.set(state, Date.now() + 10 * 60 * 1000);
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', CLIENT_ID);
    authorize.searchParams.set('redirect_uri', CALLBACK_URL);
    authorize.searchParams.set('scope', 'repo');
    authorize.searchParams.set('state', state);
    return redirect(res, authorize.toString());
  }
  if (req.method === 'GET' && pathname === '/auth/github/callback') {
    const state = url.searchParams.get('state');
    const expires = state && oauthStates.get(state);
    if (!state || !expires || expires < Date.now() || url.searchParams.has('error')) return redirect(res, '/?auth=failed');
    oauthStates.delete(state);
    try {
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: CALLBACK_URL })
      });
      const token = await tokenResponse.json();
      if (!tokenResponse.ok || token.error || !token.access_token) throw new Error('GitHub authorization failed');
      const session = { accessToken: token.access_token, expiresAt: Date.now() + SESSION_TTL };
      const profile = await github(session, '/user');
      session.user = { login: profile.login, name: profile.name, avatar_url: profile.avatar_url };
      const id = crypto.randomBytes(32).toString('hex');
      sessions.set(id, session);
      setSessionCookie(res, id);
      return redirect(res, '/');
    } catch (error) { console.error('GitHub OAuth callback:', error.message); return redirect(res, '/?auth=failed'); }
  }
  if (pathname.startsWith('/api/')) {
    const session = sessionFor(req);
    if (pathname === '/api/session' && req.method === 'GET') return send(res, 200, { authenticated: Boolean(session), user: session?.user || null, unityConfigured: Boolean(UNITY_EDITOR_PATH && fs.existsSync(UNITY_EDITOR_PATH)) });
    if (pathname === '/api/logout' && req.method === 'POST') {
      const raw = cookieValue(req, 'forge_session'); const id = raw.split('.')[0]; sessions.delete(id); clearSessionCookie(res); return send(res, 200, { ok: true });
    }
    if (!session) return send(res, 401, { error: 'Sign in with GitHub to continue.' });
    if (req.method === 'GET' && pathname === '/api/repos') {
      const repos = await github(session, '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
      return send(res, 200, repos.map(repo => ({ id: repo.id, full_name: repo.full_name, name: repo.name, owner: repo.owner.login, private: repo.private, default_branch: repo.default_branch, updated_at: repo.updated_at, description: repo.description })));
    }
    const repoMatch = pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/(branches|tree|file|commit|commits|check)$/);
    if (repoMatch) {
      const [, owner, repo, action] = repoMatch;
      if (!validSlug(owner) || !validSlug(repo)) return send(res, 400, { error: 'Invalid repository name.' });
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      if (action === 'branches' && req.method === 'GET') {
        const branches = await github(session, `${base}/branches?per_page=100`);
        return send(res, 200, branches.map(item => item.name));
      }
      if (action === 'commits' && req.method === 'GET') {
        const ref = url.searchParams.get('ref') || 'HEAD';
        const commits = await github(session, `${base}/commits?per_page=1&sha=${encodeURIComponent(ref)}`);
        return send(res, 200, commits.map(item => ({ sha: item.sha, message: item.commit.message.split('\n')[0], author: item.author?.login || item.commit.author?.name || 'Unknown', date: item.commit.author?.date || item.commit.committer?.date || null, url: item.html_url })));
      }
      if (action === 'tree' && req.method === 'GET') {
        const ref = url.searchParams.get('ref') || 'HEAD';
        const branch = await github(session, `${base}/branches/${encodeURIComponent(ref)}`);
        const tree = await github(session, `${base}/git/trees/${branch.commit.sha}?recursive=1`);
        return send(res, 200, { ref, truncated: tree.truncated, tree: tree.tree.filter(item => item.type === 'blob').map(item => ({ path: item.path, sha: item.sha, size: item.size, type: item.type })) });
      }
      if (action === 'file' && req.method === 'GET') {
        const filePath = url.searchParams.get('path'); const ref = url.searchParams.get('ref') || 'HEAD';
        if (!filePath || filePath.startsWith('/') || filePath.split('/').some(part => part === '..')) return send(res, 400, { error: 'Invalid file path.' });
        const file = await github(session, `${base}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
        if (Array.isArray(file) || file.type !== 'file') return send(res, 400, { error: 'Path is not a file.' });
        if (file.encoding !== 'base64') return send(res, 413, { error: 'This file is too large to edit in the browser.' });
        return send(res, 200, { path: file.path, sha: file.sha, content: Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8'), size: file.size });
      }
      if (action === 'commit' && req.method === 'POST') {
        const body = await readBody(req);
        if (!validSlug(body.branch || '') || !body.message?.trim() || !Array.isArray(body.files) || !body.files.length || body.files.length > 30) return send(res, 400, { error: 'Provide a branch, commit message, and up to 30 changed files.' });
        const branch = await github(session, `${base}/branches/${encodeURIComponent(body.branch)}`);
        const parent = await github(session, `${base}/git/commits/${branch.commit.sha}`);
        const tree = [];
        for (const file of body.files) {
          if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split('/').some(part => !part || part === '..')) return send(res, 400, { error: 'One or more file paths are invalid.' });
          if (file.deleted === true) { tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null }); continue; }
          if (typeof file.content !== 'string') return send(res, 400, { error: 'One or more file contents are invalid.' });
          const blob = await github(session, `${base}/git/blobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: file.content, encoding: 'utf-8' }) });
          tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
        }
        const newTree = await github(session, `${base}/git/trees`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base_tree: parent.tree.sha, tree }) });
        const commit = await github(session, `${base}/git/commits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: body.message.trim(), tree: newTree.sha, parents: [branch.commit.sha] }) });
        const updated = await github(session, `${base}/git/refs/heads/${encodeURIComponent(body.branch)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha: commit.sha, force: false }) });
        return send(res, 200, { ok: true, sha: updated.object.sha, url: commit.html_url });
      }
      if (action === 'check' && req.method === 'POST') {
        if (!UNITY_EDITOR_PATH || !fs.existsSync(UNITY_EDITOR_PATH)) return send(res, 503, { error: 'Unity Editor is not configured on this server. Install and activate Unity, then set UNITY_EDITOR_PATH.' });
        const body = await readBody(req);
        if (!validSlug(body.branch || '')) return send(res, 400, { error: 'Invalid branch.' });
        if (body.files !== undefined && (!Array.isArray(body.files) || body.files.length > 30)) return send(res, 400, { error: 'Provide up to 30 unsaved files.' });
        const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-unity-'));
        const projectPath = path.join(tempRoot, 'project');
        try {
          await gitClone(`https://github.com/${owner}/${repo}.git`, body.branch, projectPath, session.accessToken);
          for (const file of body.files || []) {
            if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split('/').some(part => !part || part === '..') || typeof file.content !== 'string') return send(res, 400, { error: 'One or more file paths or contents are invalid.' });
            const destination = path.resolve(projectPath, file.path);
            if (!destination.startsWith(`${projectPath}${path.sep}`)) return send(res, 400, { error: 'Invalid file path.' });
            await fs.promises.mkdir(path.dirname(destination), { recursive: true });
            await fs.promises.writeFile(destination, file.content, 'utf8');
          }
          const result = await runUnity(projectPath);
          return send(res, 200, result);
        } finally { await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 3 }); }
      }
    }
    return send(res, 404, { error: 'API route not found.' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filename = path.resolve(ROOT, relative);
  if (!filename.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return send(res, 404, { error: 'Not found.' });
  const type = filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filename).pipe(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error(`${req.method} ${req.url}: ${error.message}`);
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : (error.status ? error.message : 'Request failed.') });
    else res.end();
  });
});
server.listen(PORT, () => console.log(`Forge is listening at http://localhost:${PORT}`));
for (const map of [sessions, oauthStates]) setInterval(() => { const now = Date.now(); for (const [key, item] of map) if ((item.expiresAt || item) < now) map.delete(key); }, 60 * 60 * 1000).unref();
