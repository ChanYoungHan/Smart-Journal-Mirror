/**
 * OAuth 2.1 Proxy for AFFiNE MCP Server
 *
 * Specs:
 *   RFC 6749  - OAuth 2.0 Authorization Framework
 *   RFC 7636  - PKCE (Proof Key for Code Exchange)
 *   RFC 7591  - Dynamic Client Registration
 *   RFC 8414  - Authorization Server Metadata
 *   RFC 8707  - Resource Indicators / Protected Resource Metadata
 *   OAuth 2.1 - https://oauth.net/2.1/ (PKCE required, implicit flow removed)
 *
 * Flow:
 *   Claude.ai → POST /mcp (no token) → 401 + WWW-Authenticate
 *   → GET /.well-known/oauth-protected-resource
 *   → GET /.well-known/oauth-authorization-server
 *   → POST /oauth/register (dynamic client registration)
 *   → GET /oauth/authorize (login form) → POST /oauth/authorize (password)
 *   → POST /oauth/token (code + PKCE verifier → access_token)
 *   → POST /mcp (Bearer access_token) → proxy → affine-mcp (Bearer MCP_BEARER_TOKEN)
 */

'use strict';

const http   = require('http');
const crypto = require('crypto');

const PORT             = parseInt(process.env.PORT || '4000', 10);
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD   || '';
const MCP_UPSTREAM_URL = process.env.MCP_UPSTREAM_URL || 'http://affine-mcp:3000/mcp';
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || '';
const PUBLIC_URL       = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const TOKEN_TTL_SEC    = parseInt(process.env.TOKEN_TTL_SEC   || String(30 * 24 * 3600), 10);
const SESSION_TTL_SEC  = parseInt(process.env.SESSION_TTL_SEC || String(30 * 24 * 3600), 10);

if (!ADMIN_PASSWORD) { console.error('ERROR: ADMIN_PASSWORD is required'); process.exit(1); }
if (!MCP_BEARER_TOKEN) { console.error('ERROR: MCP_BEARER_TOKEN is required'); process.exit(1); }
if (!PUBLIC_URL)       { console.error('ERROR: PUBLIC_URL is required'); process.exit(1); }

// ── In-memory stores ──────────────────────────────────────────────────────────

// RFC 7591 — registered clients: clientId → { redirectUris, grantTypes }
const clients = new Map();

// Authorization codes (TTL 10 min): code → { clientId, redirectUri, codeChallenge, expiresAt, used }
const authCodes = new Map();

// Access tokens: token → { clientId, expiresAt }
const accessTokens = new Map();

// Login sessions: sessionId → { expiresAt }
const sessions = new Map();

// Cleanup expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCodes)    if (v.expiresAt < now) authCodes.delete(k);
  for (const [k, v] of accessTokens) if (v.expiresAt < now) accessTokens.delete(k);
  for (const [k, v] of sessions)     if (v.expiresAt < now) sessions.delete(k);
}, 5 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(res, status, body, extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function oauthError(res, status, error, description) {
  json(res, status, { error, error_description: description });
}

function redirect(res, uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  res.writeHead(302, { Location: u.toString() });
  res.end();
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(v.join('='));
  }
  return out;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// RFC 7636 §4.6 — S256 code challenge verification
function verifyPKCE(verifier, challenge) {
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  if (computed.length !== challenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies['mcp_session'];
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) return null;
  return session;
}

// ── Endpoint handlers ─────────────────────────────────────────────────────────

// RFC 8707 §3 — OAuth 2.0 Protected Resource Metadata
// Claude.ai hits /mcp → 401 with resource_metadata URL → fetches this endpoint
function handleProtectedResource(res) {
  json(res, 200, {
    resource:                    PUBLIC_URL,
    authorization_servers:       [PUBLIC_URL],
    bearer_methods_supported:    ['header'],
  });
}

// RFC 8414 — Authorization Server Metadata
// Advertises supported grant types, endpoints, PKCE methods
function handleAuthServerMeta(res) {
  json(res, 200, {
    issuer:                                PUBLIC_URL,
    authorization_endpoint:                `${PUBLIC_URL}/oauth/authorize`,
    token_endpoint:                        `${PUBLIC_URL}/oauth/token`,
    registration_endpoint:                 `${PUBLIC_URL}/oauth/register`,
    response_types_supported:              ['code'],
    grant_types_supported:                 ['authorization_code'],
    code_challenge_methods_supported:      ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported:                      ['mcp'],
  });
}

// RFC 7591 — Dynamic Client Registration
// Claude.ai auto-registers itself here to obtain a client_id
async function handleRegister(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return oauthError(res, 400, 'invalid_request', 'invalid JSON body');
  }

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris is required');
  }

  const clientId = crypto.randomUUID();
  clients.set(clientId, {
    redirectUris: body.redirect_uris,
    grantTypes:   body.grant_types || ['authorization_code'],
  });

  json(res, 201, {
    client_id:                  clientId,
    client_id_issued_at:        Math.floor(Date.now() / 1000),
    redirect_uris:              body.redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types:                body.grant_types || ['authorization_code'],
    response_types:             body.response_types || ['code'],
  });
}

