/**
 * Regenerates `description_norm.json`, the cross-language conformance suite for
 * the normalised description hash.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { normalise_description } from "../../src/describe.js";

const cases: Array<[string, string]> = [
  ["empty", ""],
  ["one word", "Search"],
  ["the pair that motivated the normalised hash #1", "Search for threads in the user's mailbox"],
  ["the pair that motivated the normalised hash #2", "Search threads in a user's mailbox"],
  ["word order does not matter", "mailbox threads search"],
  ["stopwords are dropped", "the a an and of to for on with by from"],
  ["a stopword inflection is dropped by its stem", "using used uses use"],
  ["domain verbs survive", "List the orders"],
  ["get is not a stopword", "Get the order"],
  ["plurals merge", "screens screening screened screen"],
  ["three-letter acronyms survive", "ATS ids api"],
  ["punctuation splits", "read-only; write_once. get/set (maybe)"],
  ["ascii casing only", "SEARCH Search sEaRcH"],
  ["digits are kept", "Page 2 of 10"],
  ["non-ascii stays as one token", "Rechercher les fils"],
  ["cjk is one token per run", "検索 スレッド"],
  ["emoji are not separators", "search \u{1F680} threads"],
  ["tabs and newlines split", "search\tthreads\nin\r\nmailbox"],
  ["repeated words collapse to repeats, not a set", "order order order"],
  ["a long real description", "Score a resume against a job description for ATS compatibility. Returns keyword match score, missing keywords, section scores, and improvement recommendations."],
];

const out = {
  $comment:
    "Conformance fixtures for MCPulse description_norm. Every MCPulse SDK, in every language, must turn `description` into exactly `normalised` and then into `description_norm` (first 12 lowercase hex of the SHA-256 of the normalised string, UTF-8). Do not edit by hand — see tests/fixtures/generate-description-norm.ts.",
  wire_version: 1,
  algorithm: "ascii-lower/ascii-split/stopwords/porter/sort/join-space, then sha256 hex12",
  fixtures: cases.map(([name, description]) => {
    const normalised = normalise_description(description);
    return {
      name,
      description,
      normalised,
      description_norm: createHash("sha256").update(normalised, "utf8").digest("hex").slice(0, 12),
    };
  }),
};

writeFileSync(process.argv[2]!, `${JSON.stringify(out, null, 2)}\n`);
console.log(`${out.fixtures.length} cases -> ${process.argv[2]}`);
for (const f of out.fixtures.slice(2, 5)) console.log(`  ${f.name}\n    -> "${f.normalised}"`);
