// =====================================================
// Cloudflare Worker — بک‌اند فاز ۱ + فاز ۲
// پلتفرم مشاور آنلاین مالیاتی و قوانین کار
// =====================================================
//
// Bindings مورد نیاز (در wrangler.toml تعریف شده‌اند):
//   DB        -> D1 database
//   KV        -> KV namespace (سشن‌ها)
//   VECTORIZE -> Vectorize index (فاز ۲ — جستجوی برداری RAG)
//   AI        -> Workers AI binding (فاز ۲ — embedding + OCR تصویر)
//   AI_KEY    -> secret: کلید API مدل هوش مصنوعی متنی (Gemini)
//
// همه‌ی مسیرها زیر /api هستند. فایل استاتیک فرانت‌اند
// جدا (روی Cloudflare Pages) سرو می‌شود.

import { getDocumentProxy, extractText as extractPdfTextRaw } from "unpdf";
import { unzipSync, strFromU8 } from "fflate";

const EMBEDDING_MODEL = "@cf/baai/bge-m3"; // چندزبانه، برای فارسی مناسب است
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

function uuid() {
  return crypto.randomUUID();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    },
  });
}

async function getSessionUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return null;
  const userId = await env.KV.get(`session:${token}`);
  if (!userId) return null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first();
  return user || null;
}

function requireAdmin(user) {
  return user && user.role === "admin";
}

// -----------------------------------------------------
// فاز ۳ — ویژگی‌های پولی و لایسنس
// -----------------------------------------------------
const FREE_FOLDER_LIMIT = 3; // وقتی ویژگی unlimited_folders پولی و غیرفعال باشد

async function hasFeatureAccess(env, userId, featureKey) {
  const flag = await env.DB.prepare("SELECT * FROM feature_flags WHERE key = ?")
    .bind(featureKey)
    .first();
  if (!flag) return true; // ویژگی تعریف‌نشده = محدودیتی اعمال نمی‌شود
  if (flag.enabled_free) return true;
  if (!flag.is_paid) return true;
  const license = await env.DB.prepare(
    `SELECT * FROM licenses WHERE user_id = ? AND feature_key = ? AND status = 'active'
     AND (expires_at IS NULL OR expires_at > datetime('now'))`
  )
    .bind(userId, featureKey)
    .first();
  return !!license;
}

// -----------------------------------------------------
// OTP: در فاز ۱ اگر سرویس پیامک متصل نباشد، کد در پاسخ
// dev برگردانده می‌شود تا تست ممکن باشد. برای پروداکشن
// SMS_API_URL و SMS_API_KEY را در wrangler.toml/secrets ست کنید.
// -----------------------------------------------------
async function sendOtp(phone, code, env) {
  if (!env.SMS_API_URL) {
    console.log(`[DEV OTP] ${phone} -> ${code}`);
    return { dev: true };
  }
  await fetch(env.SMS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, code, apiKey: env.SMS_API_KEY }),
  });
  return { dev: false };
}

async function handleRequestOtp(request, env) {
  const { phone, full_name } = await request.json();
  if (!phone || !/^09\d{9}$/.test(phone)) {
    return jsonResponse({ error: "شماره موبایل معتبر نیست" }, 400);
  }
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const id = uuid();
  const expires = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO otp_codes (id, phone, code, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, phone, code, expires)
    .run();

  let user = await env.DB.prepare("SELECT * FROM users WHERE phone = ?")
    .bind(phone)
    .first();
  if (!user && full_name) {
    const uid = uuid();
    const countRow = await env.DB.prepare("SELECT COUNT(*) c FROM users").first();
    const role = countRow.c === 0 ? "admin" : "user"; // اولین کاربر ثبت‌نامی، مدیر پلتفرم می‌شود
    await env.DB.prepare(
      "INSERT INTO users (id, full_name, phone, role) VALUES (?, ?, ?, ?)"
    )
      .bind(uid, full_name, phone, role)
      .run();
  }

  const result = await sendOtp(phone, code, env);
  return jsonResponse({ ok: true, dev_code: result.dev ? code : undefined });
}

