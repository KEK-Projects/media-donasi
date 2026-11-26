import crypto from "crypto";
import { Telegraf, Markup } from "telegraf";
import { Redis } from "@upstash/redis";
import { createClient } from "@supabase/supabase-js";

const {
  WEBHOOK_SECRET,
  BOT_TOKEN,
  BOT_USERNAME,
  PRIVATE_CHANNEL_ID,
  PRIVATE_CHANNEL_INVITE_URL,
  ADMIN_GROUP_ID,
  ADMIN_GROUP_INVITE_URL,
  COPYRIGHT_PHOTO,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  DAILY_DONATION_LIMIT = "5",
  DONATION_COOLDOWN_SECONDS = "30",
} = process.env;

if (
  !BOT_TOKEN ||
  !BOT_USERNAME ||
  !PRIVATE_CHANNEL_ID ||
  !ADMIN_GROUP_ID ||
  !UPSTASH_REDIS_REST_URL ||
  !UPSTASH_REDIS_REST_TOKEN ||
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY
) {
  throw new Error(
    "Environment variables belum lengkap. Pastikan BOT_TOKEN, BOT_USERNAME, PRIVATE_CHANNEL_ID, ADMIN_GROUP_ID, UPSTASH_REDIS_*, dan SUPABASE_* sudah diisi."
  );
}

const dailyLimit = Math.max(1, Number.parseInt(DAILY_DONATION_LIMIT, 10) || 5);
const cooldownSeconds = Math.max(0, Number.parseInt(DONATION_COOLDOWN_SECONDS, 10) || 30);

const bot = new Telegraf(BOT_TOKEN);
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Warm cache di memori instance serverless (TTL singkat agar latensi ekstra rendah)
const membershipCache = new Map(); // userId -> { allJoined, expiresAt }
const donationMetaCache = new Map(); // code -> { data, expiresAt }
const ratingSummaryCache = new Map(); // code -> { counts, expiresAt }

const MEMBERSHIP_TTL_MS = 30 * 1000;
const DONATION_META_TTL_MS = 60 * 1000;
const RATING_SUMMARY_TTL_MS = 15 * 1000;

const SUPPORTED_MEDIA_TYPES = new Set(["photo", "video", "document"]);

function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateDonationCode() {
  return `d_${crypto.randomBytes(4).toString("hex")}`;
}

function getJakartaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value || "1970";
  const month = parts.find((p) => p.type === "month")?.value || "01";
  const day = parts.find((p) => p.type === "day")?.value || "01";
  return `${year}-${month}-${day}`;
}

function getQuotaKey(userId) {
  return `donate_quota:${userId}:${getJakartaDateKey()}`;
}

function getCooldownKey(userId) {
  return `donate_cooldown:${userId}`;
}

