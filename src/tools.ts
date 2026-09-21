import { fingerprint } from "./describe.js";
import { current_slot, has_error_flag } from "./outcome.js";
import { policy_for, type PolicyMap, type WirePolicy } from "./policy.js";
import {
  TOOLS_LIST,
  type HighLevelServer,
  type LowLevelServer,
  type RegisteredTool,
} from "./server-shapes.js";

/**
 * Wrapping the author's own tool callbacks.
 *
 * Two entry points, because tools can be registered either side of `watch()`:
 * whatever is already there is wrapped now, and `registerTool`/`tool` are
 * patched so anything registered later is wrapped as it arrives.
 *
 * A callback is wrapped at most once. `registerTool` returns a handle whose
 * `update()` can swap the callback out, and re-wrapping a wrapper on every
 * update would nest them one layer deeper each time.
 */

const wrapped = new WeakSet<object>();

export function wrap_registered_tools(server: HighLevelServer): void {
  const tools = server?._registeredTools;
  if (!tools || typeof tools !== "object") return;

  for (const tool of Object.values(tools)) wrap_tool_handler(tool);
}

export function wrap_tool_handler(tool: RegisteredTool | undefined): void {
  if (!tool || typeof tool.handler !== "function") return;
  if (wrapped.has(tool.handler)) return;

  const original = tool.handler as (...args: unknown[]) => unknown;

  const instrumented = async (...args: unknown[]) => {
    const slot = current_slot();
    if (slot) slot.handler_ran = true;

    try {
      const result = await original(...args);
      if (slot) slot.outcome = has_error_flag(result) ? "tool_error" : "ok";
      return result;
    } catch (error) {
      if (slot) slot.outcome = "crashed";
      throw error;
    }
  };

  wrapped.add(instrumented);
  tool.handler = instrumented;
}

/**
 * Patches the registration methods so later tools are instrumented too.
 *
 * `registerTool` hands back a handle for enabling, disabling and updating the
 * tool. Updating replaces the callback with a fresh, unwrapped one, so the
 * handle's `update` is patched as well — otherwise a tool goes quiet the first
 * time it is changed at runtime.
 */
export function patch_registration(server: HighLevelServer): void {
  for (const method of ["registerTool", "tool"] as const) {
    const target = server as unknown as Record<string, unknown>;
    const original = target[method];
    if (typeof original !== "function") continue;
    if (wrapped.has(original as object)) continue;

    const patched = function (this: unknown, ...args: unknown[]) {
      const handle = (original as (...a: unknown[]) => unknown).apply(this, args);
      const name = typeof args[0] === "string" ? args[0] : undefined;
      if (name) wrap_tool_handler(server._registeredTools?.[name]);
      patch_update(handle, server, name);
      return handle;
    };

    wrapped.add(patched);
    target[method] = patched;
  }
}

function patch_update(handle: unknown, server: HighLevelServer, name: string | undefined): void {
  const target = handle as { update?: unknown } | null;
  if (!target || typeof target.update !== "function") return;
  if (wrapped.has(target.update as object)) return;

  const original = target.update as (...a: unknown[]) => unknown;

  const patched = function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    // `update` can rename the tool, in which case it now lives under a new key.
    const updates = args[0] as { name?: string } | undefined;
    const key = typeof updates?.name === "string" ? updates.name : name;
    if (key) wrap_tool_handler(server._registeredTools?.[key]);
    return result;
  };

  wrapped.add(patched);
  target.update = patched;
}

/**
 * The tool list as the client will see it, which is what the startup payload
 * needs: `schema_bytes` is the cost of a tool's presence in the context window,
 * so it has to be measured on the JSON that actually goes over the wire, not on
 * the Zod schema it was declared with.
 *
 * Asking the server's own `tools/list` handler is the only way to get that —
 * it is the code that does the conversion.
 */
export interface CollectedTool {
  name: string;
  schema_bytes: number;
  schema_hash: string;
  description_hash: string;
  description_norm: string;
  policy: WirePolicy | null;
}

export async function collect_tools(
  low: LowLevelServer,
  policy?: PolicyMap,
): Promise<CollectedTool[]> {
  const handler = low._requestHandlers?.get(TOOLS_LIST);
  if (!handler) return [];

  const result = (await handler({ method: TOOLS_LIST, params: {} }, minimal_extra())) as {
    tools?: unknown;
  };

  if (!Array.isArray(result?.tools)) return [];

  return result.tools.flatMap((tool) => {
    const name = (tool as { name?: unknown })?.name;
    if (typeof name !== "string" || name.length === 0) return [];

    // Hashed from the same object the byte count is taken from — the tool list
    // as the client will actually see it, after the SDK has converted whatever
    // the author declared. Hashing the Zod schema instead would report churn
    // every time a refactor changed the declaration without changing the wire.
    return [
      {
        name,
        schema_bytes: JSON.stringify(tool)?.length ?? 0,
        ...fingerprint(tool as { description?: unknown; inputSchema?: unknown }),
        policy: policy_for(policy, name),
      },
    ];
  });
}

/**
 * Enough of a `RequestHandlerExtra` to satisfy a handler that reads it.
 * `McpServer`'s own `tools/list` ignores it entirely; a hand-written one might
 * not, and the caller treats a throw here as "no tools".
 */
function minimal_extra(): unknown {
  return {
    signal: new AbortController().signal,
    requestId: 0,
    sendNotification: async () => {},
    sendRequest: async () => ({}),
  };
}
