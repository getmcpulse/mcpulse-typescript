/**
 * What a tool's description and schema hash to, and why there are three hashes.
 *
 * ── The failure this catches ───────────────────────────────────────────────
 * From a 123-tool operator: descriptions churn more often and more silently
 * than schemas. A schema gets reviewed because it is an interface. The wording
 * gets edited because it is "just wording" — and then the call pattern moves
 * and nothing in the diff explains why.
 *
 * ── Three hashes, three different questions ────────────────────────────────
 *   `schema_hash`       did the interface change?
 *   `description_hash`  did the wording change?  (exact)
 *   `description_norm`  is this the same description?  (normalised)
 *
 * The third exists because the second cannot answer it. "Search for threads in
 * the user's mailbox" and "Search threads in a user's mailbox" are one
 * description and two exact hashes. Normalising — lowercase, drop stopwords,
 * stem, sort — collapses them to one.
 *
 * That turns the hash from a change detector into an identity, and an identity
 * finds convergence as well as churn: two tools on one server landing on the
 * same normalised hash have arrived at the same wording independently, which
 * means their author could not find a way to distinguish them either.
 *
 * ── No text leaves ─────────────────────────────────────────────────────────
 * Hashes only. The startup payload has never carried a description and still
 * does not. Normalisation happens here, inside the customer's process, for that
 * reason and no other — it would be far easier to do server-side.
 */

import { canonicalize } from "./canonical.js";
import { sha256_12 } from "./hash.js";
import { stem } from "./stem.js";

/**
 * Words dropped before a description is normalised.
 *
 * Plain English glue only. It deliberately does not strip `list`, `get` or
 * `search`: on an MCP server those are the content, and dropping them would
 * make `list_orders` and `get_orders` converge on the same hash when what they
 * share is precisely the thing worth telling apart.
 *
 * Fixed, and identical in all ten SDKs. Adding a word here changes what every
 * stored hash means, so it is pinned by `tests/fixtures/description_norm.json`.
 */
const STOP = new Set(
  `a about above after again against all am an and any are aren as at be because been
   before being below between both but by can cannot could couldn did didn do does
   doesn doing don down during each few for from further had hadn has hasn have haven
   having he her here hers herself him himself his how i if in into is isn it its
   itself let me more most mustn my myself no nor not of off on once only or other
   ought our ours ourselves out over own same shan she should shouldn so some such
   than that the their theirs them themselves then there these they this those
   through to too under until up very was wasn we were weren what when where which
   while who whom why with won would wouldn you your yours yourself yourselves
   use used uses using via without will may might must shall`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * ASCII-only lowercasing, on purpose.
 *
 * `toLowerCase()` is locale-sensitive in several of the ten languages this has
 * to agree across — Turkish maps `I` to a dotless `ı` — and a hash that depends
 * on the server's locale is a hash that changes when nothing changed. Only
 * A-Z is folded; every other character is left exactly as it arrived.
 */
function ascii_lower(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : ch;
  }
  return out;
}

/**
 * Split on ASCII whitespace and ASCII punctuation, and nothing else.
 *
 * Unicode character classes are spelled differently, and are subtly different,
 * in every one of the ten languages. Restricting the separator set to ASCII is
 * the only definition that is unambiguously the same everywhere.
 *
 * The consequence is that a run of CJK text becomes one token rather than
 * several. That is a worse tokenisation than a language-aware one and a better
 * hash than one that depends on which SDK observed it: the token is stable, so
 * two servers reporting the same description still agree.
 */
function tokens(text: string): string[] {
  return text.split(/[\s!-/:-@[-`{-~]+/u).filter(Boolean);
}

/**
 * A description reduced to its content, in a fixed order.
 *
 * Lowercase, drop stopwords, stem, sort, join with one space. Sorting is what
 * makes this an identity rather than a fingerprint of word order — the two
 * mailbox descriptions above differ only in order and a filler word.
 *
 * Exported for the conformance fixture: the intermediate string is what the ten
 * SDKs are held to, because a mismatched hash says only that something differs
 * and the string says what.
 */
export function normalise_description(description: string): string {
  const out: string[] = [];

  for (const raw of tokens(ascii_lower(description))) {
    // A single character is never content. The case that makes this worth a
    // rule is the apostrophe: `user's` splits on ASCII punctuation into `user`
    // and `s`, and that `s` would otherwise be the only thing separating "the
    // user's mailbox" from "a user mailbox".
    //
    // Counted in code POINTS, not UTF-16 units. `"🚀".length` is 2 in
    // JavaScript and 1 in Python, so `.length` here would keep an emoji that
    // nine other SDKs drop — which is a different hash for the same
    // description depending on which server observed it. The conformance
    // fixture caught exactly that.
    if ([...raw].length < 2 || STOP.has(raw)) continue;
    const word = stem(raw);
    // A stopword's inflection is still a stopword: `used` is filler by the list
    // and `using` only by its stem.
    if (STOP.has(word)) continue;
    out.push(word);
  }

  return out.sort().join(" ");
}

/** The three hashes for one tool, plus what its schema costs. */
export interface ToolFingerprint {
  /** `inputSchema` in RFC 8785 canonical form. Answers "did the interface change". */
  schema_hash: string;
  /** The description exactly as written. Answers "did the wording change". */
  description_hash: string;
  /** The description normalised. Answers "is this the same description". */
  description_norm: string;
}

/** Every hash is the same 12 hex characters of SHA-256 the arg hash uses. */
export function fingerprint(tool: {
  description?: unknown;
  inputSchema?: unknown;
}): ToolFingerprint {
  const description = typeof tool.description === "string" ? tool.description : "";

  let schema_hash: string;
  try {
    schema_hash = sha256_12(canonicalize(tool.inputSchema ?? {}));
  } catch {
    // A schema that will not serialise still ships to the model somehow, but it
    // cannot be compared with the one before it. A constant says exactly that,
    // rather than a hash of nothing that would read as "unchanged".
    schema_hash = UNFINGERPRINTABLE;
  }

  return {
    schema_hash,
    description_hash: sha256_12(description),
    description_norm: sha256_12(normalise_description(description)),
  };
}

/** What a schema hashes to when it cannot be canonicalised at all. */
export const UNFINGERPRINTABLE = "000000000000";
