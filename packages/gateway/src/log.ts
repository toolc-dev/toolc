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
  /** Capped text content of the served result (observability; null when payload logging is off). */
  resultJson: string | null;
  isError: boolean;
  errorText: string | null;
  latencyMs: number;
}

export interface CallRow extends CallRecord {
  id: number;
}

/**
 * What the Router needs from a call logger. The engine's SQLite CallLog
 * implements it synchronously; hosted deployments implement it against
 * Postgres (async) — the Router awaits either.
 */
export interface CallSink {
  begin(
    call: Omit<CallRecord, "resultBytes" | "resultJson" | "isError" | "errorText" | "latencyMs">,
  ): number | Promise<number>;
  finish(
    id: number,
    outcome: Pick<CallRecord, "resultBytes" | "resultJson" | "isError" | "errorText" | "latencyMs">,
  ): void | Promise<void>;
  close?(): void | Promise<void>;
}

const ARGS_JSON_MAX_BYTES = 8 * 1024;
export const RESULT_JSON_MAX_BYTES = 16 * 1024;

export function capResultJson(text: string | null): string | null {
  if (text === null) return null;
  return Buffer.byteLength(text) > RESULT_JSON_MAX_BYTES
    ? `${text.slice(0, RESULT_JSON_MAX_BYTES)}…[truncated]`
    : text;
}

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
        result_json TEXT,
        is_error INTEGER NOT NULL,
        error_text TEXT,
        latency_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calls_run ON calls(run_id, task_id);
      CREATE INDEX IF NOT EXISTS idx_calls_tool ON calls(tool_id);
    `);
    try {
      this.db.exec("ALTER TABLE calls ADD COLUMN result_json TEXT");
    } catch {
      // column already exists
    }
  }

  /**
   * Two-phase logging for calls that spawn children (call_tool, macros): the
   * parent row is inserted before execution so children can reference its id
   * via parent_call_id, then finished with the outcome.
   */
  begin(
    call: Omit<CallRecord, "resultBytes" | "resultJson" | "isError" | "errorText" | "latencyMs">,
  ): number {
    return this.record({
      ...call,
      resultBytes: null,
      resultJson: null,
      isError: false,
      errorText: null,
      latencyMs: -1,
    });
  }

  finish(
    id: number,
    outcome: Pick<CallRecord, "resultBytes" | "resultJson" | "isError" | "errorText" | "latencyMs">,
  ): void {
    this.db
      .prepare(
        "UPDATE calls SET result_bytes = ?, result_json = ?, is_error = ?, error_text = ?, latency_ms = ? WHERE id = ?",
      )
      .run(
        outcome.resultBytes,
        capResultJson(outcome.resultJson),
        outcome.isError ? 1 : 0,
        outcome.errorText,
        outcome.latencyMs,
        id,
      );
  }

  record(call: CallRecord): number {
    const argsJson =
      Buffer.byteLength(call.argsJson) > ARGS_JSON_MAX_BYTES
        ? `${call.argsJson.slice(0, ARGS_JSON_MAX_BYTES)}…[truncated]`
        : call.argsJson;
    const result = this.db
      .prepare(`
        INSERT INTO calls (ts, session_id, run_id, task_id, surface, tool_id, parent_call_id,
                           args_json, result_bytes, result_json, is_error, error_text, latency_ms)
        VALUES (@ts, @sessionId, @runId, @taskId, @surface, @toolId, @parentCallId,
                @argsJson, @resultBytes, @resultJson, @isError, @errorText, @latencyMs)
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
      resultJson: r.result_json as string | null,
      isError: (r.is_error as number) === 1,
      errorText: r.error_text as string | null,
      latencyMs: r.latency_ms as number,
    }));
  }

  close(): void {
    this.db.close();
  }
}
