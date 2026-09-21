/**
 * Tools a model is *right* not to call, declared so they stop being penalised.
 *
 * ── This is a sign error, not a gap ────────────────────────────────────────
 * Every other signal in this product measures something that is missing. This
 * one corrects a measurement that points the wrong way.
 *
 * A model can correctly decline a perfectly well-described tool because the
 * user has not authorised its side effect, or because the identity it needs is
 * unverified. That is the system working. Measured as selection rate it reads
 * as poor discoverability, and the advice that follows — "rewrite the
 * description so it gets called more often" — makes the server *less safe*.
 *
 * ── The five stages, and which of them are observable ──────────────────────
 *
 *     candidate -> eligible    policy filter. No schema change touches it.
 *     eligible  -> selected    discoverability. Everything else in the product.
 *     selected  -> attempted   arguments the model could not fill.
 *     attempted -> succeeded   the handler.
 *
 * Three of those four gaps are visible from inside the server. The first is
 * not: the decision happens in the client and the protocol reports nothing back
 * about it. A tool that was filtered out and a tool that was never chosen look
 * identical from here, and no amount of instrumentation changes that.
 *
 * So it is author-declared. That is a weaker kind of data than the rest of this
 * package collects, and it is the only kind available — the alternative is not
 * better data, it is a metric that keeps telling people to remove a safety
 * check.
 */

/** What has to be true before a client will even consider this tool. */
export interface ToolPolicy {
  /** The user must have authorised this tool's side effect. */
  requiresAuthorization?: boolean;
  /** The caller's identity must be verified. */
  requiresVerifiedIdentity?: boolean;
}

/** Tool name → its preconditions. */
export type PolicyMap = Record<string, ToolPolicy>;

/**
 * The same thing on the wire, in the snake_case the API validates.
 *
 * A separate shape rather than the options type sent straight through, because
 * the option names are a public API in TypeScript spelling and the payload is a
 * contract shared with nine other SDKs.
 */
export interface WirePolicy {
  requires_authorization: boolean;
  requires_verified_identity: boolean;
}

/**
 * Read the declaration for one tool, or `null` when it has none.
 *
 * `null` rather than a pair of falses, so "no policy" and "a policy that
 * requires nothing" stay distinguishable at ingest. Only the first excludes a
 * tool from the discoverability metrics.
 */
export function policy_for(policy: PolicyMap | undefined, tool: string): WirePolicy | null {
  const declared = policy?.[tool];
  if (!declared || typeof declared !== "object") return null;

  const authorization = declared.requiresAuthorization === true;
  const identity = declared.requiresVerifiedIdentity === true;

  // A declaration that requires nothing is a mistake rather than a request to
  // exclude the tool, and treating it as a policy would silently drop the tool
  // out of every discoverability figure the author is trying to read.
  if (!authorization && !identity) return null;

  return { requires_authorization: authorization, requires_verified_identity: identity };
}
