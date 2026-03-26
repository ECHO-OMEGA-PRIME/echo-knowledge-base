-- Echo Knowledge Base v1.0.0 Schema
-- AI-powered documentation, wiki, and help center

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  plan TEXT DEFAULT 'free',
  max_articles INTEGER DEFAULT 100,
  custom_domain TEXT,
  branding_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  parent_id TEXT,
  order_num INTEGER DEFAULT 0,
  article_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_cat_tenant ON categories(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_slug ON categories(tenant_id, slug);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  category_id TEXT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  content TEXT,
  excerpt TEXT,
  status TEXT DEFAULT 'draft',
  visibility TEXT DEFAULT 'public',
  author_name TEXT,
  author_email TEXT,
  tags TEXT DEFAULT '[]',
  meta_title TEXT,
  meta_description TEXT,
  view_count INTEGER DEFAULT 0,
  helpful_yes INTEGER DEFAULT 0,
  helpful_no INTEGER DEFAULT 0,
  current_version INTEGER DEFAULT 1,
  featured INTEGER DEFAULT 0,
  order_num INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  published_at TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (category_id) REFERENCES categories(id)
);
CREATE INDEX IF NOT EXISTS idx_art_tenant ON articles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_art_cat ON articles(category_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_art_slug ON articles(tenant_id, slug);
CREATE INDEX IF NOT EXISTS idx_art_status ON articles(tenant_id, status);

CREATE TABLE IF NOT EXISTS article_versions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  version_num INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  change_summary TEXT,
  author_name TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_id) REFERENCES articles(id)
);
CREATE INDEX IF NOT EXISTS idx_ver_article ON article_versions(article_id);

CREATE TABLE IF NOT EXISTS search_index (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  searchable_text TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_id) REFERENCES articles(id)
);
CREATE INDEX IF NOT EXISTS idx_search_tenant ON search_index(tenant_id);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  is_helpful INTEGER NOT NULL,
  comment TEXT,
  visitor_ip TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_id) REFERENCES articles(id)
);
CREATE INDEX IF NOT EXISTS idx_fb_article ON feedback(article_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id);
