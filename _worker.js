/**
 * Cloudflare Worker — 通用代理 + Docker Registry Mirror
 *
 * 路由规则：
 *   OPTIONS *                  → CORS 预检
 *   /v2/...                    → Docker Registry → registry-1.docker.io
 *   /https://... /http://...   → 通用 URL 代理（git clone / wget）
 *   /<image> 或 /<user>/<img>  → Docker pull（docker pull 本域名时）
 *   其他路径                     → Pages 静态资源
 *
 * Docker 鉴权凭据优先级（见「凭据处理」小节）：
 *   客户端 Authorization(Basic/Bearer) → env.DOCKER_USER/DOCKER_PASS → 匿名
 */

// ============================================================
// 配置
// ============================================================

const DOCKER_UPSTREAM = 'https://registry-1.docker.io';

const ALLOWED_HOSTS = [
  'github.com', 'api.github.com', 'raw.githubusercontent.com',
  'gist.github.com', 'gist.githubusercontent.com',
  'quay.io', 'gcr.io', 'k8s.gcr.io', 'registry.k8s.io',
  'ghcr.io', 'docker.cloudsmith.io', 'registry-1.docker.io',
];

const DOCKER_REGISTRIES = new Set([
  'quay.io', 'gcr.io', 'k8s.gcr.io', 'registry.k8s.io',
  'ghcr.io', 'docker.cloudsmith.io', 'registry-1.docker.io',
]);

const STRIP_REQ_HEADERS = new Set([
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'cf-ew-via', 'x-forwarded-proto', 'x-real-ip', 'cdn-loop',
]);

const STRIP_RES_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-content-security-policy', 'x-webkit-csp',
]);

// 空 body 的 SHA-256，S3 需要
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MAX_REDIRECTS = 5;

// ============================================================
// 工具函数
// ============================================================

function isAmazonS3(url) {
  try { return new URL(url).hostname.includes('amazonaws.com'); } catch { return false; }
}

function getAmzDate() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, -5) + 'Z';
}

/** 构建代理请求头：去掉 CF 私有头，替换 Host，S3 自动补 amz 头 */
function buildReqHeaders(request, targetUrl) {
  const targetHost = new URL(targetUrl).host;
  const h = new Headers();

  for (const [k, v] of request.headers) {
    if (STRIP_REQ_HEADERS.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === 'host') { h.set('host', targetHost); continue; }
    h.set(k, v);
  }
  if (!h.has('host')) h.set('host', targetHost);

  // S3 需要这四个头，客户端可能不带
  if (isAmazonS3(targetUrl)) {
    h.set('x-amz-content-sha256', EMPTY_BODY_SHA256);
    h.set('x-amz-date', getAmzDate());
  } else {
    // 非 S3 去掉可能干扰的残留 amz 头
    h.delete('x-amz-content-sha256');
    h.delete('x-amz-date');
    h.delete('x-amz-security-token');
    h.delete('x-amz-user-agent');
  }
  return h;
}

/** CORS 预检 */
function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/** 包装上游响应：加 CORS + 去敏感头 */
function wrapResponse(upstream) {
  const h = new Headers(upstream.headers);
  for (const name of STRIP_RES_HEADERS) h.delete(name);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('Access-Control-Expose-Headers', '*');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: h,
  });
}

// ============================================================
// 凭据处理
//
// 注意：本文件所有 Authorization 一律用字符串拼接（'Basic ' + xxx），
// 不要改成模板字面量。历史上这里的 ${...} 被误写成 \(...\)，
// 导致 Basic 头变成字面量 "({user}:){pass}"，凭据永远无效。
// ============================================================

/** env 里的 Docker 账号；两者都非空才有效 */
function getEnvCreds(env) {
  if (!env) return null;
  const user = (env.DOCKER_USER || '').trim();
  const pass = (env.DOCKER_PASS || '').trim();
  return user && pass ? { user: user, pass: pass } : null;
}

/** UTF-8 安全 base64（btoa 只接受 Latin-1，密码含中文/emoji 会直接抛错） */
function base64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function basicAuthHeader(user, pass) {
  return 'Basic ' + base64Utf8(user + ':' + pass);
}

/** 客户端自带的 Authorization（Basic / Bearer），原样使用 */
function getClientAuth(request) {
  const raw = request.headers.get('Authorization');
  if (!raw) return null;
  const m = /^\s*([A-Za-z][A-Za-z0-9-]*)\s+(\S.*)$/.exec(raw);
  if (!m) return null;
  return { scheme: m[1].toLowerCase(), value: m[2].trim() };
}