function parseJsonSafe(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeMediaType(rawType) {
  if (typeof rawType !== "string") return null;
  const cleaned = rawType.trim().toLowerCase();

  if (cleaned === "foto" || cleaned === "image") return "photo";
  if (cleaned === "vid" || cleaned === "animation") return "video";
  if (cleaned === "doc" || cleaned === "file") return "document";

  return SUPPORTED_MEDIA_TYPES.has(cleaned) ? cleaned : null;
}

function normalizeDonationPayload(raw) {
  if (!raw || typeof raw !== "object") return null;

  const donationCode = String(raw.donation_code || raw.code || "").trim();
  const rawMediaType = raw.media_type ?? raw.mediaType ?? raw.type ?? null;
  const mediaType = normalizeMediaType(rawMediaType);
  const fileId = String(
    raw.telegram_file_id || raw.fileId || raw.file_id || ""
  ).trim();

  if (!donationCode || !fileId) {
    return null;
  }

  return {
    donation_code: donationCode,
    donor_user_id: raw.donor_user_id ?? raw.donorId ?? null,
    media_type: mediaType,
    raw_media_type: rawMediaType,
    telegram_file_id: fileId,
    caption: typeof raw.caption === "string" ? raw.caption : "",
    status: String(raw.status || "published").trim().toLowerCase(),
  };
}

function buildEmptyCounts() {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

function buildRatingKeyboard(code, counts = buildEmptyCounts()) {
  return Markup.inlineKeyboard([
    [1, 2, 3, 4, 5].map((num) =>
      Markup.button.callback(`${num}★ (${counts[num] || 0})`, `rate:${code}:${num}`)
    ),
  ]);
}

async function ensureBotUser(user) {
  if (!user?.id) return;
  const { error } = await supabase.from("bot_users").upsert(
    {
      telegram_user_id: user.id,
      telegram_username: user.username || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "telegram_user_id", ignoreDuplicates: false }
  );

  if (error) {
    console.error("[Upsert bot_users Error]:", error.message);
  }
}

async function isUserBanned(userId) {
  const cacheKey = `ban_status:${userId}`;
  const cached = parseJsonSafe(await redis.get(cacheKey));
  if (cached && typeof cached.banned === "boolean") {
    return cached.banned;
  }

  const { data, error } = await supabase
    .from("bot_users")
    .select("is_banned, banned_until")
    .eq("telegram_user_id", userId)
    .maybeSingle();

  if (error || !data) return false;

  const activeBan =
    Boolean(data.is_banned) &&
    (!data.banned_until || new Date(data.banned_until).getTime() > Date.now());

  await redis.set(cacheKey, JSON.stringify({ banned: activeBan }), { ex: 30 });
  return activeBan;
}

// Cache-aside: memori instance -> Upstash Redis -> Supabase PostgreSQL
async function getDonationRecord(code) {
  const cleanCode = String(code || "").trim();
  if (!cleanCode) return null;

  const now = Date.now();
  const mem = donationMetaCache.get(cleanCode);
  if (mem && mem.expiresAt > now) {
    if (mem.data && mem.data.status === "published" && mem.data.media_type && mem.data.telegram_file_id) {
      return mem.data;
    }
    donationMetaCache.delete(cleanCode);
  }

  const redisKey = `donation_meta:${cleanCode}`;
  const rawRedis = await redis.get(redisKey);
  const redisCached = normalizeDonationPayload(parseJsonSafe(rawRedis));
  if (redisCached && redisCached.status === "published" && redisCached.media_type && redisCached.telegram_file_id) {
    donationMetaCache.set(cleanCode, { data: redisCached, expiresAt: now + DONATION_META_TTL_MS });
    return redisCached;
  }

  if (rawRedis) {
    await redis.del(redisKey);
  }

  const { data, error } = await supabase
    .from("media_donations")
    .select("donation_code, donor_user_id, media_type, telegram_file_id, caption, status")
    .eq("donation_code", cleanCode)
    .eq("status", "published")
    .maybeSingle();

  const normalized = normalizeDonationPayload(data);
  if (error || !normalized || !normalized.media_type || !normalized.telegram_file_id) {
    console.warn("[Donation Record Invalid/Not Found]:", {
      code: cleanCode,
      dbError: error?.message || null,
      rawMediaType: data?.media_type ?? null,
    });
    return null;
  }

  await redis.set(redisKey, JSON.stringify(normalized), { ex: 300 });
  donationMetaCache.set(cleanCode, { data: normalized, expiresAt: now + DONATION_META_TTL_MS });
  return normalized;
}

async function getRatingCounts(code) {
  const now = Date.now();
  const mem = ratingSummaryCache.get(code);
  if (mem && mem.expiresAt > now) {
    return mem.counts;
  }

  const redisKey = `donation_counts:${code}`;
  const redisCached = parseJsonSafe(await redis.get(redisKey));
  if (redisCached && typeof redisCached === "object") {
    ratingSummaryCache.set(code, { counts: redisCached, expiresAt: now + RATING_SUMMARY_TTL_MS });
    return redisCached;
  }

  const { data, error } = await supabase
    .from("donation_ratings")
    .select("score")
    .eq("donation_code", code);

  const counts = buildEmptyCounts();
  if (!error && Array.isArray(data)) {
    for (const row of data) {
      const s = Number(row.score);
      if (s >= 1 && s <= 5) counts[s] += 1;
    }
  }

  await redis.set(redisKey, JSON.stringify(counts), { ex: 60 });
  ratingSummaryCache.set(code, { counts, expiresAt: now + RATING_SUMMARY_TTL_MS });
  return counts;
}

async function getRemainingQuota(userId) {
  const usedRaw = await redis.get(getQuotaKey(userId));
  const used = Math.max(0, Number(usedRaw) || 0);
  return {
    used,
    limit: dailyLimit,
    remaining: Math.max(0, dailyLimit - used),
  };
}

async function checkRequiredMembership(ctx, userId) {
  const now = Date.now();
  const mem = membershipCache.get(String(userId));
  if (mem && mem.expiresAt > now) {
    return mem.allJoined;
  }

  const allowedStatuses = new Set(["creator", "administrator", "member"]);

  const [channelRes, groupRes] = await Promise.allSettled([
    ctx.telegram.getChatMember(PRIVATE_CHANNEL_ID, userId),
    ctx.telegram.getChatMember(ADMIN_GROUP_ID, userId),
  ]);

  const joinedChannel =
    channelRes.status === "fulfilled" && allowedStatuses.has(channelRes.value.status);
  const joinedGroup =
    groupRes.status === "fulfilled" && allowedStatuses.has(groupRes.value.status);

  if (channelRes.status === "rejected") {
    console.error("[Membership Channel Error]:", channelRes.reason?.message || channelRes.reason);
  }
  if (groupRes.status === "rejected") {
    console.error("[Membership Group Error]:", groupRes.reason?.message || groupRes.reason);
  }

  const allJoined = joinedChannel && joinedGroup;
  membershipCache.set(String(userId), {
    allJoined,
    expiresAt: now + (allJoined ? MEMBERSHIP_TTL_MS : 10 * 1000),
  });

  return allJoined;
}

async function sendJoinRequirement(ctx, code = null) {
  const deepLink = code
    ? `https://t.me/${BOT_USERNAME}?start=${code}`
    : `https://t.me/${BOT_USERNAME}`;

  const buttons = [];
  if (PRIVATE_CHANNEL_INVITE_URL) {
    buttons.push([Markup.button.url("Gabung Channel Private", PRIVATE_CHANNEL_INVITE_URL)]);
  }
  if (ADMIN_GROUP_INVITE_URL) {
    buttons.push([Markup.button.url("Gabung Grup Chat Admin", ADMIN_GROUP_INVITE_URL)]);
  }
  if (code) {
    buttons.push([Markup.button.url("Sudah Join? Buka Media Lagi", deepLink)]);
  }

  await ctx.reply(
    [
      "<b>Akses Terkunci</b>",
      "",
      "Untuk melihat hasil donasi media, kamu wajib bergabung terlebih dahulu ke:",
      "1. <b>Channel Private</b>",
      "2. <b>Grup Chat Admin</b>",
      "",
      "Setelah bergabung, tekan tombol di bawah untuk membuka kembali media.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...(buttons.length > 0 ? Markup.inlineKeyboard(buttons) : {}),
    }
  );
}

function extractMediaPayload(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const bestPhoto = msg.photo[msg.photo.length - 1];
    return {
      mediaType: "photo",
      fileId: bestPhoto.file_id,
      fileUniqueId: bestPhoto.file_unique_id,
    };
  }

  if (msg.video) {
    return {
      mediaType: "video",
      fileId: msg.video.file_id,
      fileUniqueId: msg.video.file_unique_id,
    };
  }

  if (msg.document) {
    return {
      mediaType: "document",
      fileId: msg.document.file_id,
      fileUniqueId: msg.document.file_unique_id,
      fileName: msg.document.file_name || "dokumen",
    };
  }

  return null;
}

async function deliverDonationMedia(ctx, code, data, counts) {
  const normalized = normalizeDonationPayload(data);

  if (!normalized || !normalized.telegram_file_id) {
    console.error("[Deliver Media Error] Payload kosong/tidak valid:", { code, data });
    return ctx.reply("Data media tidak ditemukan atau file sudah tidak tersedia.");
  }

  if (!normalized.media_type) {
    console.error("[Deliver Media Error] Tipe media tidak dikenali:", {
      code,
      rawMediaType: normalized.raw_media_type,
    });
    return ctx.reply(
      `Tipe media tidak dikenali (${escapeHtml(String(normalized.raw_media_type || "kosong"))}).`
    );
  }

  const lines = [
    "<b>Hasil Donasi Media</b>",
    `Kode: <code>${escapeHtml(code)}</code>`,
  ];

  if (normalized.caption) {
    lines.push(`Judul / Caption: ${escapeHtml(normalized.caption)}`);
  }

  const extra = {
    caption: lines.join("\n"),
    parse_mode: "HTML",
    protect_content: true,
    ...buildRatingKeyboard(code, counts),
  };

  if (normalized.media_type === "photo") {
    await ctx.replyWithPhoto(normalized.telegram_file_id, extra);
  } else if (normalized.media_type === "video") {
    await ctx.replyWithVideo(normalized.telegram_file_id, extra);
  } else if (normalized.media_type === "document") {
    await ctx.replyWithDocument(normalized.telegram_file_id, extra);
  }
}

bot.start(async (ctx) => {
  if (ctx.chat?.type !== "private") return;

  const userId = ctx.from.id;
  await ensureBotUser(ctx.from);

  if (await isUserBanned(userId)) {
    return ctx.reply("Akun kamu dibatasi untuk menggunakan bot ini.");
  }

  const payload = ctx.startPayload?.trim();

  if (payload && /^d_[a-f0-9]{8}$/.test(payload)) {
    const code = payload;
    const [donation, allJoined] = await Promise.all([
      getDonationRecord(code),
      checkRequiredMembership(ctx, userId),
    ]);

    if (!donation) {
      return ctx.reply("Kode donasi tidak ditemukan atau sudah kedaluwarsa.");
    }

    if (!allJoined) {
      return sendJoinRequirement(ctx, code);
    }

    const counts = await getRatingCounts(code);
    return deliverDonationMedia(ctx, code, donation, counts);
  }

  const quota = await getRemainingQuota(userId);

  await ctx.reply(
    [
      "<b>Selamat Datang di Bot Donasi &amp; Rate Media</b>",
      "",
      "Kirimkan <b>foto</b>, <b>video</b>, atau <b>dokumen</b> beserta judul/caption opsional.",
      "Setiap donasi akan dikirim ke <b>Channel Private</b> dengan foto copyright admin dan tombol akses ke bot.",
      `Sisa kuota donasi hari ini: <b>${quota.remaining}/${quota.limit}</b>`,
      "",
      "Tekan tombol <b>Donasi</b> di bawah untuk memulai.",
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.callback("Donasi", "start_donate")]]),
    }
  );
});

