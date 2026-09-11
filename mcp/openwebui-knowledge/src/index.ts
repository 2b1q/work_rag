import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, sep } from "node:path";

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

// Browser origins allowed to call /mcp. An MCP client sends no Origin at all.
const ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

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
const UPLOAD_SETTLE_MS = Number(process.env.OPENWEBUI_UPLOAD_SETTLE_MS ?? "45000");
const UPLOAD_POLL_MS = 2000;

/**
 * How long a replace keeps trying to detach the old version after the caller has
 * gone. Embedding a large file runs for minutes, far past any single RPC, so the
 * detach outlives the call that asked for it.
 */
const REPLACE_DEADLINE_MS = Number(process.env.OPENWEBUI_REPLACE_DEADLINE_MS ?? "900000");

// An MCP call over a bridge is cut at about 60 s, and the bridge's own overhead
// eats 2-5 s of that, so a 55 s wait is measurably close enough to be cut. The
// cap stays at 55 for a client without a bridge; the default is what fits.
const WAIT_MAX_S = 55;
const WAIT_DEFAULT_S = 45;

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/* ------------------------------------------------------------------ *
 * OpenWebUI client
 * ------------------------------------------------------------------ */

// A model cannot branch on prose: "upstream is down" and "wrong name" read alike.
export type ToolErrorCode =
    | "openwebui_unreachable"
    | "openwebui_timeout"
    | "openwebui_http"
    | "no_default_collection"
    | "collection_not_found"
    | "collection_ambiguous"
    | "file_not_found"
    | "processing_failed"
    | "path_refused"
    | "invalid_argument"
    | "internal_error";

export class ToolError extends Error {
    readonly code: ToolErrorCode;
    readonly extra: Record<string, unknown>;

    constructor(code: ToolErrorCode, message: string, extra: Record<string, unknown> = {}) {
        super(message);
        this.name = "ToolError";
        this.code = code;
        this.extra = extra;
    }
}

export class OpenWebUIError extends ToolError {
    readonly status: number;
    readonly url: string;

    constructor(status: number, url: string, body: string) {
        super("openwebui_http", `OpenWebUI ${status} on ${url}${body ? `: ${body.slice(0, 500)}` : ""}`, {
            status,
            url,
            detail: body.slice(0, 500) || undefined,
            // 401/403 is the key, not the arguments: retrying cannot help.
            ...(status === 401 || status === 403 ? { auth: true } : {}),
        });
        this.name = "OpenWebUIError";
        this.status = status;
        this.url = url;
    }
}

