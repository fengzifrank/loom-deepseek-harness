# Loom Feature Guide (features.md)

> Moved from the README front page so the homepage can lead with diagrams. Pair with the [diagram gallery](diagrams.zh.md) (Chinese).

## Approvals & replay debugging (M2)

**Policy as a declaration.** `app.policy({...})` compiles to a `tools/pre-execute` verdict (the kernel's reorderable policy layer): `allow` passes, `deny` refuses, `approve` returns the kernel's `ask` verdict — the kernel tool pipeline then routes it through `ctx.approval.request` (with automatic `approval/asked`/`approval/decided` audit events in the session log). Loom registers an answerer that pushes a `loom/approval-asked` card over the session's SSE stream and waits for an HTTP decision or a timeout (default 5 minutes; timeout = rejected, fail-closed):

```typescript
app.policy({
  default: 'allow',
  rules: [
    { tool: 'gis_update_*', effect: 'approve' },   // real disk writes need a human
    { tool: 'gis_query_*',  effect: 'allow' },      // read-only queries pass
  ],
})
```

Rules are evaluated last-match-wins. In the browser, the chat stream shows an approval card (tool, args preview, allow/reject buttons); allow executes the write, reject fails the tool call with `the user rejected tool "..."`. After an SSE reconnect or page refresh, still-pending approval cards are re-sent under the original `approvalId` (the frontend dedupes by id, so pending approvals survive reconnects); concurrent answers to the same approval accept only the first (late answers get 409 `ALREADY_DECIDED`).

```bash
# Decide a pending approval from anywhere:
curl -X POST -H "content-type: application/json" \
  -d '{"decision":"allowed-once"}' \
  "http://127.0.0.1:4620/~loom/sessions/<sessionId>/approvals/<approvalId>"
```

**Time travel.** Every session is an append-only log, so any moment is re-readable and forkable:

```bash
# Bounded replay of events up to seq N (the stream ends after the range):
curl -N "http://127.0.0.1:4620/~loom/sessions/<sessionId>/events?since=-1&to=42"

# Fork at a completed turn boundary (the kernel rejects cuts inside an open turn → 400):
curl -X POST -H "content-type: application/json" \
  -d '{"atSeq":42}' \
  "http://127.0.0.1:4620/~loom/sessions/<sessionId>/fork"
# → { "sessionId": "session-gis-platform-fork-…", "forkedFrom": "…", "atSeq": 42 }
```

The example app ships a debug panel: drag the slider to any seq, see the workspace projection folded at that moment, and fork from there. Forked sessions are read-only replay views (the kernel does not allow attaching a second agent to an already-live session).

## Tool → HTTP API (the second face)

`.http(method, path?)` mounts the same tool as an HTTP endpoint (default path `/~loom/api/<toolName>`). Requests execute through the kernel tool pipeline (`ctx.tools.execute`), so schema validation and the declared policy apply:

```bash
curl "http://127.0.0.1:4620/~loom/api/gis_query_land_types?region=连河村"
# → { "totalAreaSqm": 57351531.17, "items": [...], "queriedAt": "…" }   (x-loom-exec: pipeline)
```

## Channels & multi-agent delegation (M3)

**Webhook entry.** `app.channel.webhook(path, opts)` declares an inbound route: the runtime verifies `x-loom-signature` (plain HMAC-SHA256 of the raw body, hex; compared with `timingSafeEqual`) when a `secret` is declared — 401 with a clear `{ error, code }` shape on missing/malformed/mismatched signatures — then maps the JSON payload to a task text (`map`; a throw or non-string returns 400 without creating a session), finds or creates a session by `sessionKey`, and hands the text to the agent asynchronously, immediately answering `202 {sessionId}`:

```typescript
app.channel.webhook('/hooks/demo', {
  agent: 'data-analysis',
  map: payload => `【webhook】${String(payload.text)}`,
  secret: 'whsec_loom_demo',                    // declare to require x-loom-signature
  sessionKey: payload => String(payload.topic), // same key → same session
})
```

```bash
BODY='{"text":"查询连河村的地类面积，给出一句汇总","topic":"village-lianhe"}'
SIG=$(node -e "const c=require('crypto');console.log(c.createHmac('sha256','whsec_loom_demo').update(process.argv[1]).digest('hex'))" "$BODY")
curl -X POST -H "content-type: application/json" -H "x-loom-signature: $SIG" \
  -d "$BODY" "http://127.0.0.1:4620/~loom/hooks/demo"
# → HTTP 202 { "sessionId": "session-gis-platform-hook-village-lianhe-…", "agentId": "data-analysis", "reused": false }

curl -N "http://127.0.0.1:4620/~loom/sessions/<sessionId>/events?since=-1"   # agent progress over SSE
# wrong signature → 401 { code: "SIGNATURE_MISMATCH" }; a throwing map → 400 { code: "MAP_FAILED" } (no session created)
```

The signature is tamper-proofing, **not replay protection** (no timestamp/nonce window): re-sending a signed payload enqueues it again. Deployments that need replay protection should verify a payload-borne timestamp/idempotency key inside `map`, or sit behind a reverse proxy that provides one; concurrent requests sharing a `sessionKey` are de-duplicated server-side — exactly one session is created and the rest reuse it (see the `reused` flag).

**Subagents.** `app.subagent(id, opts)` compiles to a `subagent` delegation tool registered **in the parent agent's scope only** (agents not listed in `visibleTo` never see it, and the tool only spawns declared specs). Each delegation runs through the kernel subagent seam (`dsh-subagent` + in-process spawn provider added to the composition): `persona` becomes the kernel's per-child persona, `tools` becomes the child's `toolFilter` allow-list, and the child inherits the parent's provider/model. The child lives in its own session in the same session store — the runtime registers it and pushes `loom/subagent-started {spec, childSessionId}` into the parent's SSE stream, so the existing `GET /sessions/:id/events` endpoint streams the child live and the UI shows parent/child activity side by side:

```typescript
app.subagent('researcher', {
  persona: '数据核对研究员：只负责查证与核对，给结论配证据',
  tools: ['gis_query_land_types'],   // child-visible tools (kernel toolFilter)
  visibleTo: ['data-analysis'],      // only these parents can delegate
})
```

Ask the parent “让研究员核对连河村和太平河村的地类数据，然后汇总差异” and the parent stream shows `tool/call(subagent)` → a live child session (its own turns and tool calls) → the parent receiving the result → its final summary. The example app's "多智能体" panel renders both streams; the child panel collapses when it finishes.

## Typed client & transcript evals (M4)

**`loom client` — the third face as code.** One command reads your AppSpec and generates a typed client (`src/loom.client.ts`, `AUTO-GENERATED` header, deterministic bytes). Tools that declared `.http()` become typed fetch wrappers — args come from `InferToolArgs`, returns from the new `InferToolOutput` (the same DSL→TS conditional mapping the kernel converter semantics use: `required: true` → required field) — so changing a declaration and regenerating breaks every stale call site at compile time. Agent ids become a literal union; `streamEvents` wraps the projection SSE into an `AsyncIterable`:

```typescript
import { loomTools, loomSessions, configureLoomClient } from './src/loom.client'

const r = await loomTools.gis_query_land_types({ region: '连河村' })   // r.totalAreaSqm: number → 57351531.17
const { sessionId } = await loomSessions.createSession('data-analysis')
await loomSessions.sendMessage('data-analysis', sessionId, '查询所有村庄的地类占比')
for await (const event of loomSessions.streamEvents('data-analysis', sessionId)) { /* seq-ordered */ }
```

**`loom eval` — real transcripts as the eval set.** The session log is already the ground truth, so evals are *pure replays*: `loom eval --slim <session.jsonl> -o fixtures/x.jsonl` distills a raw log (assistant/chunk folded, tool/approval/turn events kept), and each `evals/*.eval.ts` asserts over it. No key, no network — agent behavior (approval loops, delegation chains, webhook entries) gets free regression coverage in CI, and the fixture set grows from real usage:

```typescript
export default defineEval({
  name: 'approval-allowed',
  fixture: 'fixtures/approval-allowed.jsonl',
  assert(ev) {
    ev.expect.toolCalled('gis_update_land_note')      // the model really called the write tool
    if (ev.expect.approvalFlow().outcome !== 'allowed-once') throw new Error('expected allow')
    ev.expect.turnEnded('completed')                   // and the turn finished cleanly
  },
})
```

```bash
pnpm client          # regenerate examples/gis/src/loom.client.ts (CI fails on git diff)
pnpm eval:gis        # loom eval evals → 5/5 replay assertions, zero network
```

## OpenAPI interop (M5)

**Two-way interop: get out, get in.** OpenAPI is the lingua franca of APIs — `loom openapi` exports the Loom declaration as an OpenAPI 3.1.0 document (any codegen/gateway/testing tool can consume it), and `loom import-openapi` turns any external OpenAPI doc into Loom tool declarations (one line to attach; the external API instantly gains the model face + HTTP face + policy/approval). Complementary to FastAPI: already have a FastAPI service? Drop its openapi.json into Loom. Built on Loom? One command hands the API face to any OpenAPI client.

```bash
# Out: export the AppSpec as OpenAPI 3.1.0 (deterministic: same declaration → same bytes)
pnpm openapi:gis               # generates examples/gis/openapi.json (CI fails on git diff)
curl http://127.0.0.1:4620/~loom/openapi.json | head    # live doc at runtime, same source as the artifact

# In: import an external OpenAPI doc (URL or local JSON) → loom.openapi.ts
pnpm exec loom import-openapi https://petstore.example.com/openapi.json
pnpm exec loom import-openapi ./fastapi-openapi.json -o loom.openapi.ts --base http://127.0.0.1:8000
```

```typescript
// One line in loom.app.ts (the generated module is AUTO-GENERATED tool declarations + a real fetch execute):
import { registerImportedTools } from './loom.openapi'
const app = defineApp('gis-platform', { model: 'deepseek-v4-flash' })
registerImportedTools(app)        // external APIs become Loom tools: policy/approval/projections apply as usual
```

- **The doc is the runtime validation**: `dslToJsonSchema` shares semantics with the runtime — field-level `required` is hoisted to the JSON Schema `required` array, objects get `additionalProperties: false` (what the doc says is what the kernel enforces); complex query values on GET/HEAD/DELETE carry the `x-loom-query-json` extension (JSON-encoded strings, symmetric with the server's parseScalar); the `500` response honestly documents the `{ok:false, error, tool}` shape.
- **Honest degradation on import**: local `$ref` expansion, allOf shallow-merge, nullable unions land as scalars; anything Loom's DSL doesn't cover (mixed anyOf branches, format/min·max constraints) degrades to `{type:'json'}` or a bare type with a `// WARN(openapi-import)` comment right above the line — promise less, never silently wrong schemas. Path params `{id}` become required input fields; write operations (POST/PUT/PATCH/DELETE) get an `app.policy` approve suggestion comment; securitySchemes produce a `LOOM_IMPORT_TOKEN` auth injection point.
- **Bootstrapped roundtrip verified**: `examples/gis/tests/openapi-roundtrip.e2e.test.ts` boots the gis service → fetches the live doc → imports it → dynamic-imports the generated module via tsx → registers into a mini app → calls execute directly (region='连河村') → asserts `totalAreaSqm === 57351531.17` — zero key, real endpoint, real data.
- **Route governance**: `.http()` route derivation converges on a single `httpRouteOf` (shared by runtime registration, the health listing, client-gen and openapi-gen); a custom path containing `{` throws at declaration time (path params unsupported — model them as query/body input fields).

## Python tool bridge (M6)

**The kernel stays TypeScript; Python becomes a first-class tool-authoring language.** Statistics, data science, existing Python assets — write the tools in Python and attach them with one declaration: the model sees and calls them immediately, and policies/approvals keep working. Full guide (install / decorators / inference-rules table / cancellation & error semantics / stdout-pollution warning / known limits) in [docs/python-tools.zh.md](docs/python-tools.zh.md) (Chinese).

```python
# py_tools.py (pure stdlib; type annotations infer the JSON Schema)
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "loom-py"))
from loom_py import tool, run

@tool("Mean and standard deviation of village area ratios", output_schema={
    "type": "object",
    "properties": {"meanRatioPct": {"type": "number"}, "stdRatioPct": {"type": "number"}},
    "required": ["meanRatioPct", "stdRatioPct"],
})
def gis_area_stats(precision: int = 2) -> dict:
    ...   # the statistics module computes the std deviation

run()   # enters the stdio protocol loop at the end
```

```typescript
// one line in loom.app.ts
app.python({ command: 'python py_tools.py' })   // spawn + handshake -> manifest registered as proxy tools
```

- **Lightweight custom protocol** (loom-py v1, stdio JSON Lines): the TS bridge spawns the subprocess → `initialize` handshake → `tools/list` manifest → `tools/call` forwarding `{name,args,callId}` → `{value}|{error}`; cancellation is a best-effort `tools/cancel` notification. Manifest validation (legal names / required fields / duplicate rejection) and the jsonSchema→DSL conversion reuse M5's `jsonSchemaToDsl` (required hoisting, honest degradation).
- **Process resilience**: exceptions become structured errors (type + innermost traceback frame; the kernel turns them into isError tool results the model can self-correct from); process exit fails in-flight calls clearly and auto-restarts after 1s (limit 3, then unavailable + fail-loud log); a failed handshake fails the boot outright.
- **Zero-dependency discipline**: the `loom_py` package is pure stdlib (pydantic only *enhances* schema inference when importable), `python -m loom_py.selftest` self-verifies; the fake-subprocess integration test (node simulating python stdio) needs no real Python and always runs in CI.
- **Relation to OpenAPI import**: complementary — `loom import-openapi` attaches *existing HTTP services* (docs in any language), `app.python` lets *new business logic* be written directly in Python (no HTTP face, subprocess round-trip, zero network). Both can be used in the same app.
- **v1 limits**: Python tools are model-facing only (no `.http()` / client-gen / OpenAPI export); shared by all agents; single bridge; stdout carries protocol only (a stray print corrupts it — debug via stderr).

## Memory & Multi-user (M7)

**Restart without amnesia.** Every created session is registered in a sidecar index;
after a restart, routes resolve unknown sessionIds through the index and lazily
`agents.resume` them (identical persona and scoped-tool setup), so history replays
fully and the same sessionId keeps chatting. The frontend `SessionList` shows past
sessions (click to continue, button to start new); `useAgentSession` persists the
sessionId in localStorage and reconnects with full replay on page refresh.

**Multi-user in one line.** With `app.auth()`: anonymous visitors get an automatic
UUID, `POST /~loom/auth/register|login` creates local accounts (scrypt + HMAC
tokens, zero third-party deps); identity-less writes get 401, sessions and memories
are isolated per userId (someone else's → 404 without leaking existence), approval
decisions are owner-only. SSE accepts `?token=`/`?user=` query params
(EventSource cannot send headers).

**loom memory: remember the user, answer like an old friend.** `app.memory()` plus
per-agent `memory: true` (extraction costs tokens, off by default):

```ts
app.auth()
app.memory({ extraction: { maxPerTurn: 3 } })
app.agent('data-analysis', { persona: '…', tools: […], memory: true })
```

- **Write path** (mem0-v2 two-phase): after each completed turn a per-session
  serial queue extracts candidates `{kind, content}`, compares them against FTS
  neighbors, and applies ADD/UPDATE/DELETE/NOOP decisions into
  `.loom/memory.db` (node:sqlite FTS5, zero new deps, CJK bigram tokenizing);
- **Read path**: on the session's first user message, FTS top-K hits are wrapped
  in an anti-injection frame and injected with `form:'recall'` for the next
  pre-step (no extra model wake-ups);
- **Model tools**: memory_search / memory_write / memory_forget (forget is meant
  to be paired with an approve policy rule);
- **Panel**: `MemoryPanel` to search/edit/delete your own memories.

See [docs/auth.zh.md](docs/auth.zh.md) and [docs/memory.zh.md](docs/memory.zh.md)
(Chinese) for the full guides.

## Testing & CI

```bash
pnpm test          # unit + keyless smoke + approval/delegation/client/OpenAPI-roundtrip/Python-bridge/QA-matrix e2e (key e2e self-skips without DEEPSEEK_API_KEY; real-Python tests self-skip without python; fake-subprocess tests always run)
pnpm test:unit     # pure functions only (policy compiler, compose, SSE projection, chat folding, webhook/subagent compilers, client-gen, openapi export/import generators, eval, python-bridge protocol/manifest/mapping)
pnpm test:e2e      # real-key approval chain + delegation/webhook chains + generated-client call against a live service + the Python tool chain
pnpm eval:gis      # transcript evals (zero network, zero key)
pnpm openapi:gis   # regenerate examples/gis/openapi.json
pnpm typecheck
```

CI lives in `.github/workflows/ci.yml` (pnpm + Node 24 + frozen lockfile + build + typecheck + test + typed-client & OpenAPI export freshness gates (`loom client` / `loom openapi` must be `git diff --exit-code` no-ops) + transcript evals + vite build; an optional e2e job runs when the `DEEPSEEK_API_KEY` secret is configured). Once pushed to GitHub, CI runs automatically.

## Plugin ecosystem & version pinning (M8)

Loom is both a **consumer** and a **producer** in the dsh-plugin ecosystem — details in [docs/plugin-ecosystem.zh.md](docs/plugin-ecosystem.zh.md):

- **Consumed** (all pinned to exact `0.1.1-rc.1`): `dsh-session-query-sqlite` + `dsh-tool-session-query` (model-facing `session_search` over session history; keyed e2e proves the model really calls it) and `dsh-host-frontend-static` (production static serving in `loom start` — it takes the webserver's single SPA-fallback seat; verified: same-port `/` 200, SPA fallback 200, health 200, traversal 403, non-GET 405). Evaluated but not adopted: `dsh-session-log-export` (a browser `/export` ZIP command — not isomorphic to Loom's programmatic `--slim` pipeline).
- **Produced** (workspace packages, not yet on npm): [`dsh-python-tools`](../packages/python-tools) — the Python tool bridge (incl. the `jsonSchemaToDsl` converter shared with OpenAPI import), and [`dsh-web-approval-answerer`](../packages/web-approval-answerer) — the SSE approval answerer (reconnect replay, concurrent-answer 409, fail-closed timeout). Both carry `dsh-plugin` in keywords, MIT, bilingual READMEs and independent unit tests; `compose` resolves their entry URLs from `@loom-sdk/web`'s own dependencies so apps don't declare them.
- **Pin discipline**: every `@deepseek-ai/*` dependency is pinned to an exact version. Fact: the npm `latest` dist-tags of these packages currently point at stale `0.0.1-rc.x` releases (rc.1/rc.3/rc.5), so floating ranges would silently install half-year-old builds. Upgrading (e.g. to a future rc.7) is a deliberate event: bump the whole set together and re-run the full e2e suite before merging — mixed versions are undefined behavior.

