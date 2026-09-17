/**
 * 零依赖本地测试：node tests/auth.mjs
 *
 * 直接加载真实的 _worker.js（通过 data: URL 导入，因为仓库没有 package.json），
 * 替换 globalThis.fetch 捕获 Worker 发往上游的每一个请求，验证：
 *   1. 客户端无认证 → 用 env 凭据换 token
 *   2. DEBUG_AUTH=1 暴露诊断头
 *   3. 客户端 Basic 优先
 *   4. 客户端凭据失败 → 回落 env 凭据
 *   5. 客户端 Bearer 原样透传
 *   6. 重定向到 S3 时剥离 Authorization
 *   7. ghcr 路径拼接（防止 ${...} 再次被写坏）
 *   8. 非 ASCII 凭据的 UTF-8 base64
 *   9. 无 env 凭据时保持匿名
 *  10. 全档失败时返回 401 且抹掉 WWW-Authenticate
 *  11. 客户端凭据与 env 相同时不重复换 token
 *  12. 源码卫生守卫
 */

import fs from 'node:fs';

const BACKSLASH = String.fromCharCode(92);
const source = fs.readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
const worker = (await import(
  'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')
)).default;

const BASE = 'https://proxy.example.com';
const MANIFEST = '/v2/library/nginx/manifests/latest';
const ENV = { DOCKER_USER: 'envuser', DOCKER_PASS: 'envpass' };
const DEBUG_ENV = { DOCKER_USER: 'envuser', DOCKER_PASS: 'envpass', DEBUG_AUTH: '1' };
const ENV_BASIC = 'Basic ' + btoa('envuser:envpass');

let failures = 0;
let checks = 0;
let calls = [];

function ok(name, cond, detail) {
  checks++;
  if (cond) {
    console.log('PASS  ' + name);
  } else {
    failures++;
    console.log('FAIL  ' + name + (detail === undefined ? '' : '  ->  ' + detail));
  }
}

/** 记录所有上游请求，并按 URL 计数后交给 handler */
function installFetch(handler) {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const isRequest = typeof input === 'object' && input !== null;
    const url = isRequest ? input.url : String(input);
    const opts = init || {};
    const headers = new Headers(opts.headers || (isRequest ? input.headers : undefined));
    const rec = {
      url: url,
      method: opts.method || (isRequest ? input.method : 'GET'),
      headers: headers,
      auth: headers.get('Authorization'),
    };
    calls.push(rec);
    return handler(url, rec, calls.filter((c) => c.url === url).length);
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function challenge() {
  return new Response('', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
    },
  });
}

function isTokenUrl(url) {
  return url.indexOf('auth.docker.io') !== -1;
}

function run(path, headers, env) {
  return worker.fetch(
    new Request(BASE + path, { method: 'GET', headers: headers || undefined }),
    env || ENV,
    {},
  );
}

function findCalls(part) {
  return calls.filter((c) => c.url.indexOf(part) !== -1);
}

function lastCall() {
  return calls[calls.length - 1];
}

/** 标准场景：首次 401 → 换 token → 重试 200 */
function standardHandler(tokenBody) {
  return (url, rec, n) => {
    if (isTokenUrl(url)) return json(tokenBody || { token: 'TOKEN_FROM_ENV' });
    if (n === 1) return challenge();
    return new Response('manifest-body', { status: 200 });
  };
}

// ---------- 1. 客户端无认证 → env 凭据 ----------
installFetch(standardHandler());
{
  const res = await run(MANIFEST);
  const tokenCalls = findCalls('auth.docker.io');
  ok('1.1 无客户端认证时用 env 凭据换 token',
    tokenCalls.length === 1 && tokenCalls[0].auth === ENV_BASIC,
    JSON.stringify(tokenCalls.map((c) => c.auth)));
  ok('1.2 token 请求带 service 与 client_id',
    tokenCalls.length === 1
      && tokenCalls[0].url.indexOf('service=registry.docker.io') !== -1
      && tokenCalls[0].url.indexOf('client_id=cloudflare-docker-proxy') !== -1,
    tokenCalls.length ? tokenCalls[0].url : 'no token call');
  ok('1.3 用换来的 token 重试上游',
    res.status === 200 && lastCall().auth === 'Bearer TOKEN_FROM_ENV',
    lastCall().auth);
  ok('1.4 未开启 DEBUG_AUTH 时不暴露诊断头',
    res.headers.get('X-Proxy-Auth-Source') === null,
    String(res.headers.get('X-Proxy-Auth-Source')));
}