const LOGIN_FORM = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AFFiNE MCP 인증</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;
  display:flex;align-items:center;justify-content:center;background:#f5f5f7}
.card{background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.1);
  padding:2rem;width:100%;max-width:360px}
h2{margin:0 0 1.5rem;font-size:1.25rem;color:#1d1d1f}
label{display:block;font-size:.875rem;color:#3d3d3f;margin-bottom:.25rem}
input[type=password]{width:100%;padding:.625rem .75rem;border:1px solid #d2d2d7;
  border-radius:8px;font-size:1rem;outline:none;margin-bottom:1rem}
input[type=password]:focus{border-color:#0071e3;box-shadow:0 0 0 3px rgba(0,113,227,.15)}
button{width:100%;padding:.75rem;background:#0071e3;color:#fff;border:none;
  border-radius:8px;font-size:1rem;cursor:pointer;font-weight:500}
button:hover{background:#0077ed}
.err{color:#d70015;font-size:.875rem;margin-top:.75rem;padding:.5rem .75rem;
  background:#fff2f2;border-radius:6px}
</style>
</head>
<body>
<div class="card">
  <h2>AFFiNE MCP 인증</h2>
  <form method="POST" action="/oauth/authorize">
    <label for="pw">비밀번호</label>
    <input type="password" id="pw" name="password" autofocus autocomplete="current-password">
    {{HIDDEN}}
    <button type="submit">로그인</button>
    {{ERROR}}
  </form>
</div>
</body>
</html>`;

function renderLoginForm(params, error = '') {
  const hiddenFields = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escHtml(k)}" value="${escHtml(v)}">`)
    .join('\n    ');
  const errHtml = error ? `<p class="err">${escHtml(error)}</p>` : '';
  return LOGIN_FORM
    .replace('{{HIDDEN}}', hiddenFields)
    .replace('{{ERROR}}', errHtml);
}

// Authorization endpoint — GET: show login form or issue code if session exists
function handleAuthorizeGet(req, res, params) {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = params;

  // Validate client before rendering form (don't redirect on client errors per RFC 6749 §4.1.2.1)
  if (!client_id || !clients.has(client_id)) {
    return oauthError(res, 400, 'invalid_client', 'unknown client_id');
  }
  const client = clients.get(client_id);
  if (!redirect_uri || !client.redirectUris.includes(redirect_uri)) {
    return oauthError(res, 400, 'invalid_request', 'redirect_uri not registered');
  }

  if (response_type !== 'code') {
    return redirect(res, redirect_uri, { error: 'unsupported_response_type', state });
  }
  if (!code_challenge) {
    return redirect(res, redirect_uri, { error: 'invalid_request', error_description: 'code_challenge required', state });
  }
  if (code_challenge_method !== 'S256') {
    // OAuth 2.1 requires S256; plain is not allowed
    return redirect(res, redirect_uri, { error: 'invalid_request', error_description: 'only S256 supported', state });
  }

  // If valid session cookie → skip login form, issue code directly
  if (getSession(req)) {
    return issueCode(res, { client_id, redirect_uri, code_challenge, state, scope });
  }

  // Show login form with all OAuth params preserved in hidden fields
  const html = renderLoginForm({ response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state: state || '', scope: scope || '' });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function issueCode(res, { client_id, redirect_uri, code_challenge, state, scope }) {
  const code = crypto.randomBytes(32).toString('base64url');
  authCodes.set(code, {
    clientId:      client_id,
    redirectUri:   redirect_uri,
    codeChallenge: code_challenge,
    scope:         scope || 'mcp',
    expiresAt:     Date.now() + 10 * 60 * 1000,
    used:          false,
  });
  redirect(res, redirect_uri, { code, state });
}

// Authorization endpoint — POST: process login form submission
async function handleAuthorizePost(req, res) {
  const raw = await readBody(req);
  const body = new URLSearchParams(raw.toString());
  const get = k => body.get(k) || '';

  const client_id            = get('client_id');
  const redirect_uri         = get('redirect_uri');
  const code_challenge       = get('code_challenge');
  const code_challenge_method = get('code_challenge_method');
  const response_type        = get('response_type');
  const state                = get('state');
  const scope                = get('scope');
  const password             = get('password');

  // Re-validate (hidden fields could be tampered)
  if (!client_id || !clients.has(client_id)) {
    return oauthError(res, 400, 'invalid_client', 'unknown client_id');
  }
  const client = clients.get(client_id);
  if (!redirect_uri || !client.redirectUris.includes(redirect_uri)) {
    return oauthError(res, 400, 'invalid_request', 'redirect_uri not registered');
  }

  // Constant-time password comparison (timing attack mitigation)
  const pwBuf       = Buffer.from(password);
  const adminBuf    = Buffer.from(ADMIN_PASSWORD);
  const pwdMatch    = pwBuf.length === adminBuf.length &&
                      crypto.timingSafeEqual(pwBuf, adminBuf);

  if (!pwdMatch) {
    const html = renderLoginForm(
      { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope },
      '비밀번호가 올바르지 않습니다.'
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // Issue session cookie
  const sessionId = crypto.randomBytes(16).toString('hex');
  sessions.set(sessionId, { expiresAt: Date.now() + SESSION_TTL_SEC * 1000 });
  res.setHeader('Set-Cookie', `mcp_session=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/oauth/authorize; Max-Age=${SESSION_TTL_SEC}`);

  issueCode(res, { client_id, redirect_uri, code_challenge, state, scope });
}

// Token endpoint — exchange authorization code for access token
// RFC 7636 §4.6: verify code_verifier against stored code_challenge
async function handleToken(req, res) {
  const raw  = await readBody(req);
  const body = new URLSearchParams(raw.toString());
  const get  = k => body.get(k) || '';

  const grant_type    = get('grant_type');
  const code          = get('code');
  const redirect_uri  = get('redirect_uri');
  const client_id     = get('client_id');
  const code_verifier = get('code_verifier');

  if (grant_type !== 'authorization_code') {
    return oauthError(res, 400, 'unsupported_grant_type', 'only authorization_code is supported');
  }

  const entry = authCodes.get(code);
  if (!entry)                            return oauthError(res, 400, 'invalid_grant', 'unknown code');
  if (entry.used)                        return oauthError(res, 400, 'invalid_grant', 'code already used');
  if (entry.expiresAt < Date.now())      return oauthError(res, 400, 'invalid_grant', 'code expired');
  if (entry.clientId !== client_id)      return oauthError(res, 400, 'invalid_grant', 'client_id mismatch');
  if (entry.redirectUri !== redirect_uri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
  if (!code_verifier || !verifyPKCE(code_verifier, entry.codeChallenge)) {
    return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
  }

  // Mark code as used immediately (replay attack prevention)
  authCodes.set(code, { ...entry, used: true });

  const token = crypto.randomBytes(32).toString('base64url');
  accessTokens.set(token, {
    clientId:  client_id,
    expiresAt: Date.now() + TOKEN_TTL_SEC * 1000,
  });

  json(res, 200, {
    access_token: token,
    token_type:   'Bearer',
    expires_in:   TOKEN_TTL_SEC,
    scope:        entry.scope,
  });
}

// MCP reverse proxy — validate Bearer token, forward to affine-mcp
// Replaces Authorization header with internal MCP_BEARER_TOKEN
function handleMcpProxy(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) {
    return send401(res);
  }
  const token = auth.slice(7);
  const entry = accessTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    return send401(res);
  }

  const upstreamUrl = new URL(MCP_UPSTREAM_URL);

  // GET = SSE stream (no body), pipe directly
  if (req.method === 'GET') {
    const upHeaders = {
      'Authorization': `Bearer ${MCP_BEARER_TOKEN}`,
      'Accept':        'text/event-stream',
    };
    if (req.headers['mcp-session-id']) upHeaders['mcp-session-id'] = req.headers['mcp-session-id'];

    const upReq = http.request({
      hostname: upstreamUrl.hostname,
      port:     upstreamUrl.port || 80,
      path:     upstreamUrl.pathname,
      method:   'GET',
      headers:  upHeaders,
    }, upRes => {
      const outHeaders = {
        'Content-Type':                upRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control':               'no-cache',
        'Connection':                  'keep-alive',
        'Access-Control-Allow-Origin': '*',
      };
      if (upRes.headers['mcp-session-id']) outHeaders['mcp-session-id'] = upRes.headers['mcp-session-id'];
      res.writeHead(upRes.statusCode, outHeaders);
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });
    upReq.on('error', err => {
      console.error('[proxy error]', err.message);
      if (!res.headersSent) oauthError(res, 502, 'upstream_error', err.message);
      else res.destroy();
    });
    upReq.end();
    req.on('close', () => upReq.destroy());
    return;
  }

  // POST / DELETE — buffer body first to set exact Content-Length
  // (avoids Transfer-Encoding: chunked conflicts with upstream)
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    const upHeaders = {
      'Authorization':  `Bearer ${MCP_BEARER_TOKEN}`,
      'Content-Type':   req.headers['content-type'] || 'application/json',
      'Accept':         req.headers['accept']        || 'application/json, text/event-stream',
      'Content-Length': body.length,
    };
    if (req.headers['mcp-session-id']) upHeaders['mcp-session-id'] = req.headers['mcp-session-id'];

    console.log(`[proxy] → ${req.method} ${upstreamUrl.pathname} (${body.length}b)`);

    const upReq = http.request({
      hostname: upstreamUrl.hostname,
      port:     upstreamUrl.port || 80,
      path:     upstreamUrl.pathname,
      method:   req.method,
      headers:  upHeaders,
    }, upRes => {
      console.log(`[proxy] ← ${upRes.statusCode} ${upRes.headers['content-type'] || ''}`);
      const outHeaders = {
        'Content-Type':                upRes.headers['content-type'] || 'application/json',
        'Access-Control-Allow-Origin': '*',
      };
      if (upRes.headers['mcp-session-id']) outHeaders['mcp-session-id'] = upRes.headers['mcp-session-id'];
      if ((upRes.headers['content-type'] || '').includes('text/event-stream')) {
        outHeaders['Cache-Control'] = 'no-cache';
        outHeaders['Connection']    = 'keep-alive';
      }
      res.writeHead(upRes.statusCode, outHeaders);
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });

    upReq.on('error', err => {
      console.error('[proxy error]', err.message);
      if (!res.headersSent) oauthError(res, 502, 'upstream_error', err.message);
      else res.destroy();
    });

    upReq.write(body);
    upReq.end();
  });
  req.on('error', err => console.error('[client error]', err.message));
}

function send401(res) {
  // WWW-Authenticate with resource_metadata triggers Claude.ai's OAuth discovery
  res.writeHead(401, {
    'Content-Type':     'application/json',
    'WWW-Authenticate': `Bearer realm="AFFiNE MCP", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error: 'unauthorized', error_description: 'Bearer token required or expired' }));
}

// ── Router ────────────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  const parsed   = new URL(req.url, `http://localhost`);
  const pathname = parsed.pathname;
  const start    = Date.now();
  res.on('finish', () => console.log(`${req.method} ${pathname} → ${res.statusCode} (${Date.now() - start}ms)`));

  // CORS preflight for browser-based OAuth clients
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, mcp-session-id',
    });
    return res.end();
  }

  try {
    if (req.method === 'GET'  && pathname === '/.well-known/oauth-protected-resource')  return handleProtectedResource(res);
    if (req.method === 'GET'  && pathname === '/.well-known/oauth-authorization-server') return handleAuthServerMeta(res);
    if (req.method === 'POST' && pathname === '/oauth/register')                         return handleRegister(req, res);
    if (req.method === 'GET'  && pathname === '/oauth/authorize') {
      const params = {};
      for (const [k, v] of parsed.searchParams) params[k] = v;
      return handleAuthorizeGet(req, res, params);
    }
    if (req.method === 'POST'   && pathname === '/oauth/authorize') return handleAuthorizePost(req, res);
    if (req.method === 'POST'   && pathname === '/oauth/token')     return handleToken(req, res);
    // Claude.ai sends MCP requests to the connector URL root (/), not /mcp
    if (pathname === '/mcp' || pathname === '/')                     return handleMcpProxy(req, res);

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  } catch (err) {
    console.error('[unhandled]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'server_error', error_description: err.message }));
    }
  }
}).listen(PORT, () => {
  console.log(`[mcp-oauth] listening on :${PORT}`);
  console.log(`[mcp-oauth] PUBLIC_URL: ${PUBLIC_URL}`);
  console.log(`[mcp-oauth] upstream:   ${MCP_UPSTREAM_URL}`);
});
