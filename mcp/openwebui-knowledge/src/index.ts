import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, sep } from "node:path";

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

/**
 * Similarity floor for search hits. OpenWebUI applies its own RELEVANCE_THRESHOLD
 * only on the hybrid path, so filtering happens here. Recalibrate after changing
 * the embedding model or chunk size — the scale moves with them.
 */
const MIN_SCORE = Number(process.env.OPENWEBUI_MIN_SCORE ?? "0.76");

// OpenWebUI paginates knowledge and file listings server-side at a fixed size.
const PAGE_ITEM_COUNT = 30;

// Extraction and embedding run in a background task after an upload. How long
// the upload tools wait for that to finish before reporting settled:false.
const UPLOAD_SETTLE_MS = Number(process.env.OPENWEBUI_UPLOAD_SETTLE_MS ?? "60000");
const UPLOAD_POLL_MS = 2000;

/**
 * Directories `upload_document_from_path` may read, colon-separated. A path
 * parameter otherwise means "put any file on this machine into the knowledge
 * base", so the default is empty and every path is refused until the owner
 * lists roots explicitly.
 */
const UPLOAD_ROOTS = (process.env.OPENWEBUI_UPLOAD_ROOTS ?? "")
    .split(":")
    .map((r) => r.trim())
    .filter(Boolean);

// A path upload reads the whole file into memory twice (buffer, then Blob), so
// one oversized file would otherwise take the server down with it.
const UPLOAD_MAX_BYTES = Number(process.env.OPENWEBUI_UPLOAD_MAX_BYTES ?? "33554432");

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
    // sha256 of the uploaded bytes, computed by OpenWebUI on upload.
    hash?: string;
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

/** Files still being extracted and embedded. They are not linked to the collection yet. */
function pendingFiles(collectionId: string): Promise<FileItem[]> {
    return getJson(`/api/v1/knowledge/${encodeURIComponent(collectionId)}/files/pending`);
}

/** Every file in the collection carrying exactly this name, across all pages. */
async function filesNamed(collectionId: string, filename: string): Promise<FileItem[]> {
    const found: FileItem[] = [];
    for (let page = 1; ; page++) {
        const { items, total } = await listKnowledgeFiles(collectionId, page, filename);
        found.push(...items.filter((f) => fileName(f) === filename));
        if (items.length === 0 || page * PAGE_ITEM_COUNT >= total) return found;
    }
}

export type PathRefusal = "no_roots" | "not_found" | "not_a_file" | "outside_roots" | "too_large";

/** Carries a code the caller can branch on, not just prose. */
export class UploadPathError extends Error {
    constructor(readonly reason: PathRefusal, detail: string) {
        super(`${reason}: ${detail}`);
        this.name = "UploadPathError";
    }
}

// A symlinked root has to be compared against its real path, so resolve once.
let rootsOnce: Promise<string[]> | null = null;
function uploadRoots(): Promise<string[]> {
    rootsOnce ??= Promise.all(UPLOAD_ROOTS.map((r) => realpath(r).catch(() => r)));
    return rootsOnce;
}

/**
 * Resolves a caller-supplied path and refuses anything outside the allowlist.
 * realpath first, compare second — checking the raw string lets `..` and a
 * symlink walk straight out of the allowed roots.
 */
export async function resolveUploadPath(input: string): Promise<string> {
    if (UPLOAD_ROOTS.length === 0) {
        throw new UploadPathError(
            "no_roots",
            "path uploads are disabled; set OPENWEBUI_UPLOAD_ROOTS to the directories the server may read"
        );
    }

    let real: string;
    try {
        real = await realpath(input);
    } catch {
        throw new UploadPathError("not_found", input);
    }

    const roots = await uploadRoots();
    const inside = roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep));
    if (!inside) throw new UploadPathError("outside_roots", real);

    const info = await stat(real);
    if (!info.isFile()) throw new UploadPathError("not_a_file", real);
    if (info.size > UPLOAD_MAX_BYTES) {
        throw new UploadPathError("too_large", `${real} is ${info.size} bytes, over OPENWEBUI_UPLOAD_MAX_BYTES`);
    }
    return real;
}

