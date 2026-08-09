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
});
