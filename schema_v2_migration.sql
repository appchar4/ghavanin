-- =====================================================
-- Migration فاز ۲ — افزودن ستون chunk_count
-- برای امکان حذف بردارهای Vectorize مرتبط با هر سند
-- =====================================================
-- اجرا: wrangler d1 execute tax-advisor-db --file=schema_v2_migration.sql

ALTER TABLE documents ADD COLUMN chunk_count INTEGER DEFAULT 0;
