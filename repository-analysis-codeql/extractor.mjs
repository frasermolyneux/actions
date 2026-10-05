export function extractorExtensions(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 128 * 1024 ||
      text.split(/\r?\n/).filter((line) => line === "file_types:").length !== 1) {
    throw new Error("Pinned extractor needs one bounded file_types declaration");
  }
  const extensions = new Set();
  let section = false;
  let active = false;
  for (const line of text.split(/\r?\n/)) {
    if (line === "file_types:") {
      section = true;
      continue;
    }
    if (section && /^\S/.test(line)) break;
    if (!section) continue;
    if (line === "    extensions:") {
      active = true;
      continue;
    }
    if (active && /^      - \.[A-Za-z0-9]+$/.test(line)) {
      extensions.add(line.slice(8));
    } else if (line.trim()) {
      if (active && /^      - /.test(line)) throw new Error("Malformed pinned extractor extension");
      active = false;
    }
  }
  if (!extensions.size || extensions.size > 128) {
    throw new Error("Pinned extractor has no bounded supported source extensions");
  }
  return [...extensions].sort();
}

export function matchesExtractor(filename, extensions) {
  return extensions.some((extension) => filename.toLowerCase().endsWith(extension.toLowerCase()));
}
