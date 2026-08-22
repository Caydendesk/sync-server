// 个人办公工作台 - 云端同步服务器
// 零依赖，纯 Node.js 内置模块，直接跑：node server.js
// 可部署到 Railway / Render / 阿里云 ECS 等任意 Node.js 平台

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// 数据文件位置：默认写在代码目录（Railway/本地），CloudBase 等容器平台挂持久卷时
// 通过环境变量 DATA_DIR 指向挂载点（如 /data），避免容器文件系统重置导致数据丢失。
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'sync-data.json');

// 读取存储的数据。
// 新版为分桶结构 { [uid]: stateObj }（按同步空间ID隔离）；
// 旧版扁平 state（顶层直接是 wb_office_* 键）首次读取时自动迁入 'default' 桶，保证已有数据不丢。
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        if (Object.keys(raw).some(k => k.startsWith('wb_office_'))) {
          // 旧版扁平格式 → 整体迁入 default 桶
          return { default: raw };
        }
        return raw;
      }
    }
  } catch (e) { console.error('Load error:', e.message); }
  return {};
}

// 保存数据
function saveData(data) {
  try {
    // 确保数据目录存在（挂载点首次为空或异常路径时也能正常落盘）
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) { console.error('Save error:', e.message); }
}

/* =========================================================
 * 客户资讯：RSS 为主 + 联网搜索兜底
 *  - 主通道：聚合公开 RSS 新闻源，按【客户名称】模糊匹配，按 4 维度分类
 *  - 兜底（回落链）：腾讯云联网搜索 WSA（若有 key）→ Tavily（若有 key）→ Exa（若有 key）
 *    WSA 即“元宝联网搜索 MCP”底层（腾讯云 Web Search API，搜狗引擎），全部仅读环境变量，不内置 key
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

// 相关性闸门（统一标准，所有客户一致）：标题或正文命中客户名/别名即算相关（放宽）。
// 质量底线（对所有客户一致）：纯聚合"公告集锦/盘后公告"类、且标题未提名客户的，仍排除，避免强推无关资讯。
function relevantToClient(item, q) {
  const keys = customerKeywords(q);
  const title = (item.title || '').toLowerCase();
  const body = ((item.content || '') + ' ' + (item.snippet || '') + ' ' + (item.desc || '')).toLowerCase();
  const inTitle = keys.some(k => k && k.length >= 2 && title.includes(k.toLowerCase()));
  if (inTitle) return true;                       // 标题提名客户，必留
  const inBody = keys.some(k => k && k.length >= 2 && body.includes(k.toLowerCase()));
  if (!inBody) return false;                      // 标题正文都没提，丢弃
  if (/集锦|公告集锦|盘后公告|财经早报|晚间公告|公告汇总/.test(title)) return false; // 仅正文命中且属聚合文，丢弃
  return true;
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
// Tavily 兜底搜索。opts 可覆盖 topic / max_results / days；默认 topic='news'、days=30（用于资讯）。
async function tavilySearch(query, opts = {}) {
  const KEY = process.env.TAVILY_API_KEY;
  if (!KEY) return [];
  try {
    const body = {
      api_key: KEY,
      query,
      topic: opts.topic || 'news',
      max_results: opts.max_results || 3
    };
    if (opts.days) body.days = opts.days;
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
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

// Exa 备选搜索（Tavily 为空/失败时降级用）。仅读环境变量 EXA_API_KEY，不在代码内置 key。
// Exa 用 header `x-api-key` 鉴权；请求 contents.text 拿提取正文（近似 Tavily 的 content 字段）。
async function exaSearch(query, opts = {}) {
  const KEY = process.env.EXA_API_KEY;
  if (!KEY) return [];
  try {
    const body = {
      query,
      numResults: opts.maxResults || opts.max_results || 5,
      type: 'keyword',
      contents: { text: { maxCharacters: 600 } }
    };
    const r = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j.results || []).map(x => ({
      title: x.title,
      content: x.text || x.summary || '',
      snippet: (x.text || x.summary || '').slice(0, 140),
      url: x.url,
      source: 'Exa'
    }));
  } catch (e) {
    console.error(`[news] Exa failed for "${query}": ${e.message}`);
    return [];
  }
}

// 腾讯云联网搜索 API（wsa，底层搜狗，兼容“元宝联网搜索 MCP”）。
// 服务 API KEY 方式：Header `Authorization: Bearer <KEY>`，域名 api.wsa.cloud.tencent.com，POST /SearchPro。
// 仅读环境变量 TENCENT_WSA_API_KEY，不在代码内置 key（部署方在 Railway 控制台配置）。
// 响应结构：{ Response: { Pages: [ "{\"passage\":..,\"title\":..,\"url\":..,\"score\":..}"(JSON 字符串), ... ] } }
async function wsaSearch(query, opts = {}) {
  const KEY = process.env.TENCENT_WSA_API_KEY;
  if (!KEY) return [];
  try {
    const body = {
      Query: query,
      Mode: opts.mode != null ? opts.mode : 0
    };
    // Cnt 仅支持枚举 10/20/30/40/50，且为尊享版/旗舰版专属参数；非枚举值会报 illegal Cnt。
    // 故默认不传（用 API 默认条数），仅在显式传入合法枚举值时才带上。
    const cnt = opts.cnt || opts.maxResults || opts.max_results;
    if (cnt && [10, 20, 30, 40, 50].includes(Number(cnt))) body.Cnt = Number(cnt);
    if (opts.site) body.Site = opts.site;
    const r = await fetch('https://api.wsa.cloud.tencent.com/SearchPro', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Authorization': 'Bearer ' + KEY
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const resp = j.Response || {};
    if (resp.Error) throw new Error(resp.Error.Message || resp.Error.Code || 'WSA Error');
    const pages = resp.Pages || resp.Results || [];
    const out = [];
    for (const p of pages) {
      let item;
      try { item = typeof p === 'string' ? JSON.parse(p) : p; } catch (e) { continue; }
      const passage = stripTags(item.passage || item.content || '');
      if (!item.title && !passage) continue;
      out.push({
        title: item.title || '',
        content: passage,
        snippet: passage.slice(0, 140),
        url: item.url || '',
        date: item.date || '',
        source: '腾讯搜索'
      });
    }
    return out;
  } catch (e) {
    console.error(`[news] WSA failed for "${query}": ${e.message}`);
    return [];
  }
}

// 统一搜索：先 WSA（腾讯云联网搜索，若有 key），为空/失败再 Tavily（若有 key），再 Exa（若有 key）；
// 最终回落由调用方决定（如 RSS）。
async function searchWebWithFallback(query, opts = {}) {
  if (process.env.TENCENT_WSA_API_KEY) {
    const w = await wsaSearch(query, { ...opts, cnt: opts.maxResults || opts.max_results || 8 });
    if (w.length) return w;
  }
  if (process.env.TAVILY_API_KEY) {
    const t = await tavilySearch(query, { ...opts, max_results: opts.max_results || opts.maxResults || 3 });
    if (t.length) return t;
  }
  if (process.env.EXA_API_KEY) {
    const e = await exaSearch(query, { ...opts, maxResults: opts.maxResults || opts.max_results || 5 });
    if (e.length) return e;
  }
  return [];
}

// 公司简介：已知客户返回内置简介；未知客户用通用网页搜索取一段，并做质量过滤（Tavily→Exa 降级）。
function cleanProfileText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}
function domainOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}
const JOB_DOMAINS = ['liepin', 'zhipin', 'zhaopin', 'lagou', '51job', 'qcwy', 'boss', 'linkedin', 'job', 'yingjiesheng', 'wenwo', 'kanzhun', 'maimai'];
const JOB_TOKENS = ['招聘', '简历', '求职', '校招', '猎头', '职位', '单位名片', '人才网', '就业网', '校园招聘', '社会招聘', '投递'];

function isProfileGarbage(item, q) {
  const text = cleanProfileText(item.title + ' ' + item.content).toLowerCase();
  const raw = cleanProfileText(item.content);
  // 1. 必须提及客户名（去后缀）
  const core = q.replace(/(股份有限|有限|有限责任|集团|公司)$/g, '').trim();
  if (!text.includes(q.toLowerCase()) && !text.includes(core.toLowerCase())) return true;
  // 2. 剔除模板源码 / CMS 占位符
  if (/\{\{|\}\}|content\.|item\.|columnname|ng-|v-if|v-for|\$\{|template/.test(text)) return true;
  // 3. 剔除政府指标统计碎片（多个部委名、"预期性"、竖线表格）
  if (/(国家知识产权局|国家医疗保障局|国务院参事室|国家机关事务管理局|国家国际发展合作署|预期性\s*\||\|\s*\d+\s*\|.*预期性)/.test(text)) return true;
  // 4. 剔除搜索结果页 / 导航碎片
  if (/搜索结果|相关结果|site:|首页\s*>/.test(item.title)) return true;
  // 5. 过短或全是符号
  if (raw.length < 20 || /^[\s\|\->\{\}\d]+$/.test(raw)) return true;
  // 6. 导航 soup 判定：菜单词很多且没有一句像样的实体描述
  const menu = ['关于我们', '公司简介', '组织机构', '公司资质', '公司荣誉', '公司文化', '公司愿景', '新闻资讯', '下载中心', '工程案例', '典型工程', '联系我们', '人才招聘', '产品中心'];
  const hits = menu.filter(w => text.includes(w)).length;
  const hasProse = text.split(/[。！？；]/).some(s => s.trim().length >= 25 && /(主营|业务|成立于|是一家|致力于|从事|提供|服务|研发|生产)/.test(s));
  if (hits >= 4 && !hasProse) return true;
  return false;
}

// ---- 简介抽取：从候选结果里挑出最像“公司简介”的干净片段 ----
function isNavSoup(s) {
  s = cleanProfileText(s);
  const navTok = ['关注', '已关注', '自选', '添加自选', '首页', '下载', '注册', '登录', '分享', '举报', '隐私', '版权', '关于我们', '公司简介', '组织机构', '联系我们', '选股器', '热力图', '机构追踪'];
  return navTok.filter(w => s.includes(w)).length >= 3;
}
function removeMd(t) {
  const menu = ['关于我们', '公司简介', '组织机构', '公司资质', '公司荣誉', '公司文化', '公司愿景', '新闻资讯', '下载中心', '工程案例', '典型工程', '联系我们', '人才招聘', '产品中心', '关于金皇', '组织架构', '历史沿革', '企业文化', '资质荣誉', '权属企业', '企业战略', '可持续发展', '加入我们', '自选', '选股器', '添加自选', '热力图', '机构追踪'];
  t = String(t || '').replace(/[#>*|`]/g, ' ');
  for (const w of menu) t = t.split(w).join(' ');
  return cleanProfileText(t);
}
function scoreProfile(item, q) {
  const text = cleanProfileText(item.title + ' ' + item.content).toLowerCase();
  const url = (item.url || '').toLowerCase();
  const title = (item.title || '').toLowerCase();
  const dom = domainOf(item.url);
  let s = 0;
  if (/简介|概况|about|公司介绍|企业介绍|profile|intro/.test(title + url)) s += 5;
  if (/(about|company|intro|profile|corp|gsjj|aboutus)/.test(url)) s += 3;
  const path = url.includes('//') ? url.split('//')[1].split('/').slice(1).join('/') : '';
  if (path.length < 3) s -= 4; // 首页
  if (JOB_DOMAINS.some(d => dom.includes(d))) s -= 12; // 招聘/聚合站强惩
  if (JOB_TOKENS.some(t => title.includes(t) || text.includes(t))) s -= 5;
  if (/(news|article|\/202\d|报道|资讯|召开|宣布|到位|亮相|揭牌|签约|消息|动态)/.test(url + title)) s -= 4; // 新闻稿降权
  const menu = ['关于我们', '公司简介', '组织机构', '公司资质', '公司荣誉', '公司文化', '公司愿景', '新闻资讯', '下载中心', '工程案例', '典型工程', '联系我们'];
  const hits = menu.filter(w => text.includes(w)).length;
  if (hits >= 4) s -= 3;
  if (/(主营|业务涵盖|成立于|是一家|致力于|从事|提供.*服务|生产.*产品)/.test(text)) s += 2;
  return s;
}
function extractProfileSentence(text, q) {
  let t = removeMd(text);
  const core = q.replace(/(股份有限|有限|有限责任|集团|公司)$/g, '').trim();
  const needles = [q, core].filter(Boolean);
  const signal = /（?(?:成立|注册资本|位于|主营|经营范围|业务涵盖|是一家|致力于|主要从事|从事|提供|研发|生产|经[^，。]{0,12}批准|控股|旗下)/;
  let bestIdx = -1, bestDist = 1e9;
  for (const n of needles) {
    let idx = t.indexOf(n);
    while (idx !== -1) {
      const after = t.slice(idx + Math.min(n.length, t.length - idx));
      const mm = after.slice(0, 60).match(signal);
      if (mm && mm.index < bestDist) { bestDist = mm.index; bestIdx = idx; }
      idx = t.indexOf(n, idx + n.length);
    }
  }
  let seg = '';
  if (bestIdx !== -1) {
    const from = t.slice(bestIdx);
    const m = from.match(/^.{0,200}?[，。]/);
    seg = m ? from.slice(0, m[0].length - 1) : from.slice(0, 160);
  } else {
    const sentences = t.split(/[，,。！？\n;；]/).map(s => s.trim()).filter(s => s.length > 12);
    seg = sentences.find(s => (s.includes(q) || s.includes(core)) && !isNavSoup(s)) || '';
  }
  seg = seg.replace(/^(企业概况|ABOUT|公司做什么|企业介绍|公司简介)[\s:：]*/i, '')
           .replace(/^([^，。]{1,14})\s*\([^)]{1,20}\)\s*(公司做什么\s*)?/, '$1 ')
           .replace(/^[\s:：]+/, '');
  return cleanProfileText(seg).slice(0, 160);
}
function pickBestProfile(cands, q) {
  cands = cands.slice().sort((a, b) => scoreProfile(b, q) - scoreProfile(a, q));
  for (const c of cands) {
    const frag = extractProfileSentence(c.content || c.snippet, q);
    if (frag && !isNavSoup(frag) && (frag.includes(q) || /简介|主营|业务|成立|是一家|致力于|从事|提供|研发|生产|注册资本|位于/.test(frag)))
      return frag;
  }
  const top = cands[0];
  return cleanProfileText((top.content || top.snippet) || '').slice(0, 160);
}