async function handleVerifyOtp(request, env) {
  const { phone, code } = await request.json();
  const row = await env.DB.prepare(
    `SELECT * FROM otp_codes WHERE phone = ? AND code = ? AND consumed = 0
     AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1`
  )
    .bind(phone, code)
    .first();
  if (!row) return jsonResponse({ error: "کد نامعتبر یا منقضی‌شده است" }, 400);

  await env.DB.prepare("UPDATE otp_codes SET consumed = 1 WHERE id = ?")
    .bind(row.id)
    .run();

  const user = await env.DB.prepare("SELECT * FROM users WHERE phone = ?")
    .bind(phone)
    .first();
  if (!user) return jsonResponse({ error: "کاربر یافت نشد" }, 404);
  if (!user.is_active) return jsonResponse({ error: "حساب کاربری شما غیرفعال شده است" }, 403);

  const token = uuid();
  await env.KV.put(`session:${token}`, user.id, { expirationTtl: 60 * 60 * 24 * 30 });

  return jsonResponse({ token, user: { id: user.id, full_name: user.full_name, role: user.role } });
}

// -----------------------------------------------------
// پوشه‌های پایگاه دانش
// -----------------------------------------------------
async function handleListFolders(request, env, user) {
  const rows = await env.DB.prepare(
    "SELECT * FROM folders WHERE owner_id = ? OR is_shared = 1 ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all();
  return jsonResponse({ folders: rows.results });
}

async function handleCreateFolder(request, env, user) {
  const { name, description } = await request.json();
  if (!name) return jsonResponse({ error: "نام پوشه الزامی است" }, 400);

  const canUnlimited = await hasFeatureAccess(env, user.id, "unlimited_folders");
  if (!canUnlimited) {
    const count = await env.DB.prepare("SELECT COUNT(*) as c FROM folders WHERE owner_id = ?")
      .bind(user.id)
      .first();
    if (count.c >= FREE_FOLDER_LIMIT) {
      return jsonResponse(
        { error: `در نسخه رایگان حداکثر ${FREE_FOLDER_LIMIT} پوشه مجاز است. برای پوشه نامحدود لایسنس تهیه کنید.` },
        403
      );
    }
  }

  const id = uuid();
  await env.DB.prepare(
    "INSERT INTO folders (id, owner_id, name, description) VALUES (?, ?, ?, ?)"
  )
    .bind(id, user.id, name, description || null)
    .run();
  return jsonResponse({ id, name, description });
}

async function handleDeleteFolder(request, env, user, folderId) {
  const folder = await env.DB.prepare(
    "SELECT * FROM folders WHERE id = ? AND owner_id = ?"
  )
    .bind(folderId, user.id)
    .first();
  if (!folder) return jsonResponse({ error: "پوشه یافت نشد" }, 404);

  const docs = await env.DB.prepare("SELECT id, chunk_count FROM documents WHERE folder_id = ?")
    .bind(folderId)
    .all();
  for (const d of docs.results) {
    await deleteDocumentVectors(env, d.id, d.chunk_count);
  }
  await env.DB.prepare("DELETE FROM documents WHERE folder_id = ?").bind(folderId).run();
  await env.DB.prepare("DELETE FROM folders WHERE id = ?").bind(folderId).run();
  return jsonResponse({ ok: true });
}

// -----------------------------------------------------
// آپلود اسناد در یک پوشه — فاز ۲: استخراج واقعی متن
// پشتیبانی: pdf, docx, image (OCR با Workers AI)، text، link، تلگرام
// -----------------------------------------------------
async function extractPdfText(arrayBuffer) {
  const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));
  const { text } = await extractPdfTextRaw(pdf, { mergePages: true });
  return text;
}

async function extractDocxText(arrayBuffer) {
  const zip = unzipSync(new Uint8Array(arrayBuffer));
  const docXml = zip["word/document.xml"];
  if (!docXml) return "";
  const xml = strFromU8(docXml);
  const matches = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)];
  return matches.map((m) => m[1]).join(" ");
}

async function extractImageText(env, arrayBuffer) {
  try {
    const result = await env.AI.run(VISION_MODEL, {
      image: [...new Uint8Array(arrayBuffer)],
      prompt:
        "متن نوشته‌شده در این تصویر را کامل و دقیق استخراج کن. اگر متن فارسی است، همان‌طور بنویس. فقط متن استخراج‌شده را برگردان.",
      max_tokens: 1024,
    });
    return result.description || result.response || "";
  } catch (e) {
    return "";
  }
}

