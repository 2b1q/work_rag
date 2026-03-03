import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const MCP_HOST = process.env.MCP_HOST ?? "0.0.0.0";
const MCP_PORT = Number(process.env.MCP_PORT ?? "8787");

const OPENWEBUI_BASE_URL = process.env.OPENWEBUI_BASE_URL ?? "http://openwebui:8080";
const OPENWEBUI_API_KEY = process.env.OPENWEBUI_API_KEY ?? "";
const DEFAULT_COLLECTION = process.env.OPENWEBUI_DEFAULT_COLLECTION ?? "";

if (!DEFAULT_COLLECTION) {
    throw new Error("OPENWEBUI_DEFAULT_COLLECTION is required");
}

const LOG = (msg: string, data?: unknown) => {
    // eslint-disable-next-line no-console
    !data ? console.log(`[MCP] ${msg}`) : console.log(`[MCP] ${msg}`, data);
};

type RetrievalResponse = {
    distances?: number[][];
    documents?: string[][];
    metadatas?: Array<Array<Record<string, unknown>>>;
};

type FileDto = {
    file_id: string;
    name?: string;
    source?: string;
    size?: number;
    created_at?: string;
    updated_at?: string;
};

type ListCollectionsResponse = {
    ok: true;
    default_collection: string;
    page: number;
    collections: Array<{
        id: string;
        name?: string;
        description?: string;
        files_count?: number;
        updated_at?: string | number;
    }>;
    raw_shape: {
        endpoint: string;
        keys: string[];
        sample_keys: Record<string, string[]>;
    };
};

type ListDocumentsResponse = {
    ok: true;
    default_collection: string;
    collection: {
        id: string;
        name?: string;
        files_count?: number;
        updated_at?: string;
    };
    page: number;
    files: FileDto[];
    raw_shape: {
        endpoint: string;
        keys: string[];
        sample_keys: Record<string, string[]>;
    };
};

type ContextSelectionResponse = {
    ok: true;
    default_collection: string;
    selected_file_ids: string[];
    files: Array<{
        file_id: string;
        name?: string;
        source?: string;
        size?: number;
        created_at?: string;
        updated_at?: string;
    }>;
};

function jsonHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${OPENWEBUI_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
    };
}

async function httpJson<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
    }
    return (await res.json()) as T;
}