// fetch reports a dead upstream as "fetch failed" and names no URL; the cause does.
function transportError(url: string, err: unknown): ToolError {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        return new ToolError("openwebui_timeout", `OpenWebUI did not answer ${url} within ${HTTP_TIMEOUT_MS} ms`, {
            url,
            timeout_ms: HTTP_TIMEOUT_MS,
        });
    }
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
    return new ToolError("openwebui_unreachable", `Cannot reach OpenWebUI at ${url}: ${detail}`, { url, detail });
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
    let res: Response;
    try {
        res = await fetch(url, {
            ...init,
            headers: headers(),
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
    } catch (err) {
        throw transportError(url, err);
    }

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

// pending -> processing -> completed|failed. Only `completed` is ever linked.
type FileData = { content?: string; status?: string; error?: string };

type FileItem = {
    id: string;
    filename?: string;
    // sha256 of the extracted *text*, nulled when processing fails. Bytes: meta.file_hash.
    hash?: string | null;
    meta?: {
        name?: string;
        size?: number;
        content_type?: string;
        file_hash?: string;
        // Whatever the uploader sent as `metadata`; knowledge_id lands here.
        data?: { knowledge_id?: string } & Record<string, unknown>;
    };
    data?: FileData;
    created_at?: number;
    updated_at?: number;
};

type FileDetail = FileItem;

type RetrievalResponse = {
    distances?: number[][];
    documents?: string[][];
    metadatas?: Array<Array<Record<string, unknown>>>;
};

type Chunk = {
    score?: number;
    /** @deprecated `score` says what this is: a similarity, where higher is better. */
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

type ListOrder = { order_by?: string; direction?: string };

function listKnowledgeFiles(
    collectionId: string,
    page: number,
    query?: string,
    order: ListOrder = {}
): Promise<Paged<FileItem>> {
    return getJson(
        `/api/v1/knowledge/${encodeURIComponent(collectionId)}/files${qs({ query, page, ...order })}`
    );
}

function getFile(fileId: string): Promise<FileDetail> {
    return getJson(`/api/v1/files/${encodeURIComponent(fileId)}`);
}

/**
 * The file record usually carries the extracted text already, so callers that
 * already hold one pass it in rather than paying for a second round trip.
 */
async function getFileContent(fileId: string, known?: FileDetail | null): Promise<string> {
    const file = known !== undefined ? known : await getFile(fileId);
    const inline = file?.data?.content;
    if (typeof inline === "string" && inline.length > 0) return inline;

    // Not /content: that serves the stored bytes, so a PDF comes back as a PDF.
    const res = await getJson<{ content?: string }>(`/api/v1/files/${encodeURIComponent(fileId)}/data/content`);
    return res.content ?? "";
}

/** Fetches a file record and its text in one pass. Only a 404 is an answer. */
async function getFileWithContent(fileId: string): Promise<{ file: FileDetail; text: string }> {
    let file: FileDetail;
    try {
        file = await getFile(fileId);
    } catch (err) {
        if (err instanceof OpenWebUIError && err.status === 404) {
            throw new ToolError("file_not_found", `No file ${fileId}. Call list_documents for the current ids.`, {
                file_id: fileId,
            });
        }
        throw err;
    }
    // A failed file has no text at all; saying so beats an empty string.
    if (file.data?.status === "failed") {
        throw new ToolError("processing_failed", `File ${fileId} failed processing: ${file.data.error ?? "no reason given"}`, {
            file_id: fileId,
            status: "failed",
            detail: file.data.error,
        });
    }
    return { file, text: await getFileContent(fileId, file) };
}

function fileName(f: FileItem): string | undefined {
    return f.meta?.name ?? f.filename;
}

/** Files still being extracted and embedded. They are not linked to the collection yet. */
function pendingFiles(collectionId: string): Promise<FileItem[]> {
    return getJson(`/api/v1/knowledge/${encodeURIComponent(collectionId)}/files/pending`);
}

// The file listing's own page size, which is not the knowledge one.
const FILES_PAGE_SIZE = 50;
const FAILED_SCAN_PAGES = 4;

/**
 * Files whose processing failed. In no other listing — files/pending reports only
 * pending|processing — so "absent from both" otherwise reads as "never uploaded".
 * No server-side filter exists, hence a bounded scan of the newest files.
 */
async function failedFiles(collectionId: string, maxPages = FAILED_SCAN_PAGES): Promise<FileItem[]> {
    const found: FileItem[] = [];
    for (let page = 1; page <= maxPages; page++) {
        const { items, total } = await getJson<Paged<FileItem>>(`/api/v1/files/${qs({ page, content: "false" })}`);
        for (const f of items) {
            if (f.data?.status === "failed" && f.meta?.data?.knowledge_id === collectionId) found.push(f);
        }
        if (items.length === 0 || page * FILES_PAGE_SIZE >= total) break;
    }
    return found;
}

/** Which document, and why it died. */
const describeFailure = (f: FileItem) => ({
    file_id: f.id,
    name: fileName(f),
    error: f.data?.error,
    created_at: f.created_at,
});

/** Every file in the collection carrying exactly this name, across all pages. */
async function filesNamed(collectionId: string, filename: string): Promise<FileItem[]> {
    const found: FileItem[] = [];
    for (let page = 1; ; page++) {
        const { items, total } = await listKnowledgeFiles(collectionId, page, filename);
        found.push(...items.filter((f) => fileName(f) === filename));
        if (items.length === 0 || page * PAGE_ITEM_COUNT >= total) return found;
    }
}

/**
 * True when every one of `ids` sits at the collection's top level. The listing
 * never says which folder a file is in, but `directory_id=` scopes it to the root.
 */
async function allAtRoot(collectionId: string, filename: string, ids: string[]): Promise<boolean> {
    const atRoot = new Set<string>();
    for (let page = 1; ; page++) {
        const path =
            `/api/v1/knowledge/${encodeURIComponent(collectionId)}/files` +
            `?directory_id=&page=${page}&query=${encodeURIComponent(filename)}`;
        const { items, total } = await getJson<Paged<FileItem>>(path);
        for (const f of items) if (fileName(f) === filename) atRoot.add(f.id);
        if (items.length === 0 || page * PAGE_ITEM_COUNT >= total) break;
    }
    return ids.every((id) => atRoot.has(id));
}

/** Every linked file in the collection, across all pages. */
async function allFiles(collectionId: string): Promise<FileItem[]> {
    const found: FileItem[] = [];
    for (let page = 1; ; page++) {
        const { items, total } = await listKnowledgeFiles(collectionId, page);
        found.push(...items);
        if (items.length === 0 || page * PAGE_ITEM_COUNT >= total) return found;
    }
}

/**
 * Not an unlink: `delete_file` defaults to `not ENABLE_KNOWLEDGE_FILE_RETENTION`,
 * so by default this deletes the file too. Undefined leaves that to the operator.
 */
function detachFile(collectionId: string, fileId: string, deleteFile?: boolean): Promise<unknown> {
    const query = deleteFile === undefined ? "" : qs({ delete_file: String(deleteFile) });
    return postJson(`/api/v1/knowledge/${encodeURIComponent(collectionId)}/file/remove${query}`, { file_id: fileId });
}

// OpenWebUI stamps updated_at when embedding finishes, so it orders versions of
// the same document better than created_at does.
const stamp = (f: FileItem): number => f.updated_at ?? f.created_at ?? 0;

export type PathRefusal = "no_roots" | "not_found" | "not_a_file" | "outside_roots" | "too_large";

/** Carries a code the caller can branch on, not just prose. */
export class UploadPathError extends ToolError {
    readonly reason: PathRefusal;

    constructor(reason: PathRefusal, detail: string) {
        super("path_refused", `${reason}: ${detail}`, { reason });
        this.name = "UploadPathError";
        this.reason = reason;
    }
}

// A symlinked root has to be compared against its real path, so resolve once.
let rootsOnce: Promise<string[]> | null = null;
function uploadRoots(): Promise<string[]> {
    rootsOnce ??= Promise.all(UPLOAD_ROOTS.map((r) => realpath(r).catch(() => r)));
    return rootsOnce;
}

/**
 * Refusals name the roots. A caller that guessed a host path cannot otherwise
 * tell where the server can read, and the roots are container paths, not secrets.
 */
function rootsHint(): string {
    return `readable roots (paths inside the container, mounted in docker-compose.override.yaml): ${UPLOAD_ROOTS.join(", ")}`;
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
        throw new UploadPathError("not_found", `${input}; ${rootsHint()}`);
    }

    const roots = await uploadRoots();
    const inside = roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep));
    if (!inside) throw new UploadPathError("outside_roots", `${real}; ${rootsHint()}`);

    const info = await stat(real);
    if (!info.isFile()) throw new UploadPathError("not_a_file", real);
    if (info.size > UPLOAD_MAX_BYTES) {
        throw new UploadPathError("too_large", `${real} is ${info.size} bytes, over OPENWEBUI_UPLOAD_MAX_BYTES`);
    }
    return real;
}

// The extension is what OpenWebUI validates; the media type is what reads it back.
const MEDIA_TYPES: Record<string, string> = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".csv": "text/csv",
    ".html": "text/html",
    ".pdf": "application/pdf",
};

function mediaTypeFor(filename: string): string {
    return MEDIA_TYPES[extname(filename).toLowerCase()] ?? "text/plain";
}

