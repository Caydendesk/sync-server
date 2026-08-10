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
 * 客户资讯：RSS 为主 + Tavily 免费层兜底
 *  - 主通道：聚合公开 RSS 新闻源，按【客户名称】模糊匹配，按 4 维度分类
 *  - 兜底：  若配置 TAVILY_API_KEY，对 RSS 未覆盖到的维度用 Tavily 新闻搜索补全
 *  - 每次刷新都重新匹配（源内容缓存 10 分钟，源本身更新即视为新）
 *  4 个维度：项目建设 / 股权投融资 / 高层管理人动态 / 所在行业政策
 * ======================================================= */

// 已验证可达、且能解析出 item 的公开 RSS 源（中文为主，覆盖财经/科技/政策/综合）
const RSS_FEEDS = [
  { name: '新华网财经',   url: 'https://www.news.cn/fortune/news_fortune.xml' },
  { name: '人民网财经',   url: 'https://www.people.com.cn/rss/politics.xml' },
  { name: 'IT之家',       url: 'https://www.ithome.com/rss/' },
  { name: '钛媒体',       url: 'https://www.tmtpost.com/rss.xml' },
  { name: '中国新闻网',   url: 'https://www.chinanews.com.cn/rss/scroll-news.xml' },
  { name: '少数派',       url: 'https://sspai.com/feed' }
];

// 4 个资讯维度：keys 用于把命中的 RSS 条目归类；query 用于 Tavily 兜底搜索
const CATEGORIES = [
  { label: '项目建设',       keys: ['项目', '工程', '中标', '开工', '投产', '建设', '基地', '产业园', '签约', '奠基', '动工', '量产', '下线'], query: q => `${q} 项目建设 OR 工程 OR 中标 OR 开工` },
  { label: '股权投融资',     keys: ['融资', '投资', '股权', '上市', 'IPO', '增资', '并购', '收购', '估值', '轮融资', '纳斯达克', '港股', '财报', '营收', '利润', '市值', '股价', '分红'], query: q => `${q} 股权融资 OR 战略投资 OR 上市 OR 融资` },
  { label: '高层管理人动态', keys: ['董事长', '总裁', '总经理', '高管', '任命', '辞任', '辞职', '履新', '换帅', '变动', '回应', '表态'], query: q => `${q} 高管 OR 董事长 OR 总裁 任命 变动` },
  { label: '所在行业政策',   keys: ['政策', '新规', '条例', '通知', '办法', '监管', '工信部', '发改委', '部委', '意见', '规划', '印发', '标准', '指南'], query: q => `${q} 行业政策 OR 产业政策 OR 新规` }
];

// 未归入以上 4 类、但确实命中客户的资讯，统一进「综合动态」，避免遗漏
const GENERAL_LABEL = '综合动态';

// 常见别名（提升知名企业命中率）
const ALIASES = {
  '比亚迪': 'BYD', '腾讯': 'Tencent', '阿里巴巴': '阿里', '阿里': '阿里巴巴',
  '小米': 'Xiaomi', '美团': 'Meituan', '华为': 'Huawei', '京东': 'JD',
  '百度': 'Baidu', '网易': 'NetEase', '字节跳动': '抖音'
};

// 去掉公司名常见后缀，提取可用于匹配的核心词
function customerKeywords(q) {
  const stops = ['股份有限公司', '有限公司', '有限责任公司', '集团', '公司', '供应链', '科技', '企业', '（', '('];
  let k = q;
  for (const s of stops) { k = k.split(s)[0]; }
  const keys = [q, k].filter((v, i, a) => v && a.indexOf(v) === i);
  if (ALIASES[q]) keys.push(ALIASES[q]);
  return keys;
}

function stripTags(s) {
  return (s || '')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/p data-vmark="[^"]*"/gi, '')
    .replace(/\s+/g, ' ').trim();
}

