import type { LlmComplete } from "../passes/types.js";

/**
 * Spec synthesis: turn human-facing REST API docs into an OpenAPI spec, so
 * APIs without a published spec can still join the pool. The LLM only DRAFTS
 * the spec; deterministic validation checks its shape and probeSpec verifies
 * drafted endpoints against the live API before anything compiles.
 */

const SYNTH_PROMPT = `You convert REST API documentation into an OpenAPI 3.0 spec for machine use.
Rules:
- Only include endpoints the documentation actually describes. Never invent endpoints, parameters, or fields.
- servers[0].url must be the API base URL from the docs (https).
- Give every operation an operationId (snake_case), a one-line summary, and parameter descriptions lifted from the docs.
- Include parameter constraints the docs state: enum values, minimum/maximum, defaults, required flags.
- GET endpoints matter most; include write endpoints only when clearly documented.
- Auth: if the docs describe an API key or bearer header, note it in info.description but do NOT add security schemes to operations.
Respond with exactly one block and no other prose:
<<<SPEC>>>
{ ...the complete OpenAPI 3.0 JSON... }
<<<END>>>`;

const MAX_DOCS_CHARS = 150_000;

/** Fetch a docs page and reduce it to readable text (crude HTML strip). */
export async function fetchDocsText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: "text/html, text/markdown, text/plain", "User-Agent": "toolc/0.0.1" },
  });
  if (!response.ok) throw new Error(`docs fetch failed: HTTP ${response.status}`);
  let text = await response.text();
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
  return text.slice(0, MAX_DOCS_CHARS);
}

export interface SynthesisResult {
  spec: Record<string, unknown>;
  notes: string[];
}

/** Draft an OpenAPI spec from documentation text. Throws on unusable output. */
export async function synthesizeSpecFromDocs(
  docsUrl: string,
  llm: LlmComplete,
  opts: { model?: string; docsText?: string } = {},
): Promise<SynthesisResult> {
  const notes: string[] = [];
  const docsText = opts.docsText ?? (await fetchDocsText(docsUrl));
  if (docsText.trim().length < 200) {
    throw new Error("docs page had too little readable text to draft a spec");
  }
  const raw = await llm({
    model: opts.model ?? "claude-sonnet-4-6",
    system: SYNTH_PROMPT,
    prompt: `Documentation from ${docsUrl}:\n\n${docsText}`,
    maxTokens: 16_000,
  });
  const match = /<<<SPEC>>>\s*([\s\S]*?)<<<END>>>/.exec(raw);
  if (!match) throw new Error("model returned no spec block");
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(match[1]!.trim()) as Record<string, unknown>;
  } catch {
    throw new Error("drafted spec was not valid JSON");
  }
  const servers = spec.servers as Array<{ url?: string }> | undefined;
  if (!servers?.[0]?.url?.startsWith("https://")) {
    throw new Error("drafted spec has no https base URL in servers[0].url");
  }
  const paths = Object.keys((spec.paths as Record<string, unknown>) ?? {});
  if (paths.length === 0) throw new Error("drafted spec has no paths");
  notes.push(`drafted ${paths.length} path(s) from ${docsUrl}`);
  return { spec, notes };
}

export interface ProbeResult {
  operationId: string;
  method: string;
  path: string;
  probed: boolean;
  ok: boolean | null;
  status: number | null;
}

const MAX_PROBES = 10;

/**
 * Verify drafted GET endpoints against the live API: call the ones that need
 * no required path params, with the caller's credentials. Auth failures count
 * as "answered" (the endpoint exists); 404s flag likely hallucinations.
 */
export async function probeSpec(
  spec: Record<string, unknown>,
  creds: { headers?: Record<string, string>; query?: Record<string, string> } = {},
): Promise<ProbeResult[]> {
  const baseUrl = ((spec.servers as Array<{ url?: string }>)?.[0]?.url ?? "").replace(/\/$/, "");
  const results: ProbeResult[] = [];
  let probes = 0;
  for (const [path, rawItem] of Object.entries((spec.paths as Record<string, unknown>) ?? {})) {
    const op = (rawItem as Record<string, Record<string, unknown>>).get;
    if (!op) continue;
    const operationId = (op.operationId as string) ?? `get_${path}`;
    const needsPathParam = path.includes("{");
    if (needsPathParam || probes >= MAX_PROBES) {
      results.push({ operationId, method: "get", path, probed: false, ok: null, status: null });
      continue;
    }
    probes += 1;
    const query = new URLSearchParams(creds.query ?? {});
    const qs = query.toString();
    let status: number | null = null;
    try {
      const response = await fetch(`${baseUrl}${path}${qs ? `?${qs}` : ""}`, {
        headers: { Accept: "application/json", "User-Agent": "toolc/0.0.1", ...creds.headers },
      });
      status = response.status;
    } catch {
      status = null;
    }
    results.push({
      operationId,
      method: "get",
      path,
      probed: true,
      // 404 = likely hallucinated path; anything else (200/400/401/403/429) means it exists.
      ok: status !== null && status !== 404,
      status,
    });
  }
  return results;
}