bot.action("start_donate", async (ctx) => {
  const userId = ctx.from.id;
  if (await isUserBanned(userId)) {
    return ctx.answerCbQuery("Akses ditolak.", { show_alert: true });
  }

  const quota = await getRemainingQuota(userId);
  if (quota.remaining <= 0) {
    await ctx.answerCbQuery("Kuota donasi harian habis", { show_alert: true });
    return ctx.reply(
      `Kuota donasi harian kamu sudah mencapai batas (<b>${quota.limit}/${quota.limit}</b>). Silakan coba lagi besok.`,
      { parse_mode: "HTML" }
    );
  }

  await redis.set(`donate_state:${userId}`, "awaiting_media", { ex: 900 });
  await ctx.answerCbQuery("Mode donasi aktif");

  const lines = [
    "<b>Mode Donasi Aktif</b>",
    "",
    "Silakan kirimkan <b>foto</b>, <b>video</b>, atau <b>dokumen</b> sekarang.",
    "Kamu juga bisa menyertakan judul atau caption di kolom caption media (opsional).",
    `Sisa kuota hari ini: <b>${quota.remaining}/${quota.limit}</b>`,
  ];

  if (cooldownSeconds > 0) {
    lines.push(`Jeda antar donasi: <b>${cooldownSeconds} detik</b>`);
  }

  lines.push("", "Ketik /cancel untuk membatalkan.");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

bot.command("cancel", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  await redis.del(`donate_state:${ctx.from.id}`);
  await ctx.reply("Proses donasi dibatalkan.");
});

bot.action(/^rate:(d_[a-f0-9]{8}):([1-5])$/, async (ctx) => {
  const code = ctx.match[1];
  const score = Number(ctx.match[2]);
  const voterId = ctx.from.id;

  if (await isUserBanned(voterId)) {
    return ctx.answerCbQuery("Akses ditolak.", { show_alert: true });
  }

  const donation = await getDonationRecord(code);
  if (!donation) {
    return ctx.answerCbQuery("Data donasi tidak ditemukan.", { show_alert: true });
  }

  await ensureBotUser(ctx.from);

  const { error } = await supabase.from("donation_ratings").upsert(
    {
      donation_code: code,
      voter_user_id: voterId,
      score,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "donation_code,voter_user_id" }
  );

  if (error) {
    console.error("[Rating Upsert Error]:", error.message);
    return ctx.answerCbQuery("Gagal menyimpan rating.", { show_alert: true });
  }

  // Refresh cache ringkasan rating di memori & Redis
  ratingSummaryCache.delete(code);
  await redis.del(`donation_counts:${code}`);
  const counts = await getRatingCounts(code);

  try {
    await ctx.editMessageReplyMarkup(buildRatingKeyboard(code, counts).reply_markup);
  } catch {
    // Abaikan jika markup tidak berubah
  }

  await ctx.answerCbQuery(`Rating ${score} bintang tersimpan untuk ${code}`);
});

bot.on(["photo", "video", "document"], async (ctx) => {
  if (ctx.chat?.type !== "private") return;

  const userId = ctx.from.id;
  if (await isUserBanned(userId)) {
    return ctx.reply("Akun kamu dibatasi untuk menggunakan bot ini.");
  }

  const state = await redis.get(`donate_state:${userId}`);
  if (state !== "awaiting_media") {
    return ctx.reply(
      "Untuk mengirim donasi media, tekan tombol <b>Donasi</b> lewat /start terlebih dahulu.",
      { parse_mode: "HTML" }
    );
  }

  const media = extractMediaPayload(ctx.message);
  if (!media) {
    return ctx.reply("Format media tidak didukung. Kirim foto, video, atau dokumen.");
  }

  if (!COPYRIGHT_PHOTO) {
    console.error("[Config Error]: COPYRIGHT_PHOTO belum diatur.");
    return ctx.reply("Konfigurasi copyright admin belum tersedia. Silakan hubungi admin.");
  }

  if (cooldownSeconds > 0) {
    const ttl = await redis.ttl(getCooldownKey(userId));
    if (ttl > 0) {
      return ctx.reply(
        `Terlalu cepat. Tunggu <b>${ttl} detik</b> sebelum mengirim donasi berikutnya.`,
        { parse_mode: "HTML" }
      );
    }
  }

  const quotaKey = getQuotaKey(userId);
  const newCount = await redis.incr(quotaKey);
  if (newCount === 1) {
    await redis.expire(quotaKey, 129600);
  }

  if (newCount > dailyLimit) {
    await redis.set(quotaKey, dailyLimit, { keepttl: true });
    await redis.del(`donate_state:${userId}`);
    return ctx.reply(
      `Kuota donasi harian kamu sudah habis (<b>${dailyLimit}/${dailyLimit}</b>). Silakan coba lagi besok.`,
      { parse_mode: "HTML" }
    );
  }

  await redis.del(`donate_state:${userId}`);
  if (cooldownSeconds > 0) {
    await redis.set(getCooldownKey(userId), "1", { ex: cooldownSeconds });
  }

  await ensureBotUser(ctx.from);

  const caption = (ctx.message.caption || "").trim().slice(0, 800);
  const code = generateDonationCode();
  const deepLink = `https://t.me/${BOT_USERNAME}?start=${code}`;

  const { data: inserted, error: insertError } = await supabase
    .from("media_donations")
    .insert({
      donation_code: code,
      donor_user_id: userId,
      donor_username: ctx.from.username || null,
      media_type: media.mediaType,
      telegram_file_id: media.fileId,
      telegram_file_unique_id: media.fileUniqueId,
      file_name: media.fileName || null,
      caption,
      status: "published",
    })
    .select("donation_code, donor_user_id, media_type, telegram_file_id, caption, status")
    .single();

  if (insertError || !inserted) {
    await redis.decr(quotaKey);
    if (cooldownSeconds > 0) await redis.del(getCooldownKey(userId));
    console.error("[Supabase Insert Donation Error]:", insertError?.message || insertError);
    return ctx.reply("Gagal menyimpan data donasi. Kuota kamu tidak terpakai, silakan coba lagi.");
  }

  const channelLines = [
    "<b>Copyright Media Donasi</b>",
    `Kode Akses: <code>${escapeHtml(code)}</code>`,
    `Tipe: ${escapeHtml(media.mediaType.toUpperCase())}`,
  ];
  if (caption) {
    channelLines.push(`Caption: ${escapeHtml(caption)}`);
  }

  try {
    await ctx.telegram.sendPhoto(PRIVATE_CHANNEL_ID, COPYRIGHT_PHOTO, {
      caption: channelLines.join("\n"),
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([[Markup.button.url("Lihat Media di Bot", deepLink)]]),
    });
  } catch (err) {
    await supabase
      .from("media_donations")
      .update({ status: "removed", updated_at: new Date().toISOString() })
      .eq("donation_code", code);
    await redis.decr(quotaKey);
    if (cooldownSeconds > 0) await redis.del(getCooldownKey(userId));
    console.error("[Send Copyright Channel Error]:", err?.message || err);
    return ctx.reply("Gagal mengirim postingan ke Channel Private. Kuota kamu tidak terpakai, silakan coba lagi.");
  }

  const normalizedInserted = normalizeDonationPayload(inserted) || inserted;
  await redis.set(`donation_meta:${code}`, JSON.stringify(normalizedInserted), { ex: 300 });
  donationMetaCache.set(code, {
    data: normalizedInserted,
    expiresAt: Date.now() + DONATION_META_TTL_MS,
  });

  await supabase.from("donation_audit_logs").insert({
    donation_code: code,
    target_user_id: userId,
    action: "created",
    details: { media_type: media.mediaType },
  });

  const remainingAfter = Math.max(0, dailyLimit - newCount);
  const userButtons = [];
  if (PRIVATE_CHANNEL_INVITE_URL) {
    userButtons.push([Markup.button.url("Buka Channel Private", PRIVATE_CHANNEL_INVITE_URL)]);
  }

  await ctx.reply(
    [
      "<b>Donasi sudah dibagikan</b>",
      "",
      `Media tersimpan dengan kode <code>${escapeHtml(code)}</code> dan sudah diteruskan ke <b>Channel Private</b>.`,
      `Sisa kuota hari ini: <b>${remainingAfter}/${dailyLimit}</b>`,
    ].join("\n"),
    {
      parse_mode: "HTML",
      ...(userButtons.length > 0 ? Markup.inlineKeyboard(userButtons) : {}),
    }
  );
});

bot.on("text", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  if (ctx.message.text.startsWith("/")) return;

  const state = await redis.get(`donate_state:${ctx.from.id}`);
  if (state === "awaiting_media") {
    await ctx.reply(
      "Silakan kirim <b>foto</b>, <b>video</b>, atau <b>dokumen</b> (bukan hanya teks). Tulis judul/caption pada kolom caption media jika perlu.",
      { parse_mode: "HTML" }
    );
  }
});

bot.catch((err, ctx) => {
  console.error(`[Telegraf Error] update_id=${ctx.update?.update_id}:`, err?.message || err);
});

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      runtime: "vercel-serverless",
      storage: "supabase+upstash-redis",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  if (WEBHOOK_SECRET) {
    const incomingSecret = req.headers["x-telegram-bot-api-secret-token"];
    if (incomingSecret !== WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
    }
  }

  try {
    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!update || typeof update !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid update payload" });
    }

    await bot.handleUpdate(update);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[Webhook Handler Error]:", err?.message || err);
    return res.status(200).json({ ok: false, error: "Handled internally" });
  }
}