/** 解析 WWW-Authenticate 参数，兼容带引号与不带引号两种写法 */
function parseAuthParams(wwwAuth) {
  const s = wwwAuth.replace(/^\s*Bearer\s+/i, '');
  const out = {};
  const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

// ============================================================
// Docker Auth Token
// ============================================================

/**
 * 用凭据换 token。
 * 依次尝试：客户端 Basic 凭据 → env 凭据 → 匿名，任一步成功即返回。
 * 客户端带的是 Bearer 时无法用它换新 token（token 不是可再生的），直接落到 env。
 *
 * @returns {Promise<{token: string, source: 'client'|'env'|'anonymous'} | null>}
 */
async function fetchDockerToken(wwwAuth, env, clientAuth) {
  const params = parseAuthParams(wwwAuth);
  if (!params.realm) return null;

  let tokenUrl;
  try {
    tokenUrl = new URL(params.realm);
    if (params.service) tokenUrl.searchParams.set('service', params.service);
    if (params.scope) tokenUrl.searchParams.set('scope', params.scope);
    // 增加 client_id，伪装成标准客户端，防止被官方拦截
    tokenUrl.searchParams.set('client_id', 'cloudflare-docker-proxy');
  } catch (err) {
    return null;
  }

  // 组装尝试顺序：客户端凭据优先，env 兜底，最后匿名
  const attempts = [];
  if (clientAuth && clientAuth.scheme === 'basic') {
    attempts.push({ source: 'client', header: 'Basic ' + clientAuth.value });
  }
  const creds = getEnvCreds(env);
  if (creds) {
    attempts.push({ source: 'env', header: basicAuthHeader(creds.user, creds.pass) });
  }
  // 客户端凭据与 env 相同时不重复请求
  const unique = attempts.filter((a, i) => attempts.findIndex((b) => b.header === a.header) === i);
  unique.push({ source: 'anonymous', header: null });

  for (const attempt of unique) {
    try {
      const fetchHeaders = { Accept: 'application/json' };
      if (attempt.header) fetchHeaders.Authorization = attempt.header;

      const res = await fetch(tokenUrl.toString(), { headers: fetchHeaders });
      // res.ok 为 false 说明这一档凭据不被认可，继续尝试下一档
      if (!res.ok) continue;

      const data = await res.json();
      const token = data.token || data.access_token;
      if (token) return { token: token, source: attempt.source };
    } catch (err) {
      // 网络/解析异常同样降级到下一档
    }
  }
  return null;
}

// ============================================================
// 核心代理（带 token 重试 + S3 重定向反代）
// ============================================================

/**
 * @param {object} [diag] 诊断对象，会被写入 { source } 表示本次用了哪一档凭据
 */
async function proxyWithAuth(targetUrl, request, isDocker, env, redirectCount = 0, diag) {
  if (redirectCount > MAX_REDIRECTS) {
    return new Response('Too many redirects', { status: 508 });
  }

  const headers = buildReqHeaders(request, targetUrl);
  // 客户端主动带了认证就先原样透传；只有上游 401 时 Worker 才去换 token
  const clientAuth = isDocker ? getClientAuth(request) : null;
  if (clientAuth && diag && !diag.source) diag.source = 'client';

  let upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
  });

  // ===== Docker 401 → 换 token 重试 =====
  if (isDocker && upstream.status === 401) {
    const wwwAuth = upstream.headers.get('WWW-Authenticate');
    if (wwwAuth) {
      const got = await fetchDockerToken(wwwAuth, env, clientAuth);
      if (got) {
        if (diag) diag.source = got.source;
        const authHeaders = buildReqHeaders(request, targetUrl);
        authHeaders.set('Authorization', 'Bearer ' + got.token);
        upstream = await fetch(targetUrl, {
          method: request.method,
          headers: authHeaders,
          body: request.body,
          redirect: 'manual',
        });
      } else {
        // 拿不到 token（解析失败或凭据全都不认）：抹除 WWW-Authenticate，
        // 防止客户端被迫直连可能被墙的 auth 服务
        if (diag) diag.source = 'none';
        const res = wrapResponse(upstream);
        res.headers.delete('WWW-Authenticate');
        return res;
      }
    }
  }

  // ===== S3 / CDN 重定向 → 重新代理 =====
  // 此时的 upstream 可能是第一次的 307，也可能是换 token 重试后拿到的 307
  if (upstream.status === 302 || upstream.status === 307) {
    const location = upstream.headers.get('Location');
    if (location) {
      let redirectHost = '';
      try { redirectHost = new URL(location).hostname; } catch { redirectHost = ''; }

      const redirHeaders = buildReqHeaders(request, location);
      if (DOCKER_REGISTRIES.has(redirectHost)) {
        const upstreamAuth = upstream.headers.get('Authorization');
        if (upstreamAuth) redirHeaders.set('Authorization', upstreamAuth);
      } else {
        // 关键：客户端凭据只发给 registry。S3/CDN 的预签名 URL 自身带签名，
        // 再附带 Authorization 会被拒（Only one auth mechanism allowed）
        redirHeaders.delete('Authorization');
      }

      // 重定向到存储节点后不再视为 Docker 鉴权
      return proxyWithAuth(location, new Request(location, {
        method: request.method,
        headers: redirHeaders,
        body: request.body,
      }), false, env, redirectCount + 1, diag);
    }
  }

  return wrapResponse(upstream);
}

