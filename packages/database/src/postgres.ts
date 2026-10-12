// Postgres（Supabase）実装。サーバー専用。DATABASE_URL はサーバーの秘密情報としてのみ扱う。
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type {
  AccountRecord,
  AccountRepository,
  ConnectAccountInput,
  DeliveryRecord,
  DeliveryRepository,
  DeviceRecord,
  DeviceRepository,
  Repositories,
  SendRecord,
  SendRepository,
  SettingsRepository,
  UserRecord,
  UserRepository,
} from "@synedge/mail-core/server";
import type { UserSettings } from "@synedge/mail-core";
import type { AppRepositories, HandoffRepository, McpTokenRecord, McpTokenRepository } from "./app-ports";

export type Sql = postgres.Sql;

export function createSql(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 5,
    // Supabase の transaction pooler（:6543）では prepared statement が使えない
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

type Row = Record<string, unknown>;

const d = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);

function toUser(r: Row): UserRecord {
  return { id: String(r.id), email: String(r.email), sessionVersion: Number(r.session_version) };
}

function toAccount(r: Row): AccountRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    provider: r.provider as AccountRecord["provider"],
    email: String(r.email),
    refreshTokenEnc: String(r.refresh_token_enc),
    accessTokenEnc: (r.access_token_enc as string | null) ?? null,
    accessTokenExpiresAt: d(r.access_token_expires_at),
    scopes: (r.scopes as string[] | null) ?? [],
    status: r.status as AccountRecord["status"],
    statusReason: (r.status_reason as string | null) ?? null,
    historyId: (r.history_id as string | null) ?? null,
    watchExpiresAt: d(r.watch_expires_at),
    watchRenewedAt: d(r.watch_renewed_at),
    watchLastError: (r.watch_last_error as string | null) ?? null,
    lastSyncedAt: d(r.last_synced_at),
  };
}

export class PgUsers implements UserRepository {
  constructor(private readonly sql: Sql) {}
  async findById(id: string) {
    const [r] = await this.sql`select * from synedge.users where id = ${id}`;
    return r ? toUser(r) : null;
  }
  async findByEmail(email: string) {
    const [r] = await this.sql`select * from synedge.users where email = ${email.toLowerCase()}`;
    return r ? toUser(r) : null;
  }
  async upsertByEmail(email: string) {
    const [r] = await this.sql`
      insert into synedge.users (email) values (${email.toLowerCase()})
      on conflict (email) do update set email = excluded.email
      returning *`;
    return toUser(r!);
  }
  async bumpSessionVersion(id: string) {
    await this.sql`update synedge.users set session_version = session_version + 1 where id = ${id}`;
  }
}

