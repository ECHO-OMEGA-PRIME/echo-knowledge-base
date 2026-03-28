import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
  ENGINE_RUNTIME: Fetcher;
  ECHO_API_KEY: string;
};

const app = new Hono<{ Bindings: Env }>();
app.use('*', cors());

function uid(): string { return crypto.randomUUID(); }
function sanitize(s: unknown, max = 10000): string {
  if (typeof s !== 'string') return '';
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max);
}
function sanitizeBody(b: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) o[k] = typeof v === 'string' ? sanitize(v) : v;
  return o;
}
function tid(c: any): string { return sanitize(c.req.header('X-Tenant-ID') || c.req.query('tenant_id') || '', 100); }
function json(c: any, d: unknown, s = 200) { return c.json(d, s); }
function slugify(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

interface RLState { c: number; t: number }
async function rateLimit(env: Env, key: string, max: number, windowSec = 60): Promise<boolean> {
  const k = `rl:${key}`;
  const now = Date.now();
  const raw = await env.CACHE.get(k);
  let st: RLState = raw ? JSON.parse(raw) : { c: 0, t: now };
  const elapsed = (now - st.t) / 1000;
  const decay = Math.floor(elapsed * (max / windowSec));
  st.c = Math.max(0, st.c - decay);
  st.t = now;
  if (st.c >= max) return false;
  st.c++;
  await env.CACHE.put(k, JSON.stringify(st), { expirationTtl: windowSec * 2 });
  return true;
}

// Auth — public article reads exempt
app.use('*', async (c, next) => {
  const path = c.req.path;
  if (path === '/health' || path === '/status' || c.req.method === 'GET') return next();
  // Allow public feedback POST
  if (path.startsWith('/articles/') && path.endsWith('/feedback')) return next();
  const key = c.req.header('X-Echo-API-Key') || c.req.header('Authorization')?.replace('Bearer ', '');
  if (!key || key !== c.env.ECHO_API_KEY) return json(c, { error: 'Unauthorized' }, 401);
  return next();
});

// Rate limiting
app.use('*', async (c, next) => {
  const path = c.req.path;
  if (path === '/health' || path === '/status') return next();
  const ip = c.req.header('CF-Connecting-IP') || 'unknown';
  const max = c.req.method === 'GET' ? 200 : 60;
  if (!await rateLimit(c.env, `${ip}:${c.req.method}`, max)) return json(c, { error: 'Rate limited' }, 429);
  return next();
});

// Health
app.get('/', (c) => c.redirect('/health'));
app.get('/health', (c) => json(c, { status: 'ok', service: 'echo-knowledge-base', version: '1.0.0', timestamp: new Date().toISOString() }));
app.get('/status', (c) => json(c, { status: 'operational', service: 'echo-knowledge-base', version: '1.0.0' }));

// === TENANTS ===
app.post('/tenants', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const id = uid();
  await c.env.DB.prepare('INSERT INTO tenants (id,name,email,plan,max_articles,custom_domain) VALUES (?,?,?,?,?,?)').bind(id, b.name, b.email || null, b.plan || 'free', b.max_articles || 100, b.custom_domain || null).run();
  return json(c, { id }, 201);
});

// === CATEGORIES ===
app.get('/categories', async (c) => {
  const t = tid(c); if (!t) return json(c, { error: 'tenant required' }, 400);
  const r = await c.env.DB.prepare('SELECT * FROM categories WHERE tenant_id=? ORDER BY order_num, name').bind(t).all();
  return json(c, { categories: r.results });
});
app.post('/categories', async (c) => {
  const t = tid(c); if (!t) return json(c, { error: 'tenant required' }, 400);
  const b = sanitizeBody(await c.req.json()) as any;
  const id = uid();
  const slug = b.slug || slugify(b.name);
  await c.env.DB.prepare('INSERT INTO categories (id,tenant_id,name,slug,description,icon,parent_id,order_num) VALUES (?,?,?,?,?,?,?,?)').bind(id, t, b.name, slug, b.description || null, b.icon || null, b.parent_id || null, b.order_num || 0).run();
  return json(c, { id, slug }, 201);
});
app.put('/categories/:id', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  await c.env.DB.prepare('UPDATE categories SET name=COALESCE(?,name),description=COALESCE(?,description),icon=COALESCE(?,icon),order_num=COALESCE(?,order_num) WHERE id=?').bind(b.name || null, b.description || null, b.icon || null, b.order_num ?? null, c.req.param('id')).run();
  return json(c, { updated: true });
});
app.delete('/categories/:id', async (c) => {
  await c.env.DB.prepare('UPDATE articles SET category_id=NULL WHERE category_id=?').bind(c.req.param('id')).run();
  await c.env.DB.prepare('DELETE FROM categories WHERE id=?').bind(c.req.param('id')).run();
  return json(c, { deleted: true });
});

