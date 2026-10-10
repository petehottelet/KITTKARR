// HTTP Basic sign-in for the whole app. Credentials come from the environment and are never stored in the repository.
// CommonJS so the Vercel middleware, which is compiled to CommonJS, can load it.

const realm = 'K.I.T.T.';
const encoder = new TextEncoder();

function loginConfig(env = process.env) {
  const username = (env.KITT_LOGIN_USERNAME || '').trim();
  const password = env.KITT_LOGIN_PASSWORD || '';
  return username && password ? { username, password } : null;
}

// Compares every byte so the time taken does not reveal how much of a guess was right.
function sameText(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let difference = x.length ^ y.length;
  for (let index = 0; index < Math.max(x.length, y.length); index++) difference |= (x[index] ?? 0) ^ (y[index] ?? 0);
  return difference === 0;
}

function isSignedIn(authorization, login) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(authorization || '');
  if (!match || !login) return false;
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0))); } catch { return false; }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const userMatches = sameText(decoded.slice(0, separator), login.username);
  const passwordMatches = sameText(decoded.slice(separator + 1), login.password);
  return userMatches && passwordMatches;
}

const signInHeaders = { 'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

// Returns a response that blocks the request, or null when it may continue.
// Without configured credentials the hosted site stays locked rather than open.
function signInResponse(request, env = process.env) {
  const login = loginConfig(env);
  if (!login) return new Response('Sign-in has not been set up for this site.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (isSignedIn(request.headers.get('authorization'), login)) return null;
  return new Response('Sign in to use K.I.T.T.', { status: 401, headers: signInHeaders });
}

module.exports = { loginConfig, isSignedIn, signInHeaders, signInResponse };
