import { createHash, randomBytes } from "node:crypto";
import { canonicalize } from "./canonical.js";

/** What an argument set hashes to when it cannot be serialised at all. */
export const UNHASHABLE = "000000000000";

/**
 * A short, one-way fingerprint of a call's arguments.
 *
 * This is the only thing MCPulse ever learns about what was passed to a tool,
 * and it is deliberately not enough to learn anything: 12 hex characters of a
 * SHA-256 over the RFC 8785 canonical form, with no way back. All the product
 * asks of it is "were these two calls made with the same arguments or
 * different ones" — which is what separates a model retrying a reworded
 * request from a client paging through results.
 *
 * Canonicalisation is what makes that question answerable across languages:
 * key order is normalised at every depth, and numbers and strings are written
 * the one way RFC 8785 allows. See `canonical.ts` for why that matters.
 */
export function args_hash(args: unknown): string {
  // A tool that takes no arguments is called with `arguments` absent. That is
  // an ordinary call, not a failure, and it hashes as the empty object it is —
  // otherwise every no-argument tool in the product shares one hash with every
  // call whose arguments blew up.
  const value = args === undefined ? {} : args;

  try {
    return sha256_12(canonicalize(value));
  } catch {
    // Arguments JSON cannot represent (a BigInt, a circular structure, a NaN).
    // The call still happened and still deserves a row; it simply cannot be
    // compared to another, so give it a constant that says exactly that.
    return UNHASHABLE;
  }
}

/**
 * The first 12 hex characters of the SHA-256 of a UTF-8 string.
 *
 * Exported because the description and schema fingerprints in `describe.ts` are
 * the same hash over a different input, and two spellings of one hash function
 * in one package is how they drift apart.
 */
export function sha256_12(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/**
 * Identifies one run of the customer's server, so calls can be grouped and a
 * cost-per-session worked out. Random rather than derived — there is nothing
 * about the process worth encoding here, and anything derived from the machine
 * would be an identifier we did not intend to collect.
 */
export function new_session_id(): string {
  return `s_${randomBytes(6).toString("hex")}`;
}