// === ARTICLES ===
app.get('/articles', async (c) => {
  const t = tid(c); if (!t) return json(c, { error: 'tenant required' }, 400);
  const cat = c.req.query('category_id');
  const status = c.req.query('status');
  const featured = c.req.query('featured');
  let q = 'SELECT id,tenant_id,category_id,title,slug,excerpt,status,visibility,author_name,tags,view_count,helpful_yes,helpful_no,featured,created_at,updated_at,published_at FROM articles WHERE tenant_id=?';
  const params: string[] = [t];
  if (cat) { q += ' AND category_id=?'; params.push(cat); }
  if (status) { q += ' AND status=?'; params.push(status); }
  if (featured === '1') q += ' AND featured=1';
  q += ' ORDER BY order_num, updated_at DESC';
  const r = await c.env.DB.prepare(q).bind(...params).all();
  return json(c, { articles: r.results });
});
app.get('/articles/:id', async (c) => {
  const id = c.req.param('id');
  // Try by ID first, then by slug
  let r = await c.env.DB.prepare('SELECT * FROM articles WHERE id=?').bind(id).first();
  if (!r) {
    const t = tid(c);
    if (t) r = await c.env.DB.prepare('SELECT * FROM articles WHERE tenant_id=? AND slug=?').bind(t, id).first();
  }
  if (!r) return json(c, { error: 'Not found' }, 404);
  // Increment view count
  await c.env.DB.prepare('UPDATE articles SET view_count=view_count+1 WHERE id=?').bind((r as any).id).run();
  return json(c, r);
});
app.post('/articles', async (c) => {
  const t = tid(c); if (!t) return json(c, { error: 'tenant required' }, 400);
  const b = sanitizeBody(await c.req.json()) as any;
  const tenant = await c.env.DB.prepare('SELECT max_articles FROM tenants WHERE id=?').bind(t).first<any>();
  if (tenant) {
    const cnt = await c.env.DB.prepare('SELECT COUNT(*) as c FROM articles WHERE tenant_id=?').bind(t).first<any>();
    if (cnt && cnt.c >= tenant.max_articles) return json(c, { error: 'Article limit reached' }, 403);
  }
  const id = uid();
  const slug = b.slug || slugify(b.title);
  const excerpt = b.excerpt || (b.content ? b.content.replace(/<[^>]*>/g, '').slice(0, 200) : null);
  await c.env.DB.prepare('INSERT INTO articles (id,tenant_id,category_id,title,slug,content,excerpt,status,visibility,author_name,author_email,tags,meta_title,meta_description,featured,order_num) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, t, b.category_id || null, b.title, slug, b.content || null, excerpt, b.status || 'draft', b.visibility || 'public', b.author_name || null, b.author_email || null, JSON.stringify(b.tags || []), b.meta_title || b.title, b.meta_description || excerpt, b.featured ? 1 : 0, b.order_num || 0).run();
  // Add to search index
  const searchText = `${b.title} ${b.content || ''}`.replace(/<[^>]*>/g, '').toLowerCase();
  await c.env.DB.prepare('INSERT INTO search_index (id,tenant_id,article_id,searchable_text) VALUES (?,?,?,?)').bind(uid(), t, id, searchText).run();
  // Update category count
  if (b.category_id) await c.env.DB.prepare('UPDATE categories SET article_count=(SELECT COUNT(*) FROM articles WHERE category_id=?) WHERE id=?').bind(b.category_id, b.category_id).run();
  return json(c, { id, slug }, 201);
});
app.put('/articles/:id', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM articles WHERE id=?').bind(id).first<any>();
  if (!existing) return json(c, { error: 'Not found' }, 404);
  // Create version before update
  if (b.content && b.content !== existing.content) {
    await c.env.DB.prepare('INSERT INTO article_versions (id,article_id,tenant_id,version_num,title,content,change_summary,author_name) VALUES (?,?,?,?,?,?,?,?)').bind(uid(), id, existing.tenant_id, existing.current_version, existing.title, existing.content, b.change_summary || null, b.author_name || existing.author_name).run();
  }
  const newVersion = (b.content && b.content !== existing.content) ? existing.current_version + 1 : existing.current_version;
  await c.env.DB.prepare('UPDATE articles SET title=COALESCE(?,title),content=COALESCE(?,content),excerpt=COALESCE(?,excerpt),category_id=COALESCE(?,category_id),visibility=COALESCE(?,visibility),tags=COALESCE(?,tags),meta_title=COALESCE(?,meta_title),meta_description=COALESCE(?,meta_description),featured=COALESCE(?,featured),current_version=?,updated_at=datetime(\'now\') WHERE id=?').bind(b.title || null, b.content || null, b.excerpt || null, b.category_id || null, b.visibility || null, b.tags ? JSON.stringify(b.tags) : null, b.meta_title || null, b.meta_description || null, b.featured !== undefined ? (b.featured ? 1 : 0) : null, newVersion, id).run();
  // Update search index
  if (b.content || b.title) {
    const newTitle = b.title || existing.title;
    const newContent = b.content || existing.content || '';
    const searchText = `${newTitle} ${newContent}`.replace(/<[^>]*>/g, '').toLowerCase();
    await c.env.DB.prepare('UPDATE search_index SET searchable_text=?,updated_at=datetime(\'now\') WHERE article_id=?').bind(searchText, id).run();
  }
  return json(c, { updated: true, version: newVersion });
});
app.post('/articles/:id/publish', async (c) => {
  await c.env.DB.prepare("UPDATE articles SET status='published',published_at=COALESCE(published_at,datetime('now')),updated_at=datetime('now') WHERE id=?").bind(c.req.param('id')).run();
  return json(c, { published: true });
});
app.post('/articles/:id/unpublish', async (c) => {
  await c.env.DB.prepare("UPDATE articles SET status='draft',updated_at=datetime('now') WHERE id=?").bind(c.req.param('id')).run();
  return json(c, { unpublished: true });
});
app.delete('/articles/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM search_index WHERE article_id=?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM article_versions WHERE article_id=?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM feedback WHERE article_id=?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM articles WHERE id=?').bind(id).run();
  return json(c, { deleted: true });
});