export class PgAccounts implements AccountRepository {
  constructor(private readonly sql: Sql) {}
  async findById(id: string) {
    const [r] = await this.sql`select * from synedge.mail_accounts where id = ${id}`;
    return r ? toAccount(r) : null;
  }
  async listByUser(userId: string) {
    const rows = await this.sql`select * from synedge.mail_accounts where user_id = ${userId} order by created_at`;
    return rows.map(toAccount);
  }
  async findByProviderEmail(provider: string, email: string) {
    const [r] = await this.sql`select * from synedge.mail_accounts where provider = ${provider} and email = ${email.toLowerCase()}`;
    return r ? toAccount(r) : null;
  }
  async listActive() {
    const rows = await this.sql`select * from synedge.mail_accounts where status = 'active' order by created_at`;
    return rows.map(toAccount);
  }
  async upsertConnection(i: ConnectAccountInput) {
    // 他ユーザーが所有するアドレスは付け替えない（where で更新を阻止し、0行なら例外）
    const rows = await this.sql`
      insert into synedge.mail_accounts (id, user_id, provider, email, refresh_token_enc, access_token_enc, access_token_expires_at, scopes)
      values (${i.id ?? randomUUID()}, ${i.userId}, ${i.provider}, ${i.email.toLowerCase()}, ${i.refreshTokenEnc}, ${i.accessTokenEnc}, ${i.accessTokenExpiresAt}, ${i.scopes})
      on conflict (provider, email) do update set
        refresh_token_enc = excluded.refresh_token_enc,
        access_token_enc = excluded.access_token_enc,
        access_token_expires_at = excluded.access_token_expires_at,
        scopes = excluded.scopes,
        status = 'active',
        status_reason = null,
        updated_at = now()
      where mail_accounts.user_id = excluded.user_id
      returning *`;
    if (!rows[0]) throw new Error("account_owned_by_other_user");
    return toAccount(rows[0]);
  }
  async updateAccessToken(id: string, enc: string, expiresAt: Date) {
    await this.sql`update synedge.mail_accounts set access_token_enc = ${enc}, access_token_expires_at = ${expiresAt}, updated_at = now() where id = ${id}`;
  }
  async updateRefreshToken(id: string, enc: string) {
    await this.sql`update synedge.mail_accounts set refresh_token_enc = ${enc}, updated_at = now() where id = ${id}`;
  }
  async markReauthRequired(id: string, reason: string) {
    await this.sql`
      update synedge.mail_accounts set status = 'reauth_required', status_reason = ${reason.slice(0, 200)},
        access_token_enc = null, updated_at = now()
      where id = ${id}`;
  }
  async compareAndSetHistoryId(id: string, expected: string | null, next: string, syncedAt: Date) {
    const rows = await this.sql`
      update synedge.mail_accounts set history_id = ${next}, last_synced_at = ${syncedAt}, updated_at = now()
      where id = ${id} and history_id is not distinct from ${expected}
      returning id`;
    return rows.length === 1;
  }
  async updateWatch(id: string, p: { expiresAt?: Date | null; renewedAt?: Date; lastError: string | null }) {
    await this.sql`
      update synedge.mail_accounts set
        watch_expires_at = ${p.expiresAt === undefined ? this.sql`watch_expires_at` : p.expiresAt},
        watch_renewed_at = ${p.renewedAt ?? this.sql`watch_renewed_at`},
        watch_last_error = ${p.lastError},
        updated_at = now()
      where id = ${id}`;
  }
  async tryAcquireSyncLease(id: string, owner: string, ttlMs: number) {
    const rows = await this.sql`
      update synedge.mail_accounts set sync_lease_owner = ${owner}, sync_lease_until = now() + ${ttlMs} * interval '1 millisecond'
      where id = ${id} and (sync_lease_until is null or sync_lease_until < now())
      returning id`;
    return rows.length === 1;
  }
  async releaseSyncLease(id: string, owner: string) {
    await this.sql`
      update synedge.mail_accounts set sync_lease_owner = null, sync_lease_until = null
      where id = ${id} and sync_lease_owner = ${owner}`;
  }
  async delete(id: string) {
    await this.sql`delete from synedge.mail_accounts where id = ${id}`;
  }
}

export class PgSettings implements SettingsRepository {
  constructor(private readonly sql: Sql) {}
  async get(userId: string): Promise<UserSettings> {
    const [r] = await this.sql`select * from synedge.user_settings where user_id = ${userId}`;
    return r
      ? { notificationsEnabled: Boolean(r.notifications_enabled), notificationPreview: Boolean(r.notification_preview) }
      : { notificationsEnabled: true, notificationPreview: false };
  }
  async update(userId: string, patch: Partial<UserSettings>) {
    const cur = await this.get(userId);
    const next = { ...cur, ...patch };
    await this.sql`
      insert into synedge.user_settings (user_id, notifications_enabled, notification_preview)
      values (${userId}, ${next.notificationsEnabled}, ${next.notificationPreview})
      on conflict (user_id) do update set
        notifications_enabled = excluded.notifications_enabled,
        notification_preview = excluded.notification_preview,
        updated_at = now()`;
    return next;
  }
}

