/**
 * 零依赖本地测试：node tests/stream.mjs
 *
 * 验证「大文件自动断点续传」（_worker.js 的 streamWithResume）：
 *   1. 上游提前断流（content-length 没传完就 close）→ 用 Range 从断点续传
 *   2. 上游静默（不 close 也不发数据）→ 静默超时后自动续传
 *   3. 上游忽略 Range 返回 200 → 丢弃已发送前缀后拼接，字节不错位
 *   4. 续传次数用尽 → 客户端流立刻报错（而不是永久卡住）
 *   5. 小于 256KB 的响应不折腾续传
 *   6. BLOB_RESUME=0 可整体关闭
 *   7. 正常完整流：不多发请求、不等待静默超时
 *   8. 无 content-length（chunked，例如 GitHub 通道）干净结束即视为完成
 */

import fs from 'node:fs';

const source = fs.readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
const worker = (await import(
  'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64')
)).default;

const BASE = 'https://proxy.example.com';
const BLOB_PATH = '/v2/t8y2/dbx/blobs/sha256:abc123';
const CDN = 'https://cdn.example.com/blob?sig=1';
const ENV = { DOCKER_USER: 'u', DOCKER_PASS: 'p' };

let failures = 0;
let checks = 0;
let calls = [];

function ok(name, cond, detail) {
  checks++;
  if (cond) console.log('PASS  ' + name);
  else { failures++; console.log('FAIL  ' + name + (detail === undefined ? '' : '  ->  ' + detail)); }
}

/** 按「每块填一个可校验的字节值」生成整份内容 */
function expectedBody(total, partSize) {
  const buf = Buffer.alloc(total);
  for (let off = 0; off < total; off += partSize) {
    buf.fill(((off / partSize) % 250) + 1, off, Math.min(off + partSize, total));
  }
  return buf;
}

/** 造一个可控的上游 body：发完 parts 之后要么 close，要么永远静默 */
function controlledBody(parts, hang) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < parts.length) { controller.enqueue(parts[i++]); return; }
      if (hang) return;              // 不 close 也不 enqueue → 制造上游静默
      controller.close();
    },
  });
}

function cdnResponse(parts, { hang = false, total = null, status = 200, body } = {}) {
  const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' };
  if (total !== null) headers['content-length'] = String(total);
  return new Response(body !== undefined ? body : controlledBody(parts, hang), { status, headers });
}

/** 上游路由：registry 回 307，CDN 按 Range 头分别响应 */
function stubFetch(cdnHandler) {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const isRequest = typeof input === 'object' && input !== null;
    const url = isRequest ? input.url : String(input);
    const opts = init || {};
    const headers = new Headers(opts.headers || (isRequest ? input.headers : undefined));
    const rec = { url: url, method: opts.method || 'GET', headers: headers, range: headers.get('Range') };
    calls.push(rec);
    if (url.indexOf('registry-1.docker.io') !== -1) {
      return new Response('', { status: 307, headers: { Location: CDN } });
    }
    if (url.indexOf('cdn.example.com') !== -1) {
      const r = cdnHandler(rec, calls.filter((c) => c.url.indexOf('cdn.example.com') !== -1).length);
      if (!r) throw new Error('unexpected CDN call range=' + rec.range);
      return r;
    }
    throw new Error('unexpected fetch: ' + url);
  };
}

function cdnCalls() {
  return calls.filter((c) => c.url.indexOf('cdn.example.com') !== -1);
}

async function drain(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let len = 0;
  for (;;) {
    const c = await reader.read();
    if (c.done) break;
    chunks.push(Buffer.from(c.value));
    len += c.value.length;
  }
  return { buf: Buffer.concat(chunks), len: len };
}

async function pull(env, headers) {
  return worker.fetch(
    new Request(BASE + BLOB_PATH, { method: 'GET', headers: headers || undefined }),
    env || ENV,
    {},
  );
}

// ---------- 1. 提前断流 → Range 续传 ----------
const TOTAL = 400000;
const PART = 100000;
{
  const full = expectedBody(TOTAL, PART);
  const parts = [full.subarray(0, PART), full.subarray(PART, PART * 2), full.subarray(PART * 2, PART * 3), full.subarray(PART * 3)];
  stubFetch((rec, n) => {
    if (n === 1) return cdnResponse([parts[0]], { total: TOTAL });          // 只发 100000 就 close
    if (rec.range === 'bytes=' + PART + '-') {
      return cdnResponse(parts.slice(1), { total: TOTAL - PART, status: 206 });
    }
    return null;
  });
  const res = await pull();
  const got = await drain(res);
  ok('1.1 提前断流后自动续传，字节完整', got.len === TOTAL && got.buf.equals(full),
    'len=' + got.len + ' expected=' + TOTAL);
  ok('1.2 续传请求带正确的 Range 头', cdnCalls()[1] && cdnCalls()[1].range === 'bytes=' + PART + '-',
    cdnCalls()[1] ? String(cdnCalls()[1].range) : 'no second CDN call');
  ok('1.3 只续传一次，没有多余请求', cdnCalls().length === 2, 'cdn calls=' + cdnCalls().length);
  ok('1.4 客户端看到 200 与完整 content-length',
    res.status === 200 && res.headers.get('content-length') === String(TOTAL),
    res.status + ' len=' + res.headers.get('content-length'));
}

