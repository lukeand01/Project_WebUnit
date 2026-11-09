'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 10000);
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_LSP_SESSIONS || 2));
const UNITY_REFERENCES_ROOT = process.env.UNITY_REFERENCES_ROOT || '';
const activeSessions = new Set();
const lspSockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

function safeEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function validSlug(value) { return /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..'; }
function validBranch(value) {
  return typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9_./-]+$/.test(value) &&
    !value.startsWith('-') && !value.includes('..') && !value.includes('//') && !value.endsWith('/') &&
    value.split('/').every(part => part && part !== '.' && !part.startsWith('.'));
}

function rejectUpgrade(socket, status, message) {
  const body = JSON.stringify({ error: message });
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 429 ? 'Too Many Requests' : 'Service Unavailable'}\r\n` +
    'Connection: close\r\nContent-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  socket.destroy();
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
    child.stderr.on('data', chunk => { if (stderr.length < 3000) stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `git clone exited with ${code}`)));
  });
}

function hasProjectFile(root) {
  const ignored = new Set(['.git', 'Library', 'Temp', 'Obj', 'Logs', 'UserSettings', 'node_modules', 'bin', 'obj']);
  const visit = (directory, depth) => {
    if (depth > 5) return false;
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (entry.isFile() && /\.(?:sln|slnx|csproj)$/i.test(entry.name)) return true;
      if (entry.isDirectory() && !ignored.has(entry.name) && visit(path.join(directory, entry.name), depth + 1)) return true;
    }
    return false;
  };
  return visit(root, 0);
}

function unityReferenceDirectory(workspace) {
  if (!UNITY_REFERENCES_ROOT) return '';
  let version = '';
  try { version = fs.readFileSync(path.join(workspace, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8').match(/^m_EditorVersion:\s*(.+)$/m)?.[1]?.trim() || ''; } catch {}
  const candidates = [version && path.join(UNITY_REFERENCES_ROOT, version), UNITY_REFERENCES_ROOT].filter(Boolean);
  for (const candidate of candidates) {
    const managed = path.join(candidate, 'Editor', 'Data', 'Managed');
    if (fs.existsSync(managed)) return managed;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  return '';
}

function ensureWorkspaceProject(workspace) {
  if (hasProjectFile(workspace)) return;
  const references = unityReferenceDirectory(workspace);
  let referenceXml = '';
  if (references) {
    try {
      referenceXml = fs.readdirSync(references, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^(?:UnityEngine|UnityEditor)[A-Za-z0-9_.-]*\.dll$/i.test(entry.name))
        .map(entry => {
          const filename = path.join(references, entry.name).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const name = entry.name.replace(/\.dll$/i, '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `    <Reference Include="${name}"><HintPath>${filename}</HintPath><Private>false</Private></Reference>`;
        }).join('\n');
    } catch {}
  }
  const project = `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>netstandard2.1</TargetFramework>\n    <LangVersion>latest</LangVersion>\n    <EnableDefaultCompileItems>true</EnableDefaultCompileItems>\n  </PropertyGroup>\n  <ItemGroup>\n    <Compile Remove="Library/**/*.cs;Temp/**/*.cs;Obj/**/*.cs;obj/**/*.cs" />\n${referenceXml}${referenceXml ? '\n' : ''}  </ItemGroup>\n</Project>\n`;
  fs.writeFileSync(path.join(workspace, 'WebUnity.Workspace.csproj'), project, 'utf8');
}

function pathToMemoryUri(workspace, uri) {
  try {
    const filename = fileURLToPath(uri);
    const relative = path.relative(workspace, filename);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return uri;
    return `inmemory://forge/${encodeURIComponent(relative.split(path.sep).join('/'))}`;
  } catch { return uri; }
}

function memoryUriToFileUri(workspace, uri) {
  if (typeof uri !== 'string' || !uri.startsWith('inmemory://forge/')) return uri;
  let relative;
  try { relative = decodeURIComponent(new URL(uri).pathname).replace(/^\/+/, ''); }
  catch { throw new Error('Invalid editor document URI.'); }
  if (!relative || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('Invalid editor document path.');
  const filename = path.resolve(workspace, ...relative.split(/[\\/]/));
  if (!filename.startsWith(`${workspace}${path.sep}`)) throw new Error('Editor document path is outside the workspace.');
  return pathToFileURL(filename).href;
}

function rewriteLspUris(value, workspace, direction) {
  if (Array.isArray(value)) return value.map(item => rewriteLspUris(item, workspace, direction));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && key === 'uri') {
      result[key] = direction === 'in' ? memoryUriToFileUri(workspace, child) : pathToMemoryUri(workspace, child);
    } else if (key === 'rootUri' && direction === 'in' && (child == null || child === 'inmemory://forge/')) {
      result[key] = pathToFileURL(workspace).href;
    } else if (key === 'workspaceFolders' && direction === 'in' && Array.isArray(child)) {
      result[key] = [{ uri: pathToFileURL(workspace).href, name: 'WebUnity workspace' }];
    } else {
      result[key] = rewriteLspUris(child, workspace, direction);
    }
  }
  return result;
}