// === VERSIONS ===
app.get('/articles/:id/versions', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM article_versions WHERE article_id=? ORDER BY version_num DESC').bind(c.req.param('id')).all();
  return json(c, { versions: r.results });
});

// === SEARCH ===
app.get('/search', async (c) => {
  const t = tid(c); if (!t) return json(c, { error: 'tenant required' }, 400);
  const q = c.req.query('q');
  if (!q || q.length < 2) return json(c, { error: 'Query too short' }, 400);
  const searchTerms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let sql = "SELECT a.id,a.title,a.slug,a.excerpt,a.category_id,a.view_count,a.published_at FROM articles a JOIN search_index si ON a.id=si.article_id WHERE a.tenant_id=? AND a.status='published'";
  const params: string[] = [t];
  for (const term of searchTerms.slice(0, 5)) {
    sql += ' AND si.searchable_text LIKE ?';
    params.push(`%${term}%`);
  }
  sql += ' ORDER BY a.view_count DESC LIMIT 20';
  const r = await c.env.DB.prepare(sql).bind(...params).all();
  return json(c, { results: r.results, query: q });
});

// === FEEDBACK (public) ===
app.post('/articles/:id/feedback', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const isHelpful = b.is_helpful ? 1 : 0;
  const id = uid();
  await c.env.DB.prepare('INSERT INTO feedback (id,article_id,tenant_id,is_helpful,comment,visitor_ip) VALUES (?,?,(SELECT tenant_id FROM articles WHERE id=?),?,?,?)').bind(id, c.req.param('id'), c.req.param('id'), isHelpful, b.comment || null, c.req.header('CF-Connecting-IP') || '').run();
  const field = isHelpful ? 'helpful_yes' : 'helpful_no';
  await c.env.DB.prepare(`UPDATE articles SET ${field}=${field}+1 WHERE id=?`).bind(c.req.param('id')).run();
  return json(c, { id }, 201);
});

