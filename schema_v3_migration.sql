-- =====================================================
-- Migration فاز ۳ — پنل مدیریت، ویژگی‌های پولی، لایسنس
-- اجرا: wrangler d1 execute tax-advisor-db --file=schema_v3_migration.sql
-- =====================================================

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,              -- شناسه ویژگی، مثلا 'unlimited_folders'
  label TEXT NOT NULL,               -- نام قابل‌نمایش
  description TEXT,
  enabled_free INTEGER NOT NULL DEFAULT 1, -- آیا به‌صورت رایگان برای همه فعال است
  is_paid INTEGER NOT NULL DEFAULT 0,      -- آیا نسخه پولی دارد (نیاز به لایسنس)
  price_toman INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,               -- uuid / کد لایسنس
  user_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  device_id TEXT,                    -- فقط پس از اولین فعال‌سازی پر می‌شود
  status TEXT NOT NULL DEFAULT 'unused', -- unused | active | revoked | expired
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (feature_key) REFERENCES feature_flags(key)
);

CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id);
CREATE INDEX IF NOT EXISTS idx_licenses_feature ON licenses(feature_key);

-- چند ویژگی نمونه برای شروع (از پنل مدیریت قابل ویرایش/افزودن هستند)
INSERT OR IGNORE INTO feature_flags (key, label, description, enabled_free, is_paid, price_toman) VALUES
  ('unlimited_folders', 'پوشه‌های نامحدود', 'حذف محدودیت تعداد پوشه پایگاه دانش', 1, 0, 0),
  ('telegram_import', 'وارد کردن از تلگرام', 'افزودن کانال تلگرام به‌عنوان منبع', 1, 0, 0),
  ('priority_ai', 'پاسخ‌گویی سریع‌تر', 'استفاده از مدل هوش مصنوعی سریع‌تر/دقیق‌تر', 1, 0, 0);