// ---------- 2. DEBUG_AUTH=1 诊断头 ----------
installFetch(standardHandler());
{
  const res = await run(MANIFEST, null, DEBUG_ENV);
  ok('2.1 DEBUG_AUTH=1 时诊断头为 env',
    res.headers.get('X-Proxy-Auth-Source') === 'env',
    String(res.headers.get('X-Proxy-Auth-Source')));
}

// ---------- 3. 客户端 Basic 优先 ----------
const CLIENT_BASIC = 'Basic ' + btoa('cu:cp');
installFetch(standardHandler());
{
  const res = await run(MANIFEST, { Authorization: CLIENT_BASIC }, DEBUG_ENV);
  ok('3.1 上游首个请求带客户端 Basic',
    calls[0].auth === CLIENT_BASIC,
    String(calls[0].auth));
  ok('3.2 换 token 使用客户端凭据',
    findCalls('auth.docker.io').length === 1
      && findCalls('auth.docker.io')[0].auth === CLIENT_BASIC,
    JSON.stringify(findCalls('auth.docker.io').map((c) => c.auth)));
  ok('3.3 诊断头为 client',
    res.headers.get('X-Proxy-Auth-Source') === 'client',
    String(res.headers.get('X-Proxy-Auth-Source')));
}

// ---------- 4. 客户端凭据被拒 → 回落 env ----------
installFetch((url, rec, n) => {
  if (isTokenUrl(url)) {
    return rec.auth === CLIENT_BASIC ? new Response('', { status: 401 }) : json({ token: 'TOKEN_FROM_ENV' });
  }
  if (n === 1) return challenge();
  return new Response('manifest-body', { status: 200 });
});
{
  const res = await run(MANIFEST, { Authorization: CLIENT_BASIC }, DEBUG_ENV);
  const tokenCalls = findCalls('auth.docker.io');
  ok('4.1 客户端凭据失败后回落 env 凭据',
    tokenCalls.length === 2 && tokenCalls[1].auth === ENV_BASIC,
    JSON.stringify(tokenCalls.map((c) => c.auth)));
  ok('4.2 诊断头为 env', res.headers.get('X-Proxy-Auth-Source') === 'env',
    String(res.headers.get('X-Proxy-Auth-Source')));
  ok('4.3 回落成功后仍能拿到内容', res.status === 200, String(res.status));
}

// ---------- 5. 客户端 Bearer 原样透传 ----------
installFetch(() => new Response('manifest-body', { status: 200 }));
{
  const res = await run(MANIFEST, { Authorization: 'Bearer CLIENT_TOKEN' }, DEBUG_ENV);
  ok('5.1 客户端 Bearer 原样透传',
    calls.length === 1 && calls[0].auth === 'Bearer CLIENT_TOKEN',
    JSON.stringify(calls.map((c) => c.auth)));
  ok('5.2 上游 200 时不再去换 token', findCalls('auth.docker.io').length === 0);
  ok('5.3 诊断头为 client',
    res.headers.get('X-Proxy-Auth-Source') === 'client',
    String(res.headers.get('X-Proxy-Auth-Source')));
}

// ---------- 6. 重定向到 S3 时剥离 Authorization ----------
const S3_URL = 'https://docker-images-prod.s3.amazonaws.com/blobs/sha256:abc?X-Amz-Signature=sig';
installFetch((url) => {
  if (url.indexOf('s3.amazonaws.com') !== -1) return new Response('blob', { status: 200 });
  if (url.indexOf('registry-1.docker.io') !== -1) {
    return new Response('', { status: 307, headers: { Location: S3_URL } });
  }
  return new Response('unexpected ' + url, { status: 500 });
});
{
  const res = await run('/v2/library/nginx/blobs/sha256:abc', { Authorization: 'Bearer CLIENT_TOKEN' });
  const s3call = calls[1];
  ok('6.1 registry 收到客户端 Bearer',
    calls[0].auth === 'Bearer CLIENT_TOKEN', String(calls[0].auth));
  ok('6.2 重定向到 S3 时剥离 Authorization',
    !!s3call && s3call.url.indexOf('s3.amazonaws.com') !== -1 && s3call.auth === null,
    s3call ? s3call.url + ' auth=' + String(s3call.auth) : 'no second call');
  ok('6.3 S3 请求自动补 x-amz 头',
    !!s3call && s3call.headers.get('x-amz-content-sha256') !== null);
  ok('6.4 blob 正常返回', res.status === 200, String(res.status));
}

