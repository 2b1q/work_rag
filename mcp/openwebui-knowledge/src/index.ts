import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const MCP_HOST = process.env.MCP_HOST ?? "0.0.0.0";
const MCP_PORT = Number(process.env.MCP_PORT ?? "8787");

const OPENWEBUI_BASE_URL = (process.env.OPENWEBUI_BASE_URL ?? "http://openwebui:8080").replace(/\/+$/, "");
const OPENWEBUI_API_KEY = process.env.OPENWEBUI_API_KEY ?? "";
const DEFAULT_COLLECTION = process.env.OPENWEBUI_DEFAULT_COLLECTION ?? "";

const HTTP_TIMEOUT_MS = Number(process.env.OPENWEBUI_TIMEOUT_MS ?? "20000");
const DEBUG = process.env.MCP_DEBUG === "1";

// OpenWebUI paginates knowledge and file listings server-side at a fixed size.
const PAGE_ITEM_COUNT = 30;

if (!OPENWEBUI_API_KEY) {
    throw new Error("OPENWEBUI_API_KEY is required");
}

const LOG = (msg: string, data?: unknown) =>
    data === undefined ? console.log(`[MCP] ${msg}`) : console.log(`[MCP] ${msg}`, data);

/* ------------------------------------------------------------------ *
 * OpenWebUI client
 * ------------------------------------------------------------------ */

class OpenWebUIError extends Error {
    constructor(readonly status: number, readonly url: string, body: string) {
        super(`OpenWebUI ${status} on ${url}${body ? `: ${body.slice(0, 500)}` : ""}`);
        this.name = "OpenWebUIError";
    }
}

