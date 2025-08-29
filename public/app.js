// Front-end for Melaleuca Product Recommender using OpenAI Realtime Agents
// ESM imports via CDN (no npm install required)
import { RealtimeAgent, RealtimeSession, tool } from 'https://esm.sh/@openai/agents-realtime@0.1.0';
import { z } from 'https://esm.sh/zod@3.25.40';

function setSearchStatus(content, cls = '') {
  const el = els.searchStatus;
  if (!el) return;
  el.className = `search-status ${cls}`.trim();
  el.innerHTML = content || '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const els = {
  status: document.getElementById('status'),
  connectBtn: document.getElementById('connectBtn'),
  interruptBtn: document.getElementById('interruptBtn'),
  resetBtn: document.getElementById('resetBtn'),
  textInput: document.getElementById('textInput'),
  sendBtn: document.getElementById('sendBtn'),
  history: document.getElementById('history'),
  recommendations: document.getElementById('recommendations'),
  searchStatus: document.getElementById('searchStatus'),
};

let cachedProducts = null;

async function loadProducts() {
  if (cachedProducts) return cachedProducts;
  const res = await fetch('/data/products.json');
  if (!res.ok) throw new Error('Failed to load product catalog');
  const data = await res.json();
  cachedProducts = data.products || [];
  return cachedProducts;
}

// Live search via server scrape endpoint with simple client-side cache
const liveCache = new Map(); // key -> { items, meta }
async function searchLive({ query, category, max_price, limit }) {
  const key = JSON.stringify({ query: query || '', category: category || '', max_price: max_price ?? '', limit: limit || 3 });
  if (liveCache.has(key)) return liveCache.get(key);
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (category) params.set('category', category);
  if (typeof max_price === 'number') params.set('max_price', String(max_price));
  if (limit) params.set('limit', String(limit));
  setSearchStatus(`Searching <strong>melaleuca.com</strong> for “${esc(query || '')}”…`, 'loading');
  const res = await fetch(`/api/products/search?${params.toString()}`);
  if (!res.ok) throw new Error(`Search API failed: ${res.status}`);
  const json = await res.json();
  const items = Array.isArray(json.items) ? json.items : [];
  const meta = { source: json.source, url: json.url, cached: !!json.cached, site: json.site, query: json.query };
  const payload = { items, meta };
  liveCache.set(key, payload);
  return payload;
}

function renderHistory(historyItems) {
  els.history.innerHTML = '';
  for (const item of historyItems) {
    if (item.type !== 'message') continue;
    const div = document.createElement('div');
    div.className = `msg ${item.role}`;
    div.textContent = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
    els.history.appendChild(div);
  }
  els.history.scrollTop = els.history.scrollHeight;
}

