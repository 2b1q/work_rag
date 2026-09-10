/**
 * A replace outlives the call that asked for it. Two things have to hold: the old
 * version comes off once the new one is linked, with no second call from the
 * caller — that gap is how a collection ends up holding two copies of the same
 * document — and a replace that did *not* finish cleanly stays visible, because a
 * finished task leaves the live map either way and would otherwise read as success.
 *
 * Driven against a stub OpenWebUI so the sequence (pending -> linked -> remove) is
 * exact rather than a matter of timing on a real embedding queue.
 *
 * Run: npm test  (builds first — the test imports dist/)
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

const OLD_ID = "file-old";
const FILENAME = "doc.md";

/** Per-collection stub state. `broken` refuses every removal. */
type Kb = { listings: number; linkedAt: number; removed: Array<{ id: string; at: number }> };
const kbs = new Map<string, Kb>();
const kb = (id: string): Kb => {
    let state = kbs.get(id);
    if (!state) kbs.set(id, (state = { listings: 0, linkedAt: 0, removed: [] }));
    return state;
};

/** Marks the order of events without depending on the clock's resolution. */
let tick = 0;
let server: Server;

const collectionOf = (pathname: string) => pathname.split("/")[4] ?? "";

/**
 * Serves the one behaviour under test: the new file is invisible to the file
 * listing until it has been "embedded", which here means one poll has gone by.
 */
function stub(): Server {
    return createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://stub");
        const json = (payload: unknown, code = 200) => {
            res.statusCode = code;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(payload));
        };
        const readBody = (then: (body: string) => void) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c as Buffer));
            req.on("end", () => then(Buffer.concat(chunks).toString("utf8")));
        };

        if (url.pathname.endsWith("/files") && req.method === "GET") {
            const id = collectionOf(url.pathname);
            const state = kb(id);
            const old = { id: OLD_ID, meta: { name: FILENAME }, hash: "old-digest", updated_at: 1 };
            state.listings += 1;
            // 1: the pre-upload lookup. 2: still embedding. 3+: linked.
            if (state.listings < 3) return json({ items: [old], total: 1 });
            if (!state.linkedAt) state.linkedAt = ++tick;
            return json({ items: [old, { id: `${id}-new`, meta: { name: FILENAME }, updated_at: 2 }], total: 2 });
        }

        if (url.pathname === "/api/v1/files/" && req.method === "POST") {
            // The stub does not parse multipart; the collection is only needed to hand
            // back an id the listing above will recognise.
            return readBody((body) => {
                const id = /"knowledge_id":\s*"([^"]+)"/.exec(body)?.[1] ?? "";
                json({ id: `${id}-new`, filename: FILENAME, meta: { name: FILENAME } });
            });
        }

        if (url.pathname.endsWith("/file/remove") && req.method === "POST") {
            const id = collectionOf(url.pathname);
            return readBody((body) => {
                if (id === "broken") return json({ detail: "nope" }, 500);
                kb(id).removed.push({ id: JSON.parse(body).file_id, at: ++tick });
                json({ ok: true });
            });
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

const replace = (collectionId: string) =>
    mod.putDocument({
        collectionId,
        filename: FILENAME,
        body: new TextEncoder().encode(`# new content for ${collectionId}\n`),
        replace: true,
        waitMs: 0,
    });

/** Polls a condition instead of sleeping a fixed amount, so the test is not a race. */
async function until(cond: () => boolean, budgetMs = 20_000): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (!cond()) {
        if (Date.now() > deadline) assert.fail("timed out waiting for the background replace");
        await new Promise((r) => setTimeout(r, 50));
    }
}

describe("putDocument with replace", () => {
    it("removes the old version after the new one links, with no second call", async () => {
        const started = Date.now();
        const result = await replace("kb");

        // The caller is released while the file is still embedding, and told what
        // is still owed rather than being handed a silently incomplete replace.
        assert.ok(Date.now() - started < 1000, "returned without waiting for embedding");
        assert.equal(result.settled, false);
        assert.equal(result.file_id, "kb-new");
        assert.deepEqual(result.replace_pending, [OLD_ID]);
        assert.deepEqual(result.replaced, []);
        assert.equal(kb("kb").removed.length, 0);

        // Nothing below calls the server again: the removal is the server's own doing.
        await until(() => kb("kb").removed.length > 0);
        await until(() => mod.recentReplaces("kb").length > 0);

        assert.deepEqual(
            kb("kb").removed.map((r) => r.id),
            [OLD_ID]
        );
        assert.ok(kb("kb").removed[0]!.at > kb("kb").linkedAt, "removed only after the replacement linked");

        const [done] = mod.recentReplaces("kb");
        assert.deepEqual(
            { linked: done!.linked, replaced: done!.replaced, detach_failed: done!.detach_failed },
            { linked: true, replaced: [OLD_ID], detach_failed: [] }
        );
    });

    it("keeps a failed removal readable after the task is gone", async () => {
        await replace("broken");

        await until(() => mod.recentReplaces("broken").length > 0);

        // The task is finished, so it is out of replace_pending and a caller asking
        // "is the queue clear?" gets yes. This record is the only thing that says the
        // collection still holds both versions.
        const [done] = mod.recentReplaces("broken");
        assert.equal(done!.linked, true);
        assert.deepEqual(done!.replaced, []);
        assert.deepEqual(done!.detach_failed, [OLD_ID]);
    });
});

after(() => {
    server.close();
    delete process.env.MCP_NO_LISTEN;
});
