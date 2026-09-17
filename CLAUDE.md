# Project: work_rag — self-hosted knowledge base + MCP bridge

A local RAG stack (`docker compose`) plus an MCP server that lets Claude query it
from the editor. Purpose, quick start and design notes: [README.md](README.md).
This file is the operating contract, not the handbook.

## Layers

Three, and the boundaries matter:

- **Stack** — [docker-compose.yaml](docker-compose.yaml). OpenWebUI (ingestion,
  retrieval, chat, admin), ChromaDB (vectors), PostgreSQL (metadata, config,
  chats). All state lives here; the repo holds none of it.
- **MCP server** — [mcp/openwebui-knowledge/](mcp/openwebui-knowledge/src/index.ts).
  A thin, stateless adapter: it speaks MCP to Claude and REST to OpenWebUI, and
  owns no data. Anything it stores is a bug.
- **Consumers** — repos that keep documents in the collections and sync them.
  They own the ingestion policy; this repo owns transport and retrieval.

The MCP server never talks to Chroma or Postgres directly. Retrieval semantics
belong to OpenWebUI; going around it would fork the ranking behaviour.

## Repo map

| Path | What |
| --- | --- |
| [docker-compose.yaml](docker-compose.yaml) | the stack; image tags are pinned on purpose |
| [docker-compose.override.example.yaml](docker-compose.override.example.yaml) | template for the gitignored local override; host paths and per-deployment policy live there |
| [mcp/openwebui-knowledge/src/index.ts](mcp/openwebui-knowledge/src/index.ts) | the whole MCP server, single file |
| [prompts/](prompts/) | system prompt used in the OpenWebUI chat UI |
| `.env` | credentials and per-deployment settings — gitignored, see `.env.example` |
| [tools/githooks/pre-commit](tools/githooks/pre-commit) | sanitization gate; private terms go in gitignored `.sanitize-deny` |
| [tools/reindex.py](tools/reindex.py) | re-embed one collection file by file, resumably, when the vector store is lost |

## MCP tools

Read: `ping_openwebui` · `list_collections` · `list_documents` · `get_document` ·
`select_context_files` · `search_knowledge` · `wait_pending` · `doctor_collection`.
Write: `create_collection` · `upload_document` · `upload_document_from_path` ·
`dedupe_collection` · `remove_document`. The path variant reads only under
`OPENWEBUI_UPLOAD_ROOTS`, which is empty by default and refuses every path.

A `replace` outlives its own RPC: the tool returns `replace_pending` and a
background task removes the old version once the new one is linked. That task is
in memory, not state — a restart loses it and the old version merely stays, which
is what `dedupe_collection` is for. `wait_pending`'s `settled: true` means the
queue is empty, not that every replace succeeded; read `replace_done` beside it.
Blocking tools default to 45 s and cap at 55: an MCP call over a bridge is cut at
about 60 and the bridge's own overhead takes several seconds of that.

`collection` accepts an id **or a name** — a model can produce a name and cannot
guess a uuid; an ambiguous name is refused with the candidates rather than
resolved to whichever matched first. `search_knowledge` filters by `min_score`
(see below) and takes `collections` for a multi-collection query. Every tool
carries MCP annotations, and every failure is JSON with a `code`.

Transport: Streamable HTTP on `/mcp`, deprecated HTTP+SSE on `/sse` for older
clients. Register with:

```sh
claude mcp add --scope user --transport http openwebui-knowledge http://localhost:8787/mcp
```

## Skills

None in this repo — the stack is infrastructure, and the routines that use it
belong to the repos whose documents live in the collections. The pattern worth
copying is a session-close skill that (1) writes findings into their real homes,
(2) regenerates a short digest, (3) syncs changed documents, (4) once
`wait_pending` settles, calls `doctor_collection` — an empty queue says the writes
landed, not that the vectors survived. It lives in the consumer repo that owns the
collection, not here.

## Rules of engagement

- **Comments earn their place.** Explain *why*, never *what* the next line
  already says. A constant gets one to four lines, not a page. Never bake
  measurements taken from private data into a public file — they leak and they
  go stale.
- **Keep the MCP server one file** until it genuinely stops fitting. It is an
  adapter; splitting it into layers costs more than it returns.
- **Pinned image tags stay pinned.** `:main` and `:latest` change under you; an
  upgrade should be a decision, not a side effect of `docker compose pull`.
- **Never commit `.env`**, and never echo a key into output that lands in a
  commit, an issue, or a README.