async function extractTelegramText(url) {
  const m = url.match(/t\.me\/([A-Za-z0-9_]+)/);
  const previewUrl = m ? `https://t.me/s/${m[1]}` : url;
  try {
    const res = await fetch(previewUrl);
    const html = await res.text();
    const matches = [
      ...html.matchAll(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/g),
    ];
    return matches
      .map((m) => m[1].replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, ""))
      .join("\n\n")
      .slice(0, 20000);
  } catch (e) {
    return "";
  }
}

async function extractTextFromFile(env, file, type) {
  if (type === "text") return await file.text();
  const buf = await file.arrayBuffer();
  if (type === "pdf") return await extractPdfText(buf);
  if (type === "docx") return await extractDocxText(buf);
  if (type === "image") return await extractImageText(env, buf);
  return "";
}

// -----------------------------------------------------
// RAG — chunking + embedding + Vectorize
// -----------------------------------------------------
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const clean = (text || "").trim();
  if (!clean) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + size, clean.length);
    chunks.push(clean.slice(start, end));
    if (end === clean.length) break;
    start += size - overlap;
  }
  return chunks;
}

async function embedTexts(env, texts) {
  if (texts.length === 0) return [];
  const result = await env.AI.run(EMBEDDING_MODEL, { text: texts });
  return result.data;
}

async function indexDocument(env, doc) {
  const chunks = chunkText(doc.extracted_text);
  if (chunks.length === 0) return 0;
  const vectors = await embedTexts(env, chunks);
  const points = chunks.map((chunk, i) => ({
    id: `${doc.id}-${i}`,
    values: vectors[i],
    metadata: {
      folder_id: doc.folder_id,
      document_id: doc.id,
      title: doc.title,
      chunk_text: chunk.slice(0, 1900),
    },
  }));
  await env.VECTORIZE.upsert(points);
  return chunks.length;
}

async function deleteDocumentVectors(env, docId, chunkCount) {
  if (!chunkCount) return;
  const ids = Array.from({ length: chunkCount }, (_, i) => `${docId}-${i}`);
  await env.VECTORIZE.deleteByIds(ids);
}

async function retrieveContext(env, folderId, query, topK = 6) {
  const [queryVector] = await embedTexts(env, [query]);
  if (!queryVector) return { context: "", sources: [] };
  const results = await env.VECTORIZE.query(queryVector, {
    topK,
    filter: { folder_id: folderId },
    returnMetadata: true,
  });
  const matches = results.matches || [];
  const context = matches
    .map((m) => `--- منبع: ${m.metadata.title} ---\n${m.metadata.chunk_text}`)
    .join("\n\n");
  const sources = [...new Set(matches.map((m) => m.metadata.title))];
  return { context, sources };
}

