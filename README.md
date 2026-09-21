<img src="assets/logo.svg" alt="" width="44" height="44" align="left" />

# @mcpulse/sdk

Analytics for MCP servers. Tells you whether your tools actually work for the
models calling them.

**[getmcpulse.com](https://getmcpulse.com)** · [Docs](https://docs.getmcpulse.com) · [Dashboard](https://app.getmcpulse.com)

You publish an MCP server and can see nothing: not how many people use it, not
which tools get called, not whether the model understands your descriptions, not
what your server costs the people running it. This package is how that data
gets out.

## Install

```bash
npm install @mcpulse/sdk
```

## Use

One import, one wrap, after your tools are registered. `watch` returns the same
server, so nothing downstream changes.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { watch } from "@mcpulse/sdk";

const server = new McpServer({ name: "my-server", version: "1.0.0" });

// … your registerTool calls …

watch(server, { key: process.env.MCPULSE_KEY });

await server.connect(new StdioServerTransport());
```

### Serving over HTTP

A streamable-HTTP server builds a fresh `McpServer` for every request, so there
is no long-lived instance to wrap. Wrap it inside the factory instead, beside
the tool registration:

```ts
function createServer() {
  const server = new McpServer({ name: "my-server", version: "1.0.0" });

  // … your registerTool calls …

  return watch(server, { key: process.env.MCPULSE_KEY });
}
```

Calling `watch` once per request is expected and cheap. The session and its
buffer are shared for the life of the process, so your calls stay grouped into
one session rather than one per request — which is what keeps retries and
first-call success meaningful.

Get a key by creating an MCP at
[app.getmcpulse.com](https://app.getmcpulse.com) — it is shown once, at
creation.

### Options

| Option | Default | |
|---|---|---|
| `key` | — | Ingest key, `mp_live_…`. Without one the SDK does nothing. |
| `debug` | `false` | Log what is sent, to **stderr** — never stdout, which is the transport. |
| `agree` | off | Fields that more than one tool returns. See below. |
| `agreeOptions` | — | `windowMs` (5 min) and `tolerance` (0.0001) for `agree`. |

```ts
watch(server, {
  key: process.env.MCPULSE_KEY ?? "",
  debug: true,
});
```

### Cross-tool agreement

Opt-in, and it catches the failure every other metric here calls healthy.

Two tools return the same underlying field. A stale cache key, or a versioned
key a cron did not follow, and they disagree for hours. Every number stays green
the whole time — the calls succeed, the results are non-empty, there are no
retries and the latency is fine. Callers get two different answers to one
question and nothing reports it.

Name the value once, and say where each tool returns it:

```ts
watch(server, {
  key: process.env.MCPULSE_KEY ?? "",
  agree: {
    global_liquidity: [
      { tool: "getGlobalLiquidity", path: "globalLiquidity.value_t" },
      { tool: "getPillars",         path: "pillars.global_liquidity.value" },
    ],
    vix: [
      { tool: "getVix",     path: "vix.value" },
      { tool: "getPillars", path: "pillars.vix.value" },
    ],
  },
  agreeOptions: {
    windowMs: 300_000,   // how long a value stays comparable
    tolerance: 0.0001,   // relative, for floats
  },
});
```

A map rather than a list of field names, because the same value routinely ships
under a different name and a different shape in each tool — which is most of why
two copies of it drift apart without anyone noticing.

**The comparison happens in your process, and only the verdict is sent.**

```json
{
  "v": 1,
  "type": "agreement",
  "session_id": "s_7f2a91",
  "field": "global_liquidity",
  "tool_a": "getGlobalLiquidity",
  "tool_b": "getPillars",
  "agreed": false,
  "checked_at": "2026-09-11T14:22:31Z",
  "window_ms": 300000
}
```

No value, no difference, no hash of a value. Hashing could not work anyway:
`25.22`, `25.220` and `"25.22"` are the same number and three different hashes,
so a server-side check would report every representation change as a divergence
forever. Comparing numerically needs the values, and comparing them where they
already are is the only way to have both.

Four things worth knowing before turning it on:

- **`windowMs` must be shorter than your data's refresh interval.** A window
  that outlives a refresh compares a figure against its own predecessor and
  calls a legitimate change a divergence. It also has to be long enough that
  both tools are plausibly called inside it.
- **Integers and strings are compared exactly.** `tolerance` is relative and
  applies to floats only — a count that is off by one is off by one.
- **Nothing is reported until both tools have been called inside one window.**
  A low-traffic tool can stay silently wrong for a long time, which is a limit
  of the method rather than a clean result. Run once with `debug: true` after
  setting it up: a path that never resolves says so there, which is how a typo'd
  declaration shows up as something other than a passing check.
- **The path is searched in `structuredContent`, in the JSON of a text content
  part, and in the result itself**, so it does not matter which envelope your
  tool returns.

## What leaves your process

Per tool call:

```json
{
  "v": 1,
  "type": "call",
  "session_id": "s_7f2a91",
  "tool_name": "search_orders",
  "client_name": "claude-desktop",
  "started_at": "2026-08-09T14:22:31Z",
  "duration_ms": 240,
  "outcome": "ok",
  "response_bytes": 1420,
  "is_empty": false,
  "args_hash": "9c1b4e2f0a11"
}
```

And once at startup, the tool list with the byte size of each schema.

**Never the arguments. Never the results.** `args_hash` is twelve hex characters
of a SHA-256 over the arguments with keys sorted — enough to tell whether two
calls used the same arguments, and not enough for anything else. There is no
option that turns this off, because the guarantee is only worth something if it
cannot be switched off.

### Outcomes

Every call ends as exactly one of these:

| | |
|---|---|
| `ok` | Ran and returned a result. |
| `bad_args` | Arguments failed schema validation — your handler never ran. |
| `tool_error` | Ran and returned `isError: true`. |
| `crashed` | Threw. |

Telling `crashed` from `tool_error` takes some doing. `McpServer` catches
everything a tool does and converts it into `{ isError: true }`, so from outside
its request handler a crash, a returned error and a rejected set of arguments
are the same object. The SDK wraps your tool callbacks as well as the request,
so what actually happened is known rather than guessed from an error message.

`is_empty` marks a call that succeeded and returned nothing useful — an empty
array, an empty object, a blank string. Those are the failures nobody reports:
the protocol calls them success, the model gets nothing it can use, and you
never hear about it.

## The three rules

1. **Never throw.** Every entry point swallows. If MCPulse fails inside your
   tool call, your tool fails and you blame us — so if instrumentation cannot be
   attached, your server is handed back untouched and runs without analytics.
2. **Never block.** Record, buffer, return. Nothing awaits the network on the
   path a model is waiting on.
3. **Never store customer data.** Sizes and hashes only.

Payloads are batched and sent every 5 seconds or every 30 calls, whichever
comes first, with a final flush on the way out. If the network is down the batch
is dropped rather than retried — the buffer is capped at 1000 and sheds the
oldest first, because your server running out of memory over our analytics is
the one failure we must never cause.

## Requirements

Node 20.12 or newer, and `@modelcontextprotocol/sdk` as a peer dependency —
whatever version your server already uses.

## Try it

`examples/test-server` is a real MCP server with one tool per behaviour: fast,
slow, empty, error, crash, and one registered but never called so dead-tool
detection has something to find.

```bash
cd examples/test-server
pnpm install
MCPULSE_KEY=mp_live_… pnpm exercise
```

`pnpm exercise` drives every behaviour once through a real MCP client and waits
for the send. `pnpm start` runs the same server over stdio for a real client to
connect to.

## Read it back in Claude

This package sends the data out. The dashboard is one way to read it and MCPulse's
own MCP server is another — connect it and an agent answers "how is
`search_orders` doing for Cursor" against your own account, with your own
window. It is on every plan, free included.

Sign-in is OAuth, so there is no key to copy or leak. Setup:
[docs.getmcpulse.com/mcp/connect](https://docs.getmcpulse.com/mcp/connect), or
add it from the [Smithery listing](https://smithery.ai/servers/mcpulse/mcpulse).

<!-- Smithery's usage-counter badge belongs on the line above, as:

     [![smithery badge](https://smithery.ai/badge/mcpulse/mcpulse)](https://smithery.ai/servers/mcpulse/mcpulse)

     It is a plain link instead because `smithery.ai/badge/<server>` answers 500
     for every server on the registry, their own `brave` and `gmail` included —
     so the badge renders as a broken image rather than a counter. Swap it in
     once that endpoint recovers; the link above already satisfies Smithery's
     backlink check either way. -->

## Licence

MIT