function headers(): Record<string, string> {
    return {
        Authorization: `Bearer ${OPENWEBUI_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
    };
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${OPENWEBUI_BASE_URL}${path}`;
    const res = await fetch(url, {
        ...init,
        headers: headers(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new OpenWebUIError(res.status, url, body);
    }
    return res;
}

async function getJson<T>(path: string): Promise<T> {
    return (await request(path)).json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
    return (await request(path, { method: "POST", body: JSON.stringify(body) })).json() as Promise<T>;
}

function qs(params: Record<string, string | number | undefined>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== "") sp.set(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : "";
}

/* ------------------------------------------------------------------ *
 * Domain types (only the fields we actually consume)
 * ------------------------------------------------------------------ */

type Paged<T> = { items: T[]; total: number };

type KnowledgeItem = {
    id: string;
    name?: string;
    description?: string;
    created_at?: number;
    updated_at?: number;
};

type FileItem = {
    id: string;
    filename?: string;
    meta?: { name?: string; size?: number; content_type?: string };
    created_at?: number;
    updated_at?: number;
};

type FileDetail = FileItem & {
    data?: { content?: string };
};

type RetrievalResponse = {
    distances?: number[][];
    documents?: string[][];
    metadatas?: Array<Array<Record<string, unknown>>>;
};

type Chunk = {
    distance?: number;
    source?: string;
    name?: string;
    file_id?: string;
    start_index?: number;
    text: string;
};

/* ------------------------------------------------------------------ *
 * OpenWebUI operations
 * ------------------------------------------------------------------ */

function listKnowledge(page: number, query?: string): Promise<Paged<KnowledgeItem>> {
    // /search honours `query`; the plain listing is cheaper when there is none.
    return query
        ? getJson(`/api/v1/knowledge/search${qs({ query, page })}`)
        : getJson(`/api/v1/knowledge/${qs({ page })}`);
}

function listKnowledgeFiles(collectionId: string, page: number, query?: string): Promise<Paged<FileItem>> {
    return getJson(`/api/v1/knowledge/${encodeURIComponent(collectionId)}/files${qs({ query, page })}`);
}

function getFile(fileId: string): Promise<FileDetail> {
    return getJson(`/api/v1/files/${encodeURIComponent(fileId)}`);
}

/**
 * The file record usually carries the extracted text already, so callers that
 * already hold one pass it in rather than paying for a second round trip.
 */
async function getFileContent(fileId: string, known?: FileDetail | null): Promise<string> {
    const file = known !== undefined ? known : await getFile(fileId).catch(() => null);
    const inline = file?.data?.content;
    if (typeof inline === "string" && inline.length > 0) return inline;

    const res = await request(`/api/v1/files/${encodeURIComponent(fileId)}/content`);
    return res.text();
}

/** Fetches a file record and its text in a single pass. */
async function getFileWithContent(fileId: string): Promise<{ file: FileDetail | null; text: string }> {
    const file = await getFile(fileId).catch(() => null);
    return { file, text: await getFileContent(fileId, file) };
}

function fileName(f: FileItem): string | undefined {
    return f.meta?.name ?? f.filename;
}

/**
 * Accepts a collection id or a (case-insensitive) collection name and returns
 * the id. Names are far easier for a model to produce than uuids.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveCollection(ref?: string): Promise<string> {
    const wanted = (ref ?? DEFAULT_COLLECTION).trim();
    if (!wanted) {
        throw new Error(
            "No collection given and OPENWEBUI_DEFAULT_COLLECTION is not set. Call list_collections first."
        );
    }
    if (UUID_RE.test(wanted)) return wanted;

    const { items } = await listKnowledge(1, wanted);
    const hit =
        items.find((c) => c.name?.toLowerCase() === wanted.toLowerCase()) ??
        items.find((c) => c.name?.toLowerCase().includes(wanted.toLowerCase()));

    if (!hit) throw new Error(`No knowledge collection matches "${wanted}".`);
    return hit.id;
}

function toChunks(raw: RetrievalResponse): Chunk[] {
    // The backend merges every queried collection into a single result row.
    const distances = raw.distances?.[0] ?? [];
    const documents = raw.documents?.[0] ?? [];
    const metadatas = raw.metadatas?.[0] ?? [];

    return documents
        .map((text, i) => {
            const meta = (metadatas[i] ?? {}) as Record<string, unknown>;
            return {
                distance: typeof distances[i] === "number" ? distances[i] : undefined,
                source: typeof meta.source === "string" ? meta.source : undefined,
                name: typeof meta.name === "string" ? meta.name : undefined,
                file_id: typeof meta.file_id === "string" ? meta.file_id : undefined,
                start_index: typeof meta.start_index === "number" ? meta.start_index : undefined,
                text: (text ?? "").trim(),
            };
        })
        .filter((c) => c.text.length > 0);
}

async function searchCollections(collections: string[], query: string, k: number, hybrid: boolean): Promise<Chunk[]> {
    const raw = await postJson<RetrievalResponse>("/api/v1/retrieval/query/collection", {
        collection_names: collections,
        query,
        k,
        hybrid,
    });
    return toChunks(raw);
}

/* ------------------------------------------------------------------ *
 * MCP server
 * ------------------------------------------------------------------ */

function ok(payload: unknown, extraText?: string) {
    const content: Array<{ type: "text"; text: string }> = [
        { type: "text", text: JSON.stringify(payload, null, 2) },
    ];
    if (extraText) content.push({ type: "text", text: extraText });
    return { content };
}

function fail(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (DEBUG) LOG(`tool error: ${message}`);
    return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

/** Wraps a handler so transport-level failures reach the model as tool errors. */
function guard<A>(fn: (args: A) => Promise<ReturnType<typeof ok>>) {
    return async (args: A) => {
        try {
            return await fn(args);
        } catch (err) {
            return fail(err);
        }
    };
}

/** Runs tasks with bounded concurrency so a wide fan-out cannot stampede OpenWebUI. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;

    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]!);
        }
    });

    await Promise.all(workers);
    return out;
}

function paging(page: number, total: number) {
    return { page, total, page_size: PAGE_ITEM_COUNT, has_more: page * PAGE_ITEM_COUNT < total };
}

function createMcpServer(): McpServer {
    const mcp = new McpServer({ name: "openwebui-knowledge", version: "1.0.0" });

    mcp.registerTool(
        "ping_openwebui",
        {
            description: "Check OpenWebUI API reachability and credentials.",
            inputSchema: {},
        },
        guard(async () => {
            const res = await getJson<{ data?: Array<{ id?: string }> }>("/api/models");
            const ids = (res.data ?? []).map((m) => m?.id).filter((x): x is string => Boolean(x));
            return ok({
                ok: true,
                base_url: OPENWEBUI_BASE_URL,
                default_collection: DEFAULT_COLLECTION || null,
                models_count: ids.length,
                sample: ids.slice(0, 10),
            });
        })
    );

    mcp.registerTool(
        "list_collections",
        {
            description:
                "List knowledge collections, newest first. Optional `query` filters by name server-side. " +
                "Returns ids to pass to the other tools.",
            inputSchema: {
                query: z.string().optional(),
                page: z.number().int().min(1).optional(),
            },
        },
        guard(async ({ query, page }: { query?: string; page?: number }) => {
            const p = page ?? 1;
            const { items, total } = await listKnowledge(p, query);

            return ok({
                ok: true,
                default_collection: DEFAULT_COLLECTION || null,
                ...paging(p, total),
                collections: items.map((c) => ({
                    id: c.id,
                    name: c.name,
                    description: c.description || undefined,
                })),
            });
        })
    );

    mcp.registerTool(
        "list_documents",
        {
            description:
                "List files inside a knowledge collection. `collection` accepts an id or a name; " +
                "defaults to OPENWEBUI_DEFAULT_COLLECTION. Optional `query` filters by filename.",
            inputSchema: {
                collection: z.string().optional(),
                query: z.string().optional(),
                page: z.number().int().min(1).optional(),
            },
        },
        guard(async ({ collection, query, page }: { collection?: string; query?: string; page?: number }) => {
            const id = await resolveCollection(collection);
            const p = page ?? 1;
            const { items, total } = await listKnowledgeFiles(id, p, query);

            return ok({
                ok: true,
                collection: { id },
                ...paging(p, total),
                files: items.map((f) => ({
                    file_id: f.id,
                    name: fileName(f),
                    size: f.meta?.size,
                })),
            });
        })
    );

    mcp.registerTool(
        "get_document",
        {
            description: "Fetch the extracted text of one file by file_id.",
            inputSchema: {
                file_id: z.string().min(1),
                max_chars: z.number().int().min(200).max(400_000).optional(),
            },
        },
        guard(async ({ file_id, max_chars }: { file_id: string; max_chars?: number }) => {
            const limit = max_chars ?? 100_000;
            const { file, text } = await getFileWithContent(file_id);

            return ok(
                {
                    ok: true,
                    file_id,
                    name: file ? fileName(file) : undefined,
                    length: text.length,
                    truncated: text.length > limit,
                },
                text.slice(0, limit)
            );
        })
    );

    mcp.registerTool(
        "select_context_files",
        {
            description:
                "Fetch several files by file_id and return them as one concatenated context block, " +
                "ready to paste into a prompt.",
            inputSchema: {
                file_ids: z.array(z.string().min(1)).min(1).max(20),
                max_chars_per_file: z.number().int().min(200).max(200_000).optional(),
                total_budget: z.number().int().min(1_000).max(600_000).optional(),
            },
        },
        guard(
            async ({
                file_ids,
                max_chars_per_file,
                total_budget,
            }: {
                file_ids: string[];
                max_chars_per_file?: number;
                total_budget?: number;
            }) => {
                const perFile = max_chars_per_file ?? 60_000;
                const budget = total_budget ?? 240_000;
                const unique = [...new Set(file_ids)];

                const docs = await mapLimit(unique, 4, async (file_id) => {
                    try {
                        const { file, text } = await getFileWithContent(file_id);
                        return { file_id, name: file ? fileName(file) : undefined, text, error: undefined };
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        return { file_id, name: undefined, text: "", error: message };
                    }
                });

                // Clip per file first, then stop once the shared budget is spent.
                let spent = 0;
                const blocks: string[] = [];
                const included: Array<{ file_id: string; name?: string; chars: number }> = [];
                const skipped: Array<{ file_id: string; reason: string }> = [];

                for (const d of docs) {
                    if (d.error) {
                        skipped.push({ file_id: d.file_id, reason: d.error });
                        continue;
                    }
                    const room = budget - spent;
                    if (room <= 0) {
                        skipped.push({ file_id: d.file_id, reason: "total_budget exhausted" });
                        continue;
                    }

                    const text = d.text.slice(0, Math.min(perFile, room));
                    spent += text.length;

                    const header = ["-----", `file_id: ${d.file_id}`, d.name ? `name: ${d.name}` : null, "-----"]
                        .filter(Boolean)
                        .join("\n");

                    blocks.push(`${header}\n${text}\n`);
                    included.push({ file_id: d.file_id, name: d.name, chars: text.length });
                }

                return ok(
                    { ok: true, requested: unique.length, included, skipped, total_chars: spent },
                    blocks.join("\n")
                );
            }
        )
    );

    mcp.registerTool(
        "search_knowledge",
        {
            description:
                "Semantic search over knowledge collections. Pass `collection` (id or name) or `collections` " +
                "for a multi-collection query; defaults to OPENWEBUI_DEFAULT_COLLECTION.",
            inputSchema: {
                query: z.string().min(1),
                collection: z.string().optional(),
                collections: z.array(z.string().min(1)).min(1).max(10).optional(),
                k: z.number().int().min(1).max(30).optional(),
                hybrid: z.boolean().optional(),
            },
        },
        guard(
            async ({
                query,
                collection,
                collections,
                k,
                hybrid,
            }: {
                query: string;
                collection?: string;
                collections?: string[];
                k?: number;
                hybrid?: boolean;
            }) => {
                const refs = collections?.length ? collections : [collection ?? ""];
                const ids = await mapLimit(refs, 4, (ref) => resolveCollection(ref || undefined));

                const results = await searchCollections(ids, query, k ?? 8, hybrid ?? true);

                return ok({
                    ok: true,
                    collections: ids,
                    query,
                    count: results.length,
                    results,
                });
            }
        )
    );

    return mcp;
}

/* ------------------------------------------------------------------ *
 * HTTP transports
 * ------------------------------------------------------------------ */

function sendJson(res: ServerResponse, code: number, payload: unknown) {
    if (res.headersSent) return;
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

/** Legacy HTTP+SSE transport: long-lived GET /sse plus POST /message per session. */
const sseSessions = new Map<string, { transport: SSEServerTransport; mcp: McpServer }>();

async function handleSseConnect(res: ServerResponse) {
    const transport = new SSEServerTransport("/message", res);
    const mcp = createMcpServer();
    const sessionId = transport.sessionId;

    sseSessions.set(sessionId, { transport, mcp });
    LOG(`SSE connect ${sessionId}`);

    res.on("close", () => {
        sseSessions.delete(sessionId);
        void mcp.close().catch(() => {});
        LOG(`SSE close ${sessionId}`);
    });

    await mcp.connect(transport);
}

async function handleSseMessage(req: IncomingMessage, res: ServerResponse, url: URL) {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) return sendJson(res, 400, { error: "Missing sessionId" });

    const session = sseSessions.get(sessionId);
    if (!session) return sendJson(res, 404, { error: "Unknown sessionId" });

    await session.transport.handlePostMessage(req, res);
}

/**
 * Streamable HTTP transport (the current MCP spec) served statelessly: one
 * throwaway server per request, so there is no session table to leak.
 */
async function handleStreamable(req: IncomingMessage, res: ServerResponse) {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = createMcpServer();

    res.on("close", () => {
        void transport.close().catch(() => {});
        void mcp.close().catch(() => {});
    });

    await mcp.connect(transport);

    if (req.method === "POST") {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return sendJson(res, 400, { error: "Invalid JSON body" });
        }
        if (DEBUG) LOG(`POST /mcp method=${(parsed as any)?.method ?? "?"}`);
        await transport.handleRequest(req, res, parsed);
        return;
    }

    await transport.handleRequest(req, res);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") return sendJson(res, 200, { ok: true });

    if (url.pathname === "/mcp") return handleStreamable(req, res);

    if (url.pathname === "/sse" && req.method === "GET") return handleSseConnect(res);
    if (url.pathname === "/message" && req.method === "POST") return handleSseMessage(req, res, url);

    return sendJson(res, 404, { error: "Not found" });
}

createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
        LOG(`request failed: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
}).listen(MCP_PORT, MCP_HOST, () => {
    LOG(`listening on ${MCP_HOST}:${MCP_PORT} (/mcp streamable, /sse legacy)`);
    LOG(`upstream ${OPENWEBUI_BASE_URL}`);
    LOG(`default collection ${DEFAULT_COLLECTION || "(unset)"}`);
});
