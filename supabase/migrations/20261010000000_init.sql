-- Synedge 初期スキーマ
-- 方針（仕様7章）:
--   - メール本文・件名・アドレス帳は保存しない。Gmail を正本とする
--   - トークンはアプリ側で AES-256-GCM 暗号化した文字列のみ保存（鍵はDBに置かない）
--   - 全テーブルで RLS を有効にし、anon / authenticated ロールには一切のポリシーを与えない
--     → Supabase の公開API（PostgREST）経由では読めない。サーバーのみ DATABASE_URL で接続する
--   - 全オブジェクトを synedge スキーマに置き、同じDBの他アプリ（public スキーマ）と名前が衝突しないようにする

create extension if not exists pgcrypto;

-- 他アプリ（navy）と同じ Supabase プロジェクトに同居するため、専用スキーマに置く。
-- synedge スキーマは PostgREST の公開対象（Exposed schemas）に入れない
create schema if not exists synedge;

create table if not exists synedge.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  session_version integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists synedge.mail_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references synedge.users(id) on delete cascade,
  provider text not null check (provider in ('gmail')),
  email text not null check (email = lower(email)),
  refresh_token_enc text not null,
  access_token_enc text,
  access_token_expires_at timestamptz,
  scopes text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'reauth_required')),
  status_reason text,
  history_id text check (history_id ~ '^[0-9]+$'),
  last_synced_at timestamptz,
  watch_expires_at timestamptz,
  watch_renewed_at timestamptz,
  watch_last_error text,
  sync_lease_owner text,
  sync_lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, email)
);
create index if not exists mail_accounts_user_idx on synedge.mail_accounts(user_id);

create table if not exists synedge.user_settings (
  user_id uuid primary key references synedge.users(id) on delete cascade,
  notifications_enabled boolean not null default true,
  -- 既定はプレビュー非表示（ロック画面に件名・送信者を出さない安全側）
  notification_preview boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists synedge.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references synedge.users(id) on delete cascade,
  fcm_token text not null unique,
  platform text not null check (platform in ('android', 'web')),
  disabled_at timestamptz,
  disabled_reason text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists devices_user_idx on synedge.devices(user_id) where disabled_at is null;

-- 通知の重複排除キー兼配信状態。メッセージIDのみ（件名・本文は持たない）
create table if not exists synedge.notification_deliveries (
  account_id uuid not null references synedge.mail_accounts(id) on delete cascade,
  message_id text not null,
  thread_id text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts integer not null default 0,
  last_error_code text,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, message_id)
);
create index if not exists notification_deliveries_due_idx
  on synedge.notification_deliveries(next_attempt_at) where status = 'failed' and next_attempt_at is not null;
create index if not exists notification_deliveries_created_idx on synedge.notification_deliveries(created_at);

-- 送信の冪等キー（二重送信防止と、結果不明時の照合）
create table if not exists synedge.send_requests (
  user_id uuid not null references synedge.users(id) on delete cascade,
  idempotency_key uuid not null,
  status text not null check (status in ('pending', 'sent', 'failed', 'unknown')),
  rfc822_message_id text not null,
  message_id text,
  thread_id text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);

-- Androidアプリへのログイン受け渡し用ワンタイムコード（ハッシュのみ保存）
create table if not exists synedge.auth_handoff_codes (
  code_hash text primary key,
  user_id uuid not null references synedge.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- MCP接続用の個人アクセストークン（ハッシュのみ保存）
create table if not exists synedge.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references synedge.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  token_hash text not null unique,
  token_prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists mcp_tokens_user_idx on synedge.mcp_tokens(user_id);

-- RLS：ポリシーを作らない＝ anon / authenticated からは全行拒否
alter table synedge.users enable row level security;
alter table synedge.mail_accounts enable row level security;
alter table synedge.user_settings enable row level security;
alter table synedge.devices enable row level security;
alter table synedge.notification_deliveries enable row level security;
alter table synedge.send_requests enable row level security;
alter table synedge.auth_handoff_codes enable row level security;
alter table synedge.mcp_tokens enable row level security;

-- Supabase の公開ロールから権限を外す（ロールがない素のPostgresでは何もしない）
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format(
        'revoke all on all tables in schema synedge from %I; revoke all on schema synedge from %I',
        r, r
      );
    end if;
  end loop;
end
$$;
