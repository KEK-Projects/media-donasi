-- 1. Profil & status moderasi pengguna Telegram
CREATE TABLE IF NOT EXISTS public.bot_users (
  telegram_user_id BIGINT PRIMARY KEY,
  telegram_username TEXT,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  ban_reason TEXT,
  banned_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Data utama donasi media (source of truth)
CREATE TABLE IF NOT EXISTS public.media_donations (
  id BIGSERIAL PRIMARY KEY,
  donation_code TEXT NOT NULL UNIQUE,
  donor_user_id BIGINT NOT NULL REFERENCES public.bot_users(telegram_user_id),
  donor_username TEXT,
  media_type TEXT NOT NULL CHECK (media_type IN ('photo', 'video', 'document')),
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT NOT NULL,
  file_name TEXT,
  caption TEXT,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Rating / penilaian per user untuk setiap donasi (1 akun = 1 skor aktif per donasi)
CREATE TABLE IF NOT EXISTS public.donation_ratings (
  id BIGSERIAL PRIMARY KEY,
  donation_code TEXT NOT NULL REFERENCES public.media_donations(donation_code) ON DELETE CASCADE,
  voter_user_id BIGINT NOT NULL REFERENCES public.bot_users(telegram_user_id),
  score SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (donation_code, voter_user_id)
);

-- 4. Log audit donasi & moderasi
CREATE TABLE IF NOT EXISTS public.donation_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  donation_code TEXT,
  target_user_id BIGINT,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index untuk pencarian cepat dan query berulang
CREATE INDEX IF NOT EXISTS idx_media_donations_code_status
  ON public.media_donations (donation_code, status);

CREATE INDEX IF NOT EXISTS idx_media_donations_file_unique
  ON public.media_donations (telegram_file_unique_id);

CREATE INDEX IF NOT EXISTS idx_media_donations_donor_created
  ON public.media_donations (donor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_donation_ratings_code
  ON public.donation_ratings (donation_code);

CREATE INDEX IF NOT EXISTS idx_donation_audit_logs_code_created
  ON public.donation_audit_logs (donation_code, created_at DESC);

-- Aktifkan RLS (akses bot server menggunakan SUPABASE_SERVICE_ROLE_KEY)
ALTER TABLE public.bot_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_donations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.donation_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.donation_audit_logs ENABLE ROW LEVEL SECURITY;
