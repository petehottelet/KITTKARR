const { test } = require('node:test');
const assert = require('node:assert/strict');
const authModule = Promise.resolve(require('../auth.cjs'));

const env = { KITT_LOGIN_USERNAME: 'test-user', KITT_LOGIN_PASSWORD: 'test-pass:with-colon' };
const basic = (credentials) => `Basic ${Buffer.from(credentials).toString('base64')}`;
const request = (authorization) => new Request('https://example.com/', authorization ? { headers: { Authorization: authorization } } : undefined);

test('the hosted site stays locked until a username and password are configured', async () => {
  const { loginConfig, signInResponse } = await authModule;
  assert.equal(loginConfig({}), null);
  assert.equal(loginConfig({ KITT_LOGIN_USERNAME: 'test-user' }), null);
  assert.equal(loginConfig({ KITT_LOGIN_PASSWORD: 'test-pass' }), null);
  const response = signInResponse(request(basic('test-user:test-pass')), {});
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('www-authenticate'), null);
});

test('requests without the correct username and password are asked to sign in', async () => {
  const { signInResponse } = await authModule;
  for (const authorization of [undefined, 'Bearer test-pass', basic('test-user:wrong'), basic('other:test-pass:with-colon'), basic('test-user'), basic('test-user:test-pass:with-colo'), 'Basic not-base64!']) {
    const response = signInResponse(request(authorization), env);
    assert.equal(response.status, 401, String(authorization));
    assert.match(response.headers.get('www-authenticate'), /^Basic realm=/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('the correct username and password let the request continue, including passwords with colons', async () => {
  const { signInResponse, isSignedIn, loginConfig } = await authModule;
  assert.equal(signInResponse(request(basic('test-user:test-pass:with-colon')), env), null);
  assert.equal(signInResponse(request(basic('test-user:test-pass:with-colon').replace('Basic', 'basic')), env), null);
  assert.equal(isSignedIn(basic('Test-user:test-pass:with-colon'), loginConfig(env)), false);
});