function attachLspProtocol(ws, child, workspace) {
  let stdoutBuffer = Buffer.alloc(0);
  let closed = false;
  const fail = message => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message })); };

  child.stdout.on('data', chunk => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    while (true) {
      const headerEnd = stdoutBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = stdoutBuffer.subarray(0, headerEnd).toString('ascii');
      const length = Number(header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > 2 * 1024 * 1024) { fail('Roslyn sent an invalid LSP message.'); ws.close(1011); return; }
      const frameEnd = headerEnd + 4 + length;
      if (stdoutBuffer.length < frameEnd) break;
      const body = stdoutBuffer.subarray(headerEnd + 4, frameEnd);
      stdoutBuffer = stdoutBuffer.subarray(frameEnd);
      try {
        const message = JSON.parse(body.toString('utf8'));
        const clientMessage = rewriteLspUris(message, workspace, 'out');
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(clientMessage));
      } catch (error) { fail(error.message); ws.close(1011); return; }
    }
  });
  child.stderr.on('data', chunk => {
    const line = chunk.toString().trim();
    if (line) console.warn(`Roslyn LSP: ${line.slice(0, 500)}`);
  });
  child.once('error', error => { if (!closed) fail(`Could not start the Roslyn language server: ${error.message}`); });
  child.once('close', code => { if (!closed && ws.readyState === WebSocket.OPEN) { fail(`Roslyn language server stopped${code == null ? '' : ` (exit ${code})`}.`); ws.close(1011); } });

  ws.on('message', (data, isBinary) => {
    if (isBinary || !child.stdin.writable) return ws.close(1003, 'Send JSON LSP messages as text.');
    try {
      const message = JSON.parse(data.toString());
      const outgoing = rewriteLspUris(message, workspace, 'in');
      const body = Buffer.from(JSON.stringify(outgoing), 'utf8');
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
    } catch (error) { fail(error.message); ws.close(1008); }
  });
  ws.once('close', () => { closed = true; });
  return () => { closed = true; if (!child.killed) child.kill('SIGTERM'); };
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  res.writeHead(404); res.end();
});

server.on('upgrade', (req, socket, head) => {
  void (async () => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const owner = req.headers['x-webunity-owner'];
    const repo = req.headers['x-webunity-repo'];
    const branch = req.headers['x-webunity-branch'];
    const token = req.headers['x-webunity-github-token'];
    if (url.pathname !== '/lsp' || !INTERNAL_SECRET || !safeEqual(req.headers.authorization?.replace(/^Bearer\s+/i, ''), INTERNAL_SECRET)) return rejectUpgrade(socket, 401, 'Unauthorized.');
    if (!validSlug(owner) || !validSlug(repo) || !validBranch(branch) || typeof token !== 'string' || token.length < 10 || token.length > 4096) return rejectUpgrade(socket, 400, 'Invalid repository workspace request.');
    if (activeSessions.size >= MAX_SESSIONS) return rejectUpgrade(socket, 429, 'The language server is at capacity. Try again shortly.');

    const session = { directory: null, child: null, dispose: () => {} };
    activeSessions.add(session);
    const cleanup = async () => {
      if (session.cleaned) return;
      session.cleaned = true;
      activeSessions.delete(session);
      session.dispose();
      if (session.directory) await fs.promises.rm(session.directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    };
    socket.once('close', () => { void cleanup(); });
    try {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webunity-roslyn-'));
      session.directory = root;
      const workspace = path.join(root, 'workspace');
      await gitClone(`https://github.com/${owner}/${repo}.git`, branch, workspace, token);
      ensureWorkspaceProject(workspace);
      const command = process.env.ROSLYN_LANGUAGE_SERVER || 'roslyn-language-server';
      const child = spawn(command, ['--stdio', '--autoLoadProjects'], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      session.child = child;
      lspSockets.handleUpgrade(req, socket, head, ws => {
        session.dispose = attachLspProtocol(ws, child, workspace);
        ws.once('close', () => { void cleanup(); });
        ws.once('error', () => { void cleanup(); });
      });
    } catch (error) {
      console.error(`Roslyn workspace startup failed: ${error.message}`);
      await cleanup();
      if (!socket.destroyed) rejectUpgrade(socket, 503, 'Could not prepare the C# language server workspace.');
    }
  })();
});

server.listen(PORT, '0.0.0.0', () => console.log(`WebUnity Roslyn worker listening on ${PORT}`));
server.on('close', () => { for (const session of activeSessions) session.dispose(); });