export class PgDevices implements DeviceRepository {
  constructor(private readonly sql: Sql) {}
  async listActive(userId: string): Promise<DeviceRecord[]> {
    const rows = await this.sql`select * from synedge.devices where user_id = ${userId} and disabled_at is null order by created_at`;
    return rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      token: String(r.fcm_token),
      platform: r.platform as DeviceRecord["platform"],
    }));
  }
  async register(userId: string, token: string, platform: DeviceRecord["platform"]) {
    // 同じトークンが別ユーザーに紐づいていた場合は本人に付け替える（端末の持ち主が変わったケース）
    await this.sql`
      insert into synedge.devices (user_id, fcm_token, platform) values (${userId}, ${token}, ${platform})
      on conflict (fcm_token) do update set
        user_id = excluded.user_id, platform = excluded.platform,
        disabled_at = null, disabled_reason = null, last_seen_at = now()`;
  }
  async remove(userId: string, token: string) {
    await this.sql`delete from synedge.devices where user_id = ${userId} and fcm_token = ${token}`;
  }
  async disableToken(token: string, reason: string) {
    await this.sql`update synedge.devices set disabled_at = now(), disabled_reason = ${reason.slice(0, 100)} where fcm_token = ${token}`;
  }
  async deleteAllForUser(userId: string) {
    await this.sql`delete from synedge.devices where user_id = ${userId}`;
  }
}

function toDelivery(r: Row): DeliveryRecord {
  return {
    accountId: String(r.account_id),
    messageId: String(r.message_id),
    threadId: String(r.thread_id),
    status: r.status as DeliveryRecord["status"],
    attempts: Number(r.attempts),
    nextAttemptAt: d(r.next_attempt_at),
  };
}

export class PgDeliveries implements DeliveryRepository {
  constructor(private readonly sql: Sql) {}
  async claim(accountId: string, messageId: string, threadId: string) {
    const rows = await this.sql`
      insert into synedge.notification_deliveries (account_id, message_id, thread_id)
      values (${accountId}, ${messageId}, ${threadId})
      on conflict do nothing returning message_id`;
    return rows.length === 1;
  }
  async markSent(accountId: string, messageId: string) {
    await this.sql`
      update synedge.notification_deliveries set status = 'sent', next_attempt_at = null, updated_at = now()
      where account_id = ${accountId} and message_id = ${messageId}`;
  }
  async markSkipped(accountId: string, messageId: string, reason: string) {
    await this.sql`
      update synedge.notification_deliveries set status = 'skipped', last_error_code = ${reason}, next_attempt_at = null, updated_at = now()
      where account_id = ${accountId} and message_id = ${messageId}`;
  }
  async markFailed(accountId: string, messageId: string, errorCode: string, nextAttemptAt: Date | null) {
    await this.sql`
      update synedge.notification_deliveries set status = 'failed', attempts = attempts + 1, last_error_code = ${errorCode},
        next_attempt_at = ${nextAttemptAt}, updated_at = now()
      where account_id = ${accountId} and message_id = ${messageId}`;
  }
  async listDue(now: Date, limit: number) {
    const rows = await this.sql`
      select * from synedge.notification_deliveries
      where status = 'failed' and next_attempt_at is not null and next_attempt_at <= ${now}
      order by next_attempt_at limit ${limit}`;
    return rows.map(toDelivery);
  }
  async deleteForAccount(accountId: string) {
    await this.sql`delete from synedge.notification_deliveries where account_id = ${accountId}`;
  }
  async purgeOlderThan(date: Date) {
    const rows = await this.sql`
      delete from synedge.notification_deliveries where created_at < ${date} and status <> 'failed' returning message_id`;
    return rows.length;
  }
}

