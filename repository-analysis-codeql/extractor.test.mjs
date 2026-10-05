import assert from "node:assert/strict";
import test from "node:test";
import { extractorExtensions, matchesExtractor } from "./extractor.mjs";

const declared = [".js", ".jsx", ".es", ".es6", ".mjs", ".ts", ".tsx", ".html",
  ".htm", ".xhtm", ".xhtml", ".vue", ".json", ".yml", ".yaml", ".raml"];
const metadata = "name: javascript\nfile_types:\n  - name: language\n    extensions:\n" +
  declared.map((extension) => "      - " + extension).join("\n") +
  "\noptions:\n  another_list:\n    extensions:\n      - .not-source\n";

test("candidate matching follows the complete pinned extractor declaration, including Vue-only input", () => {
  const extensions = extractorExtensions(metadata);
  assert.deepEqual(extensions, [...declared].sort());
  for (const extension of declared) assert(matchesExtractor("src/source" + extension, extensions));
  assert(matchesExtractor("src/App.VUE", extensions));
  assert.equal(["src/App.vue", "README.md"].filter((filename) => matchesExtractor(filename, extensions)).length, 1);
  assert(!matchesExtractor("src/source.not-source", extensions));
  assert(!matchesExtractor("src/file.json.backup", extensions));
});

test("missing, duplicated, malformed and oversized extractor declarations fail explicitly", () => {
  for (const input of ["name: javascript\n", metadata + "\nfile_types:\n",
    metadata.replace("      - .js\n", "      - invalid\n"), "x".repeat(128 * 1024 + 1)]) {
    assert.throws(() => extractorExtensions(input), /Pinned extractor|pinned extractor/);
  }
});