/** Uploads bytes and lets OpenWebUI link them itself; see the note in putDocument. */
async function uploadIntoCollection(collectionId: string, filename: string, body: Uint8Array): Promise<FileItem> {
    const form = new FormData();
    // Copied into a fresh view: a Buffer is backed by ArrayBufferLike, which is not a BlobPart.
    form.append("file", new Blob([new Uint8Array(body)], { type: mediaTypeFor(filename) }), filename);
    // A plain form field, not a Blob — a Blob part arrives as an upload and the
    // endpoint rejects it (metadata is declared Form(dict | str)).
    form.append("metadata", JSON.stringify({ knowledge_id: collectionId }));

    // Multipart: fetch sets its own boundary, so the JSON Content-Type from headers() must not leak in.
    const url = `${OPENWEBUI_BASE_URL}/api/v1/files/`;
    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${OPENWEBUI_API_KEY}`, Accept: "application/json" },
            body: form,
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
    } catch (err) {
        throw transportError(url, err);
    }
    if (!res.ok) throw new OpenWebUIError(res.status, url, await res.text().catch(() => ""));
    return (await res.json()) as FileItem;
}

// `linked: false, failed: false` is the only combination meaning "still going".
export type LinkOutcome = { linked: boolean; failed: boolean; error?: string };

/** Resolves once the file is linked, has failed, or the budget runs out. */
async function waitForLink(collectionId: string, fileId: string, filename: string, budgetMs: number): Promise<LinkOutcome> {
    const started = Date.now();
    const deadline = started + budgetMs;
    for (;;) {
        const linked = await filesNamed(collectionId, filename).catch(() => [] as FileItem[]);
        if (linked.some((f) => f.id === fileId)) return { linked: true, failed: false };

        // A failed file is never linked and never pending: without this, the loop
        // waits out its whole deadline on a document that is already gone.
        const status = await getFile(fileId).then(
            (f) => f.data,
            () => undefined
        );
        if (status?.status === "failed") return { linked: false, failed: true, error: status.error };

        if (Date.now() >= deadline) return { linked: false, failed: false };
        // Small files link in seconds; a big one takes minutes, and every poll is a
        // listing call, so slow down once the fast case has clearly not happened.
        await sleep(Date.now() - started < 60_000 ? UPLOAD_POLL_MS : UPLOAD_POLL_MS * 5);
    }
}

/**
 * A replace in flight: the new file is uploaded, the old versions are still
 * attached, and something has to take them off once the new one is linked.
 *
 * The map is module-level on purpose. The streamable transport builds a fresh
 * McpServer per request and closes it with the response, so a task owned by the
 * server instance would die with the call that started it — which is the failure
 * this exists to fix. It is not stored state: a task holds only what its own
 * loop needs, and a restart loses nothing a caller cannot see (the old version
 * simply stays attached, exactly as it did before, and dedupe_collection clears it).
 */
type ReplaceTask = {
    collection_id: string;
    file_id: string;
    filename: string;
    pending: string[];
    replaced: string[];
    detach_failed: string[];
    linked: boolean;
    /** The replacement failed processing: it never linked, and never will. */
    failed: boolean;
    process_error?: string;
    done: Promise<void>;
};

type ReplaceDone = {
    collection_id: string;
    file_id: string;
    name: string;
    linked: boolean;
    failed: boolean;
    replaced: string[];
    detach_failed: string[];
    finished_at: number;
    error?: string;
};

const replaceTasks = new Map<string, ReplaceTask>();

/**
 * The last few finished replaces. A task takes itself out of the live map when it
 * ends, so without this a detach that failed — or a replacement that never linked
 * before the deadline — reads exactly like a clean run to whoever asks next. Only
 * as long as the process: a restart is the one case this cannot report, which is
 * why the upload tools name dedupe_collection as the check.
 */
const REPLACE_HISTORY = 20;
const replaceHistory: ReplaceDone[] = [];

function liveReplaces(collectionId: string): ReplaceTask[] {
    return [...replaceTasks.values()].filter((t) => t.collection_id === collectionId);
}

export function recentReplaces(collectionId: string): ReplaceDone[] {
    return replaceHistory.filter((r) => r.collection_id === collectionId);
}

/** True of a finished replace that did not do everything it promised. */
const incomplete = (r: ReplaceDone) => !r.linked || r.failed || r.detach_failed.length > 0 || r.error !== undefined;

/** Detaches `oldIds` once `fileId` is linked, however long that takes. */
function startReplace(collectionId: string, file: FileItem, filename: string, oldIds: string[]): ReplaceTask {
    const task: ReplaceTask = {
        collection_id: collectionId,
        file_id: file.id,
        filename,
        pending: [...oldIds],
        replaced: [],
        detach_failed: [],
        linked: false,
        failed: false,
        done: Promise.resolve(),
    };
    replaceTasks.set(file.id, task);

    let failure: string | undefined;
    task.done = (async () => {
        try {
            const outcome = await waitForLink(collectionId, file.id, filename, REPLACE_DEADLINE_MS);
            task.linked = outcome.linked;
            task.failed = outcome.failed;
            task.process_error = outcome.error;
            // Detaching early would leave the collection without the document for
            // the whole embedding window, and a failed replacement replaces nothing.
            if (!task.linked) {
                LOG(
                    outcome.failed
                        ? `replace ${filename}: the new version failed processing (${outcome.error ?? "no reason given"}), old version left attached`
                        : `replace ${filename}: not linked within the deadline, old version left attached`
                );
                return;
            }
            while (task.pending.length > 0) {
                const old = task.pending[0]!;
                const gone = await detachFile(collectionId, old).then(
                    () => true,
                    () => false
                );
                // Moved only after the call returns, so a caller reading the task
                // mid-flight never sees an id in two lists or in none.
                task.pending.shift();
                (gone ? task.replaced : task.detach_failed).push(old);
            }
        } catch (err) {
            failure = err instanceof Error ? err.message : String(err);
            LOG(`replace ${filename} failed: ${failure}`);
        } finally {
            replaceTasks.delete(file.id);
            replaceHistory.push({
                collection_id: collectionId,
                file_id: file.id,
                name: filename,
                linked: task.linked,
                failed: task.failed,
                replaced: [...task.replaced],
                // Whatever never came off, however it ended: an id left in `pending`
                // means the deadline or an error stopped the loop before it got there.
                detach_failed: [...task.detach_failed, ...task.pending],
                finished_at: Date.now(),
                error: failure ?? task.process_error,
            });
            if (replaceHistory.length > REPLACE_HISTORY) replaceHistory.shift();
        }
    })();

    return task;
}

/** The task's outcome so far: linked, failed, or still running when the budget ran out. */
async function settleWithin(task: ReplaceTask, budgetMs: number): Promise<LinkOutcome> {
    await Promise.race([task.done, sleep(budgetMs)]);
    return { linked: task.linked, failed: task.failed, error: task.process_error };
}

type PutResult = {
    file_id: string;
    filename: string;
    bytes: number;
    replaced: string[];
    replace_pending: string[];
    detach_failed: string[];
    settled: boolean;
    unchanged: boolean;
    /** Processing died: the document is in no listing and no retry of the same bytes will fix it. */
    failed: boolean;
    error?: string;
};

/**
 * The single write path behind both upload tools.
 *
 * Two orderings matter here. `metadata.knowledge_id` makes OpenWebUI embed into
 * the collection and link the file itself, which avoids the race a separate
 * `file/add` loses. And OpenWebUI links only *after* embedding, so a replacement
 * can be detached only once the new file is linked — otherwise the collection
 * spends the embedding window with no copy of the document at all.
 *
 * That wait is longer than the call that asks for it: embedding a 160 KB file on
 * CPU runs for minutes against a bridge window of about a minute. So the detach
 * belongs to a background task, and `wait` only decides how long this caller
 * watches it. Whoever stops watching gets `replace_pending` instead of `replaced`
 * — the old version comes off regardless, rather than being left for a human.
 */
export async function putDocument(args: {
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

    // meta.file_hash covers the uploaded bytes; `hash` covers the extracted text and
    // matches only where extraction was the identity. The wrong one re-uploads silently.
    const identical = existing.find((f) => (f.meta?.file_hash ?? f.hash) === digest);
    if (identical) {
        return {
            file_id: identical.id,
            filename,
            bytes,
            replaced: [],
            replace_pending: [],
            detach_failed: [],
            settled: true,
            unchanged: true,
            failed: false,
        };
    }

    const file = await uploadIntoCollection(collectionId, filename, body);
    const task = replace && existing.length > 0 ? startReplace(collectionId, file, filename, existing.map((f) => f.id)) : null;

    const outcome: LinkOutcome =
        waitMs <= 0
            ? { linked: false, failed: false }
            : task
              ? await settleWithin(task, waitMs)
              : await waitForLink(collectionId, file.id, filename, waitMs);

    // A snapshot of the task as it stands now: whatever is still in `pending` will
    // come off after this call returns.
    return {
        file_id: file.id,
        filename,
        bytes,
        replaced: task ? [...task.replaced] : [],
        replace_pending: task ? [...task.pending] : [],
        detach_failed: task ? [...task.detach_failed] : [],
        settled: outcome.linked,
        unchanged: false,
        failed: outcome.failed,
        error: outcome.error,
    };
}

/**
 * Accepts a collection id or a (case-insensitive) collection name and returns
 * the id. Names are far easier for a model to produce than uuids.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every collection the search matches, across pages. */
async function searchCollectionsByName(query: string): Promise<KnowledgeItem[]> {
    const found: KnowledgeItem[] = [];
    for (let page = 1; ; page++) {
        const { items, total } = await listKnowledge(page, query);
        found.push(...items);
        if (items.length === 0 || page * PAGE_ITEM_COUNT >= total) return found;
    }
}

async function resolveCollection(ref?: string): Promise<string> {
    const wanted = (ref ?? DEFAULT_COLLECTION).trim();
    if (!wanted) {
        throw new ToolError(
            "no_default_collection",
            "No collection given and OPENWEBUI_DEFAULT_COLLECTION is not set. Call list_collections first."
        );
    }
    if (UUID_RE.test(wanted)) return wanted;

    const lower = wanted.toLowerCase();
    // /knowledge/search matches description and owner too, so the name filter is ours.
    const matches = await searchCollectionsByName(wanted);
    const named = (c: KnowledgeItem) => ({ id: c.id, name: c.name });

    const exact = matches.filter((c) => (c.name ?? "").toLowerCase() === lower);
    if (exact.length === 1) return exact[0]!.id;

    // "docs" fits "my-docs" and "docs-archive" equally; the first match is a coin flip.
    const candidates = exact.length > 1 ? exact : matches.filter((c) => (c.name ?? "").toLowerCase().includes(lower));
    if (candidates.length === 1) return candidates[0]!.id;
    if (candidates.length > 1) {
        throw new ToolError("collection_ambiguous", `"${wanted}" matches ${candidates.length} collections; name one exactly.`, {
            candidates: candidates.map(named),
        });
    }

    const nearby = await listKnowledge(1).then(
        (p) => p.items.slice(0, 5).map(named),
        () => []
    );
    throw new ToolError("collection_not_found", `No knowledge collection matches "${wanted}".`, { nearby });
}

function toChunks(raw: RetrievalResponse): Chunk[] {
    // The backend merges every queried collection into a single result row.
    const distances = raw.distances?.[0] ?? [];
    const documents = raw.documents?.[0] ?? [];
    const metadatas = raw.metadatas?.[0] ?? [];

    return documents
        .map((text, i) => {
            const meta = (metadatas[i] ?? {}) as Record<string, unknown>;
            // Normalised to a similarity in [0,1], higher better, still named distance.
            const score = typeof distances[i] === "number" ? distances[i] : undefined;
            return {
                score,
                distance: score,
                source: typeof meta.source === "string" ? meta.source : undefined,
                name: typeof meta.name === "string" ? meta.name : undefined,
                file_id: typeof meta.file_id === "string" ? meta.file_id : undefined,
                // Only when it means something. The markdown header splitter this stack
                // runs leaves it at 0 on every chunk, which reads like a real offset and
                // is not one; a splitter that does fill it still comes through.
                start_index:
                    typeof meta.start_index === "number" && meta.start_index > 0 ? meta.start_index : undefined,
                text: (text ?? "").trim(),
            };
        })
        .filter((c) => c.text.length > 0);
}

/** Per-query knobs for the hybrid path. They are ignored while it is off. */
type RerankOptions = { k_reranker?: number; r?: number; bm25_weight?: number };

/**
 * No per-query `hybrid`: with the flag on, the non-hybrid branch re-checks it and
 * runs hybrid anyway, just with global parameters. The switch is the operator's.
 */
async function searchCollections(
    collections: string[],
    query: string,
    k: number,
    rerank?: RerankOptions
): Promise<Chunk[]> {
    const raw = await postJson<RetrievalResponse>("/api/v1/retrieval/query/collection", {
        collection_names: collections,
        query,
        k,
        ...(rerank?.k_reranker !== undefined ? { k_reranker: rerank.k_reranker } : {}),
        ...(rerank?.r !== undefined ? { r: rerank.r } : {}),
        ...(rerank?.bm25_weight !== undefined ? { hybrid_bm25_weight: rerank.bm25_weight } : {}),
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

/** The log line is unconditional: an unseen failure reads as a bad question. */
function fail(err: unknown) {
    const tool = err instanceof ToolError ? err : null;
    const code = tool?.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);

    LOG(`tool error code=${code}: ${message}`);
    const envelope = { ok: false, error: { code, ...(tool?.extra ?? {}), message } };
    return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }] };
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

// Unannotated defaults to destructiveHint: true, which makes search and delete
// look alike. One known backend, so openWorldHint is false throughout.
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, openWorldHint: false } as const;

function createMcpServer(): McpServer {
    const mcp = new McpServer({ name: "openwebui-knowledge", version: "1.3.0" });

    mcp.registerTool(
        "ping_openwebui",
        {
            title: "Check OpenWebUI connectivity",
            description: "Check OpenWebUI API reachability and credentials.",
            inputSchema: {},
            annotations: READS,
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
            title: "List knowledge collections",
            description:
                "List knowledge collections, newest first. Optional `query` searches name, description and " +
                "owner server-side, so a match is not necessarily a name match. Returns ids to pass to the " +
                "other tools.",
            inputSchema: {
                query: z.string().optional(),
                page: z.number().int().min(1).optional(),
            },
            annotations: READS,
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
                    created_at: c.created_at,
                    updated_at: c.updated_at,
                })),
            });
        })
    );

    mcp.registerTool(
        "list_documents",
        {
            title: "List documents in a collection",
            description:
                "List files inside a knowledge collection. `collection` accepts an id or a name; " +
                "defaults to OPENWEBUI_DEFAULT_COLLECTION. Optional `query` filters by filename " +
                "(a SQL LIKE pattern, so _ and % are wildcards); `order_by` takes name, created_at or " +
                "updated_at. A document is in exactly one of three states: `files` (linked and " +
                "searchable), `pending` (still embedding — not searchable yet, not lost), or `failed` " +
                "(processing died; it is in no other listing and re-uploading the same bytes will fail " +
                "the same way). `failed` is a scan of the newest uploads, so it is recent failures, not " +
                "all of them. Timestamps are unix seconds; `updated_at` is set when embedding finishes, " +
                "so it tells two same-named files apart.",
            inputSchema: {
                collection: z.string().optional(),
                query: z.string().optional(),
                page: z.number().int().min(1).optional(),
                order_by: z.enum(["name", "created_at", "updated_at"]).optional(),
                direction: z.enum(["asc", "desc"]).optional(),
            },
            annotations: READS,
        },
        guard(async ({ collection, query, page, order_by, direction }: { collection?: string; query?: string; page?: number; order_by?: string; direction?: string }) => {
            const id = await resolveCollection(collection);
            const p = page ?? 1;
            const [{ items, total }, pending, failed] = await Promise.all([
                listKnowledgeFiles(id, p, query, { order_by, direction }),
                pendingFiles(id).catch(() => [] as FileItem[]),
                // Best effort: a restricted key may not reach the file list at all.
                failedFiles(id).catch(() => [] as FileItem[]),
            ]);

            return ok({
                ok: true,
                collection: { id },
                ...paging(p, total),
                files: items.map((f) => ({
                    file_id: f.id,
                    name: fileName(f),
                    size: f.meta?.size,
                    // The byte digest, so a consumer can decide locally whether to re-sync.
                    file_hash: f.meta?.file_hash,
                    created_at: f.created_at,
                    updated_at: f.updated_at,
                })),
                // Linked only after embedding, so `files` is accurate but not complete.
                pending: pending.map((f) => ({ file_id: f.id, name: fileName(f) })),
                // And these did not make it. In no other listing, hence uploaded twice.
                failed: failed.map(describeFailure),
            });
        })
    );

    mcp.registerTool(
        "get_document",
        {
            title: "Read one document",
            description:
                "Fetch the extracted text of one file by file_id. Long documents come back in windows: " +
                "read `next_offset` and call again with it until it is absent, rather than raising " +
                "`max_chars` — the default window is sized to what an MCP result can carry, and a bigger " +
                "one is truncated again further down the pipe, invisibly. Offsets are characters.",
            inputSchema: {
                file_id: z.string().min(1),
                offset: z.number().int().min(0).optional(),
                max_chars: z.number().int().min(200).max(400_000).optional(),
            },
            annotations: READS,
        },
        guard(async ({ file_id, offset, max_chars }: { file_id: string; offset?: number; max_chars?: number }) => {
            // A client truncates an oversized result without saying where it cut.
            const limit = max_chars ?? 24_000;
            const from = offset ?? 0;
            const { file, text } = await getFileWithContent(file_id);
            const window = text.slice(from, from + limit);
            const end = from + window.length;

            return ok(
                {
                    ok: true,
                    file_id,
                    name: fileName(file),
                    status: file.data?.status,
                    length: text.length,
                    offset: from,
                    returned: window.length,
                    truncated: end < text.length,
                    next_offset: end < text.length ? end : undefined,
                },
                window
            );
        })
    );

    mcp.registerTool(
        "select_context_files",
        {
            title: "Assemble a context block",
            description:
                "Fetch several files by file_id and return them as one concatenated context block, " +
                "ready to paste into a prompt. The default budgets are sized to what an MCP result can " +
                "carry; raising them past that gets the block truncated further down the pipe with no " +
                "mark where it was cut. Skipped files carry an error `code`, not just prose.",
            inputSchema: {
                file_ids: z.array(z.string().min(1)).min(1).max(20),
                max_chars_per_file: z.number().int().min(200).max(200_000).optional(),
                total_budget: z.number().int().min(1_000).max(600_000).optional(),
            },
            annotations: READS,
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
                const perFile = max_chars_per_file ?? 20_000;
                const budget = total_budget ?? 60_000;
                const unique = [...new Set(file_ids)];

                const docs = await mapLimit(unique, 4, async (file_id) => {
                    try {
                        const { file, text } = await getFileWithContent(file_id);
                        return { file_id, name: fileName(file), text, error: undefined, code: undefined };
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        const code = err instanceof ToolError ? err.code : "internal_error";
                        return { file_id, name: undefined, text: "", error: message, code };
                    }
                });

                // Clip per file first, then stop once the shared budget is spent.
                let spent = 0;
                const blocks: string[] = [];
                const included: Array<{ file_id: string; name?: string; chars: number }> = [];
                const skipped: Array<{ file_id: string; code: string; reason: string }> = [];

                for (const d of docs) {
                    if (d.error) {
                        skipped.push({ file_id: d.file_id, code: d.code ?? "internal_error", reason: d.error });
                        continue;
                    }
                    const room = budget - spent;
                    if (room <= 0) {
                        skipped.push({
                            file_id: d.file_id,
                            code: "budget_exhausted",
                            reason: "total_budget spent before this file",
                        });
                        continue;
                    }

                    const text = d.text.slice(0, Math.min(perFile, room));
                    spent += text.length;

                    const header = ["-----", `file_id: ${d.file_id}`, d.name ? `name: ${d.name}` : null, `chars: ${text.length}`, "-----"]
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
            title: "Search knowledge collections",
            description:
                "Semantic search over knowledge collections. Pass `collection` (id or name) or `collections` " +
                "for a multi-collection query; defaults to OPENWEBUI_DEFAULT_COLLECTION. `score` is a " +
                "similarity in [0,1] where higher is better, and hits below `min_score` are dropped here " +
                "because OpenWebUI's own threshold applies on one retrieval path only. The floor belongs to " +
                "the corpus, not to the stack: conversational or distilled text scores systematically lower " +
                "than curated prose, so pass `min_score` for a collection that is not the one the default " +
                "was calibrated on. `rerank` tunes the hybrid path and is ignored while the operator has " +
                "hybrid search off; there is no per-query switch for it, only these knobs.",
            inputSchema: {
                query: z.string().min(1),
                collection: z.string().optional(),
                collections: z.array(z.string().min(1)).min(1).max(10).optional(),
                k: z.number().int().min(1).max(30).optional(),
                min_score: z.number().min(0).max(1).optional(),
                rerank: z
                    .object({
                        k_reranker: z.number().int().min(1).max(100).optional(),
                        r: z.number().min(0).max(1).optional(),
                        bm25_weight: z.number().min(0).max(1).optional(),
                    })
                    .optional(),
            },
            annotations: READS,
        },
        guard(
            async ({
                query,
                collection,
                collections,
                k,
                min_score,
                rerank,
            }: {
                query: string;
                collection?: string;
                collections?: string[];
                k?: number;
                min_score?: number;
                rerank?: RerankOptions;
            }) => {
                const refs = collections?.length ? collections : [collection ?? ""];
                const ids = await mapLimit(refs, 4, (ref) => resolveCollection(ref || undefined));

                const found = await searchCollections(ids, query, k ?? 8, rerank);
                const floor = min_score ?? MIN_SCORE;
                const scored = found.filter((r) => typeof r.score === "number");
                const results = scored.filter((r) => r.score! >= floor);

                return ok({
                    ok: true,
                    collections: ids,
                    query,
                    min_score: floor,
                    count: results.length,
                    // An unscored chunk cannot be measured against the floor, and
                    // dropping it silently is how a filter looks like an empty collection.
                    ...(found.length > scored.length ? { unscored_dropped: found.length - scored.length } : {}),
                    ...(results.length === 0 && scored.length > 0
                        ? {
                              nothing_above_threshold: true,
                              best_score_seen: Math.max(...scored.map((r) => r.score!)),
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

    // OpenWebUI keeps only the basename, and every later lookup is by name — so a
    // path silently becomes a file that replace and dedupe can never find again.
    const filenameSchema = z
        .string()
        .min(1)
        .max(255)
        .refine((n) => n === basename(n) && n !== "." && n !== ".." && !n.includes("\0"), {
            message: "filename must be a bare name with no directory part: OpenWebUI keeps only the basename",
        });

    mcp.registerTool(
        "create_collection",
        {
            title: "Create a collection",
            description:
                "Create a knowledge collection. Returns its id. If a collection with the same name already " +
                "exists the existing one is returned untouched, so this is safe to call again.",
            inputSchema: {
                name: z.string().min(1),
                description: z.string().optional(),
            },
            annotations: { ...WRITES, destructiveHint: false, idempotentHint: true },
        },
        guard(async ({ name, description }: { name: string; description?: string }) => {
            // Not .catch(() => null): a failed lookup meant "no match", which created
            // a second collection of the same name — the one outcome ruled out here.
            const existing = await searchCollectionsByName(name);
            const hit = existing.find((k) => (k.name ?? "").toLowerCase() === name.trim().toLowerCase());
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
            title: "Upload a document",
            description:
                "Put a text document into a knowledge collection: uploads the content as a file and attaches it. " +
                "`collection` accepts an id or a name; defaults to OPENWEBUI_DEFAULT_COLLECTION. " +
                "Set `replace` to drop any file already in the collection with the same filename, which is what " +
                "you want when re-syncing a document that changed. Returns as soon as the upload is accepted; " +
                "`settled: false` means embedding is still running in the background, not that it failed. " +
                "Old versions listed in `replace_pending` are removed by the server once the new one is " +
                "linked, with no further call needed — unless the server restarts first, in which case " +
                "the old version stays and dedupe_collection dry_run: true is the check. `unchanged: true` " +
                "means the collection already held a byte-identical file of that name and nothing was " +
                "uploaded. `failed: true` means processing died — the document is in no listing, and " +
                "re-uploading the same bytes will die the same way; read `error`. Set `wait` to " +
                "block until it finishes, or call wait_pending. Prefer upload_document_from_path when the " +
                "file is on disk.",
            inputSchema: {
                filename: filenameSchema,
                content: z.string().min(1),
                collection: z.string().optional(),
                replace: z.boolean().optional(),
                wait: z.boolean().optional(),
            },
            // Annotations are static, so this describes the `replace: true` case.
            annotations: { ...WRITES, destructiveHint: true, idempotentHint: false },
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
                    waitMs: wait ? UPLOAD_SETTLE_MS : 0,
                });

                // The same shape as upload_document_from_path; `unchanged` was missing.
                return ok({
                    ok: true,
                    collection: collectionId,
                    ...result,
                    // Characters, not bytes. `bytes` is what was actually uploaded.
                    chars: content.length,
                });
            }
        )
    );

    mcp.registerTool(
        "upload_document_from_path",
        {
            title: "Upload a document from disk",
            description:
                "Attach a file the server can read from disk, given its absolute path, so the text never has to " +
                "travel through the conversation. Reads only under OPENWEBUI_UPLOAD_ROOTS, which is empty by " +
                "default and refuses every path until the owner lists roots. `filename` defaults to the " +
                "basename; `collection` takes an id or a name. Returns `unchanged: true` and touches nothing " +
                "when the collection already holds a byte-identical file of that name. Returns without waiting " +
                "for embedding unless `wait` is set — `settled: false` is a queue, not a failure, and retrying " +
                "on it duplicates the document. `replace` no longer waits: the previous version is detached by " +
                "the server once the new one is linked, however long embedding takes, and until then it is " +
                "listed in `replace_pending`; anything that did not come off is in `detach_failed`. " +
                "That task lives in the server process: if it restarts mid-replace the old version stays " +
                "attached and nothing reports it, so check with dedupe_collection dry_run: true. " +
                "`timeout_s` only sets how long `wait` blocks, and caps at 55 because an MCP call over a " +
                "bridge is cut at about 60 s — use wait_pending for a long embedding. Path refusals carry a " +
                "code: no_roots, not_found, not_a_file, outside_roots, too_large, and name the readable roots.",
            inputSchema: {
                path: z.string().min(1),
                collection: z.string().optional(),
                filename: filenameSchema.optional(),
                replace: z.boolean().optional(),
                wait: z.boolean().optional(),
                timeout_s: z.number().int().min(1).max(WAIT_MAX_S).optional(),
            },
            annotations: { ...WRITES, destructiveHint: true, idempotentHint: false },
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

                const result = await putDocument({
                    collectionId,
                    filename: filename ?? basename(real),
                    body,
                    replace: replace ?? false,
                    waitMs: wait ? (timeout_s ?? UPLOAD_SETTLE_MS / 1000) * 1000 : 0,
                });

                return ok({ ok: true, collection: collectionId, path: real, ...result });
            }
        )
    );

    mcp.registerTool(
        "wait_pending",
        {
            title: "Wait for the embedding queue",
            description:
                "Block until a collection's embedding queue is empty, or until one `file_id` is linked. " +
                "Use it instead of polling list_documents after an upload: one call, not five. Returns " +
                "`settled: false` if the timeout came first — call again, nothing is lost. `settled: true` " +
                "for a whole collection also means no replace is still waiting to remove an old version. " +
                "`failed: true` is the other answer: processing died, the wait is over, and retrying the " +
                "same bytes will not help. Check `replace_done` too: a replace that failed to remove the " +
                "old version, or never linked before its deadline, is finished and therefore absent from " +
                "`replace_pending` — `settled: true` alone does not mean the collection is clean. " +
                "Defaults to 45 s: the cap is 55 but an MCP call over a bridge is cut at about 60 and " +
                "the bridge's own overhead takes several seconds of that.",
            inputSchema: {
                collection: z.string().optional(),
                file_id: z.string().optional(),
                timeout_s: z.number().int().min(1).max(WAIT_MAX_S).optional(),
            },
            annotations: READS,
        },
        guard(async ({ collection, file_id, timeout_s }: { collection?: string; file_id?: string; timeout_s?: number }) => {
            const id = await resolveCollection(collection);
            const started = Date.now();
            const deadline = started + (timeout_s ?? WAIT_DEFAULT_S) * 1000;

            // Membership is by name, so waiting on one file costs one lookup up front.
            const wanted = file_id ? fileName(await getFile(file_id)) : undefined;
            if (file_id && !wanted) {
                throw new ToolError("invalid_argument", `File ${file_id} has no filename to match on.`, { file_id });
            }

            let pending: FileItem[] = [];
            let settled = false;
            let failure: FileData | undefined;
            for (;;) {
                pending = await pendingFiles(id).catch(() => [] as FileItem[]);
                if (wanted) {
                    settled = (await filesNamed(id, wanted)).some((f) => f.id === file_id);
                    // Otherwise the full timeout runs and reports `settled: false`
                    // — "call again" — for a document that is already dead.
                    if (!settled) {
                        const data = await getFile(file_id!).then(
                            (f) => f.data,
                            () => undefined
                        );
                        if (data?.status === "failed") {
                            failure = data;
                            break;
                        }
                    }
                } else {
                    settled = pending.length === 0 && liveReplaces(id).length === 0;
                }
                if (settled || Date.now() >= deadline) break;
                await sleep(UPLOAD_POLL_MS);
            }

            // An empty queue is not an empty queue plus a clean run.
            const failed = wanted ? [] : await failedFiles(id).catch(() => [] as FileItem[]);

            const done = recentReplaces(id);
            return ok({
                ok: true,
                collection: id,
                settled,
                ...(failure
                    ? {
                          failed: true,
                          error: failure.error,
                          hint: "Processing failed. The document is in no listing; uploading the same "
                              + "bytes again fails the same way.",
                      }
                    : {}),
                waited_ms: Date.now() - started,
                pending: pending.map((f) => ({ file_id: f.id, name: fileName(f) })),
                ...(failed.length > 0 ? { failed_recent: failed.map(describeFailure) } : {}),
                replace_pending: liveReplaces(id).map((t) => ({
                    file_id: t.file_id,
                    name: t.filename,
                    removing: t.pending,
                })),
                // Finished replaces, this process only. The ones that did not finish
                // cleanly are the point: nothing else reports them.
                replace_done: done,
                ...(done.some(incomplete)
                    ? {
                          replace_incomplete: true,
                          hint: "A replace did not finish cleanly. Run dedupe_collection with "
                              + "dry_run: true to see what is still attached.",
                      }
                    : {}),
            });
        })
    );

    mcp.registerTool(
        "dedupe_collection",
        {
            title: "Dedupe a collection (deletes files)",
            description:
                "Find files sharing a filename in a collection and detach all but the newest by " +
                "`updated_at`, which is when embedding finished. Duplicates accumulate silently when a " +
                "replace never completed — including one lost to a server restart. `dry_run` defaults to " +
                "true: it reports what it would do and changes nothing. **While " +
                "ENABLE_KNOWLEDGE_FILE_RETENTION is off, which is the default, detach means delete**: " +
                "`dry_run: false` destroys the file and its blob, not just its membership, and there is " +
                "no undo. Read the dry run first. A group whose two newest copies carry the same " +
                "timestamp is reported under `skipped` and left alone rather than guessed at, and so is " +
                "a name that is shared by files in different folders, where two copies are two documents.",
            inputSchema: {
                collection: z.string().optional(),
                dry_run: z.boolean().optional(),
                max_deletions: z.number().int().min(1).max(500).optional(),
            },
            annotations: { ...WRITES, destructiveHint: true, idempotentHint: true },
        },
        guard(async ({ collection, dry_run, max_deletions }: { collection?: string; dry_run?: boolean; max_deletions?: number }) => {
            const id = await resolveCollection(collection);
            const dry = dry_run ?? true;
            // One call should not be able to empty a collection by accident.
            const cap = max_deletions ?? 20;

            const groups = new Map<string, FileItem[]>();
            for (const f of await allFiles(id)) {
                const name = fileName(f) ?? f.id;
                const seen = groups.get(name);
                if (seen) seen.push(f);
                else groups.set(name, [f]);
            }

            const describe = (name: string, f: FileItem) => ({ name, file_id: f.id, updated_at: stamp(f) });
            const kept: ReturnType<typeof describe>[] = [];
            const detached: ReturnType<typeof describe>[] = [];
            const detach_failed: ReturnType<typeof describe>[] = [];
            const skipped: Array<{ name: string; reason: string; file_ids: string[] }> = [];

            for (const [name, group] of groups) {
                if (group.length < 2) continue;

                // docs/api/readme.md beside docs/cli/readme.md is two documents.
                if (!(await allAtRoot(id, name, group.map((f) => f.id)))) {
                    skipped.push({
                        name,
                        reason: "copies live in different folders, so they are different documents",
                        file_ids: group.map((f) => f.id),
                    });
                    continue;
                }

                const [newest, runnerUp, ...rest] = [...group].sort((a, b) => stamp(b) - stamp(a));

                // Detaching the wrong copy loses the newer version and looks like a
                // successful cleanup, so a tie is left for a human to resolve.
                if (stamp(newest!) === 0 || stamp(newest!) === stamp(runnerUp!)) {
                    skipped.push({
                        name,
                        reason: "timestamps do not separate the newest copy",
                        file_ids: group.map((f) => f.id),
                    });
                    continue;
                }

                kept.push(describe(name, newest!));
                for (const old of [runnerUp!, ...rest]) {
                    if (dry) {
                        detached.push(describe(name, old));
                        continue;
                    }
                    if (detached.length >= cap) {
                        skipped.push({ name, reason: `max_deletions (${cap}) reached`, file_ids: [old.id] });
                        continue;
                    }
                    const gone = await detachFile(id, old.id).then(
                        () => true,
                        () => false
                    );
                    (gone ? detached : detach_failed).push(describe(name, old));
                }
            }

            return ok({
                ok: true,
                collection: id,
                dry_run: dry,
                max_deletions: cap,
                names: groups.size,
                // In a dry run these are what *would* come off; nothing was touched.
                kept,
                detached,
                detach_failed,
                skipped,
            });
        })
    );

    mcp.registerTool(
        "remove_document",
        {
            title: "Remove a document (deletes the file)",
            description:
                "Take a file out of a knowledge collection by file_id. This deletes the file itself — the " +
                "record and its blob, not just its membership — and there is no undo. Pass " +
                "`keep_file: true` to unlink only. The outcome is stated in `deleted_file` rather than " +
                "left to the server's retention setting, which is invisible from here. A file that " +
                "belongs to several collections is deleted out of all of them.",
            inputSchema: {
                file_id: z.string().min(1),
                collection: z.string().optional(),
                keep_file: z.boolean().optional(),
            },
            annotations: { ...WRITES, destructiveHint: true, idempotentHint: true },
        },
        guard(async ({ file_id, collection, keep_file }: { file_id: string; collection?: string; keep_file?: boolean }) => {
            const collectionId = await resolveCollection(collection);
            const deleteFile = !(keep_file ?? false);
            await detachFile(collectionId, file_id, deleteFile);
            return ok({ ok: true, collection: collectionId, file_id, removed: true, deleted_file: deleteFile });
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
        if (DEBUG) {
            const method = typeof parsed === "object" && parsed !== null && "method" in parsed ? String(parsed.method) : "?";
            LOG(`POST /mcp method=${method}`);
        }
        await transport.handleRequest(req, res, parsed);
        return;
    }

    await transport.handleRequest(req, res);
}

/**
 * DNS rebinding is the one attack a loopback bind does not stop. A browser always
 * attaches Origin; an MCP client sends none, so refusing an unlisted one is free.
 */
function originRefused(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return typeof origin === "string" && origin.length > 0 && !ALLOWED_ORIGINS.includes(origin);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") return sendJson(res, 200, { ok: true });

    if (originRefused(req)) {
        LOG(`refused Origin ${req.headers.origin} on ${url.pathname}`);
        return sendJson(res, 403, { error: "Origin not allowed. Set MCP_ALLOWED_ORIGINS to permit it." });
    }

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
