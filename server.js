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

// 4 个资讯维度：keys 用于把命中的 RSS 条目归类；tavily 用于兜底搜索的自然语言查询
const CATEGORIES = [
  { label: '项目建设',       keys: ['项目', '工程', '中标', '开工', '投产', '建设', '基地', '产业园', '签约', '奠基', '动工', '量产', '下线'], tavily: q => `${q} 项目建设 工程 中标 投产 基地` },
  { label: '股权投融资',     keys: ['融资', '投资', '股权', '上市', 'IPO', '增资', '并购', '收购', '估值', '轮融资', '纳斯达克', '港股', '财报', '营收', '利润', '市值', '股价', '分红'], tavily: q => `${q} 股权融资 战略投资 上市 并购 财报` },
  { label: '高层管理人动态', keys: ['董事长', '总裁', '总经理', '高管', '任命', '辞任', '辞职', '履新', '换帅', '变动', '回应', '表态'], tavily: q => `${q} 董事长 总裁 高管 任命 变动 履新` },
  { label: '所在行业政策',   keys: ['政策', '新规', '条例', '通知', '办法', '监管', '工信部', '发改委', '部委', '意见', '规划', '印发', '标准', '指南'], tavily: q => `${q} 行业政策 产业政策 规划 新规 监管` }
];

// 未归入以上 4 类、但确实命中客户的资讯，统一进「综合动态」，避免遗漏
const GENERAL_LABEL = '综合动态';

// 已知客户：精确匹配词 + 公司简介（≤5 句，统一格式）。未知客户走 Tavily 兜底简介。
const CLIENT_PROFILES = {
  '紫金矿业': {
    keys: ['紫金矿业', '紫金'],
    profile: '紫金矿业是全球领先的矿业企业，主营黄金、铜、锌等金属矿产的勘探、开采与冶炼。公司总部位于福建龙岩，在海外拥有多座大型矿山，铜产量位居国内前列。近年持续布局锂、钴等新能源金属，向综合矿业巨头迈进。'
  },
  '福建省工业控股': {
    keys: ['福建省工业控股', '福建工业控股', '福建工控'],
    profile: '福建省工业控股集团是福建省属国有重要骨干企业，聚焦机械制造、电子信息、冶金建材等工业领域的投资与运营。集团承担省内产业升级与战略重组平台职能，下辖多家工业类子公司。'
  },
  '华电新能源': {
    keys: ['华电新能源', '华电新能'],
    profile: '华电新能源集团是中国华电集团旗下新能源上市平台，主营风电、光伏等清洁能源项目的开发、投资与运营。公司装机规模位居行业前列，是国内重要的绿电运营商之一。'
  },
  '南平铝业': {
    keys: ['南平铝业', '南平铝'],
    profile: '福建省南平铝业是华东地区重要的铝加工企业，主营铝型材、铝板带箔等产品的研发与生产。产品广泛应用于建筑、交通与包装领域，是区域铝工业龙头企业。'
  }
};

// 常见别名（提升知名企业命中率）
const ALIASES = {
  '比亚迪': 'BYD', '腾讯': 'Tencent', '阿里巴巴': '阿里', '阿里': '阿里巴巴',
  '小米': 'Xiaomi', '美团': 'Meituan', '华为': 'Huawei', '京东': 'JD',
  '百度': 'Baidu', '网易': 'NetEase', '字节跳动': '抖音'
};

// 提取客户匹配词：已知客户用精确词表，未知客户去掉常见后缀兜底
function customerKeywords(q) {
  if (CLIENT_PROFILES[q]) return CLIENT_PROFILES[q].keys;
  const stops = ['股份有限公司', '有限公司', '有限责任公司', '集团', '公司', '供应链', '科技', '企业', '（', '('];
  let k = q;
  for (const s of stops) { k = k.split(s)[0]; }
  const keys = [q, k].filter((v, i, a) => v && a.indexOf(v) === i);
  if (ALIASES[q]) keys.push(ALIASES[q]);
  return keys;
}

// 相关性闸门：标题或正文必须出现客户名/别名，否则视为不相关（避免强推无关资讯）
function relevantToClient(item, q) {
  const keys = customerKeywords(q);
  const hay = ((item.title || '') + ' ' + (item.content || item.desc || item.snippet || '')).toLowerCase();
  return keys.some(k => k && k.length >= 2 && hay.includes(k.toLowerCase()));
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

// Tavily 兜底。仅读环境变量 TAVILY_API_KEY，不在代码内置任何 key（部署方在 Railway 控制台配置）。
// Tavily 需 POST + JSON body，GET 会 401
async function tavilySearch(query) {
  const KEY = process.env.TAVILY_API_KEY;
  if (!KEY) return [];
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: KEY,
        query,
        topic: 'news',
        max_results: 3,
        days: 30
      })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j.results || []).map(x => ({
      title: x.title,
      content: x.content || '',
      snippet: (x.content || '').slice(0, 140),
      url: x.url,
      source: 'Tavily'
    }));
  } catch (e) {
    console.error(`[news] Tavily failed for "${query}": ${e.message}`);
    return [];
  }
}

// 公司简介：已知客户返回内置简介；未知客户用 Tavily 尽力取一段（≤160 字）
async function getProfile(q) {
  if (CLIENT_PROFILES[q]) return CLIENT_PROFILES[q].profile;
  if (!process.env.TAVILY_API_KEY) return '';
  const r = await tavilySearch(q + ' 公司简介 主营业务 规模');
  const top = r[0];
  if (!top) return '';
  return (top.content || top.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

// 一个客户的 4 个维度：RSS 匹配为主，空维度用 Tavily 补（均做相关性过滤）
async function searchAllCategories(q) {
  const items = await loadAllRss();
  const matched = matchCustomer(items, q);
  console.log(`[news] 客户「${q}」RSS 命中 ${matched.length} 条`);
  const out = classify(matched);
  let profile = '';
  if (process.env.TAVILY_API_KEY) {
    // 并行：简介 + 各空维度兜底（兜底结果必须过相关性闸门）
    const profileP = getProfile(q);
    const fillP = CATEGORIES.map(async c => {
      if (!out[c.label].length) {
        const r = (await tavilySearch(c.tavily(q))).filter(x => relevantToClient(x, q));
        out[c.label] = r.slice(0, 3).map(x => ({ title: x.title, snippet: x.snippet, url: x.url, source: x.source }));
      }
    });
    const [p] = await Promise.all([profileP, ...fillP]);
    profile = p;
  }
  let total = 0;
  CATEGORIES.forEach(c => { total += out[c.label].length; });
  total += out[GENERAL_LABEL].length;
  return { profile, found: total > 0, categories: out };
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
        const result = await searchAllCategories(q);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, q, updatedAt: Date.now(), profile: result.profile, found: result.found, categories: result.categories }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, q, error: e.message, profile: '', found: false, categories: {} }));
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
  console.log(`News mode: RSS aggregation${process.env.TAVILY_API_KEY ? ' + Tavily fallback (env var)' : ' (Tavily key not set - only RSS)'}`);
});