- **The repo is English, end to end.** Code, comments, identifiers, log messages,
  docs and the local notes beside them. The corpus this stack indexes is Russian;
  the repo that serves it is not. Reproduce a non-English string only when it has
  to be verbatim — a probe query, a sample chunk — and quote it as data rather
  than writing prose around it. One deliberate exception: `prompts/` holds a
  runtime artifact, not source, and is written in the operator's language — leave
  it alone. `polymarket/` is a separate project that happens to sit in this
  directory; it is gitignored and out of scope.
- **The sanitization hook is not optional.** `git config core.hooksPath
  tools/githooks` once per clone; it refuses a commit carrying credentials,
  Cyrillic or a denylisted term. Keep the private terms in `.sanitize-deny`,
  never in the hook — a denylist in a public repo publishes what it hides.
- **No employer or client identifiers.** This is a personal stack; keep work
  project names, internal repo names and team vocabulary out of it, including
  commit messages. The knowledge collections are where that material lives.
- After editing the server: `npx tsc -p tsconfig.json`, then
  `docker compose up -d --build openwebui-knowledge`. The image must match source.

## Operational knowledge

Each of these was found the hard way, and none of them announces itself.

**Getting an API key.** Key creation is gated by a *user permission*, not just the
global toggle: Admin → Users → Groups → Default permissions → Features → API
Keys. Off by default, and the create button returns 403 with no explanation.
Take the `sk-...` key, **not** the JWT shown above it in the same panel — the JWT
expires in four weeks and takes the integration down with it.

**`WEBUI_SECRET_KEY` must be set.** Without it OpenWebUI generates a new signing
key on every restart and logs everyone out.

**Upgrading OpenWebUI across several minor versions.** Its built-in migration
runs at import time and dies on a circular import, logging `Error running
migrations` and continuing. Installs already at head never notice; a
multi-version jump then fails on a column the un-run migration should have
created. Run alembic out-of-band first, importing config fully so the module is
initialised:

```sh
docker compose run --rm --no-deps -e ENABLE_DB_MIGRATIONS=false --entrypoint python openwebui -c '
import open_webui.config as c
from alembic import command
from alembic.config import Config as AlembicConfig
cfg = AlembicConfig(str(c.OPEN_WEBUI_DIR / "alembic.ini"))
cfg.set_main_option("script_location", str(c.OPEN_WEBUI_DIR / "migrations"))
command.upgrade(cfg, "head")'
```

**A vector store is pinned to its embedding model's dimension.** Change the model
and every write fails with `expecting embedding with dimension of N, got M`. The
collection has to be dropped and refilled. The documents survive in Postgres, so
`POST /api/v1/knowledge/reindex` rebuilds the vectors — it walks the
`knowledge_file` join, so orphaned file records cost nothing, but it is one
synchronous request over every linked file and it drops each collection *before*
refilling it, so an interrupted run leaves collections empty.

**Check a volume against the path the image actually writes to.** `chromadb/chroma`
carries `persist_path: "/data"` in its `/config.yaml`; a volume mounted on the
older `/chroma/chroma` is accepted, stays empty, and never receives a byte. The
vectors then live in the container's writable layer, so every backup of the volume
is empty and the next `docker compose up` that *recreates* the service — a changed
`ports` line or an image bump is enough, and compose recreates dependencies too —
deletes the entire store while the volume still looks healthy. Nothing errors:
`list_documents` keeps reporting every file, `failed` stays empty, and search
simply returns nothing. What distinguishes it fastest is the embedding date
against the file date, and asking Chroma directly whether a collection with that
id exists at all. Verify by measurement after any change: write one document,
`docker compose up -d --force-recreate vector-db`, search for it again.

**Attach on upload, never in a second call.** `POST /api/v1/files/` followed by
`knowledge/{id}/file/add` loses a race it gives no hint of: extraction runs in a
background task, the upload returns while it is still going, and the add then
rejects the file with "The content provided is empty" — which reads like a corrupt
document rather than a timing bug. Pass `metadata={"knowledge_id": ...}` on the
upload instead and OpenWebUI embeds into the collection and links the file itself,
with nothing to race. Send `metadata` as a plain form field: a multipart part with
its own content type arrives as an upload and is rejected. Embedding is still
asynchronous either way, so poll `knowledge/{id}/files/pending` before treating the
document as searchable. Both routes write the file's own `file-{id}` store as well
as the collection's, so neither saves an embedding pass — the difference is the
race, not the cost.

**Removing a file from a collection deletes it.** `POST
/knowledge/{id}/file/remove` takes `delete_file`, defaulted to `not
ENABLE_KNOWLEDGE_FILE_RETENTION` — and retention is off by default, so the call
that reads like an unlink also drops the file record and its blob. Retention on
is the other trap: every superseded version then survives forever, which is how
`uploads` fills with orphans nothing references. Whichever way it is set, say so
where the tools are documented — the tool descriptions here promised "the file
itself stays", and nothing contradicted them until a delete of an
already-detached file came back 404.

