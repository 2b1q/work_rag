/**
 * Two silent failures that both reported success.
 *
 * The no-op check compared the wrong digest: `hash` is the sha256 of the extracted
 * text, and only `meta.file_hash` covers the uploaded bytes — so an unchanged
 * document was re-uploaded and rejected as duplicate content in the background.
 *
 * And a file that fails extraction is linked to nothing and listed as pending by
 * nothing, so waiting for it used to run the full deadline before giving up.
 *
 * Run: npm test  (builds first — the test imports dist/)
 */import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

const BODY = new TextEncoder().encode("# a document\n");
const BYTE_DIGEST = createHash("sha256").update(BODY).digest("hex");
// What OpenWebUI stores in `hash`: a digest of the text it extracted, which is a
// different string even when the file is byte-identical to the one on disk.
const TEXT_DIGEST = createHash("sha256").update("a document").digest("hex");

/** Per-collection stub behaviour, keyed by the collection id the test asks for. */
type Kb = { existing: unknown[]; uploads: number; status: string };
const kbs = new Map<string, Kb>();
const kb = (id: string): Kb => {
    let state = kbs.get(id);
    if (!state) kbs.set(id, (state = { existing: [], uploads: 0, status: "completed" }));
    return state;
};

let server: Server;
const collectionOf = (pathname: string) => pathname.split("/")[4] ?? "";

function stub(): Server {
    return createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://stub");
        const json = (payload: unknown, code = 200) => {
            res.statusCode = code;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(payload));
        };

        if (url.pathname.endsWith("/files") && req.method === "GET") {
            const state = kb(collectionOf(url.pathname));
            return json({ items: state.existing, total: state.existing.length });
        }

        if (url.pathname === "/api/v1/files/" && req.method === "POST") {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c as Buffer));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                const id = /"knowledge_id":\s*"([^"]+)"/.exec(body)?.[1] ?? "";
                kb(id).uploads += 1;
                json({ id: `${id}-new`, filename: "doc.md", meta: { name: "doc.md" } });
            });
            return;
        }

        // The file record, which is the only place a failure is visible.
        const single = /^\/api\/v1\/files\/([^/]+)$/.exec(url.pathname);
        if (single && req.method === "GET") {
            const id = single[1]!.replace(/-new$/, "");
            return json({ id: single[1], meta: { name: "doc.md" }, data: { status: kb(id).status, error: "unsupported file type" } });
        }

        json({ error: url.pathname }, 404);
    });
}

let mod: typeof import("../dist/index.js");

before(async () => {
    server = stub();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    process.env.MCP_NO_LISTEN = "1";
    process.env.OPENWEBUI_API_KEY = "test-key";
    process.env.OPENWEBUI_BASE_URL = `http://127.0.0.1:${port}`;
    mod = await import("../dist/index.js");
});

const put = (collectionId: string, waitMs = 0) =>
    mod.putDocument({ collectionId, filename: "doc.md", body: BODY, replace: false, waitMs });

describe("putDocument", () => {
    it("treats a byte-identical file as unchanged and uploads nothing", async () => {
        kb("same").existing = [
            // The shape OpenWebUI actually returns: a text digest in `hash`, the byte
            // digest in meta.file_hash. Only the second one can match what we sent.
            { id: "file-1", meta: { name: "doc.md", file_hash: BYTE_DIGEST }, hash: TEXT_DIGEST, updated_at: 1 },
        ];

        const result = await put("same");
        assert.equal(result.unchanged, true);
        assert.equal(result.file_id, "file-1");
        assert.equal(kb("same").uploads, 0, "nothing should have been uploaded");
    });

    it("uploads when the stored bytes differ, however the text hash compares", async () => {
        kb("changed").existing = [
            // Extraction collapsed two different files to the same text: `hash` matches
            // and the document still has to go up.
            { id: "file-1", meta: { name: "doc.md", file_hash: "a-different-byte-digest" }, hash: TEXT_DIGEST, updated_at: 1 },
        ];

        const result = await put("changed");
        assert.equal(result.unchanged, false);
        assert.equal(kb("changed").uploads, 1);
    });

    it("falls back to `hash` for a file uploaded before OpenWebUI recorded file_hash", async () => {
        kb("legacy").existing = [{ id: "file-1", meta: { name: "doc.md" }, hash: BYTE_DIGEST, updated_at: 1 }];

        const result = await put("legacy");
        assert.equal(result.unchanged, true);
        assert.equal(kb("legacy").uploads, 0);
    });

    it("reports a failed upload instead of waiting out the budget", async () => {
        kb("broken").status = "failed";

        const started = Date.now();
        // A budget far longer than this should take: the point is that it returns on
        // the failure rather than on the clock.
        const result = await put("broken", 30_000);

        assert.equal(result.failed, true);
        assert.equal(result.settled, false);
        assert.equal(result.error, "unsupported file type");
        assert.ok(Date.now() - started < 10_000, "returned on the failure, not on the deadline");
    });
});

after(() => {
    server.close();
    delete process.env.MCP_NO_LISTEN;
});