async function handleUploadDocument(request, env, user) {
  const formData = await request.formData();
  const folderId = formData.get("folder_id");
  const type = formData.get("type"); // pdf|docx|image|text|link
  const linkUrl = formData.get("url");
  const rawText = formData.get("text");

  const folder = await env.DB.prepare(
    "SELECT * FROM folders WHERE id = ? AND (owner_id = ? OR is_shared = 1)"
  )
    .bind(folderId, user.id)
    .first();
  if (!folder) return jsonResponse({ error: "پوشه یافت نشد" }, 404);

  const id = uuid();
  let title = formData.get("title") || "سند بدون عنوان";
  let r2Key = null;
  let extractedText = "";
  let status = "ready";

  if (type === "link" && linkUrl) {
    title = title === "سند بدون عنوان" ? linkUrl : title;
    const isTelegram = /t\.me\//.test(linkUrl);
    try {
      if (isTelegram) {
        extractedText = await extractTelegramText(linkUrl);
      } else {
        const res = await fetch(linkUrl);
        const html = await res.text();
        extractedText = html.replace(/<script[\s\S]*?<\/script>/g, "")
          .replace(/<style[\s\S]*?<\/style>/g, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, 20000);
      }
      if (!extractedText) status = "failed";
    } catch (e) {
      status = "failed";
      extractedText = "";
    }
  } else if (type === "text" && rawText) {
    extractedText = rawText;
  } else {
    const file = formData.get("file");
    if (!file) return jsonResponse({ error: "فایلی ارسال نشده" }, 400);
    title = title === "سند بدون عنوان" ? file.name : title;
    const buf = await file.arrayBuffer();
    // توجه: فایل خام ذخیره نمی‌شود (R2 برای این حساب در دسترس نیست)؛
    // فقط متن استخراج‌شده در D1 نگه‌داری می‌شود که برای پاسخ‌گویی AI کافی است.
    try {
      extractedText = await extractTextFromFile(env, new File([buf], file.name), type);
    } catch (e) {
      status = "failed";
    }
    if (!extractedText) status = status === "failed" ? status : "failed";
  }

  let chunkCount = 0;
  if (status !== "failed" && extractedText) {
    try {
      chunkCount = await indexDocument(env, { id, folder_id: folderId, title, extracted_text: extractedText });
    } catch (e) {
      status = "failed";
    }
  }

  await env.DB.prepare(
    `INSERT INTO documents (id, folder_id, type, title, source_url, r2_key, extracted_text, status, chunk_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, folderId, type, title, linkUrl || null, r2Key, extractedText, status, chunkCount)
    .run();

  return jsonResponse({ id, title, status, chunk_count: chunkCount });
}

// -----------------------------------------------------
// استخراج متن یک فایل پیوست‌شده در چت (بدون ذخیره در KB)
// -----------------------------------------------------
async function handleExtractAttachment(request, env) {
  const formData = await request.formData();
  const file = formData.get("file");
  const type = formData.get("type") || "text";
  if (!file) return jsonResponse({ error: "فایلی ارسال نشده" }, 400);
  try {
    const text = await extractTextFromFile(env, file, type);
    return jsonResponse({ text: text.slice(0, 12000) });
  } catch (e) {
    return jsonResponse({ error: "خطا در پردازش فایل" }, 500);
  }
}

async function handleListDocuments(request, env, user, folderId) {
  const rows = await env.DB.prepare(
    "SELECT id, type, title, status, created_at FROM documents WHERE folder_id = ? ORDER BY created_at DESC"
  )
    .bind(folderId)
    .all();
  return jsonResponse({ documents: rows.results });
}

async function handleDeleteDocument(request, env, user, docId) {
  const doc = await env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(docId).first();
  if (!doc) return jsonResponse({ error: "سند یافت نشد" }, 404);
  await deleteDocumentVectors(env, doc.id, doc.chunk_count);
  await env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(docId).run();
  return jsonResponse({ ok: true });
}

async function handleActivateLicense(request, env, user) {
  const { license_id, device_id } = await request.json();
  if (!device_id) return jsonResponse({ error: "شناسه دستگاه ارسال نشده" }, 400);
  const license = await env.DB.prepare("SELECT * FROM licenses WHERE id = ? AND user_id = ?")
    .bind(license_id, user.id)
    .first();
  if (!license) return jsonResponse({ error: "لایسنس یافت نشد" }, 404);
  if (license.status === "revoked") return jsonResponse({ error: "این لایسنس باطل شده است" }, 403);
  if (license.status === "active" && license.device_id && license.device_id !== device_id) {
    return jsonResponse({ error: "این لایسنس قبلاً روی دستگاه دیگری فعال شده است" }, 403);
  }
  await env.DB.prepare(
    "UPDATE licenses SET status = 'active', device_id = ?, activated_at = COALESCE(activated_at, datetime('now')) WHERE id = ?"
  )
    .bind(device_id, license.id)
    .run();
  return jsonResponse({ ok: true });
}

async function handleMyLicenses(request, env, user) {
  const rows = await env.DB.prepare("SELECT * FROM licenses WHERE user_id = ?").bind(user.id).all();
  return jsonResponse({ licenses: rows.results });
}

// -----------------------------------------------------
// فاز ۳ — پنل مدیریت (فقط ادمین)
// -----------------------------------------------------
async function handleAdminDashboard(env) {
  const [users, folders, documents, chats, messages, tokensTotal, tokensToday, activeLicenses] =
    await Promise.all([
      env.DB.prepare("SELECT COUNT(*) c FROM users").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM folders").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM documents").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM chats").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM messages").first(),
      env.DB.prepare("SELECT COALESCE(SUM(tokens),0) s FROM token_usage").first(),
      env.DB.prepare("SELECT COALESCE(SUM(tokens),0) s FROM token_usage WHERE created_at >= datetime('now','-1 day')").first(),
      env.DB.prepare("SELECT COUNT(*) c FROM licenses WHERE status = 'active'").first(),
    ]);
  return jsonResponse({
    users: users.c,
    folders: folders.c,
    documents: documents.c,
    chats: chats.c,
    messages: messages.c,
    tokens_total: tokensTotal.s,
    tokens_today: tokensToday.s,
    active_licenses: activeLicenses.c,
  });
}

async function handleAdminGetSettings(env) {
  const rows = await env.DB.prepare("SELECT * FROM settings").all();
  const obj = {};
  rows.results.forEach((r) => (obj[r.key] = r.value));
  return jsonResponse({ settings: obj });
}

async function handleAdminUpdateSettings(request, env) {
  const body = await request.json();
  for (const [key, value] of Object.entries(body)) {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
      .bind(key, String(value))
      .run();
  }
  return jsonResponse({ ok: true });
}

async function handleAdminListFeatures(env) {
  const rows = await env.DB.prepare("SELECT * FROM feature_flags").all();
  return jsonResponse({ features: rows.results });
}

async function handleAdminUpsertFeature(request, env) {
  const { key, label, description, enabled_free, is_paid, price_toman } = await request.json();
  if (!key || !label) return jsonResponse({ error: "کلید و عنوان ویژگی الزامی است" }, 400);
  await env.DB.prepare(
    `INSERT INTO feature_flags (key, label, description, enabled_free, is_paid, price_toman)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET label=excluded.label, description=excluded.description,
       enabled_free=excluded.enabled_free, is_paid=excluded.is_paid, price_toman=excluded.price_toman`
  )
    .bind(key, label, description || "", enabled_free ? 1 : 0, is_paid ? 1 : 0, price_toman || 0)
    .run();
  return jsonResponse({ ok: true });
}

async function handleAdminListUsers(env) {
  const rows = await env.DB.prepare(
    "SELECT id, full_name, phone, role, is_active, created_at FROM users ORDER BY created_at DESC"
  ).all();
  return jsonResponse({ users: rows.results });
}

async function handleAdminUpdateUser(request, env, userId) {
  const { role, is_active } = await request.json();
  if (role) await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, userId).run();
  if (typeof is_active !== "undefined") {
    await env.DB.prepare("UPDATE users SET is_active = ? WHERE id = ?").bind(is_active ? 1 : 0, userId).run();
  }
  return jsonResponse({ ok: true });
}

async function handleAdminListLicenses(env) {
  const rows = await env.DB.prepare(
    `SELECT l.*, u.full_name, u.phone FROM licenses l
     JOIN users u ON u.id = l.user_id ORDER BY l.issued_at DESC`
  ).all();
  return jsonResponse({ licenses: rows.results });
}

async function handleAdminIssueLicense(request, env) {
  const { user_id, feature_key, days } = await request.json();
  if (!user_id || !feature_key) return jsonResponse({ error: "کاربر و ویژگی الزامی است" }, 400);
  const id = uuid();
  const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
  await env.DB.prepare(
    "INSERT INTO licenses (id, user_id, feature_key, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, user_id, feature_key, expiresAt)
    .run();
  return jsonResponse({ id });
}

async function handleAdminRevokeLicense(env, licenseId) {
  await env.DB.prepare("UPDATE licenses SET status = 'revoked' WHERE id = ?").bind(licenseId).run();
  return jsonResponse({ ok: true });
}

async function handleAdminBackup(env) {
  const tables = ["users", "folders", "documents", "chats", "messages", "settings", "feature_flags", "licenses"];
  const dump = {};
  for (const t of tables) {
    const rows = await env.DB.prepare(`SELECT * FROM ${t}`).all();
    dump[t] = rows.results;
  }
  dump._exported_at = new Date().toISOString();
  dump._note = "این پشتیبان شامل فایل‌های خام R2 و بردارهای Vectorize نیست، فقط داده‌های ساختاریافته دیتابیس است.";
  return jsonResponse(dump);
}

async function handleAdminRestore(request, env) {
  const dump = await request.json();
  const tables = ["users", "folders", "documents", "chats", "messages", "settings", "feature_flags", "licenses"];
  for (const t of tables) {
    const rows = dump[t];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    for (const row of rows) {
      const cols = Object.keys(row);
      const placeholders = cols.map(() => "?").join(",");
      const updateSet = cols.map((c) => `${c}=excluded.${c}`).join(",");
      const pk = t === "settings" ? "key" : "id";
      await env.DB.prepare(
        `INSERT INTO ${t} (${cols.join(",")}) VALUES (${placeholders})
         ON CONFLICT(${pk}) DO UPDATE SET ${updateSet}`
      )
        .bind(...cols.map((c) => row[c]))
        .run();
    }
  }
  return jsonResponse({ ok: true });
}
// (RAG واقعی با embedding در فاز ۲)
// -----------------------------------------------------
const SYSTEM_PROMPT_BASE = `تو یک دستیار هوشمند مشاور مالیاتی و قوانین کار هستی.
قوانین سخت‌گیرانه:
۱. فقط و فقط بر اساس متن‌هایی که در بخش «منابع» زیر آمده پاسخ بده.
۲. اگر پاسخ سوال در منابع نبود، صریح بگو «این موضوع در منابع پایگاه دانش موجود نیست» — هرگز حدس نزن یا از دانش عمومی خودت استفاده نکن.
۳. در پایان هر پاسخ، به سند/منبعی که از آن استفاده کردی اشاره کن.
۴. پاسخ‌ها را به زبان فارسی روان و حرفه‌ای بنویس.`;

async function callAI(env, systemPrompt, userMessage) {
  const apiKey = env.AI_KEY;
  const model = "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
    }),
  });
  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") ||
    `[DEBUG] status=${res.status} apiKeySet=${!!apiKey} response=${JSON.stringify(data).slice(0, 500)}`;
  const tokens = data?.usageMetadata?.totalTokenCount || 0;
  return { text, tokens };
}

async function handleChat(request, env, user) {
  const { chat_id, folder_id, message, attached_text } = await request.json();

  let chatId = chat_id;
  if (!chatId) {
    chatId = uuid();
    await env.DB.prepare(
      "INSERT INTO chats (id, user_id, folder_id, title) VALUES (?, ?, ?, ?)"
    )
      .bind(chatId, user.id, folder_id || null, message.slice(0, 40))
      .run();
  }

  let context = "";
  let sources = [];
  if (folder_id) {
    const retrieved = await retrieveContext(env, folder_id, message);
    context = retrieved.context;
    sources = retrieved.sources;
  }

  if (attached_text) {
    context += `\n\n--- فایل پیوست‌شده در چت ---\n${attached_text.slice(0, 10000)}`;
  }

  const systemPrompt = context
    ? `${SYSTEM_PROMPT_BASE}\n\n### منابع (نتایج جستجوی مرتبط با سوال کاربر):\n${context}`
    : `تو یک دستیار عمومی مشاور مالیاتی و قوانین کار هستی. کاربر هیچ پوشه‌ای انتخاب نکرده یا منبع مرتبطی در پایگاه دانش پیدا نشد، پس به‌صورت عمومی و با احتیاط پاسخ بده و توصیه کن برای پاسخ دقیق‌تر یک پوشه مرتبط انتخاب کند.`;

  await env.DB.prepare(
    "INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'user', ?)"
  )
    .bind(uuid(), chatId, message)
    .run();

  const { text, tokens } = await callAI(env, systemPrompt, message);

  await env.DB.prepare(
    "INSERT INTO messages (id, chat_id, role, content, tokens_used) VALUES (?, ?, 'assistant', ?, ?)"
  )
    .bind(uuid(), chatId, text, tokens)
    .run();

  await env.DB.prepare(
    "INSERT INTO token_usage (id, user_id, chat_id, tokens) VALUES (?, ?, ?, ?)"
  )
    .bind(uuid(), user.id, chatId, tokens)
    .run();

  return jsonResponse({ chat_id: chatId, reply: text, tokens, sources });
}

async function handleListChats(request, env, user) {
  const rows = await env.DB.prepare(
    "SELECT id, title, folder_id, created_at FROM chats WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all();
  return jsonResponse({ chats: rows.results });
}

async function handleChatMessages(request, env, user, chatId) {
  const chat = await env.DB.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?")
    .bind(chatId, user.id)
    .first();
  if (!chat) return jsonResponse({ error: "چت یافت نشد" }, 404);
  const rows = await env.DB.prepare(
    "SELECT role, content, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC"
  )
    .bind(chatId)
    .all();
  return jsonResponse({ messages: rows.results });
}

// -----------------------------------------------------
// روتر اصلی
// -----------------------------------------------------
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return jsonResponse({});

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/auth/request-otp" && request.method === "POST") {
        return await handleRequestOtp(request, env);
      }
      if (path === "/api/auth/verify-otp" && request.method === "POST") {
        return await handleVerifyOtp(request, env);
      }

      // مسیرهای زیر نیاز به احراز هویت دارند
      const user = await getSessionUser(request, env);
      if (!user) return jsonResponse({ error: "لطفاً وارد شوید" }, 401);

      if (path === "/api/folders" && request.method === "GET") {
        return await handleListFolders(request, env, user);
      }
      if (path === "/api/folders" && request.method === "POST") {
        return await handleCreateFolder(request, env, user);
      }
      const folderDeleteMatch = path.match(/^\/api\/folders\/([^/]+)$/);
      if (folderDeleteMatch && request.method === "DELETE") {
        return await handleDeleteFolder(request, env, user, folderDeleteMatch[1]);
      }

      if (path === "/api/documents" && request.method === "POST") {
        return await handleUploadDocument(request, env, user);
      }
      if (path === "/api/extract" && request.method === "POST") {
        return await handleExtractAttachment(request, env);
      }
      const docsListMatch = path.match(/^\/api\/folders\/([^/]+)\/documents$/);
      if (docsListMatch && request.method === "GET") {
        return await handleListDocuments(request, env, user, docsListMatch[1]);
      }
      const docDeleteMatch = path.match(/^\/api\/documents\/([^/]+)$/);
      if (docDeleteMatch && request.method === "DELETE") {
        return await handleDeleteDocument(request, env, user, docDeleteMatch[1]);
      }

      if (path === "/api/chat" && request.method === "POST") {
        return await handleChat(request, env, user);
      }
      if (path === "/api/chats" && request.method === "GET") {
        return await handleListChats(request, env, user);
      }
      const chatMsgMatch = path.match(/^\/api\/chats\/([^/]+)\/messages$/);
      if (chatMsgMatch && request.method === "GET") {
        return await handleChatMessages(request, env, user, chatMsgMatch[1]);
      }

      if (path === "/api/licenses/activate" && request.method === "POST") {
        return await handleActivateLicense(request, env, user);
      }
      if (path === "/api/licenses/mine" && request.method === "GET") {
        return await handleMyLicenses(request, env, user);
      }

      // ---------------- مسیرهای مدیریت (فقط ادمین) ----------------
      if (path.startsWith("/api/admin/")) {
        if (!requireAdmin(user)) return jsonResponse({ error: "دسترسی غیرمجاز" }, 403);

        if (path === "/api/admin/dashboard" && request.method === "GET") {
          return await handleAdminDashboard(env);
        }
        if (path === "/api/admin/settings" && request.method === "GET") {
          return await handleAdminGetSettings(env);
        }
        if (path === "/api/admin/settings" && request.method === "POST") {
          return await handleAdminUpdateSettings(request, env);
        }
        if (path === "/api/admin/features" && request.method === "GET") {
          return await handleAdminListFeatures(env);
        }
        if (path === "/api/admin/features" && request.method === "POST") {
          return await handleAdminUpsertFeature(request, env);
        }
        if (path === "/api/admin/users" && request.method === "GET") {
          return await handleAdminListUsers(env);
        }
        const userUpdateMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
        if (userUpdateMatch && request.method === "POST") {
          return await handleAdminUpdateUser(request, env, userUpdateMatch[1]);
        }
        if (path === "/api/admin/licenses" && request.method === "GET") {
          return await handleAdminListLicenses(env);
        }
        if (path === "/api/admin/licenses" && request.method === "POST") {
          return await handleAdminIssueLicense(request, env);
        }
        const licenseRevokeMatch = path.match(/^\/api\/admin\/licenses\/([^/]+)\/revoke$/);
        if (licenseRevokeMatch && request.method === "POST") {
          return await handleAdminRevokeLicense(env, licenseRevokeMatch[1]);
        }
        if (path === "/api/admin/backup" && request.method === "GET") {
          return await handleAdminBackup(env);
        }
        if (path === "/api/admin/restore" && request.method === "POST") {
          return await handleAdminRestore(request, env);
        }
        return jsonResponse({ error: "مسیر مدیریت یافت نشد" }, 404);
      }

      return jsonResponse({ error: "مسیر یافت نشد" }, 404);
    } catch (err) {
      return jsonResponse({ error: "خطای سرور", detail: String(err) }, 500);
    }
  },
};
