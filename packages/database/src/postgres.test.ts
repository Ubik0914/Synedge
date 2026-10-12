// 実DBでのテスト。DATABASE_URL_TEST（スーパーユーザー権限の接続先）が未設定ならスキップする。
// 毎回一時データベースを作り、マイグレーションが新規DBへ適用できることから検証する。
import { randomBytes } from "node:crypto";
import { repositoryContract } from "@synedge/mail-core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate";
import { createPgRepositories, createSql, type Sql } from "./postgres";

const adminUrl = process.env.DATABASE_URL_TEST;
const suite = adminUrl ? describe : describe.skip;

suite("Postgres", () => {
  const dbName = `synedge_t_${randomBytes(4).toString("hex")}`;
  let admin: Sql;
  let sql: Sql;

  beforeAll(async () => {
    admin = createSql(adminUrl!, { max: 1 });
    await admin.unsafe(`create database ${dbName}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    sql = createSql(url.toString());
    // Supabase の公開ロールを模擬する
    await sql.unsafe(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$`);
    await sql.unsafe(`grant usage on schema public to anon, authenticated;
      alter default privileges in schema public grant all on tables to anon, authenticated;`);
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  it("マイグレーションが新規DBへ適用でき、再実行しても変化しない", async () => {
    expect(await migrate(sql)).toEqual(["20261010000000_init.sql"]);
    expect(await migrate(sql)).toEqual([]);
  });

  it("公開ロール（anon/authenticated）からは全テーブルを読み書きできない", async () => {
    const tables = ["users", "mail_accounts", "user_settings", "devices", "notification_deliveries", "send_requests", "auth_handoff_codes", "mcp_tokens"];
    await sql`insert into synedge.users (email) values ('rls@example.com') on conflict do nothing`;
    for (const role of ["anon", "authenticated"]) {
      for (const t of tables) {
        await expect(
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            return tx.unsafe(`select * from synedge.${t}`);
          }),
        ).rejects.toThrow(/permission denied/);
      }
    }
    // 権限を誤って付与しても RLS により行は見えない
    await sql.unsafe(`grant usage on schema synedge to authenticated; grant select on synedge.users to authenticated`);
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role authenticated`);
      return tx.unsafe(`select * from synedge.users`);
    });
    expect(rows).toHaveLength(0);
    await sql.unsafe(`revoke select on synedge.users from authenticated; revoke usage on schema synedge from authenticated`);
  });

  it("ハンドオフコードは1回限り・期限付き", async () => {
    const repos = createPgRepositories(sql);
    const user = await repos.users.upsertByEmail("handoff@example.com");
    const now = new Date();
    await repos.handoff.create("h1", user.id, new Date(now.getTime() + 60_000));
    expect(await repos.handoff.consume("h1", now)).toBe(user.id);
    expect(await repos.handoff.consume("h1", now)).toBeNull();
    await repos.handoff.create("h2", user.id, new Date(now.getTime() - 1));
    expect(await repos.handoff.consume("h2", now)).toBeNull();
  });

  it("MCPトークン：ハッシュで検索し、失効後は見つからない", async () => {
    const repos = createPgRepositories(sql);
    const user = await repos.users.upsertByEmail("mcp@example.com");
    const t = await repos.mcpTokens.create(user.id, "Claude Desktop", "hash-1", "syn_abcd");
    expect((await repos.mcpTokens.findActiveByHash("hash-1"))?.id).toBe(t.id);
    const other = await repos.users.upsertByEmail("other-mcp@example.com");
    expect(await repos.mcpTokens.revoke(other.id, t.id)).toBe(false);
    expect(await repos.mcpTokens.revoke(user.id, t.id)).toBe(true);
    expect(await repos.mcpTokens.findActiveByHash("hash-1")).toBeNull();
  });

  repositoryContract("postgres", async () => {
    await sql.unsafe(`truncate synedge.users cascade`);
    return createPgRepositories(sql);
  });
});
