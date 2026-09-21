/**
 * Who is reporting, and over what.
 *
 * ── Why the wire-mapping table needs this ──────────────────────────────────
 * MCPulse instruments the `McpServer` layer, not the wire. A thrown error and a
 * deliberately returned `isError` are distinguishable here, because this package
 * wraps the tool callbacks — and they arrive at the model identically once
 * `McpServer` has normalised them.
 *
 * How that normalisation behaves is a property of the MCP SDK version and the
 * transport, not of any customer's server. So it is derived once in CI against
 * a fixture server and applied to everyone's data, which works on stdio servers
 * nobody can reach and adds no synthetic traffic to anyone's analytics. But it
 * can only be applied to a customer's rows if their rows say which version and
 * which transport produced them. That is what this file is for.
 *
 * Everything here is best effort and nothing here may throw. A version we
 * cannot determine is reported as absent, and the table is simply not applied —
 * which is the honest outcome, and much better than guessing at the nearest
 * version we have tested.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { LowLevelServer } from "./server-shapes.js";

/**
 * This package's own version.
 *
 * A constant rather than a read of `package.json`: this file is bundled into
 * both an ESM and a CJS artefact, so `import.meta.url` is unavailable in one and
 * `__dirname` in the other, and reading the manifest at runtime would mean a
 * filesystem call on every boot to learn something fixed at publish time.
 *
 * `tests/units.test.ts` asserts this equals the manifest, so the two cannot
 * drift without a test failing.
 */
export const SDK_VERSION = "0.1.6";
export const SDK_NAME = "@mcpulse/sdk";

/**
 * The version of `@modelcontextprotocol/sdk` the customer is running.
 *
 * The MCP SDK does not export its own version, so it is read from the manifest
 * — resolved from the customer's working directory, which is where their
 * dependency tree lives rather than ours.
 *
 * `createRequire` rather than `import.meta.url` or a bare `require`, because
 * this has to work identically in the ESM and CJS builds and only
 * `createRequire` does. Everything is wrapped: a bundled server with no
 * resolvable manifest, a runtime with no filesystem, or a future layout that
 * moves the file all produce `null` rather than an exception on the boot path.
 */
let mcp_version: string | null | undefined;

export function mcp_sdk_version(): string | null {
  if (mcp_version !== undefined) return mcp_version;

  mcp_version = null;
  try {
    const require_from = createRequire(join(process.cwd(), "package.json"));

    // Resolved from a module the SDK certainly has, then walked up to its
    // manifest — not read as `@modelcontextprotocol/sdk/package.json`.
    //
    // That subpath is not in the package's `exports`, so on npm it throws and
    // under pnpm it resolves to something with no `version` on it at all, which
    // is worse: the lookup succeeds and reports `undefined`. Walking up from a
    // file that is definitely there works under every layout, including pnpm's
    // content-addressed one.
    let directory = dirname(require_from.resolve("@modelcontextprotocol/sdk/server/mcp.js"));

    for (let depth = 0; depth < 8; depth++) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (manifest?.name === "@modelcontextprotocol/sdk" && typeof manifest.version === "string") {
          mcp_version = manifest.version;
          break;
        }
      } catch {
        /* No manifest at this level. Keep walking. */
      }

      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    /* Bundled, no filesystem, or a layout we do not know. Absent is the answer. */
  }
  return mcp_version;
}

/**
 * Which transport the server is answering on.
 *
 * Read from the constructor name of the transport the MCP SDK stored when the
 * server connected, and mapped to a small fixed vocabulary — the class names
 * are not a public interface and have been renamed before, whereas `stdio`,
 * `http` and `sse` are what the wire-mapping table is keyed on.
 *
 * Anything unrecognised reports as `unknown` rather than as a guess. A row that
 * says "we do not know" can be excluded from the mapping; a row that says
 * "stdio" when it was SSE cannot be found at all.
 */
export type Transport = "stdio" | "http" | "sse" | "unknown";

export function transport_of(low: LowLevelServer | null): Transport {
  try {
    const held = (low as { _transport?: unknown } | null)?._transport;
    if (!held || typeof held !== "object") return "unknown";

    const name = String((held as { constructor?: { name?: unknown } }).constructor?.name ?? "");
    if (/stdio/i.test(name)) return "stdio";
    // Checked before `sse`, because the streamable-HTTP transport's own name
    // contains neither word in every SDK version and this is the broader match.
    if (/streamablehttp|streamable_http/i.test(name)) return "http";
    if (/sse/i.test(name)) return "sse";
    if (/http/i.test(name)) return "http";
    return "unknown";
  } catch {
    return "unknown";
  }
}