**A file joins its collection only after it is embedded.** OpenWebUI runs
extraction and embedding first and calls `add_file_to_knowledge_by_id` last, so
between the upload and the end of the queue the document is in no listing and in
no search result. Nothing is stale and nothing is lost — the file simply is not a
member yet. Read `knowledge/{id}/files/pending` to see it. The trap is that a
listing taken in that window looks authoritative and is merely early; a caller
that retries on it uploads the document a second time. It also means a
replacement cannot be detached until its successor is linked, or the collection
spends the whole embedding window empty.

**"Absent from both lists" is not absence.** `files/pending` selects
`data.status in ('pending','processing')` only, so a file whose processing
*failed* — a rejected extension, an unreadable document, duplicate content, a
dimension mismatch — is in neither the collection listing nor the pending one,
and its orphaned `file` row with `meta.data.knowledge_id` is what is left. There
is no server-side filter for it: the tools scan the newest pages of
`GET /api/v1/files/?content=false` for `data.status == 'failed'` and surface it as
`failed` / `failed_recent`. Read `data.error` for the reason, and do not re-upload
the same bytes — they fail the same way.

**Two hashes, and the obvious one is the wrong one.** `file.hash` is the sha256
of the *extracted text* (`calculate_sha256_string(text_content)`), written when
processing succeeds and set back to null when it fails. The digest of the
uploaded bytes — the one a caller can compute before uploading, and the one
`sync/diff` compares — is `meta.file_hash`. Comparing a local digest against
`hash` appears to work on clean LF markdown, where extraction is close enough to
the identity, and silently re-uploads everything else.

**Retrieval settings do not behave as their names suggest.**
`ENABLE_RAG_HYBRID_SEARCH` defaults to off, and while it is off the API silently
ignores `hybrid: true`. With it *on*, `hybrid: false` does not turn it off either:
the handler's else-branch calls `query_collection`, which re-reads the same flag
and runs hybrid search with the global `k_reranker`/`r`/`bm25_weight` instead of
the call's. The parameter only ever chose which set of parameters applied, so the
tools expose the knobs and not the switch. With hybrid on and no reranking model
configured, every query re-embeds its candidates — on CPU that is seconds per chunk, and the cost scales
with `top_k`. `RELEVANCE_THRESHOLD` lives only on that same hybrid path, so on
the cheap path it does nothing: retrieval always returns `top_k` chunks, however
irrelevant. That is why the MCP server filters by `MIN_SCORE` itself. The two
paths also score on different scales — a threshold measured on one will misfire
on the other.

**A score floor belongs to the corpus, not to the stack.** `MIN_SCORE` is set by
probing one collection — score a batch of relevant queries and a batch of
unrelated ones, then put the floor in the gap between the two bands. Those bands
move when the material changes. Conversational or distilled text — chat exports,
transcripts, meeting notes — scores systematically lower against a well-formed
question than curated prose does, because it is not written like an answer to
one. Carry a floor across that boundary and the collection returns almost
nothing, which reads exactly like a broken ingestion pipeline and sends you to
debug the wrong thing. Calibrate per collection on a sample, and pass `min_score`
in the call rather than moving the default.

**Corpus size does not bloat the context.** Retrieval injects `top_k × chunk_size`
regardless of collection size. What size costs is competition: near-duplicate
documents crowd each other out of those few slots. Split collections by role and
keep artifacts atomic.

**Identical chunks collapse into one result.** OpenWebUI keys retrieved chunks by
a hash of their text (`merge_and_sort_query_results`), so byte-identical chunks in
different documents count as a single hit. Repeated boilerplate that lands in its
own chunk — a per-artifact provenance header, a shared preamble — therefore eats
the result set: a query whose nearest neighbours are those chunks comes back with
one row instead of `top_k`, and the real answers never surface. Nothing errors;
the response is just short. Keep boilerplate out of its own chunk, and when recall
on a collection looks arbitrary, compare its chunk count against its *distinct*
chunk count.

**The default embedding model is English-only** with a 256-token limit. Non-Latin
text tokenises far worse, so a chunk sized for English is silently truncated
mid-way. Check `max_seq_length` against your own corpus before trusting recall.
This stack therefore pins a multilingual model in `docker-compose.yaml` as well as
in persistent config: the pin is what stops a deploy without that config from
falling back to the default and failing every write on the dimension mismatch.