// ---------- 7. ghcr / 第三方 registry 路径拼接 ----------
installFetch(() => new Response('{}', { status: 200 }));
{
  await run('/v2/ghcr.io/owner/img/manifests/latest');
  ok('7.1 /v2/ghcr.io/... 拼接正确',
    calls[0].url === 'https://ghcr.io/v2/owner/img/manifests/latest',
    calls[0].url);
}
installFetch(() => new Response('{}', { status: 200 }));
{
  await run('/ghcr.io/owner/img/manifests/latest?x=1');
  ok('7.2 /ghcr.io/... 拼接正确且保留 query',
    calls[0].url === 'https://ghcr.io/v2/owner/img/manifests/latest?x=1',
    calls[0].url);
}
installFetch(() => new Response('{}', { status: 200 }));
{
  await run('/v2/library/nginx/manifests/latest?ns=library');
  ok('7.3 Docker Hub 路径保留 query',
    calls[0].url === 'https://registry-1.docker.io/v2/library/nginx/manifests/latest?ns=library',
    calls[0].url);
}

// ---------- 8. 非 ASCII 凭据 ----------
installFetch(standardHandler());
{
  await run(MANIFEST, null, { DOCKER_USER: '用户', DOCKER_PASS: '密码' });
  ok('8.1 非 ASCII 凭据使用 UTF-8 base64',
    findCalls('auth.docker.io')[0].auth === 'Basic ' + Buffer.from('用户:密码', 'utf8').toString('base64'),
    String(findCalls('auth.docker.io')[0].auth));
}

// ---------- 9. 无 env 凭据 → 匿名 ----------
installFetch(standardHandler({ token: 'ANON_TOKEN' }));
{
  // 注意：这里必须用一个「没有 DOCKER_USER/DOCKER_PASS」的 env，否则测的就不是匿名档
  const res = await run(MANIFEST, null, { DEBUG_AUTH: '1' });
  ok('9.1 无 env 凭据时 token 请求不带 Authorization',
    findCalls('auth.docker.io')[0].auth === null,
    String(findCalls('auth.docker.io')[0].auth));
  ok('9.2 诊断头为 anonymous',
    res.headers.get('X-Proxy-Auth-Source') === 'anonymous',
    String(res.headers.get('X-Proxy-Auth-Source')));
}

// ---------- 10. 全档失败 → 401 且抹掉挑战 ----------
installFetch((url) => (isTokenUrl(url) ? new Response('', { status: 401 }) : challenge()));
{
  const res = await run(MANIFEST, null, DEBUG_ENV);
  ok('10.1 所有凭据档都失败时返回 401', res.status === 401, String(res.status));
  ok('10.2 抹掉 WWW-Authenticate（防止客户端直连被墙的 auth 服务）',
    res.headers.get('WWW-Authenticate') === null,
    String(res.headers.get('WWW-Authenticate')));
  ok('10.3 诊断头为 none',
    res.headers.get('X-Proxy-Auth-Source') === 'none',
    String(res.headers.get('X-Proxy-Auth-Source')));
}

// ---------- 11. 客户端与 env 凭据相同 → 只换一次 token ----------
installFetch(standardHandler());
{
  await run(MANIFEST, { Authorization: 'Basic ' + btoa('envuser:envpass') }, ENV);
  ok('11.1 同凭据不重复请求 token',
    findCalls('auth.docker.io').length === 1,
    String(findCalls('auth.docker.io').length));
}

// ---------- 12. 源码卫生 ----------
ok('12.1 源码无坏转义 ' + BACKSLASH + '({',
  source.indexOf(BACKSLASH + '({') === -1);
ok('12.2 源码无坏转义 ' + BACKSLASH + '){',
  source.indexOf(BACKSLASH + '){') === -1);
ok('12.3 Basic 头由字符串拼接构造',
  source.indexOf("'Basic ' + base64Utf8") !== -1);
ok('12.4 已移除 globalThis.USER/PASS 写法',
  source.indexOf('globalThis.USER') === -1);
ok('12.5 调用 fetchDockerToken 时传入了 env',
  source.indexOf('fetchDockerToken(wwwAuth, env, clientAuth)') !== -1);

console.log('');
console.log(failures === 0
  ? 'ALL PASS (' + checks + ' checks)'
  : failures + '/' + checks + ' CHECK(S) FAILED');
process.exitCode = failures === 0 ? 0 : 1;