// ============================================================
// Docker 路径解析
// ============================================================

/**
 * 仅识别两种 Docker 路径（Docker daemon 实际发出的请求格式）：
 *   /v2/library/nginx/...         → Docker Hub registry mirror
 *   /ghcr.io/user/image/...       → 第三方 registry
 * 不做"单段 = library/xxx"的猜测，避免把 /gh、/docs 等静态页面路径误判为镜像名。
 */
function parseDockerPath(pathname, search) {
  const suffix = search || '';

  // 处理 /v2/ghcr.io/xxx 格式
  if (pathname.startsWith('/v2/')) {
    const pathWithoutV2 = pathname.replace('/v2/', '');
    const parts = pathWithoutV2.split('/');

    // 如果发现路径第一段是第三方 registry（比如 ghcr.io）
    if (DOCKER_REGISTRIES.has(parts[0])) {
      const host = parts[0];
      const imagePath = parts.slice(1).join('/');
      // 一律字符串拼接，别用模板字面量（历史踩坑见「凭据处理」说明）
      return {
        targetUrl: 'https://' + host + '/v2/' + imagePath + suffix,
        isDocker: true,
      };
    }

    // 否则默认发往 Docker Hub
    return {
      targetUrl: DOCKER_UPSTREAM + pathname + suffix,
      isDocker: true,
    };
  }

  // 处理客户端非标请求格式 (直接请求 /ghcr.io/...)
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length > 0 && DOCKER_REGISTRIES.has(parts[0])) {
    const host = parts[0];
    const imagePath = parts.slice(1).join('/');
    return {
      targetUrl: 'https://' + host + '/v2/' + imagePath + suffix,
      isDocker: true,
    };
  }

  return null;
}

// ============================================================
// 主入口
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, search } = url;

    if (request.method === 'OPTIONS') return corsPreflight();

    // —— Docker 路径 ——
    const docker = parseDockerPath(pathname, search);
    if (docker) {
      const diag = { source: null };
      const res = await proxyWithAuth(docker.targetUrl, request, docker.isDocker, env, 0, diag);

      // 诊断：只暴露「用了哪一档凭据」，不含任何凭据内容
      const source = diag.source || 'none';
      console.log('docker-proxy ' + request.method + ' ' + pathname + ' auth=' + source);
      if (env.DEBUG_AUTH === '1') {
        try { res.headers.set('X-Proxy-Auth-Source', source); } catch (err) { /* 响应头不可写就算了 */ }
      }
      return res;
    }

    // —— 通用 URL 代理 (/https://github.com/...) ——
    if (/^\/https?:\/\//.test(pathname)) {
      const targetUrl = pathname.slice(1) + (search || '');
      // 目标域名不在白名单里就拒绝
      try {
        const targetHost = new URL(targetUrl).hostname;
        if (!ALLOWED_HOSTS.includes(targetHost)) {
          return new Response('Error: domain "' + targetHost + '" not allowed.\n', { status: 400 });
        }
      } catch (err) {
        return new Response('Error: invalid target URL.\n', { status: 400 });
      }
      return proxyWithAuth(targetUrl, request, false, env);
    }

    // —— 静态资源 ——
    try {
      const assetsResp = await env.ASSETS.fetch(request);
      // 如果路径不含扩展名，且 ASSETS 返回了 404，尝试追加 .html
      if (assetsResp.status === 404 && !pathname.includes('.')) {
        const htmlUrl = new URL(request.url);
        htmlUrl.pathname = pathname + '.html';
        const htmlResp = await env.ASSETS.fetch(new Request(htmlUrl, request));
        if (htmlResp.status !== 404) return htmlResp;
      }
      return assetsResp;
    } catch (_) {
      return new Response('Not Found', { status: 404 });
    }
  },
};
