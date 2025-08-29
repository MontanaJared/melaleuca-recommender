'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
let cheerio = null; try { cheerio = require('cheerio'); } catch (e) { /* optional dependency for scraping */ }

async function filterAndHydrateDetails(items, limit = 6, maxFetch = 10, startTs = Date.now()) {
  const keep = [];
  const visited = new Set();
  for (const p of items) {
    if ((Date.now() - startTs) > SCRAPE_MAX_TIME_MS) break;
    if (!p || !p.url) continue;
    if (visited.has(p.url)) continue;
    visited.add(p.url);
    // Only verify likely productstore links
    if (!isLikelyProductDetailUrl(p.url)) continue;
    try {
      const html = await httpGet(p.url);
      const blocks = extractJSONLDBlocks(html);
      let found = null;
      for (const b of blocks) {
        const prod = normalizeProductFromJSONLD(b, p.url);
        if (prod) { found = prod; break; }
      }
      if (found) {
        // Merge any pre-parsed data (e.g., price/image) into the verified product
        keep.push({ ...p, ...found, url: found.url || p.url });
      }
      if (keep.length >= limit || visited.size >= maxFetch) break;
    } catch {}
    if (--maxFetch <= 0) break;
  }
  return keep;
}

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
const SITEMAP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SITEMAP_CACHE = { ts: 0, urls: [] };
const SCRAPE_HTTP_TIMEOUT_MS = Number(process.env.SCRAPE_HTTP_TIMEOUT_MS || 6000);
const SCRAPE_MAX_TIME_MS = Number(process.env.SCRAPE_MAX_TIME_MS || 12000);

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
    req.setTimeout(SCRAPE_HTTP_TIMEOUT_MS, () => {
      try { req.destroy(new Error('Timeout')); } catch {}
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

async function searchViaBingProducts(q, limit = 8, startTs = Date.now()) {
  if (!cheerio) return [];
  try {
    const query = `site:melaleuca.com/productstore ${q}`.trim();
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    const html = await httpGet(url);
    const $ = cheerio.load(html);
    const links = new Set();
    $('li.b_algo h2 a, ol#b_results li h2 a, a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!href) return;
      if (!/melaleuca\.com\//i.test(href)) return;
      if (!/\/productstore\//i.test(href)) return;
      try {
        const u = new URL(href, 'https://www.bing.com').toString();
        if (isLikelyProductDetailUrl(u)) links.add(u);
      } catch {}
    });
    const candidates = Array.from(links).slice(0, Math.max(3, limit)).map(u => ({ name: '', price: 0, category: '', description: '', url: u, image: undefined, tags: [] }));
    const verified = await filterAndHydrateDetails(candidates, Math.max(3, limit), 6, startTs);
    return verified && verified.length ? prioritizeProducts(verified) : [];
  } catch {
    return [];
  }
}

async function fetchSitemapUrls() {
  const now = Date.now();
  if (SITEMAP_CACHE.urls.length && (now - SITEMAP_CACHE.ts) < SITEMAP_CACHE_TTL_MS) {
    return SITEMAP_CACHE.urls.slice();
  }
  const root = 'https://www.melaleuca.com/sitemap.xml';
  const urls = new Set();
  try {
    const xml = await httpGet(root);
    const isIndex = /<sitemapindex/i.test(xml);
    const extractLocs = (s) => Array.from(s.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map(m => m[1]);
    if (isIndex) {
      const locs = extractLocs(xml);
      const cand = locs.filter(u => /product/i.test(u) || /productstore/i.test(u)).slice(0, 4);
      for (const u of cand) {
        try {
          const x = await httpGet(u);
          for (const l of extractLocs(x)) {
            if (/\/productstore\//i.test(l)) urls.add(l);
          }
        } catch {}
      }
    } else {
      for (const l of extractLocs(xml)) {
        if (/\/productstore\//i.test(l)) urls.add(l);
      }
    }
  } catch {}
  const out = Array.from(urls);
  SITEMAP_CACHE.ts = now;
  SITEMAP_CACHE.urls = out;
  return out;
}

async function searchViaSitemap(q, limit = 8, startTs = Date.now()) {
  try {
    const urls = await fetchSitemapUrls();
    if (!urls.length) return [];
    const toks = String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const scored = urls
      .filter(u => isLikelyProductDetailUrl(u))
      .map(u => {
        const slug = u.toLowerCase();
        let s = 0; for (const t of toks) { if (slug.includes(t)) s++; }
        return { u, s };
      })
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.max(3, (limit || 6) * 3));
    if (!scored.length) return [];
    const candidates = scored.map(x => ({ name: '', price: 0, category: '', description: '', url: x.u, image: undefined, tags: [] }));
    const verified = await filterAndHydrateDetails(candidates, Math.max(3, limit || 6), Math.max(6, (limit || 6) * 2), startTs);
    return verified && verified.length ? prioritizeProducts(verified) : [];
  } catch {
    return [];
  }
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
  // If it lacks an offer price AND the URL looks category-like, drop it
  try {
    const likely = isLikelyProductDetailUrl(url);
    if (!likely && !(Number.isFinite(price) && price > 0)) return null;
  } catch {}
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

// --- Heuristics to identify product detail vs category links ---
const STOPWORDS = new Set([
  'r3','supplements','cleaning-and-laundry','all-cleaning-and-laundry','personal-care','home-care','home-cleaning','laundry','skincare','skin-care','nutrition','pharmacy','beauty','bath-and-body','home','shop-all','shop','categories','gifts','clearance','new-products','product-store','productstore',
  // additional category-like segments
  'healthy-foods-and-drinks','color-cosmetics','acne-prevention','premium-skin-care','hand-soap-sanitizers','healthy-weight-protein','healthy-snacks','baking-mixes','outlet-store','extra-savings','beauty-specials','now-trending-seasonal-colors'
]);

function isLikelyProductDetailUrl(u) {
  try {
    if (!u) return false;
    const url = new URL(u, 'https://www.melaleuca.com');
    const parts = url.pathname.toLowerCase().split('/').filter(Boolean);
    const idx = parts.indexOf('productstore');
    if (idx === -1) return false;
    const rest = parts.slice(idx + 1);
    if (rest.length < 2) return false; // too shallow
    // reject if rest are only stopwords
    if (rest.every(seg => STOPWORDS.has(seg))) return false;
    // keywords indicating detail routes
    const keyword = rest.some(seg => /(product|detail|item|showdetails)/i.test(seg));
    if (keyword) return true;
    // deeper paths are more likely to be details
    if (rest.length >= 3) return true;
    // presence of digits in last segments often indicates SKU/variant
    const hasDigits = rest.some(seg => /\d/.test(seg));
    return hasDigits;
  } catch {
    return false;
  }
}

function isCategoryLike(name, url) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return true;
  if (STOPWORDS.has(n.replace(/\s+/g, '-'))) return true;
  try {
    const u = new URL(url, 'https://www.melaleuca.com');
    const parts = u.pathname.toLowerCase().split('/').filter(Boolean);
    const idx = parts.indexOf('productstore');
    const rest = idx === -1 ? parts : parts.slice(idx + 1);
    if (rest.length <= 1) return true;
    if (rest.every(seg => STOPWORDS.has(seg))) return true;
  } catch {}
  return false;
}

function prioritizeProducts(items) {
  // prefer likely detail pages, non-zero price, longer names
  return items.slice().sort((a, b) => {
    const ad = isLikelyProductDetailUrl(a.url) ? 1 : 0;
    const bd = isLikelyProductDetailUrl(b.url) ? 1 : 0;
    if (ad !== bd) return bd - ad;
    const ap = (typeof a.price === 'number' && a.price > 0) ? 1 : 0;
    const bp = (typeof b.price === 'number' && b.price > 0) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    const an = String(a.name || '').length;
    const bn = String(b.name || '').length;
    return bn - an;
  });
}

async function enrichFromDetailPages(items, maxFetch = 5) {
  const out = items.slice();
  let changed = false;
  for (let i = 0, fetched = 0; i < out.length && fetched < maxFetch; i++) {
    const p = out[i];
    if (!isLikelyProductDetailUrl(p.url)) continue;
    // Skip if already has decent info
    const hasBasics = p.description || (typeof p.price === 'number' && p.price > 0) || (p.image && p.image.startsWith('http'));
    if (hasBasics) continue;
    try {
      const html = await httpGet(p.url);
      const blocks = extractJSONLDBlocks(html);
      for (const b of blocks) {
        const prod = normalizeProductFromJSONLD(b, p.url);
        if (prod) {
          // merge
          out[i] = { ...p, ...prod, url: prod.url || p.url };
          changed = true;
          break;
        }
      }
      fetched++;
    } catch {}
  }
  return { items: out, changed };
}

function parseProductsFromHTML(html, baseUrl) {
  const items = [];
  const blocks = extractJSONLDBlocks(html);
  const pushNode = (n) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(pushNode);
    if (n['@graph']) return pushNode(n['@graph']);
    const types = toArray(n['@type']).map(String);
    // If the block is an ItemList, drill into its elements
    if (types.includes('ItemList') && Array.isArray(n.itemListElement)) {
      for (const el of n.itemListElement) {
        if (el && typeof el === 'object') {
          if (el.item) pushNode(el.item); else pushNode(el);
        }
      }
      return;
    }
    // If it's a ListItem that wraps an item, unwrap
    if (types.includes('ListItem') && n.item) {
      return pushNode(n.item);
    }
    const p = normalizeProductFromJSONLD(n, baseUrl);
    if (p) items.push(p);
  };
  for (const b of blocks) pushNode(b);
  // Fallback: If few/no items from JSON-LD and cheerio is available, try parsing product cards/links
  if (items.length < 3 && cheerio) {
    try {
      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        const hrefRaw = $(a).attr('href') || '';
        let href;
        try { href = new URL(hrefRaw, baseUrl).toString(); } catch { return; }
        if (!isLikelyProductDetailUrl(href)) return;
        // Extract name
        let name = ($(a).attr('title') || $(a).text() || '').replace(/\s+/g, ' ').trim();
        if (!name) {
          const alt = $(a).find('img[alt]').attr('alt');
          if (alt) name = String(alt).trim();
        }
        if (!name || isCategoryLike(name, href)) return;
        // Nearby price within containing tile
        const $tile = $(a).closest('li, article, div');
        const text = ($tile.text() || '').replace(/\s+/g, ' ');
        const pm = text.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
        const price = pm ? Number(pm[1]) : 0;
        const imgSrc = $(a).find('img').attr('src') || '';
        let image;
        try { image = imgSrc ? new URL(imgSrc, baseUrl).toString() : undefined; } catch {}
        items.push({ name, price: Number.isFinite(price) ? price : 0, category: '', description: '', url: href, image, tags: [] });
      });
    } catch {}
  }
  // If cheerio is present, we could add additional card parsing in future
  const dedup = new Map();
  for (const p of items) {
    const key = (p.url || p.name).toLowerCase();
    if (!dedup.has(key)) dedup.set(key, p);
  }
  let list = Array.from(dedup.values());
  // Filter: keep likely detail pages or those with a positive price
  try {
    list = list.filter(p => (isLikelyProductDetailUrl(p.url) || (typeof p.price === 'number' && p.price > 0)));
  } catch {}
  return prioritizeProducts(list);
}

async function searchRemoteProducts({ q, category, maxPrice, limit }) {
  if (!SCRAPE_ENABLED) return { items: [], url: '', cached: false };
  const key = JSON.stringify(['remote', q || '', category || '', maxPrice || '', limit || '']);
  const now = Date.now();
  const startTs = now;
  const urlPrimary = (process.env.SCRAPE_SEARCH_URL || SCRAPE_SEARCH_URL).replace('{q}', encodeURIComponent(q || ''));
  const cached = SEARCH_CACHE.get(key);
  if (cached && Array.isArray(cached.items) && cached.items.length > 0 && (now - cached.ts) < SCRAPE_CACHE_TTL_MS) {
    return { items: cached.items, url: cached.url || urlPrimary, cached: true };
  }
  let usedUrl = urlPrimary;
  let html;
  try {
    html = await httpGet(urlPrimary);
  } catch (e) {
    html = '';
  }
  let items = html ? parseProductsFromHTML(html, urlPrimary) : [];
  try { console.log('[scrape] primary url:', urlPrimary, 'html_len:', html ? html.length : 0, 'items:', items.length); } catch {}
  // Try alternate Melaleuca search path if no items or few likely details
  const hasDetail = items.some(p => isLikelyProductDetailUrl(p.url));
  if (!items.length || !hasDetail) {
    if ((Date.now() - startTs) > SCRAPE_MAX_TIME_MS) {
      try { console.log('[scrape] time budget exceeded before alt'); } catch {}
    } else {
      const alt = `https://www.melaleuca.com/Search?searchTerm=${encodeURIComponent(q || '')}`;
      try {
        const html2 = await httpGet(alt);
        const parsed = parseProductsFromHTML(html2, alt);
        if (parsed.length && parsed.some(p => isLikelyProductDetailUrl(p.url))) {
          items = parsed.length ? parsed : items;
          usedUrl = alt;
          try { console.log('[scrape] alt url used:', alt, 'items:', parsed.length); } catch {}
        }
      } catch {}
    }
  }
  // Verify and hydrate: only keep real Product detail pages; if none, try Bing fallback
  let verified = [];
  try {
    if ((Date.now() - startTs) <= SCRAPE_MAX_TIME_MS) {
      verified = await filterAndHydrateDetails(items, Math.max(3, limit || 6), 6, startTs);
    }
  } catch {}
  if (!verified || verified.length === 0) {
    try {
      if ((Date.now() - startTs) <= SCRAPE_MAX_TIME_MS) {
        const viaBing = await searchViaBingProducts(q, limit || 6, startTs);
        if (viaBing && viaBing.length) {
          items = viaBing;
          try { console.log('[scrape] bing fallback used:', viaBing.length); } catch {}
        } else if ((Date.now() - startTs) <= SCRAPE_MAX_TIME_MS) {
          // Try sitemap discovery as a last resort
          const viaSitemap = await searchViaSitemap(q, limit || 6, startTs);
          if (viaSitemap && viaSitemap.length) {
            items = viaSitemap;
            try { console.log('[scrape] sitemap fallback used:', viaSitemap.length); } catch {}
          } else {
            items = [];
          }
        } else {
          items = [];
        }
      } else {
        items = [];
      }
    } catch { items = []; }
  } else {
    items = verified;
    try { console.log('[scrape] verified detail pages:', verified.length); } catch {}
  }
  // Final filter: keep only likely product detail URLs
  try {
    const before = items.length;
    items = items.filter(p => isLikelyProductDetailUrl(p.url));
    if (before && items.length !== before) {
      try { console.log('[scrape] final filter removed', before - items.length, 'non-detail entries'); } catch {}
    }
  } catch {}
  // Basic filtering
  if (category) {
    const c = String(category).toLowerCase();
    items = items.filter(p => String(p.category || '').toLowerCase().includes(c) || String(p.name || '').toLowerCase().includes(c));
  }
  if (typeof maxPrice === 'number' && Number.isFinite(maxPrice)) {
    items = items.filter(p => typeof p.price === 'number' && p.price <= maxPrice);
  }
  if (limit) items = items.slice(0, limit);
  // Enrich a few candidate detail pages if data is thin
  try {
    const thin = items.filter(p => isLikelyProductDetailUrl(p.url) && (!p.description && (!p.price || p.price === 0)));
    if (thin.length) {
      const { items: enriched, changed } = await enrichFromDetailPages(items, 4);
      if (changed) items = prioritizeProducts(enriched);
    }
  } catch {}
  if (Array.isArray(items) && items.length > 0) {
    SEARCH_CACHE.set(key, { ts: now, items, url: usedUrl });
  }
  try { console.log('[scrape] used url:', usedUrl, 'final items:', items.length, 'cached:', false); } catch {}
  return { items, url: usedUrl, cached: false };
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
  if (cached && (now - cached.ts) < SCRAPE_CACHE_TTL_MS) return { items: cached.items, cached: true };
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
  return { items: list, cached: false };
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

      let meta = { source: 'empty', url: '', cached: false };
      let items = [];
      try {
        const remote = await searchRemoteProducts({ q, category, maxPrice, limit });
        if (Array.isArray(remote.items) && remote.items.length) {
          items = remote.items;
          meta = { source: 'web', url: remote.url || '', cached: !!remote.cached };
        }
      } catch (e) {
        console.warn('Scrape failed:', e.message);
      }
      if (!Array.isArray(items) || items.length === 0) {
        const local = await searchLocalProducts({ q, category, maxPrice, limit });
        items = local.items || [];
        meta = { source: 'local', url: '', cached: !!local.cached };
      }
      try { console.log('[search endpoint]', { q, category, maxPrice, limit, meta, count: items.length }); } catch {}
      return sendJSON(res, 200, { items, ...meta, site: 'melaleuca.com', query: q });
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
