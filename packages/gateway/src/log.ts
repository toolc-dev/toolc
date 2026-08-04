import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * Call log — one row per tool invocation (spec §6.5).
 * This schema seeds the future observability/PGO product: keep it boring and complete.
 */

export interface CallRecord {
  ts: string;
  sessionId: string | null;
  runId: string | null;
  taskId: string | null;
  surface: "mirror" | "compiled";
  toolId: string;
  parentCallId: number | null;
  argsJson: string;
  resultBytes: number | null;
  isError: boolean;
  errorText: string | null;
  latencyMs: number;
}

export interface CallRow extends CallRecord {
  id: number;
}

const ARGS_JSON_MAX_BYTES = 8 * 1024;

export class CallLog {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        session_id TEXT,
        run_id TEXT,
        task_id TEXT,
        surface TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        parent_call_id INTEGER,
        args_json TEXT NOT NULL,
        result_bytes INTEGER,
        is_error INTEGER NOT NULL,
        error_text TEXT,
        latency_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calls_run ON calls(run_id, task_id);
      CREATE INDEX IF NOT EXISTS idx_calls_tool ON calls(tool_id);
    `);
  }

  record(call: CallRecord): number {
    const argsJson =
      Buffer.byteLength(call.argsJson) > ARGS_JSON_MAX_BYTES
        ? `${call.argsJson.slice(0, ARGS_JSON_MAX_BYTES)}…[truncated]`
        : call.argsJson;
    const result = this.db
      .prepare(`
        INSERT INTO calls (ts, session_id, run_id, task_id, surface, tool_id, parent_call_id,
                           args_json, result_bytes, is_error, error_text, latency_ms)
        VALUES (@ts, @sessionId, @runId, @taskId, @surface, @toolId, @parentCallId,
                @argsJson, @resultBytes, @isError, @errorText, @latencyMs)
      `)
      .run({ ...call, argsJson, isError: call.isError ? 1 : 0 });
    return Number(result.lastInsertRowid);
  }

  recent(limit = 100): CallRow[] {
    const rows = this.db
      .prepare("SELECT * FROM calls ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      ts: r.ts as string,
      sessionId: r.session_id as string | null,
      runId: r.run_id as string | null,
      taskId: r.task_id as string | null,
      surface: r.surface as "mirror" | "compiled",
      toolId: r.tool_id as string,
      parentCallId: r.parent_call_id as number | null,
      argsJson: r.args_json as string,
      resultBytes: r.result_bytes as number | null,
      isError: (r.is_error as number) === 1,
      errorText: r.error_text as string | null,
      latencyMs: r.latency_ms as number,
    }));
  }

  close(): void {
    this.db.close();
  }
}
