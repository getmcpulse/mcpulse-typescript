/**
 * MCPulse — analytics for MCP servers.
 *
 * ```ts
 * import { watch } from "@mcpulse/sdk";
 *
 * const server = watch(myServer, { key: "mp_live_…" });
 * ```
 *
 * Three rules this package keeps, in order of how badly it would hurt to break
 * one:
 *
 * 1. **Never throw.** Every entry point swallows. If MCPulse fails inside a
 *    customer's tool call, their tool fails and they blame us.
 * 2. **Never block.** Record, buffer, return. Nothing awaits the network on the
 *    path a model is waiting on.
 * 3. **Never store customer data.** Sizes and hashes leave this process.
 *    Arguments and results do not, and no option turns that off.
 */

export { watch } from "./watch.js";
export type { WatchOptions } from "./options.js";
export type { AgreeOptions, AgreementField, AgreementMap, AgreementSite } from "./agree.js";
export type { PolicyMap, ToolPolicy } from "./policy.js";
export { SDK_NAME, SDK_VERSION } from "./version.js";
export type {
  AgreementPayload,
  CallPayload,
  Outcome,
  Payload,
  StartupPayload,
} from "./types.js";
export { WIRE_VERSION } from "./types.js";
