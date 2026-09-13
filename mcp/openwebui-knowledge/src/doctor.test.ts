/**
 * The loss this catches is invisible everywhere else: every file listed, nothing
 * failed, no search result. Both times it had the shape of a date — everything
 * embedded before it gone — so the sample has to span that date, and a verdict
 * built on a sample has to say it is one.
 *
 * Run: npm test  (builds first — the test imports dist/)
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

const COLLECTION = "c0ffee00-0000-4000-8000-000000000000";

/** Ten files embedded a day apart; `alive` decides which per-file stores exist. */
const files = Array.from({ length: 10 }, (_, i) => ({
    id: `f${i}`,
    meta: { name: `doc${i}.md` },
    created_at: 1_000 + i * 86_400,
    updated_at: 1_000 + i * 86_400,
}));
let alive: (id: string) => boolean = () => true;
let collectionStore = true;
const flaky = new Set<string>();
const broken = new Set<string>();

let server: Server;

function stub(): Server {
    return createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://stub");
        const json = (payload: unknown) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(payload));
        };

        if (url.pathname === `/api/v1/knowledge/${COLLECTION}/files`) return json({ items: files, total: files.length });
        if (url.pathname.endsWith("/files/pending")) return json([]);
        if (url.pathname === "/api/v1/files/") return json({ items: [], total: 0 });

        if (url.pathname === "/api/v1/retrieval/query/doc") {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c as Buffer));
            req.on("end", () => {
                const { collection_name: name } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (broken.has(name)) {
                    res.statusCode = 502;
                    return json({ detail: "upstream restarting" });
                }
                // A flaky store answers null exactly once, the way a hiccup does.
                const hiccup = flaky.delete(name);
                const exists = !hiccup && (name.startsWith("file-") ? alive(name.slice(5)) : collectionStore);
                // What OpenWebUI's Chroma adapter returns for a store it cannot find.
                json(exists ? { documents: [["chunk"]], distances: [[0.8]], metadatas: [[{}]] } : null);
            });
            return;
        }

        res.statusCode = 404;
        json({ error: url.pathname });
    });
}

let doctor: typeof import("../dist/index.js");

before(async () => {
    server = stub().listen(0);
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as { port: number };
    process.env.OPENWEBUI_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OPENWEBUI_API_KEY = "test";
    process.env.MCP_NO_LISTEN = "1";
    doctor = await import("../dist/index.js");
});

after(() => server.close());

describe("pickSample", () => {
    it("always includes the oldest and newest, whatever the draw", () => {
        const shuffled = [...files].reverse();
        for (const r of [0, 0.5, 0.999]) {
            const picked = doctor.pickSample(shuffled, 3, () => r).map((f) => f.id);
            assert.equal(picked.length, 5);
            assert.deepEqual(picked.slice(0, 2), ["f0", "f9"]);
            assert.equal(new Set(picked).size, 5);
        }
    });

    it("takes everything when the sample would cover the collection", () => {
        assert.equal(doctor.pickSample(files, 8).length, 10);
    });
});

describe("diagnoseCollection", () => {
    it("names a loss bounded in time, and says it is an estimate", async () => {
        alive = (id) => Number(id.slice(1)) >= 6;
        collectionStore = true;
        const report = await doctor.diagnoseCollection(COLLECTION, 3);

        assert.equal(report.verdict, "partial_loss");
        assert.equal(report.file_stores!.exhaustive, false);
        assert.ok(report.file_stores!.boundary, "dead files all predate live ones");
        assert.match(report.basis!, /estimate from a sample of 5 of 10/);
        assert.ok(report.not_covered);
    });

    it("reports a collection with no store behind it, even when every file store is alive", async () => {
        alive = () => true;
        collectionStore = false;
        const report = await doctor.diagnoseCollection(COLLECTION, 20);

        assert.equal(report.verdict, "no_collection_store");
        assert.equal(report.collection_store, "missing");
        assert.equal(report.file_stores!.exhaustive, true);
        assert.equal(report.not_covered, undefined);
    });

    it("calls a collection ok only when nothing checked is dead", async () => {
        alive = () => true;
        collectionStore = true;
        assert.equal((await doctor.diagnoseCollection(COLLECTION, 3)).verdict, "ok");
    });

    it("does not report a loss that a second look does not confirm", async () => {
        alive = () => true;
        collectionStore = true;
        flaky.add(COLLECTION);
        for (const f of files) flaky.add(`file-${f.id}`);
        const report = await doctor.diagnoseCollection(COLLECTION, 20);

        assert.equal(report.verdict, "ok");
        assert.equal(report.rechecked, 11);
        assert.equal(report.recovered_on_recheck, 11);
    });

    it("treats an upstream error as no answer, not as a loss and not as ok", async () => {
        alive = () => true;
        collectionStore = true;
        broken.add("file-f4");
        const report = await doctor.diagnoseCollection(COLLECTION, 20);
        broken.clear();

        assert.equal(report.verdict, "inconclusive");
        assert.equal(report.file_stores!.dead, 0);
        assert.equal(report.unanswered, 1);
        assert.doesNotMatch(report.basis!, /exact/);
    });

    it("still names a confirmed loss when another check got no answer", async () => {
        alive = (id) => id !== "f2";
        collectionStore = true;
        broken.add("file-f4");
        const report = await doctor.diagnoseCollection(COLLECTION, 20);
        broken.clear();

        assert.equal(report.verdict, "partial_loss");
    });

    it("stops checking at the deadline and says the report is incomplete", async () => {
        alive = () => true;
        collectionStore = true;
        const report = await doctor.diagnoseCollection(COLLECTION, 20, undefined, Date.now() - 1);

        assert.equal(report.verdict, "inconclusive");
        assert.equal(report.collection_store, "unknown");
        assert.match(report.basis!, /no answer/);
    });
});
