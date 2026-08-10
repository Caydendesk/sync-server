// 个人办公工作台 - 云端同步服务器
// 零依赖，纯 Node.js 内置模块，直接跑：node server.js
// 可部署到 Railway / Render / 阿里云 ECS 等任意 Node.js 平台

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'sync-data.json');

// 读取存储的数据
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (e) { console.error('Load error:', e.message); }
  return {};
}

// 保存数据
function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) { console.error('Save error:', e.message); }
}

/* =========================================================
 * 客户资讯：实时多源公开搜索
 * 主用 Bing，尝试 Baidu，DuckDuckGo 兜底；每刷新都真实拉取最新结果
 * 按 4 个维度（项目建设 / 股权投融资 / 高层管理人动态 / 所在行业政策）各搜一次
 * ======================================================= */

// 4 个资讯维度（query 模板带入客户名）
const CATEGORIES = [
  { label: '项目建设',       query: q => `${q} 项目建设 OR 工程 OR 中标 OR 扩建` },
  { label: '股权投融资',     query: q => `${q} 股权融资 OR 战略投资 OR 上市 OR 融资` },
  { label: '高层管理人动态', query: q => `${q} 高管 任命 OR 变动 OR 辞职 OR 履新` },
  { label: '所在行业政策',   query: q => `${q} 行业政策 OR 产业政策 OR 新规` }
];

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// 全局节流 + 短时缓存：避免对 DDG 突发并行请求触发限流（数据中心 IP 易被拦）
const _newsCache = new Map();
const NEWS_CACHE_TTL = 90000;
let _lastOutbound = 0;
const MIN_GAP_MS = 600;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function throttle() {
  const wait = MIN_GAP_MS - (Date.now() - _lastOutbound);
  if (wait > 0) await sleep(wait);
  _lastOutbound = Date.now();
}

// 带超时与桌面 UA 的抓取（timeout 可覆盖，百度用更短超时快速放弃）
async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---- 各搜索引擎结果解析 ----

// Bing 网页结果：<li class="b_algo"> 内有 <h2><a href> 与 <p> 摘要
function parseBing(html) {
  const items = [];
  const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = blockRe.exec(html))) {
    const block = m[1];
    const a = /<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    const url = a[1];
    if (!/^https?:\/\//i.test(url)) continue;
    const title = stripTags(a[2]);
    const sp = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = sp ? stripTags(sp[1]) : '';
    if (title) items.push({ title, snippet, url });
  }
  return items;
}

// Baidu 网页结果：<h3 class="t"><a href> 标题，<div class="c-abstract"> 摘要
function parseBaidu(html) {
  const items = [];
  // 反爬验证页直接放弃
  if (/百度安全验证|wappass|网络不给力/.test(html)) return items;
  const aRe = /<h3[^>]*class="t"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html))) {
    const url = m[1];
    const title = stripTags(m[2]);
    if (title && /^https?:\/\//i.test(url)) items.push({ title, snippet: '', url });
  }
  // 摘要
  const snips = [];
  const sRe = /<div class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let sm;
  while ((sm = sRe.exec(html))) snips.push(stripTags(sm[1]));
  items.forEach((it, i) => { if (snips[i]) it.snippet = snips[i]; });
  return items;
}

// DuckDuckGo（html / lite 两种接口统一解析）：标题在 class 含 result__a / result-link 的 <a>，
// 摘要在 class 含 result__snippet / result-snippet；href 多为重定向，需解码 uddg 参数
function parseDDG(html) {
  const titles = [];
  const aRe = /<a[^>]*class="[^"]*(?:result__a|result-link)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html))) {
    let url = m[1];
    const u = /[?&]uddg=([^&]+)/.exec(url);
    if (u) url = decodeURIComponent(u[1]);
    const title = stripTags(m[2]);
    if (title && /^https?:\/\//i.test(url)) titles.push({ title, snippet: '', url });
  }
  const snips = [];
  const sRe = /<(?:a|td|div)[^>]*class="[^"]*(?:result__snippet|result-snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/gi;
  let sm;
  while ((sm = sRe.exec(html))) snips.push(stripTags(sm[1]));
  titles.forEach((it, i) => { if (snips[i]) it.snippet = snips[i]; });
  return titles;
}

// 单条查询：DuckDuckGo 优先（html + lite 两个接口兜底），Bing/Baidu 作尽力兜底
// 注：Baidu 拦截服务器 IP（超时）；Bing 结果页 JS 渲染常为空；DDG 聚合 Bing/Yahoo 索引最稳
async function fetchSearch(query) {
  const cacheKey = 'q:' + query;
  const cached = _newsCache.get(cacheKey);
  if (cached && (Date.now() - cached.t) < NEWS_CACHE_TTL) return cached.items;
  const sources = [
    { name: 'DuckDuckGo',      url: 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),        parse: parseDDG },
    { name: 'DuckDuckGo Lite', url: 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query),        parse: parseDDG },
    { name: 'Bing',            url: 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&cc=CN', parse: parseBing },
    { name: 'Baidu',           url: 'https://www.baidu.com/s?wd=' + encodeURIComponent(query),                 parse: parseBaidu, timeout: 5000 }
  ];
  let lastErr = '';
  for (const s of sources) {
    try {
      await throttle();
      const html = await fetchText(s.url, s.timeout);
      const items = s.parse(html);
      if (items.length) {
        const out = items.slice(0, 5).map(it => ({ ...it, source: s.name }));
        _newsCache.set(cacheKey, { t: Date.now(), items: out });
        return out;
      }
    } catch (e) { lastErr = e.message; }
  }
  if (lastErr) console.error(`[news] all sources failed for "${query}": ${lastErr}`);
  return [];
}

// 一个客户的 4 个维度：串行 + 节流，降低被 DDG 限流概率
async function searchAllCategories(q) {
  const out = {};
  for (const c of CATEGORIES) {
    try {
      const items = await fetchSearch(c.query(q));
      out[c.label] = items.slice(0, 3);
    } catch (e) {
      out[c.label] = [];
    }
    await sleep(250);
  }
  return out;
}

const server = http.createServer((req, res) => {
  // CORS 允许多设备访问
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/sync') {
    if (req.method === 'GET') {
      // 拉取数据
      const data = loadData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data }));
    } else if (req.method === 'PUT') {
      // 推送数据（时间戳合并策略）
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          const existing = loadData();

          // 合并：每个 key 保留 _lastModified 更大的那份
          for (const key of Object.keys(incoming)) {
            const inc = incoming[key];
            if (!inc._lastModified) continue;
            const ext = existing[key];
            if (!ext || !ext._lastModified || inc._lastModified >= ext._lastModified) {
              existing[key] = inc;
            }
          }

          saveData(existing);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    } else {
      res.writeHead(405);
      res.end();
    }
    return;
  }

  // 客户资讯：实时多源公开搜索（Bing / Baidu / DuckDuckGo），按 4 个维度分组返回
  if (url.pathname === '/api/news') {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const q = (url.searchParams.get('q') || '').toString().trim();
    if (!q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, q: '', updatedAt: Date.now(), categories: {} }));
      return;
    }
    (async () => {
      try {
        const categories = await searchAllCategories(q);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, q, updatedAt: Date.now(), categories }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, q, error: e.message, categories: {} }));
      }
    })();
    return;
  }

  // 健康检查
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Sync server running on port ${PORT}`);
  console.log(`Sync endpoint: http://localhost:${PORT}/api/sync`);
  console.log(`News endpoint: http://localhost:${PORT}/api/news`);
});
