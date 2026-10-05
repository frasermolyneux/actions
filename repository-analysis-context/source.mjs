export function validateUntrackedFiles(files, excludedDirectories) {
  if (!Array.isArray(files) || !Array.isArray(excludedDirectories) ||
      files.some((filename) => typeof filename !== "string" ||
        !filename.split("/").some((part) => excludedDirectories.includes(part)))) {
    throw new Error("Untracked analyzable or unknown files outside known excluded/generated outputs cannot be analyzed");
  }
}

export function validateUntrackedWorktree(git, excludedDirectories) {
  const files = [
    ["ls-files", "--others", "--exclude-standard", "-z"],
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
  ].flatMap((args) => git(args).split("\0").filter(Boolean));
  validateUntrackedFiles(files, excludedDirectories);
}
