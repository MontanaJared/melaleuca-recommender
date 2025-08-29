'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
let cheerio = null; try { cheerio = require('cheerio'); } catch (e) { /* optional dependency for scraping */ }

// Simple .env loader (avoids external deps)
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
})();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const SCRAPE_SEARCH_URL = process.env.SCRAPE_SEARCH_URL || 'https://www.melaleuca.com/search?q={q}';
const SCRAPE_CACHE_TTL_MS = Number(process.env.SCRAPE_CACHE_TTL_MS || 15 * 60 * 1000);
const SCRAPE_ENABLED = process.env.SCRAPE_DISABLED === '1' ? false : true;
const SEARCH_CACHE = new Map(); // key -> { ts, items }

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(text);
}

function serveStatic(req, res) {
  let reqPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (reqPath === '/') reqPath = '/index.html';
  // Normalize and ensure the path stays within PUBLIC_DIR
  const normalized = path.normalize(reqPath).replace(/^([.]{2}[\/])+/, '');
  const joined = path.join(PUBLIC_DIR, normalized.replace(/^[/\\]+/, ''));
  const filePath = path.resolve(joined);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR))) {
    return sendText(res, 403, 'Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    const typeMap = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml; charset=utf-8',
      '.ico': 'image/x-icon',
    };
    const ct = typeMap[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': ct,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
}

// --- Simple HTTP GET with redirect handling ---
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MelaleucaScraper/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return resolve(httpGet(next));
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (status >= 200 && status < 300) return resolve(data);
        reject(new Error(`HTTP ${status}`));
      });
    });
    req.on('error', reject);
  });
}

function extractJSONLDBlocks(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = (m[1] || '').trim();
    if (!text) continue;
    try {
      // Some sites embed multiple JSON objects; attempt safe parse
      const json = JSON.parse(text);
      out.push(json);
    } catch {}
  }
  return out;
}