async function httpText(url: string, init: RequestInit): Promise<string> {
    const res = await fetch(url, init);
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`);
    }
    return await res.text();
}

function normalize(raw: RetrievalResponse) {
    const distances = raw.distances?.[0] ?? [];
    const documents = raw.documents?.[0] ?? [];
    const metadatas = raw.metadatas?.[0] ?? [];

    return documents
        .map((text, i) => ({
            text: (text ?? "").trim(),
            distance: typeof distances[i] === "number" ? distances[i] : undefined,
            metadata: metadatas[i] ?? {},
        }))
        .filter((x) => x.text.length > 0);
}

function pickCollections(input?: { collection?: string; collections?: string[] }): string[] {
    if (input?.collections?.length) return input.collections;
    if (input?.collection) return [input.collection];
    return [DEFAULT_COLLECTION];
}

async function searchCollections(args: { collections: string[]; query: string; k: number; hybrid: boolean }) {
    const url = `${OPENWEBUI_BASE_URL}/api/v1/retrieval/query/collection`;
    const body = {
        collection_names: args.collections,
        query: args.query,
        k: args.k,
        hybrid: args.hybrid,
    };

    const raw = await httpJson<RetrievalResponse>(url, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
    });

    return normalize(raw);
}

function shapeInfo(data: any) {
    if (!data || typeof data !== "object") return { keys: [] as string[], sample_keys: {} as Record<string, string[]> };

    const keys = Object.keys(data);
    const sample_keys: Record<string, string[]> = {};

    for (const k of keys.slice(0, 12)) {
        const v = data[k];
        if (v && typeof v === "object" && !Array.isArray(v)) {
            sample_keys[k] = Object.keys(v).slice(0, 20);
        } else if (Array.isArray(v)) {
            sample_keys[k] = [`Array(len=${v.length})`];
        } else {
            sample_keys[k] = [typeof v];
        }
    }

    return { keys, sample_keys };
}

function pickCollectionMeta(data: any, collectionId: string) {
    const c = data?.collection ?? data?.data?.collection ?? data;

    return {
        id: c?.id ?? c?._id ?? c?.uuid ?? collectionId,
        name: c?.name ?? c?.title ?? c?.collection_name,
        files_count: c?.files_count ?? c?.filesCount ?? c?.file_count,
        updated_at: c?.updated_at ?? c?.updatedAt,
    };
}

function fileToDto(x: any): FileDto | null {
    if (!x || typeof x !== "object") return null;

    const file_id = x.id ?? x._id ?? x.file_id ?? x.fileId ?? x.uuid ?? x?.file?.id ?? x?.document?.id;
    if (!file_id || typeof file_id !== "string") return null;

    const name =
        x.filename ??
        x.name ??
        x?.meta?.name ??
        x?.file?.name ??
        x?.document?.name ??
        x?.file?.filename ??
        x?.document?.filename;

    const source = x.source ?? x.origin ?? x?.meta?.source;
    const size = x?.meta?.size ?? x.size ?? x.file_size ?? x.fileSize;

    const created_at = x.created_at ?? x.createdAt;
    const updated_at = x.updated_at ?? x.updatedAt;

    return {
        file_id,
        name: typeof name === "string" ? name : undefined,
        source: typeof source === "string" ? source : undefined,
        size: typeof size === "number" ? size : undefined,
        created_at: typeof created_at === "string" ? created_at : undefined,
        updated_at: typeof updated_at === "string" ? updated_at : undefined,
    };
}

function hasAnyId(x: any): boolean {
    if (!x || typeof x !== "object") return false;
    const raw = x?.file ?? x?.document ?? x;
    const id = raw?.id ?? raw?._id ?? raw?.file_id ?? raw?.fileId ?? raw?.uuid;
    return typeof id === "string" && id.length > 0;
}

function extractFromContainer(v: any): any[] {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v !== "object") return [];

    const known = [
        (v as any).items,
        (v as any).data,
        (v as any).results,
        (v as any).files,
        (v as any).documents,
        (v as any).knowledge_files,
    ];

    for (const k of known) {
        if (Array.isArray(k)) return k;
        if (k && typeof k === "object") {
            const nested = extractFromContainer(k);
            if (nested.length) return nested;
        }
    }

    const vals = Object.values(v);
    if (vals.some(hasAnyId)) return vals;

    for (const val of vals) {
        if (val && typeof val === "object") {
            const nested = extractFromContainer(val);
            if (nested.length) return nested;
        }
    }

    return [];
}

function extractFilesDeep(data: any): any[] {
    const directCandidates = [
        data?.files,
        data?.documents,
        data?.knowledge_files,
        data?.items,
        data?.results,
        data?.data?.files,
        data?.data?.documents,
        data?.data?.knowledge_files,
        data?.data?.items,
        data?.data?.results,
        data?.collection?.files,
        data?.collection?.documents,
        data?.collection?.knowledge_files,
        data?.data?.collection?.files,
        data?.data?.collection?.documents,
        data?.data?.collection?.knowledge_files,
    ].filter(Boolean);

    for (const c of directCandidates) {
        const arr = extractFromContainer(c);
        if (arr.length && arr.some(hasAnyId)) return arr;
    }

    const visited = new Set<any>();
    const queue: any[] = [data];

    while (queue.length) {
        const cur = queue.shift();
        if (!cur || typeof cur !== "object") continue;
        if (visited.has(cur)) continue;
        visited.add(cur);

        for (const v of Object.values(cur)) {
            const extracted = extractFromContainer(v);
            if (extracted.length && extracted.some(hasAnyId)) return extracted;

            if (Array.isArray(v)) {
                for (const el of v) queue.push(el);
            } else if (v && typeof v === "object") {
                queue.push(v);
            }
        }
    }

    return [];
}

async function listDocumentsByCollection(collectionId: string, page: number): Promise<ListDocumentsResponse> {
    const q = new URLSearchParams({ page: String(page) }).toString();

    const candidates = [
        `${OPENWEBUI_BASE_URL}/api/v1/knowledge/${collectionId}/files?${q}`,
        `${OPENWEBUI_BASE_URL}/api/v1/knowledge/${collectionId}/documents?${q}`,
        `${OPENWEBUI_BASE_URL}/api/v1/knowledge/files?collection_id=${encodeURIComponent(collectionId)}&${q}`,
        `${OPENWEBUI_BASE_URL}/api/v1/knowledge/${collectionId}`,
    ];

    let lastErr: unknown;

    for (const url of candidates) {
        try {
            const data = await httpJson<any>(url, { method: "GET", headers: jsonHeaders() });

            const rawFiles = extractFilesDeep(data);
            const files = rawFiles.map(fileToDto).filter((x): x is FileDto => Boolean(x?.file_id));

            return {
                ok: true,
                default_collection: DEFAULT_COLLECTION,
                collection: pickCollectionMeta(data, collectionId),
                page,
                files,
                raw_shape: {
                    endpoint: url,
                    ...shapeInfo(data),
                },
            };
        } catch (err) {
            lastErr = err;
        }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getDocumentByFileId(fileId: string) {
    const candidates = [
        `${OPENWEBUI_BASE_URL}/api/v1/knowledge/file/${fileId}`,
        `${OPENWEBUI_BASE_URL}/api/v1/knowledge/files/${fileId}`,
        `${OPENWEBUI_BASE_URL}/api/v1/files/${fileId}`,
    ];

    let lastErr: unknown;

    for (const url of candidates) {
        try {
            try {
                const data = await httpJson<any>(url, { method: "GET", headers: jsonHeaders() });
                const text =
                    (typeof data?.content === "string" && data.content) ||
                    (typeof data?.text === "string" && data.text) ||
                    (typeof data?.data?.content === "string" && data.data.content) ||
                    "";

                return {
                    ok: true,
                    file_id: fileId,
                    endpoint: url,
                    content_type: "application/json",
                    document: text,
                    meta: {
                        name: data?.name ?? data?.filename ?? data?.data?.name,
                        source: data?.source ?? data?.data?.source,
                    },
                    raw_shape: shapeInfo(data),
                };
            } catch {
                const text = await httpText(url, { method: "GET", headers: jsonHeaders() });
                return {
                    ok: true,
                    file_id: fileId,
                    endpoint: url,
                    content_type: "text/plain",
                    document: text,
                };
            }
        } catch (err) {
            lastErr = err;
        }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function listCollectionsPage(page: number): Promise<ListCollectionsResponse> {
    const q = new URLSearchParams({ page: String(page) }).toString();

    const candidates = [
        `${OPENWEBUI_BASE_URL}/api/v1/knowledge/search?${q}`,
        `${OPENWEBUI_BASE_URL}/api/v1/knowledge/search?page=${page}`,
        `${OPENWEBUI_BASE_URL}/api/v1/knowledge/?${q}`,
        `${OPENWEBUI_BASE_URL}/api/v1/knowledge/`,
    ];

    let lastErr: unknown;

    for (const url of candidates) {
        try {
            const data = await httpJson<any>(url, { method: "GET", headers: jsonHeaders() });

            const items: any[] =
                (Array.isArray(data) && data) ||
                (Array.isArray(data?.data) && data.data) ||
                (Array.isArray(data?.items) && data.items) ||
                (Array.isArray(data?.results) && data.results) ||
                [];

            const collections = items
                .map((x) => ({
                    id: x?.id ?? x?._id ?? x?.uuid,
                    name: x?.name ?? x?.title ?? x?.collection_name,
                    description: x?.description,
                    files_count: x?.files_count ?? x?.filesCount ?? x?.file_count,
                    updated_at: x?.updated_at ?? x?.updatedAt,
                }))
                .filter((c) => typeof c.id === "string" && c.id.length > 0);

            return {
                ok: true,
                default_collection: DEFAULT_COLLECTION,
                page,
                collections,
                raw_shape: {
                    endpoint: url,
                    ...shapeInfo(data),
                },
            };
        } catch (err) {
            lastErr = err;
        }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function createMcpServer(): McpServer {
    const mcp = new McpServer({ name: "openwebui-knowledge", version: "0.7.0" });

    mcp.tool("ping_openwebui", "Check OpenWebUI API access using /api/models", {}, async () => {
        const url = `${OPENWEBUI_BASE_URL}/api/models`;
        const res = await httpJson<any>(url, { method: "GET", headers: jsonHeaders() });

        const modelIds: string[] = Array.isArray(res?.data) ? res.data.map((m: any) => m?.id).filter(Boolean) : [];

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ ok: true, models_count: modelIds.length, sample: modelIds.slice(0, 10) }, null, 2),
                },
            ],
        };
    });

    mcp.tool(
        "list_collections",
        "List OpenWebUI knowledge collections (paged). Returns {name,id} per collection.",
        {
            page: z.number().int().min(1).optional(),
            limit: z.number().int().min(1).max(50).optional(),
        },
        async (input) => {
            const page = input.page ?? 1;
            const limit = input.limit ?? 10;

            const data = await listCollectionsPage(page);
            const trimmed = data.collections.slice(0, limit).map((c) => ({ id: c.id, name: c.name }));

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                ok: true,
                                default_collection: DEFAULT_COLLECTION,
                                page,
                                limit,
                                collections: trimmed,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    mcp.tool(
        "list_documents",
        "List documents (files) inside a knowledge collection by collection id (default if not specified).",
        {
            collection: z.string().optional(),
            page: z.number().int().min(1).optional(),
        },
        async (input) => {
            const collectionId = input.collection ?? DEFAULT_COLLECTION;
            const page = input.page ?? 1;

            const data = await listDocumentsByCollection(collectionId, page);
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
    );

    mcp.tool(
        "get_document",
        "Get document content by OpenWebUI file_id",
        { file_id: z.string().min(1) },
        async (input) => {
            const data = await getDocumentByFileId(input.file_id);
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
    );

    mcp.tool(
        "select_context_files",
        "Fetch multiple documents by file_id and return concatenated context text (for pasting into coding prompt).",
        {
            file_ids: z.array(z.string().min(1)).min(1).max(20),
            max_chars_per_file: z.number().int().min(200).max(200_000).optional(),
        },
        async (input) => {
            const maxChars = input.max_chars_per_file ?? 60_000;

            const results = await Promise.all(
                input.file_ids.map(async (file_id) => {
                    const doc = await getDocumentByFileId(file_id);
                    const text = typeof doc?.document === "string" ? doc.document : "";
                    const clipped = text.length > maxChars ? text.slice(0, maxChars) : text;

                    const name =
                        typeof (doc as any)?.meta?.name === "string"
                            ? (doc as any).meta.name
                            : undefined;

                    const source =
                        typeof (doc as any)?.meta?.source === "string"
                            ? (doc as any).meta.source
                            : undefined;

                    return { file_id, name, source, text: clipped };
                })
            );

            const context = results
                .map((r) => {
                    const header = [
                        "-----",
                        `file_id: ${r.file_id}`,
                        r.name ? `name: ${r.name}` : null,
                        r.source ? `source: ${r.source}` : null,
                        "-----",
                    ]
                        .filter(Boolean)
                        .join("\n");

                    return `${header}\n${r.text}\n`;
                })
                .join("\n");

            const files = results.map((r) => ({
                file_id: r.file_id,
                name: r.name,
                source: r.source,
            }));

            const payload: ContextSelectionResponse = {
                ok: true,
                default_collection: DEFAULT_COLLECTION,
                selected_file_ids: input.file_ids,
                files,
            };

            return {
                content: [
                    { type: "text", text: JSON.stringify(payload, null, 2) },
                    { type: "text", text: context },
                ],
            };
        }
    );

    mcp.tool(
        "search_knowledge",
        "Search OpenWebUI knowledge via retrieval (uses default collection if not specified).",
        {
            query: z.string().min(1),
            k: z.number().int().min(1).max(30).optional(),
            hybrid: z.boolean().optional(),
            collection: z.string().optional(),
        },
        async (input) => {
            const collections = pickCollections({ collection: input.collection });
            const k = input.k ?? 8;
            const hybrid = input.hybrid ?? true;

            const results = await searchCollections({ collections, query: input.query, k, hybrid });

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                default_collection: DEFAULT_COLLECTION,
                                collections,
                                query: input.query,
                                results: results.map((r) => ({
                                    distance: r.distance,
                                    source: (r.metadata as any)?.source,
                                    name: (r.metadata as any)?.name,
                                    file_id: (r.metadata as any)?.file_id,
                                    start_index: (r.metadata as any)?.start_index,
                                    text: r.text,
                                })),
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    mcp.tool(
        "search_knowledge_multi",
        "Search multiple OpenWebUI knowledge collections via retrieval.",
        {
            query: z.string().min(1),
            collections: z.array(z.string().min(1)).min(1),
            k: z.number().int().min(1).max(30).optional(),
            hybrid: z.boolean().optional(),
        },
        async (input) => {
            const k = input.k ?? 8;
            const hybrid = input.hybrid ?? true;

            const results = await searchCollections({ collections: input.collections, query: input.query, k, hybrid });

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                collections: input.collections,
                                query: input.query,
                                results: results.map((r) => ({
                                    distance: r.distance,
                                    source: (r.metadata as any)?.source,
                                    name: (r.metadata as any)?.name,
                                    file_id: (r.metadata as any)?.file_id,
                                    start_index: (r.metadata as any)?.start_index,
                                    text: r.text,
                                })),
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    return mcp;
}

type Session = {
    transport: SSEServerTransport;
    mcp: McpServer;
};

const sessions = new Map<string, Session>();

function sendJson(res: ServerResponse, code: number, payload: unknown) {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function cloneRequestWithBody(original: IncomingMessage, body: Buffer): IncomingMessage {
    const stream = new PassThrough();
    stream.end(body);

    (stream as any).headers = original.headers;
    (stream as any).method = original.method;
    (stream as any).url = original.url;

    return stream as any;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health" && req.method === "GET") {
        return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/message", res);
        const mcp = createMcpServer();

        const sessionId = (transport as any).sessionId as string | undefined;
        if (!sessionId) {
            sendJson(res, 500, { error: "Missing sessionId in SSE transport" });
            return;
        }

        sessions.set(sessionId, { transport, mcp });
        LOG(`SSE CONNECT sessionId=${sessionId}`);

        res.on("close", () => {
            sessions.delete(sessionId);
            try {
                (transport as any).close?.();
                (mcp as any).close?.();
            } catch {
                // ignore
            }
            LOG(`SSE CLOSE sessionId=${sessionId}`);
        });

        await mcp.connect(transport);
        return;
    }

    if (url.pathname === "/message" && req.method === "POST") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) return sendJson(res, 400, { error: "Missing sessionId" });

        const session = sessions.get(sessionId);
        if (!session) return sendJson(res, 404, { error: "Unknown sessionId" });

        const body = await readBody(req);

        const raw = body.toString("utf8");
        try {
            const parsed = JSON.parse(raw);
            const method = typeof parsed?.method === "string" ? parsed.method : undefined;
            LOG(`POST /message sessionId=${sessionId}${method ? ` method=${method}` : ""}`, parsed);
        } catch {
            LOG(`POST /message sessionId=${sessionId} (non-json)`, raw.slice(0, 2000));
        }

        const req2 = cloneRequestWithBody(req, body);
        await (session.transport as any).handlePostMessage(req2, res);
        return;
    }

    sendJson(res, 404, { error: "Not found" });
}

createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
}).listen(MCP_PORT, MCP_HOST, () => {
    LOG(`LISTEN ${MCP_HOST}:${MCP_PORT}`);
    LOG(`DEFAULT_COLLECTION=${DEFAULT_COLLECTION}`);
});