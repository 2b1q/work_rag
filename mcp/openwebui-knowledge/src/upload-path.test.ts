/**
 * The path allowlist is the whole security boundary of upload_document_from_path:
 * without it the tool reads any file on the host. These cases are the ways out of
 * a root that look legitimate to a string comparison.
 *
 * Run: npm test  (builds first — the test imports dist/)
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

let root: string;
let outside: string;
let mod: typeof import("../dist/index.js");

before(async () => {
    const base = await mkdtemp(join(tmpdir(), "owui-upload-"));
    root = join(base, "allowed");
    outside = join(base, "forbidden");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, "doc.md"), "# inside\n");
    await writeFile(join(outside, "secret.md"), "# outside\n");
    await symlink(join(outside, "secret.md"), join(root, "escape.md"));

    process.env.MCP_NO_LISTEN = "1";
    process.env.OPENWEBUI_API_KEY = "test-key";
    process.env.OPENWEBUI_UPLOAD_ROOTS = root;
    // The built artifact, not the source: index.ts uses constructor parameter
    // properties, which Node's strip-only TypeScript mode cannot parse.
    mod = await import("../dist/index.js");
});

const refusal = async (path: string, reason: string) => {
    await assert.rejects(
        () => mod.resolveUploadPath(path),
        (err: unknown) => err instanceof mod.UploadPathError && err.reason === reason,
        `expected ${reason} for ${path}`
    );
};

describe("resolveUploadPath", () => {
    it("accepts a file inside a root, returning the resolved path", async () => {
        const wanted = await realpath(join(root, "doc.md"));
        assert.equal(await mod.resolveUploadPath(join(root, "doc.md")), wanted);
    });

    it("refuses a file that does not exist", async () => {
        await refusal(join(root, "missing.md"), "not_found");
    });

    it("refuses a path outside the roots", async () => {
        await refusal(join(outside, "secret.md"), "outside_roots");
    });

    it("refuses a symlink pointing out of a root", async () => {
        await refusal(join(root, "escape.md"), "outside_roots");
    });

    it("refuses .. that climbs out of a root", async () => {
        await refusal(join(root, "..", "forbidden", "secret.md"), "outside_roots");
    });

    it("refuses a directory", async () => {
        await refusal(root, "not_a_file");
    });

    it("refuses a file over the size cap", async () => {
        const big = join(root, "big.md");
        await writeFile(big, "x".repeat(64));
        process.env.OPENWEBUI_UPLOAD_MAX_BYTES = "32";
        // The cap is read at import time, so re-import under a fresh module registry.
        const strict = await import(`../dist/index.js?cap=${Date.now()}`);
        await assert.rejects(
            () => strict.resolveUploadPath(big),
            (err: unknown) => err instanceof strict.UploadPathError && err.reason === "too_large"
        );
        delete process.env.OPENWEBUI_UPLOAD_MAX_BYTES;
    });
});

after(() => {
    delete process.env.MCP_NO_LISTEN;
});