/** Uploads bytes and lets OpenWebUI link them itself; see the note in putDocument. */
async function uploadIntoCollection(collectionId: string, filename: string, body: Uint8Array): Promise<FileItem> {
    const form = new FormData();
    // Copied into a fresh view: a Buffer is backed by ArrayBufferLike, which is not a BlobPart.
    form.append("file", new Blob([new Uint8Array(body)], { type: "text/markdown" }), filename);
    // A plain form field, not a Blob — a Blob part arrives as an upload and the
    // endpoint rejects it (metadata is declared Form(dict | str)).
    form.append("metadata", JSON.stringify({ knowledge_id: collectionId }));

    // Multipart: fetch sets its own boundary, so the JSON Content-Type from headers() must not leak in.
    const url = `${OPENWEBUI_BASE_URL}/api/v1/files/`;
    const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENWEBUI_API_KEY}`, Accept: "application/json" },
        body: form,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new OpenWebUIError(res.status, url, await res.text().catch(() => ""));
    return (await res.json()) as FileItem;
}

/** Resolves true once the file is linked, false once the budget runs out. */
async function waitForLink(collectionId: string, fileId: string, filename: string, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
        const linked = await filesNamed(collectionId, filename).catch(() => [] as FileItem[]);
        if (linked.some((f) => f.id === fileId)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, UPLOAD_POLL_MS));
    }
}

type PutResult = {
    file_id: string;
    filename: string;
    bytes: number;
    replaced: string[];
    detach_failed: string[];
    settled: boolean;
    unchanged: boolean;
};

/**
 * The single write path behind both upload tools.
 *
 * Two orderings matter here. `metadata.knowledge_id` makes OpenWebUI embed into
 * the collection and link the file itself, which avoids the race a separate
 * `file/add` loses. And OpenWebUI links only *after* embedding, so a replacement
 * can be detached only once the new file is linked — otherwise the collection
 * spends the embedding window with no copy of the document at all. A replace
 * therefore waits, and on timeout keeps the old version and reports nothing
 * replaced.
 */
async function putDocument(args: {
    collectionId: string;
    filename: string;
    body: Uint8Array;
    replace: boolean;
    waitMs: number;
}): Promise<PutResult> {
    const { collectionId, filename, body, replace, waitMs } = args;
    const bytes = body.byteLength;
    const digest = createHash("sha256").update(body).digest("hex");
    const existing = await filesNamed(collectionId, filename);

    // OpenWebUI refuses to attach a byte-identical file anyway; matching its own
    // sha256 turns that refusal into a plain no-op the caller can read.
    const identical = existing.find((f) => f.hash === digest);
    if (identical) {
        return { file_id: identical.id, filename, bytes, replaced: [], detach_failed: [], settled: true, unchanged: true };
    }

    const file = await uploadIntoCollection(collectionId, filename, body);

    // A replace has to wait, so callers pass a positive budget for it; see the tools.
    const settled = waitMs > 0 ? await waitForLink(collectionId, file.id, filename, waitMs) : false;

    const replaced: string[] = [];
    const detach_failed: string[] = [];
    if (replace && settled) {
        for (const old of existing) {
            // Record only what actually came off. Reporting a failed detach as done
            // tells the caller the old copy is gone while it is still being searched.
            const gone = await postJson(`/api/v1/knowledge/${encodeURIComponent(collectionId)}/file/remove`, {
                file_id: old.id,
            })
                .then(() => true)
                .catch(() => false);
            (gone ? replaced : detach_failed).push(old.id);
        }
    }

    return { file_id: file.id, filename, bytes, replaced, detach_failed, settled, unchanged: false };
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
    const mcp = new McpServer({ name: "openwebui-knowledge", version: "1.1.0" });

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
                "defaults to OPENWEBUI_DEFAULT_COLLECTION. Optional `query` filters by filename. " +
                "`pending` lists files still being embedded: they are not in `files` yet and are not " +
                "searchable, but they are not lost either.",
            inputSchema: {
                collection: z.string().optional(),
                query: z.string().optional(),
                page: z.number().int().min(1).optional(),
            },
        },
        guard(async ({ collection, query, page }: { collection?: string; query?: string; page?: number }) => {
            const id = await resolveCollection(collection);
            const p = page ?? 1;
            const [{ items, total }, pending] = await Promise.all([
                listKnowledgeFiles(id, p, query),
                pendingFiles(id).catch(() => [] as FileItem[]),
            ]);

            return ok({
                ok: true,
                collection: { id },
                ...paging(p, total),
                files: items.map((f) => ({
                    file_id: f.id,
                    name: fileName(f),
                    size: f.meta?.size,
                })),
                // OpenWebUI links a file only after its embedding finishes, so `files`
                // is accurate but not yet complete. These are on the way in; a document
                // missing from both lists is genuinely absent.
                pending: pending.map((f) => ({ file_id: f.id, name: fileName(f) })),
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
                min_score: z.number().min(0).max(1).optional(),
            },
        },
        guard(
            async ({
                query,
                collection,
                collections,
                k,
                hybrid,
                min_score,
            }: {
                query: string;
                collection?: string;
                collections?: string[];
                k?: number;
                hybrid?: boolean;
                min_score?: number;
            }) => {
                const refs = collections?.length ? collections : [collection ?? ""];
                const ids = await mapLimit(refs, 4, (ref) => resolveCollection(ref || undefined));

                // Off by default: the hybrid path re-embeds every candidate per query.
                const found = await searchCollections(ids, query, k ?? 8, hybrid ?? false);
                const floor = min_score ?? MIN_SCORE;
                const results = found.filter((r) => (r.distance ?? 0) >= floor);

                return ok({
                    ok: true,
                    collections: ids,
                    query,
                    min_score: floor,
                    count: results.length,
                    ...(results.length === 0 && found.length > 0
                        ? {
                              nothing_above_threshold: true,
                              best_score_seen: Math.max(...found.map((r) => r.distance ?? 0)),
                              hint: "Nothing relevant enough in this collection — say so instead of "
                                  + "answering from the chunks.",
                          }
                        : {}),
                    results,
                });
            }
        )
    );


    /* -------------------------------------------------------------- *
     * Write side. Creating a collection and putting documents in it.
     * -------------------------------------------------------------- */

    mcp.registerTool(
        "create_collection",
        {
            description:
                "Create a knowledge collection. Returns its id. If a collection with the same name already " +
                "exists the existing one is returned untouched, so this is safe to call again.",
            inputSchema: {
                name: z.string().min(1),
                description: z.string().optional(),
            },
        },
        guard(async ({ name, description }: { name: string; description?: string }) => {
            const existing = await listKnowledge(1, name).catch(() => null);
            const hit = (existing?.items ?? []).find(
                (k) => (k.name ?? "").toLowerCase() === name.trim().toLowerCase()
            );
            if (hit) return ok({ ok: true, created: false, id: hit.id, name: hit.name, description: hit.description });

            const made = await postJson<KnowledgeItem>("/api/v1/knowledge/create", {
                name,
                description: description ?? "",
            });
            return ok({ ok: true, created: true, id: made.id, name: made.name, description: made.description });
        })
    );

    mcp.registerTool(
        "upload_document",
        {
            description:
                "Put a text document into a knowledge collection: uploads the content as a file and attaches it. " +
                "`collection` accepts an id or a name; defaults to OPENWEBUI_DEFAULT_COLLECTION. " +
                "Set `replace` to drop any file already in the collection with the same filename, which is what " +
                "you want when re-syncing a document that changed. Returns as soon as the upload is accepted; " +
                "`settled: false` means embedding is still running in the background, not that it failed. " +
                "Set `wait` to block until it finishes. Prefer upload_document_from_path when the file is on disk.",
            inputSchema: {
                filename: z.string().min(1),
                content: z.string().min(1),
                collection: z.string().optional(),
                replace: z.boolean().optional(),
                wait: z.boolean().optional(),
            },
        },
        guard(
            async ({
                filename,
                content,
                collection,
                replace,
                wait,
            }: {
                filename: string;
                content: string;
                collection?: string;
                replace?: boolean;
                wait?: boolean;
            }) => {
                const collectionId = await resolveCollection(collection);
                const result = await putDocument({
                    collectionId,
                    filename,
                    body: new TextEncoder().encode(content),
                    replace: replace ?? false,
                    // A replace waits whether or not `wait` was asked for: the old version
                    // is detached only once the new one is linked.
                    waitMs: wait || replace ? UPLOAD_SETTLE_MS : 0,
                });

                return ok({
                    ok: true,
                    collection: collectionId,
                    file_id: result.file_id,
                    filename: result.filename,
                    // Characters, not bytes: Cyrillic is two UTF-8 bytes apiece, so this reads well
                    // below the stored size. list_documents reports the real byte count.
                    chars: content.length,
                    replaced: result.replaced,
                    settled: result.settled,
                });
            }
        )
    );

    mcp.registerTool(
        "upload_document_from_path",
        {
            description:
                "Attach a file the server can read from disk, given its absolute path, so the text never has to " +
                "travel through the conversation. Reads only under OPENWEBUI_UPLOAD_ROOTS, which is empty by " +
                "default and refuses every path until the owner lists roots. `filename` defaults to the " +
                "basename; `collection` takes an id or a name. Returns `unchanged: true` and touches nothing " +
                "when the collection already holds a byte-identical file of that name. Returns without waiting " +
                "for embedding unless `wait` is set — `settled: false` is a queue, not a failure, and retrying " +
                "on it duplicates the document. `replace` waits regardless, because the previous version is " +
                "detached only once the new one is linked; on timeout the old version stays and `replaced` is " +
                "empty; anything that did not come off is listed in `detach_failed`. Path refusals carry a code: " +
                "no_roots, not_found, not_a_file, outside_roots, too_large.",
            inputSchema: {
                path: z.string().min(1),
                collection: z.string().optional(),
                filename: z.string().optional(),
                replace: z.boolean().optional(),
                wait: z.boolean().optional(),
                timeout_s: z.number().int().min(1).max(900).optional(),
            },
        },
        guard(
            async ({
                path,
                collection,
                filename,
                replace,
                wait,
                timeout_s,
            }: {
                path: string;
                collection?: string;
                filename?: string;
                replace?: boolean;
                wait?: boolean;
                timeout_s?: number;
            }) => {
                const real = await resolveUploadPath(path);
                const collectionId = await resolveCollection(collection);
                const body = await readFile(real);
                const budgetMs = (timeout_s ?? UPLOAD_SETTLE_MS / 1000) * 1000;

                const result = await putDocument({
                    collectionId,
                    filename: filename ?? basename(real),
                    body,
                    replace: replace ?? false,
                    waitMs: wait || replace ? budgetMs : 0,
                });

                return ok({ ok: true, collection: collectionId, path: real, ...result });
            }
        )
    );

    mcp.registerTool(
        "remove_document",
        {
            description:
                "Detach a file from a knowledge collection by file_id. The file itself stays in OpenWebUI.",
            inputSchema: {
                file_id: z.string().min(1),
                collection: z.string().optional(),
            },
        },
        guard(async ({ file_id, collection }: { file_id: string; collection?: string }) => {
            const collectionId = await resolveCollection(collection);
            await postJson(`/api/v1/knowledge/${encodeURIComponent(collectionId)}/file/remove`, { file_id });
            return ok({ ok: true, collection: collectionId, file_id, removed: true });
        })
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

// The path allowlist is unit-tested by importing this module, which must not
// bind the port while doing so.
if (process.env.MCP_NO_LISTEN !== "1") {
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
}