function renderRecommendations(items) {
  els.recommendations.innerHTML = '';
  for (const p of items) {
    const card = document.createElement('div');
    card.className = 'card';
    const title = p.url ? `<a href="${p.url}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name);
    card.innerHTML = `
      <div class="card-body">
        <div class="title">${title}</div>
        <div class="meta">${esc(p.category || '')} • Rating ${p.rating?.toFixed?.(1) ?? p.rating ?? 'N/A'}</div>
        <div class="price">$${(typeof p.price === 'number' && Number.isFinite(p.price)) ? p.price.toFixed(2) : 'N/A'}</div>
        <div class="desc">${esc(p.description || '')}</div>
        ${p.tags?.length ? `<div class="tags">${p.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
    `;
    els.recommendations.appendChild(card);
  }
}

// Expose to tools
window.renderRecommendations = renderRecommendations;

function normalize(str) {
  return (str || '').toLowerCase();
}

function scoreProduct(p, { query, category, max_price }) {
  let score = 0;
  const q = normalize(query);
  if (q) {
    const hay = `${normalize(p.name)} ${normalize(p.description)} ${(p.tags||[]).map(normalize).join(' ')}`;
    // simple keyword scoring
    for (const token of q.split(/[^a-z0-9]+/).filter(Boolean)) {
      if (hay.includes(token)) score += 2;
    }
    // exact phrase boost
    if (hay.includes(q)) score += 3;
  }
  if (category && normalize(p.category) === normalize(category)) score += 2;
  if (typeof max_price === 'number' && p.price <= max_price) score += 1; // prefer under budget
  // prefer higher rating
  if (typeof p.rating === 'number') score += p.rating * 0.2;
  // some helpful tag boosts
  const boosts = [
    { key: 'sensitive', inc: 1 },
    { key: 'fragrance-free', inc: 1 },
    { key: 'eco', inc: 0.5 },
    { key: 'concentrated', inc: 0.5 },
  ];
  const tagset = new Set((p.tags || []).map(normalize));
  for (const b of boosts) if (tagset.has(b.key)) score += b.inc;
  return score;
}

// Define the product search tool (runs in browser)
const searchProducts = tool({
  name: 'search_products',
  description: 'Search the Melaleuca product catalog and return top matches with name, price, category, and tags.',
  parameters: z.object({
    query: z.string().describe('Natural language need, e.g. "gentle fragrance-free detergent for sensitive skin under $25"'),
    category: z.string().nullable().optional().describe('Optional product category filter'),
    max_price: z.number().nullable().optional().describe('Optional budget cap in USD'),
    limit: z.number().int().min(1).max(10).default(3),
  }),
  async execute({ query, category, max_price, limit }) {
    let items = [];
    let meta = null;
    // 1) Try live scrape via server
    try {
      const res = await searchLive({ query, category, max_price, limit });
      items = res.items;
      meta = res.meta;
    } catch (e) {
      console.warn('Live search failed:', e);
      setSearchStatus(`Error searching melaleuca.com: ${esc(e.message || e)}`, 'error');
    }
    // 2) If no live items, fall back to local JSON
    if (!Array.isArray(items) || items.length === 0) {
      const products = await loadProducts();
      let filtered = products.slice();
      if (typeof max_price === 'number') filtered = filtered.filter(p => typeof p.price === 'number' && p.price <= max_price);
      if (category) filtered = filtered.filter(p => normalize(p.category) === normalize(category));
      items = filtered
        .map(p => ({ p, s: scoreProduct(p, { query, category, max_price }) }))
        .sort((a, b) => b.s - a.s)
        .map(x => x.p)
        .slice(0, limit);
      meta = { source: 'local', url: '', cached: false, site: 'local' };
    } else {
      // Optionally rescore remote items to better match user intent
      items = items
        .map(p => ({ p, s: scoreProduct(p, { query, category, max_price }) }))
        .sort((a, b) => b.s - a.s)
        .map(x => x.p)
        .slice(0, limit);
    }

    // Update UI immediately
    try { window.renderRecommendations(items); } catch { /* noop */ }

    // Update status line with final source and link
    if (meta && meta.source === 'web') {
      const cachedTxt = meta.cached ? ' (cached)' : '';
      const link = meta.url ? ` • <a href="${meta.url}" target="_blank" rel="noopener">View on melaleuca.com</a>` : '';
      setSearchStatus(`Showing ${items.length} result(s) from <strong>melaleuca.com</strong>${cachedTxt}${link}`, 'ok');
    } else if (meta && meta.source === 'local') {
      setSearchStatus(`Showing ${items.length} local fallback result(s).`, 'warn');
    } else {
      setSearchStatus(items.length ? `Showing ${items.length} result(s).` : 'No results found.', items.length ? 'ok' : 'warn');
    }

    // Return structured data for the agent
    const fmtPrice = (v) => (typeof v === 'number' && Number.isFinite(v)) ? `$${v.toFixed(2)}` : 'N/A';
    return {
      items,
      summary: items.map(r => `${r.name} (${fmtPrice(r.price)}) - ${r.category || ''}`).join('; '),
      count: items.length,
      source: meta?.source || 'unknown',
      url: meta?.url || '',
    };
  },
});

// Build the Realtime Agent
const agent = new RealtimeAgent({
  name: 'Melaleuca Product Expert',
  instructions: [
    'Always respond in English, regardless of the user\'s input language.',
    'You are a helpful product recommender for Melaleuca.com.',
    'Always use the search_products tool to find items before answering.',
    'Ask a brief clarifying question if the user intent is unclear (e.g., budget, skin sensitivity, fragrance-free).',
    'Answer concisely: present top 3 matches with name, price, category, and a short reason.',
    'If you do not find relevant products, ask for more details.',
    'Avoid making claims about stock or medical benefits. Recommend consulting product labels on Melaleuca.com for full details.',
  ].join(' '),
  tools: [searchProducts],
});

const session = new RealtimeSession(agent, {
  model: 'gpt-realtime',
  // You can experiment with audio config here if needed
});

// Render history on updates
session.on('history_updated', (history) => {
  renderHistory(history);
});

function setConnectedUI(connected) {
  els.status.textContent = connected ? 'Connected' : 'Disconnected';
  els.connectBtn.disabled = connected;
  els.interruptBtn.disabled = !connected;
  els.resetBtn.disabled = !connected;
  els.sendBtn.disabled = !connected;
}

async function connectSession() {
  setConnectedUI(false);
  els.status.textContent = 'Connecting…';
  const resp = await fetch('/session', { method: 'POST' });
  if (!resp.ok) throw new Error('Failed to get client secret');
  const data = await resp.json();
  const clientKey = data?.client_secret?.value || data?.client_secret?.secret || data?.client_secret;
  if (!clientKey) throw new Error('Invalid client secret response');
  await session.connect({ apiKey: clientKey });
  setConnectedUI(true);
}

// UI events
els.connectBtn.addEventListener('click', async () => {
  els.connectBtn.disabled = true;
  try {
    await connectSession();
  } catch (err) {
    console.error(err);
    alert('Failed to connect: ' + err.message);
    setConnectedUI(false);
    els.connectBtn.disabled = false;
  }
});

els.sendBtn.addEventListener('click', async () => {
  const text = els.textInput.value.trim();
  if (!text) return;
  els.textInput.value = '';
  session.sendMessage(text);
});

els.textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    els.sendBtn.click();
  }
});

els.interruptBtn.addEventListener('click', () => {
  session.interrupt();
});

els.resetBtn.addEventListener('click', () => {
  session.updateHistory([]);
  els.history.innerHTML = '';
  els.recommendations.innerHTML = '';
});

// Prefetch products for faster first response
loadProducts().catch(console.warn);