function toSend(r: Row): SendRecord {
  return {
    userId: String(r.user_id),
    idempotencyKey: String(r.idempotency_key),
    status: r.status as SendRecord["status"],
    rfc822MessageId: String(r.rfc822_message_id),
    messageId: (r.message_id as string | null) ?? null,
    threadId: (r.thread_id as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
  };
}

export class PgSends implements SendRepository {
  constructor(private readonly sql: Sql) {}
  async begin(userId: string, key: string, rfc822MessageId: string) {
    const inserted = await this.sql`
      insert into synedge.send_requests (user_id, idempotency_key, status, rfc822_message_id)
      values (${userId}, ${key}, 'pending', ${rfc822MessageId})
      on conflict do nothing returning *`;
    if (inserted[0]) return { created: true, record: toSend(inserted[0]) };
    const [r] = await this.sql`select * from synedge.send_requests where user_id = ${userId} and idempotency_key = ${key}`;
    return { created: false, record: toSend(r!) };
  }
  async finish(userId: string, key: string, p: Parameters<SendRepository["finish"]>[2]) {
    await this.sql`
      update synedge.send_requests set status = ${p.status}, message_id = ${p.messageId ?? null}, thread_id = ${p.threadId ?? null},
        error_code = ${p.errorCode ?? null}, updated_at = now()
      where user_id = ${userId} and idempotency_key = ${key}`;
  }
  async get(userId: string, key: string) {
    const [r] = await this.sql`select * from synedge.send_requests where user_id = ${userId} and idempotency_key = ${key}`;
    return r ? toSend(r) : null;
  }
}

export class PgHandoff implements HandoffRepository {
  constructor(private readonly sql: Sql) {}
  async create(codeHash: string, userId: string, expiresAt: Date) {
    await this.sql`insert into synedge.auth_handoff_codes (code_hash, user_id, expires_at) values (${codeHash}, ${userId}, ${expiresAt})`;
  }
  async consume(codeHash: string, now: Date) {
    const [r] = await this.sql`
      update synedge.auth_handoff_codes set used_at = ${now}
      where code_hash = ${codeHash} and used_at is null and expires_at > ${now}
      returning user_id`;
    await this.sql`delete from synedge.auth_handoff_codes where expires_at < ${new Date(now.getTime() - 86400_000)}`;
    return r ? String(r.user_id) : null;
  }
}

function toMcpToken(r: Row): McpTokenRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    name: String(r.name),
    tokenPrefix: String(r.token_prefix),
    createdAt: d(r.created_at)!,
    lastUsedAt: d(r.last_used_at),
    revokedAt: d(r.revoked_at),
  };
}

export class PgMcpTokens implements McpTokenRepository {
  constructor(private readonly sql: Sql) {}
  async create(userId: string, name: string, tokenHash: string, tokenPrefix: string) {
    const [r] = await this.sql`
      insert into synedge.mcp_tokens (user_id, name, token_hash, token_prefix) values (${userId}, ${name}, ${tokenHash}, ${tokenPrefix})
      returning *`;
    return toMcpToken(r!);
  }
  async list(userId: string) {
    const rows = await this.sql`select * from synedge.mcp_tokens where user_id = ${userId} and revoked_at is null order by created_at desc`;
    return rows.map(toMcpToken);
  }
  async revoke(userId: string, id: string) {
    const rows = await this.sql`
      update synedge.mcp_tokens set revoked_at = now() where id = ${id} and user_id = ${userId} and revoked_at is null returning id`;
    return rows.length === 1;
  }
  async findActiveByHash(tokenHash: string) {
    const [r] = await this.sql`select * from synedge.mcp_tokens where token_hash = ${tokenHash} and revoked_at is null`;
    return r ? toMcpToken(r) : null;
  }
  async touch(id: string) {
    await this.sql`update synedge.mcp_tokens set last_used_at = now() where id = ${id}`;
  }
  async revokeAllForUser(userId: string) {
    await this.sql`update synedge.mcp_tokens set revoked_at = now() where user_id = ${userId} and revoked_at is null`;
  }
}

export function createPgRepositories(sql: Sql): Repositories & AppRepositories {
  return {
    users: new PgUsers(sql),
    accounts: new PgAccounts(sql),
    settings: new PgSettings(sql),
    devices: new PgDevices(sql),
    deliveries: new PgDeliveries(sql),
    sends: new PgSends(sql),
    handoff: new PgHandoff(sql),
    mcpTokens: new PgMcpTokens(sql),
  };
}