// ---------- 2. 上游静默 → 静默超时后续传 ----------
{
  const full = expectedBody(TOTAL, PART);
  const parts = [full.subarray(0, PART), full.subarray(PART, PART * 2), full.subarray(PART * 2, PART * 3), full.subarray(PART * 3)];
  stubFetch((rec, n) => {
    if (n === 1) return cdnResponse([parts[0]], { total: TOTAL, hang: true });   // 发完就静默，不 close
    return cdnResponse(parts.slice(1), { total: TOTAL - PART, status: 206 });
  });
  const t0 = Date.now();
  const res = await pull({ DOCKER_USER: 'u', DOCKER_PASS: 'p', BLOB_IDLE_MS: '250' });
  const got = await drain(res);
  const ms = Date.now() - t0;
  ok('2.1 静默超时后自动续传，字节完整', got.len === TOTAL && got.buf.equals(full), 'len=' + got.len);
  ok('2.2 续传起点为静默前已收到的字节', cdnCalls()[1] && cdnCalls()[1].range === 'bytes=' + PART + '-',
    cdnCalls()[1] ? String(cdnCalls()[1].range) : 'none');
  ok('2.3 确实是等满静默阈值才动手（>=250ms）', ms >= 250 && ms < 5000, ms + 'ms');
}

// ---------- 3. 上游忽略 Range（返回 200）→ 丢弃前缀 ----------
{
  const full = expectedBody(TOTAL, PART);
  const all = [full.subarray(0, PART), full.subarray(PART, PART * 2), full.subarray(PART * 2, PART * 3), full.subarray(PART * 3)];
  stubFetch((rec, n) => {
    if (n === 1) return cdnResponse([all[0]], { total: TOTAL });                 // 提前断流
    return cdnResponse(all, { total: TOTAL, status: 200 });                      // 忽略 Range，整份重下
  });
  const res = await pull();
  const got = await drain(res);
  ok('3.1 上游不支持 Range 时丢弃前缀后拼接正确', got.len === TOTAL && got.buf.equals(full),
    'len=' + got.len);
  ok('3.2 没有重复写出前缀（长度不翻倍）', got.len === TOTAL, 'len=' + got.len);
}

// ---------- 4. 续传次数用尽 → 客户端流立刻报错 ----------
{
  const full = expectedBody(TOTAL, PART);
  stubFetch((rec, n) => {
    if (n === 1) return cdnResponse([full.subarray(0, PART)], { total: TOTAL });
    // 每次续传只给 10000 字节就 close，永远到不了终点
    return cdnResponse([full.subarray(PART, PART + 10000)], { total: TOTAL, status: 206 });
  });
  const res = await pull({ DOCKER_USER: 'u', DOCKER_PASS: 'p', BLOB_MAX_RESUMES: '2' });
  let threw = false;
  try { await drain(res); } catch (e) { threw = true; }
  ok('4.1 续传用尽后客户端流报错而不是永久卡住', threw);
  ok('4.2 续传次数受 BLOB_MAX_RESUMES 限制', cdnCalls().length === 3, 'cdn calls=' + cdnCalls().length);
}

// ---------- 5. 小响应不续传 ----------
{
  const SMALL = 100000;
  const full = expectedBody(SMALL, 50000);
  stubFetch(() => cdnResponse([full.subarray(0, 50000)], { total: SMALL }));
  const got = await drain(await pull());
  ok('5.1 小于 256KB 不包续传（提前结束就是结束）', got.len === 50000 && cdnCalls().length === 1,
    'len=' + got.len + ' cdn calls=' + cdnCalls().length);
}

// ---------- 6. BLOB_RESUME=0 关闭续传 ----------
{
  const full = expectedBody(TOTAL, PART);
  stubFetch(() => cdnResponse([full.subarray(0, PART)], { total: TOTAL }));
  const got = await drain(await pull({ DOCKER_USER: 'u', DOCKER_PASS: 'p', BLOB_RESUME: '0' }));
  ok('6.1 BLOB_RESUME=0 时不续传', got.len === PART && cdnCalls().length === 1,
    'len=' + got.len + ' cdn calls=' + cdnCalls().length);
}

// ---------- 7. 正常完整流：不发请求、不等超时 ----------
{
  const full = expectedBody(TOTAL, PART);
  const parts = [full.subarray(0, PART), full.subarray(PART, PART * 2), full.subarray(PART * 2, PART * 3), full.subarray(PART * 3)];
  stubFetch(() => cdnResponse(parts, { total: TOTAL }));
  const t0 = Date.now();
  const got = await drain(await pull());
  const ms = Date.now() - t0;
  ok('7.1 完整流字节正确', got.len === TOTAL && got.buf.equals(full), 'len=' + got.len);
  ok('7.2 完整流不发多余请求', cdnCalls().length === 1, 'cdn calls=' + cdnCalls().length);
  ok('7.3 完整流不等待静默超时（<1s）', ms < 1000, ms + 'ms');
}

// ---------- 8. 无 content-length（chunked）干净结束即完成 ----------
{
  const parts = [Buffer.alloc(50000, 7), Buffer.alloc(50000, 8)];
  stubFetch(() => cdnResponse(parts, { total: null }));
  const got = await drain(await pull());
  ok('8.1 无 content-length 时干净结束不触发续传', got.len === 100000 && cdnCalls().length === 1,
    'len=' + got.len + ' cdn calls=' + cdnCalls().length);
}

// ---------- 9. 源码守卫 ----------
ok('9.1 续传相关常量存在', source.indexOf('BLOB_MAX_RESUMES') !== -1 && source.indexOf('BLOB_IDLE_MS') !== -1);
ok('9.2 重定向最后一跳会带上续传上下文', source.indexOf('diag, resumeCtx)') !== -1);

console.log('');
console.log(failures === 0 ? 'ALL PASS (' + checks + ' checks)' : failures + '/' + checks + ' CHECK(S) FAILED');
process.exitCode = failures === 0 ? 0 : 1;
