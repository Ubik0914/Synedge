// supabase/migrations/*.sql を順に適用する簡易ランナー。
// Supabase プロジェクトは navy と共用のため、Supabase CLI（supabase db push）は使わずこのランナーで適用する（READMEに記載）。
// 適用記録は synedge スキーマに置き、navy の supabase_migrations には触れない。
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./postgres";

export function defaultMigrationsDir(): string {
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../supabase/migrations");
}

export async function migrate(sql: Sql, dir = defaultMigrationsDir()): Promise<string[]> {
  await sql`create schema if not exists synedge`;
  await sql`create table if not exists synedge.synedge_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await sql`select name from synedge.synedge_migrations`).map((r) => String(r.name)));
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const text = await readFile(join(dir, f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into synedge.synedge_migrations (name) values (${f})`;
    });
    done.push(f);
  }
  return done;
}