// 带超时与 UA 的抓取
async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 9000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WorkbenchRSS/1.0)' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// 通用 RSS / Atom 解析
function parseRss(xml) {
  const items = [];
  const blockRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = blockRe.exec(xml))) {
    const b = m[1];
    const title = /<title>([\s\S]*?)<\/title>/i.exec(b);
    const link = /<link>([\s\S]*?)<\/link>/i.exec(b);
    const desc = /<description>([\s\S]*?)<\/description>/i.exec(b);
    if (title) items.push({ title: stripTags(title[1]), link: link ? link[1].trim() : '', desc: desc ? stripTags(desc[1]) : '' });
  }
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  while ((m = entryRe.exec(xml))) {
    const b = m[1];
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(b);
    const link = /<link[^>]*href="([^"]+)"[^>]*>/i.exec(b);
    const desc = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(b);
    if (title) items.push({ title: stripTags(title[1]), link: link ? link[1] : '', desc: desc ? stripTags(desc[1]) : '' });
  }
  return items;
}

// RSS 聚合（带缓存，源更新慢，10 分钟足够新鲜）
let _rssCache = { t: 0, items: [] };
const RSS_TTL = 10 * 60 * 1000;
async function loadAllRss() {
  if (Date.now() - _rssCache.t < RSS_TTL && _rssCache.items.length) return _rssCache.items;
  const all = [];
  await Promise.all(RSS_FEEDS.map(async f => {
    try {
      const xml = await fetchText(f.url, 9000);
      const items = parseRss(xml);
      items.forEach(it => { it.source = f.name; });
      all.push(...items.filter(it => it.title && it.title.trim()));
    } catch (e) { console.error(`[rss] ${f.name} failed: ${e.message}`); }
  }));
  console.log(`[rss] 聚合完成，共 ${all.length} 条`);
  _rssCache = { t: Date.now(), items: all };
  return all;
}

// 按客户名模糊匹配
function matchCustomer(items, q) {
  const keys = customerKeywords(q);
  return items.filter(it => {
    const text = it.title + ' ' + it.desc;
    return keys.some(k => k && text.includes(k));
  });
}

// 把命中条目按维度关键词归类（每条只归入第一个命中的维度），未归类的进综合动态
function classify(items) {
  const out = {};
  CATEGORIES.forEach(c => { out[c.label] = []; });
  out[GENERAL_LABEL] = [];
  for (const it of items) {
    const text = it.title + ' ' + it.desc;
    let placed = false;
    for (const c of CATEGORIES) {
      if (c.keys.some(k => text.includes(k))) {
        out[c.label].push({ title: it.title, snippet: (it.desc || '').slice(0, 120), url: it.link, source: it.source });
        placed = true;
        break;
      }
    }
    if (!placed) out[GENERAL_LABEL].push({ title: it.title, snippet: (it.desc || '').slice(0, 120), url: it.link, source: it.source });
  }
  CATEGORIES.forEach(c => { out[c.label] = out[c.label].slice(0, 3); });
  out[GENERAL_LABEL] = out[GENERAL_LABEL].slice(0, 5);
  return out;
}

// Tavily 兜底（仅当配置了 TAVILY_API_KEY）
async function tavilySearch(query) {
  if (!process.env.TAVILY_API_KEY) return [];
  try {
    const url = 'https://api.tavily.com/search?api_key=' + encodeURIComponent(process.env.TAVILY_API_KEY)
      + '&query=' + encodeURIComponent(query) + '&max_results=5&topic=news&days=30';
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j.results || []).map(x => ({
      title: x.title,
      snippet: (x.content || '').slice(0, 120),
      url: x.url,
      source: 'Tavily'
    }));
  } catch (e) {
    console.error(`[news] Tavily failed for "${query}": ${e.message}`);
    return [];
  }
}

// 一个客户的 4 个维度：RSS 匹配为主，空维度用 Tavily 补
async function searchAllCategories(q) {
  const items = await loadAllRss();
  const matched = matchCustomer(items, q);
  console.log(`[news] 客户「${q}」RSS 命中 ${matched.length} 条`);
  const out = classify(matched);
  if (process.env.TAVILY_API_KEY) {
    for (const c of CATEGORIES) {
      if (!out[c.label].length) {
        const r = await tavilySearch(c.query(q));
        out[c.label] = r.slice(0, 3);
      }
    }
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

  // 客户资讯：RSS 为主 + Tavily 兜底，按 4 个维度分组返回
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
  console.log(`News mode: RSS aggregation${process.env.TAVILY_API_KEY ? ' + Tavily fallback' : ' (Tavily key not set)'}`);
});
