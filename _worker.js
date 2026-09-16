/**
 * Cloudflare Worker — 通用代理 + Docker Registry Mirror
 *
 * 路由规则：
 *   OPTIONS *                  → CORS 预检
 *   /v2/...                    → Docker Registry → registry-1.docker.io
 *   /https://... /http://...   → 通用 URL 代理（git clone / wget）
 *   /<image> 或 /<user>/<img>  → Docker pull（docker pull 本域名时）
 *   其他路径                     → Pages 静态资源
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
// Docker Auth Token
// ============================================================

/** 解析 WWW-Authenticate 并拿 token */
async function fetchDockerToken(wwwAuth) {
  // 1. 去除 "Bearer " 前缀（忽略大小写，兼容开头可能的空格）
  const paramString = wwwAuth.replace(/^Bearer\s+/i, '');
  
  // 2. 动态提取所有的 key="value" 对，存入对象
  const params = {};
  const regex = /(\w+)="([^"]+)"/g;
  let match;
  while ((match = regex.exec(paramString)) !== null) {
    params[match[1]] = match[2];
  }

  // 3. 校验必须的最核心参数 realm
  if (!params.realm) return null;

  // 4. 使用原生 URL 对象安全地构建带参数的请求
  try {
    const tokenUrl = new URL(params.realm);
    if (params.service) tokenUrl.searchParams.set('service', params.service);
    if (params.scope) tokenUrl.searchParams.set('scope', params.scope);

    const res = await fetch(tokenUrl.toString(), { 
      headers: { Accept: 'application/json' } 
    });
    
    if (!res.ok) return null;
    
    const data = await res.json();
    return data.token || data.access_token || null;
  } catch (err) {
    return null;
  }
}

// ============================================================
// 核心代理（带 token 重试 + S3 重定向反代）
// ============================================================

async function proxyWithAuth(targetUrl, request, isDocker, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) {
    return new Response('Too many redirects', { status: 508 });
  }

  const headers = buildReqHeaders(request, targetUrl);

  // 修改点：使用 let 声明，允许被重试的请求覆盖
  let upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual', 
  });

  // ===== Docker 401 → 拿 token 重试 =====
  if (isDocker && upstream.status === 401) {
    const wwwAuth = upstream.headers.get('WWW-Authenticate');
    if (wwwAuth) {
      const token = await fetchDockerToken(wwwAuth);
      if (token) {
        const authHeaders = buildReqHeaders(request, targetUrl);
        authHeaders.set('Authorization', `Bearer ${token}`);
        // 修改点：不直接 return，而是覆盖 upstream，让其继续往下走
        upstream = await fetch(targetUrl, {
          method: request.method,
          headers: authHeaders,
          body: request.body,
          redirect: 'manual',
        });
      } else {
        // 修改点：如果拿不到 token（或解析失败），抹除 WWW-Authenticate，防止客户端直连被墙
        const res = wrapResponse(upstream);
        res.headers.delete('WWW-Authenticate');
        return res;
      }
    }
  }

  // ===== S3 / CDN 重定向 → 重新代理 =====
  // 修改点：此时的 upstream 可能是第一次的 307，也可能是获取 Token 重试后拿到的 307
  if (upstream.status === 302 || upstream.status === 307) {
    const location = upstream.headers.get('Location');
    if (location) {
      const redirHeaders = buildReqHeaders(request, location);
      const upstreamAuth = upstream.headers.get('Authorization');
      if (upstreamAuth) redirHeaders.set('Authorization', upstreamAuth);

      // 修改点：直接递归调用 proxyWithAuth 自己，而不是单独写一套 fetch
      // 注意：重定向到 S3 后，不再视为 Docker 鉴权 (isDocker = false)
      return proxyWithAuth(location, new Request(location, {
        method: request.method,
        headers: redirHeaders,
        body: request.body
      }), false, redirectCount + 1);
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
  // 核心修改：处理 /v2/ghcr.io/xxx 格式
  if (pathname.startsWith('/v2/')) {
    const pathWithoutV2 = pathname.replace('/v2/', '');
    const parts = pathWithoutV2.split('/');
    
    // 如果发现路径第一段是第三方 registry（比如 ghcr.io）
    if (DOCKER_REGISTRIES.has(parts[0])) {
      const host = parts[0];
      const imagePath = parts.slice(1).join('/');
      return {
        targetUrl: `https://\({host}/v2/\){imagePath}${search || ''}`,
        isDocker: true,
      };
    }
    
    // 否则默认发往 Docker Hub
    return {
      targetUrl: DOCKER_UPSTREAM + pathname + (search || ''),
      isDocker: true,
    };
  }

  // 处理客户端非标请求格式 (直接请求 /ghcr.io/...)
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length > 0 && DOCKER_REGISTRIES.has(parts[0])) {
    const host = parts[0];
    const imagePath = parts.slice(1).join('/');
    return {
      targetUrl: `https://\({host}/v2/\){imagePath}${search || ''}`,
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
      return proxyWithAuth(docker.targetUrl, request, docker.isDocker);
    }

    // —— 通用 URL 代理 (/https://github.com/...) ——
    if (/^\/https?:\/\//.test(pathname)) {
      const targetUrl = pathname.slice(1) + (search || '');
      // 目标域名不在白名单里就拒绝
      try {
        const targetHost = new URL(targetUrl).hostname;
        if (!ALLOWED_HOSTS.includes(targetHost)) {
          return new Response(`Error: domain "${targetHost}" not allowed.\n`, { status: 400 });
        }
      } catch {
        return new Response('Error: invalid target URL.\n', { status: 400 });
      }
      return proxyWithAuth(targetUrl, request, false);
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
