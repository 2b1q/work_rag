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
| [mcp/openwebui-knowledge/src/index.ts](mcp/openwebui-knowledge/src/index.ts) | the whole MCP server, single file |
| [prompts/](prompts/) | system prompt used in the OpenWebUI chat UI |
| `.env` | credentials and per-deployment settings — gitignored, see `.env.example` |

## MCP tools

`ping_openwebui` · `list_collections` · `list_documents` · `get_document` ·
`select_context_files` · `search_knowledge`.

`collection` accepts an id **or a name** — a model can produce a name and cannot
guess a uuid. `search_knowledge` filters by `min_score` (see below) and takes
`collections` for a multi-collection query.

Transport: Streamable HTTP on `/mcp`, deprecated HTTP+SSE on `/sse` for older
clients. Register with:

```sh
claude mcp add --scope user --transport http openwebui-knowledge http://localhost:8787/mcp
```

## Skills

None in this repo — the stack is infrastructure, and the routines that use it
belong to the repos whose documents live in the collections. The pattern worth
copying is a session-close skill that (1) writes findings into their real homes,
(2) regenerates a short digest, (3) syncs changed documents. A working example:
[ai-nomad `kb-sync`](https://github.com/2b1q/ai-nomad).

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
- Node comments, identifiers and log messages in English.
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
collection has to be dropped and refilled. A Chroma major upgrade can likewise
leave the old data unreadable — the documents survive in Postgres, so
`POST /api/v1/knowledge/reindex` rebuilds the vectors.

**Uploading twice is the default mistake.** `POST /api/v1/files/` followed by
`knowledge/{id}/file/add` embeds the same text twice — once into the file's own
store, once into the collection's. Pass `metadata={"knowledge_id": ...}` on
upload instead: one pass, and the link is made for you. Processing then runs in a
background task, so poll `knowledge/{id}/files/pending`; attaching before
extraction finishes fails with an "empty content" error that reads like a corrupt
file.

**Retrieval settings do not behave as their names suggest.**
`ENABLE_RAG_HYBRID_SEARCH` defaults to off, and while it is off the API silently
ignores `hybrid: true`. With it on and no reranking model configured, every query
re-embeds its candidates — on CPU that is seconds per chunk, and the cost scales
with `top_k`. `RELEVANCE_THRESHOLD` lives only on that same hybrid path, so on
the cheap path it does nothing: retrieval always returns `top_k` chunks, however
irrelevant. That is why the MCP server filters by `MIN_SCORE` itself. The two
paths also score on different scales — a threshold measured on one will misfire
on the other.

**Corpus size does not bloat the context.** Retrieval injects `top_k × chunk_size`
regardless of collection size. What size costs is competition: near-duplicate
documents crowd each other out of those few slots. Split collections by role and
keep artifacts atomic.

**The default embedding model is English-only** with a 256-token limit. Non-Latin
text tokenises far worse, so a chunk sized for English is silently truncated
mid-way. Check `max_seq_length` against your own corpus before trusting recall.
