-- =====================================================
-- Schema فاز ۱ — پلتفرم مشاور آنلاین مالیاتی و قوانین کار
-- =====================================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,               -- uuid
  full_name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', -- user | admin
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,               -- uuid
  owner_id TEXT NOT NULL,            -- users.id ('system' for shared/global folders)
  name TEXT NOT NULL,
  description TEXT,
  is_shared INTEGER NOT NULL DEFAULT 0, -- visible to all users (e.g. official KB)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,               -- uuid
  folder_id TEXT NOT NULL,
  type TEXT NOT NULL,                -- pdf | docx | image | text | link
  title TEXT NOT NULL,
  source_url TEXT,                   -- for type=link
  r2_key TEXT,                       -- storage key in R2 (for uploaded files)
  extracted_text TEXT,               -- raw extracted text content
  status TEXT NOT NULL DEFAULT 'processing', -- processing | ready | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (folder_id) REFERENCES folders(id)
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,               -- uuid
  user_id TEXT NOT NULL,
  folder_id TEXT,                    -- selected knowledge folder (nullable = general chat)
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,               -- uuid
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,                -- user | assistant
  content TEXT NOT NULL,
  attached_file_r2_key TEXT,         -- optional file attached to this message
  tokens_used INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);

CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- تنظیمات پیش‌فرض
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_name', 'مشاور مالیاتی هوشمند'),
  ('ai_provider', 'gemini'),
  ('ai_model', 'gemini-1.5-flash'),
  ('max_tokens_per_user_daily', '50000');

CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders(owner_id);