async function getProfile(q) {
  if (CLIENT_PROFILES[q]) return CLIENT_PROFILES[q].profile;
  if (!process.env.TAVILY_API_KEY && !process.env.EXA_API_KEY && !process.env.TENCENT_WSA_API_KEY) return '';
  // 用通用网页搜索（非 news），多取几条供质量过滤；Tavily 为空自动降级 Exa
  const queries = [`${q} 公司简介 主营业务`, `${q} 企业简介 经营范围`];
  const all = [];
  for (const query of queries) {
    const res = await searchWebWithFallback(query, { topic: 'general', maxResults: 8 });
    all.push(...res);
  }
  const candidates = all.filter(x => !isProfileGarbage(x, q));
  if (!candidates.length) {
    // 无可信简介时返回兜底，避免展示碎片
    const suffix = q.includes('公司') ? '' : '公司';
    return `${q}${suffix}：公开渠道暂未收录可信公司简介，请手动补充或稍后再试。`;
  }
  return pickBestProfile(candidates, q);
}

// 一个客户的 4 个维度：RSS 匹配为主，空维度用 Tavily/Exa 补（均做相关性过滤）
// 资讯结果内存缓存：按客户名缓存，TTL 20 分钟。
// 个人工具客户就那几个、反复刷新，缓存可省下大量 WSA/Tavily 调用额度并秒回。
// 注意：这是进程内缓存，容器冷启动（缩容到0后重建）会清空，属可接受代价。
const NEWS_CACHE = new Map();
const NEWS_CACHE_TTL = 20 * 60 * 1000;
async function getNewsCached(q) {
  const key = q;
  const hit = NEWS_CACHE.get(key);
  if (hit && (Date.now() - hit.t < NEWS_CACHE_TTL)) {
    console.log(`[news] 命中缓存「${q}」`);
    return { ...hit.v, cached: true };
  }
  const v = await searchAllCategories(q);
  NEWS_CACHE.set(key, { t: Date.now(), v });
  return { ...v, cached: false };
}