// === ANALYTICS ===
app.get('/analytics/overview', async (c) => {
  const t = tid(c); if (!t) return json(c, { error: 'tenant required' }, 400);
  const [articles, published, categories, views, helpful] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as c FROM articles WHERE tenant_id=?').bind(t).first<any>(),
    c.env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE tenant_id=? AND status='published'").bind(t).first<any>(),
    c.env.DB.prepare('SELECT COUNT(*) as c FROM categories WHERE tenant_id=?').bind(t).first<any>(),
    c.env.DB.prepare('SELECT SUM(view_count) as total FROM articles WHERE tenant_id=?').bind(t).first<any>(),
    c.env.DB.prepare('SELECT SUM(helpful_yes) as yes, SUM(helpful_no) as no FROM articles WHERE tenant_id=?').bind(t).first<any>(),
  ]);
  const totalFeedback = (helpful?.yes || 0) + (helpful?.no || 0);
  return json(c, {
    total_articles: articles?.c || 0,
    published_articles: published?.c || 0,
    total_categories: categories?.c || 0,
    total_views: views?.total || 0,
    helpfulness_rate: totalFeedback > 0 ? Math.round((helpful?.yes || 0) / totalFeedback * 100) : 0,
  });
});
app.get('/analytics/popular', async (c) => {
  const t = tid(c); if (!t) return json(c, { error: 'tenant required' }, 400);
  const r = await c.env.DB.prepare("SELECT id,title,slug,view_count,helpful_yes,helpful_no FROM articles WHERE tenant_id=? AND status='published' ORDER BY view_count DESC LIMIT 10").bind(t).all();
  return json(c, { articles: r.results });
});

// === AI ENDPOINTS ===
app.post('/ai/generate-article', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  try {
    const resp = await c.env.ENGINE_RUNTIME.fetch('https://engine/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine_id: 'MKT-01', query: `Write a comprehensive knowledge base article about: "${b.topic}". Type: ${b.type || 'how-to guide'}. Audience: ${b.audience || 'end users'}. Include: clear title, introduction, step-by-step instructions or explanations, tips/best practices, and a summary. Use markdown formatting. Return as JSON with title, content (markdown), excerpt (2 sentences), tags (array).` }),
    });
    const data = await resp.json() as any;
    return json(c, { article: data.response || data });
  } catch { return json(c, { error: 'AI service unavailable' }, 503); }
});
app.post('/ai/improve-article', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  try {
    const resp = await c.env.ENGINE_RUNTIME.fetch('https://engine/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine_id: 'MKT-01', query: `Improve this knowledge base article for clarity, completeness, and SEO. Current content: "${(b.content || '').slice(0, 3000)}". Focus: ${b.focus || 'clarity and completeness'}. Return the improved content in markdown.` }),
    });
    const data = await resp.json() as any;
    return json(c, { improved: data.response || data });
  } catch { return json(c, { error: 'AI service unavailable' }, 503); }
});

// Scheduled cleanup
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await env.DB.prepare("DELETE FROM activity_log WHERE created_at < datetime('now','-90 days')").run();
  },
};