function toArray(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

function parsePrice(x) {
  if (typeof x === 'number') return x;
  if (typeof x === 'string') {
    const m = x.replace(/[,\s]/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
    return m ? Number(m[1]) : NaN;
  }
  return NaN;
}

function normalizeProductFromJSONLD(node, baseUrl) {
  if (!node || (node['@type'] == null && node['@graph'] == null)) return null;
  const types = toArray(node['@type']).map(String);
  if (!types.includes('Product')) return null;
  const name = node.name || '';
  let price;
  const offers = node.offers;
  if (offers) {
    const offersArr = toArray(offers);
    for (const o of offersArr) {
      if (o && o.price) { price = parsePrice(o.price); break; }
      if (o && o.priceSpecification && o.priceSpecification.price) { price = parsePrice(o.priceSpecification.price); break; }
    }
  }
  const category = node.category || '';
  const description = node.description || '';
  let url = node.url || '';
  try { if (url) url = new URL(url, baseUrl).toString(); } catch {}
  const image = Array.isArray(node.image) ? node.image[0] : node.image;
  if (!name) return null;
  return {
    name,
    price: Number.isFinite(price) ? price : 0,
    category: String(category || ''),
    description: String(description || ''),
    url,
    image,
    tags: [],
  };
}

function parseProductsFromHTML(html, baseUrl) {
  const items = [];
  const blocks = extractJSONLDBlocks(html);
  const pushNode = (n) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(pushNode);
    if (n['@graph']) return pushNode(n['@graph']);
    const p = normalizeProductFromJSONLD(n, baseUrl);
    if (p) items.push(p);
  };
  for (const b of blocks) pushNode(b);
  // If cheerio is present, we could add additional card parsing in future
  const dedup = new Map();
  for (const p of items) {
    const key = (p.url || p.name).toLowerCase();
    if (!dedup.has(key)) dedup.set(key, p);
  }
  return Array.from(dedup.values());
}

async function searchRemoteProducts({ q, category, maxPrice, limit }) {
  if (!SCRAPE_ENABLED) return [];
  const key = JSON.stringify(['remote', q || '', category || '', maxPrice || '', limit || '']);
  const now = Date.now();
  const cached = SEARCH_CACHE.get(key);
  if (cached && (now - cached.ts) < SCRAPE_CACHE_TTL_MS) return cached.items;
  const url = (process.env.SCRAPE_SEARCH_URL || SCRAPE_SEARCH_URL).replace('{q}', encodeURIComponent(q || ''));
  const html = await httpGet(url);
  let items = parseProductsFromHTML(html, url);
  // Basic filtering
  if (category) {
    const c = String(category).toLowerCase();
    items = items.filter(p => String(p.category || '').toLowerCase().includes(c) || String(p.name || '').toLowerCase().includes(c));
  }
  if (typeof maxPrice === 'number' && Number.isFinite(maxPrice)) {
    items = items.filter(p => typeof p.price === 'number' && p.price <= maxPrice);
  }
  if (limit) items = items.slice(0, limit);
  SEARCH_CACHE.set(key, { ts: now, items });
  return items;
}

function scoreLocal(p, { q, category, maxPrice }) {
  let score = 0;
  const norm = (s) => String(s || '').toLowerCase();
  const hay = `${norm(p.name)} ${norm(p.description)} ${(p.tags || []).map(norm).join(' ')} ${norm(p.category)}`;
  const qq = norm(q);
  if (qq) {
    for (const tok of qq.split(/[^a-z0-9]+/).filter(Boolean)) {
      if (hay.includes(tok)) score += 2;
    }
    if (hay.includes(qq)) score += 3;
  }
  if (category && norm(p.category) === norm(category)) score += 2;
  if (typeof maxPrice === 'number' && p.price <= maxPrice) score += 1;
  if (typeof p.rating === 'number') score += p.rating * 0.2;
  return score;
}

async function searchLocalProducts({ q, category, maxPrice, limit }) {
  const key = JSON.stringify(['local', q || '', category || '', maxPrice || '', limit || '']);
  const now = Date.now();
  const cached = SEARCH_CACHE.get(key);
  if (cached && (now - cached.ts) < SCRAPE_CACHE_TTL_MS) return cached.items;
  const filePath = path.join(PUBLIC_DIR, 'data', 'products.json');
  let products = [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(raw || '{}');
    products = json.products || [];
  } catch {}
  let list = products.slice();
  if (typeof maxPrice === 'number') list = list.filter(p => typeof p.price === 'number' && p.price <= maxPrice);
  if (category) list = list.filter(p => String(p.category || '').toLowerCase() === String(category).toLowerCase());
  list = list
    .map(p => ({ p, s: scoreLocal(p, { q, category, maxPrice }) }))
    .sort((a, b) => b.s - a.s)
    .map(x => x.p);
  if (limit) list = list.slice(0, limit);
  SEARCH_CACHE.set(key, { ts: now, items: list });
  return list;
}

function createClientSecret() {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      session: { type: 'realtime', model: 'gpt-realtime' },
    });

    const options = {
      host: 'api.openai.com',
      path: '/v1/realtime/client_secrets',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data || '{}');
          console.log('[OpenAI] /realtime/client_secrets status:', res.statusCode, 'body:', data || '<empty>');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            const msg = json.error?.message || `OpenAI error (status ${res.statusCode})`;
            reject(new Error(msg));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  // API: scrape live products with fallback to local catalog
  if (req.url.startsWith('/api/products/search')) {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'Method Not Allowed' });
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const q = (u.searchParams.get('q') || '').toString();
      const category = u.searchParams.get('category') || '';
      const maxPriceParam = u.searchParams.get('max_price');
      const limitParam = u.searchParams.get('limit');
      const maxPrice = maxPriceParam != null ? Number(maxPriceParam) : undefined;
      const limit = limitParam != null ? Math.max(1, Math.min(20, Number(limitParam))) : 3;

      let items = [];
      try {
        items = await searchRemoteProducts({ q, category, maxPrice, limit });
      } catch (e) {
        console.warn('Scrape failed:', e.message);
      }
      if (!Array.isArray(items) || items.length === 0) {
        items = await searchLocalProducts({ q, category, maxPrice, limit });
      }
      return sendJSON(res, 200, { items, source: Array.isArray(items) && items.length ? 'ok' : 'empty' });
    } catch (err) {
      console.error('Search endpoint error:', err.message);
      return sendJSON(res, 500, { error: 'Search failed' });
    }
  }

  if (req.url.startsWith('/session')) {
    if (!OPENAI_API_KEY) {
      return sendJSON(res, 500, { error: 'Missing OPENAI_API_KEY in environment.' });
    }
    try {
      const data = await createClientSecret();
      // Normalize shape for the browser client
      const client_secret = data?.client_secret ?? (data?.value ? { value: data.value, expires_at: data.expires_at } : undefined);
      return sendJSON(res, 200, { client_secret, raw: data });
    } catch (err) {
      console.error('Failed to create client secret:', err.message);
      return sendJSON(res, 500, { error: 'Failed to create client secret' });
    }
  }

  // Static files
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