async function searchAllCategories(q) {
  const items = await loadAllRss();
  const matched = matchCustomer(items, q);
  console.log(`[news] 客户「${q}」RSS 命中 ${matched.length} 条`);
  const out = classify(matched);
  let profile = '';
  if (process.env.TAVILY_API_KEY || process.env.EXA_API_KEY || process.env.TENCENT_WSA_API_KEY) {
    // 并行：简介 + 各空维度兜底（兜底结果必须过相关性闸门）
    const profileP = getProfile(q);
    const fillP = CATEGORIES.map(async c => {
      if (!out[c.label].length) {
        const seen = new Set();
        const r = (await searchWebWithFallback(c.tavily(q)))
          .filter(x => relevantToClient(x, q))
          .filter(x => { if (seen.has(x.url)) return false; seen.add(x.url); return true; });
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
    // uid = 同步空间ID，未传则归入 'default' 桶（保持单人现状兼容）
    const uid = url.searchParams.get('uid') || 'default';
    if (req.method === 'GET') {
      // 拉取数据（仅该空间的数据）
      const data = loadData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uid, data: data[uid] || {} }));
    } else if (req.method === 'PUT') {
      // 推送数据（时间戳合并策略，按空间隔离）
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const incoming = JSON.parse(body);
          const all = loadData();
          const existing = all[uid] || {};

          // 合并：每个 key 保留 _lastModified 更大的那份
          for (const key of Object.keys(incoming)) {
            const inc = incoming[key];
            if (!inc._lastModified) continue;
            const ext = existing[key];
            if (!ext || !ext._lastModified || inc._lastModified >= ext._lastModified) {
              existing[key] = inc;
            }
          }

          all[uid] = existing;
          saveData(all);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, uid }));
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
        const result = await getNewsCached(q);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, q, updatedAt: Date.now(), profile: result.profile, found: result.found, categories: result.categories, cached: result.cached }));
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
  console.log(`News mode: RSS aggregation${process.env.TENCENT_WSA_API_KEY ? ' + 腾讯云联网搜索WSA (env var)' : ''}${process.env.TAVILY_API_KEY ? ' + Tavily fallback (env var)' : ''}${process.env.EXA_API_KEY ? ' + Exa fallback (env var)' : ''}`);
});
