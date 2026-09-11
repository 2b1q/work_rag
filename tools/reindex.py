#!/usr/bin/env python3
"""Re-embed a knowledge collection one file at a time, resumably.

Usage:
    export OPENWEBUI_URL=http://127.0.0.1:3000
    export OPENWEBUI_API_KEY=      # the same key the MCP server uses

    python3 tools/reindex.py my-docs [--limit N] [--state DIR]
    python3 tools/reindex.py --all

Not POST /api/v1/knowledge/reindex: that walks every collection in one synchronous
request and drops each collection's vectors before refilling it, so a run cut off
by a timeout leaves collections empty. The per-file route used here adds the new
vectors before removing the old ones.

That route answers 200 even when processing threw, so a file counts as done only
when its record comes back with data.status == "completed".

State is one JSON object per file in <state>/reindex-<collection>.jsonl; a file
recorded ok is skipped next time. Delete it to force a full re-run.
"""
import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

# OpenWebUI paginates knowledge file listings server-side at this size.
PAGE_ITEM_COUNT = 30

# One file's embedding is CPU-bound and runs inside the request. A large document
# can take a minute; the ceiling is here only so a wedged call cannot hang a run.
REQUEST_TIMEOUT_S = 900


class Api:
    def __init__(self, base: str, key: str) -> None:
        self.base = base.rstrip("/")
        self.key = key

    def __call__(self, path: str, payload=None):
        request = urllib.request.Request(
            f"{self.base}{path}",
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"},
            method="POST" if payload is not None else "GET",
        )
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
            return json.loads(response.read().decode())


def collections(api: Api) -> list[dict]:
    found, page = [], 1
    while True:
        listing = api(f"/api/v1/knowledge/?page={page}")
        found += listing["items"]
        if not listing["items"] or page * PAGE_ITEM_COUNT >= listing["total"]:
            return found
        page += 1


def resolve(api: Api, ref: str) -> str:
    """A name or an id, because a name is what an operator has to hand."""
    if len(ref) == 36 and ref.count("-") == 4:
        return ref
    for collection in collections(api):
        if (collection.get("name") or "").lower() == ref.lower():
            return collection["id"]
    sys.exit(f"no collection named {ref!r}")


def linked_files(api: Api, collection_id: str) -> list[dict]:
    """Files actually joined to the collection — the ones reindex has to cover."""
    found, page = [], 1
    while True:
        listing = api(f"/api/v1/knowledge/{collection_id}/files?page={page}")
        found += listing["items"]
        if not listing["items"] or page * PAGE_ITEM_COUNT >= listing["total"]:
            return found
        page += 1


def reembed(api: Api, file_id: str) -> tuple[bool, str | None]:
    text = (api(f"/api/v1/files/{file_id}/data/content") or {}).get("content") or ""
    if not text.strip():
        # Nothing stored to rebuild from; re-uploading the source is the only fix.
        return False, "no stored text to re-embed"

    api(f"/api/v1/files/{file_id}/data/content/update", {"content": text})

    data = (api(f"/api/v1/files/{file_id}") or {}).get("data") or {}
    if data.get("status") == "completed":
        return True, None
    return False, f"status={data.get('status')} {data.get('error')}"


def run(api: Api, ref: str, state_dir: str, limit: int | None) -> int:
    collection_id = resolve(api, ref)
    state_path = os.path.join(state_dir, f"reindex-{ref}.jsonl")

    done = set()
    if os.path.exists(state_path):
        with open(state_path) as state:
            for line in state:
                record = json.loads(line)
                if record["ok"]:
                    done.add(record["file_id"])

    files = linked_files(api, collection_id)
    todo = [f for f in files if f["id"] not in done]
    if limit:
        todo = todo[:limit]

    print(f"{ref} ({collection_id}): {len(files)} linked, {len(done)} already done, {len(todo)} to go", flush=True)

    started, failures, timings = time.time(), 0, []
    with open(state_path, "a") as state:
        for index, item in enumerate(todo, start=1):
            file_id = item["id"]
            name = (item.get("meta") or {}).get("name") or item.get("filename")
            began = time.time()
            try:
                ok, error = reembed(api, file_id)
            except urllib.error.HTTPError as err:
                ok, error = False, f"HTTP {err.code}: {err.read()[:200].decode(errors='replace')}"
            except Exception as err:  # keep going: one bad file is not the run
                ok, error = False, f"{type(err).__name__}: {err}"

            took = round(time.time() - began, 1)
            timings.append(took)
            failures += 0 if ok else 1
            state.write(
                json.dumps(
                    {"file_id": file_id, "name": name, "ok": ok, "error": error, "secs": took, "at": int(time.time())}
                )
                + "\n"
            )
            state.flush()

            remaining = (time.time() - started) / index * (len(todo) - index)
            print(
                f"  [{index}/{len(todo)}] {'ok  ' if ok else 'FAIL'} {took:>6}s  eta {round(remaining / 60)}m  {name}"
                + (f"  -- {error}" if error else ""),
                flush=True,
            )

    elapsed = round((time.time() - started) / 60, 1)
    median = statistics.median(timings) if timings else 0
    print(f"{ref}: {len(todo) - failures} ok, {failures} failed, {elapsed}m (median {median}s/file)", flush=True)
    return failures


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("collection", nargs="?", help="collection name or id")
    parser.add_argument("--all", action="store_true", help="every collection, newest first")
    parser.add_argument("--limit", type=int, help="stop after this many files, to try it out first")
    parser.add_argument(
        "--state",
        default=".",
        help="where to keep the resume log (default: the working directory). It is scratch, not a record.",
    )
    args = parser.parse_args()

    if bool(args.collection) == bool(args.all):
        parser.error("give a collection name or --all, not both")

    url, key = os.environ.get("OPENWEBUI_URL"), os.environ.get("OPENWEBUI_API_KEY")
    if not url or not key:
        sys.exit("OPENWEBUI_URL and OPENWEBUI_API_KEY are required")

    api = Api(url, key)
    targets = [c["name"] for c in collections(api)] if args.all else [args.collection]

    failures = sum(run(api, target, args.state, args.limit) for target in targets)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
