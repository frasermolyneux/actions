import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateUntrackedFiles, validateUntrackedWorktree } from "./source.mjs";

const codeqlOutputs = ["bin", "obj", "node_modules", "vendor", "build", "__pycache__"];

test("unknown source extensions cannot evade the shared tracked-source boundary", () => {
  for (const extension of ["vue", "svelte", "ipp", "inl", "ixx", "new-extension"]) {
    assert.throws(() => validateUntrackedFiles([`src/added.${extension}`], codeqlOutputs),
      /Untracked analyzable/);
  }
  validateUntrackedFiles(["src/obj/Generated.cs", "build/compiler-output",
    "__pycache__/source.cpython-312.pyc"], codeqlOutputs);
});

test("actual ordinary and ignored untracked source fail before CodeQL publication", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "analysis-source-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = process.platform === "win32" ? String.raw`C:\Program Files\Git\cmd\git.exe` : "/usr/bin/git";
  const git = (args) => execFileSync(command, ["-C", root, ...args], { encoding: "utf8" });
  await writeFile(path.join(root, ".gitignore"), "ignored/\nobj/\n");
  await writeFile(path.join(root, "source.js"), "export const value = 1;\n");
  git(["init", "--quiet"]);
  git(["add", "."]);
  git(["-c", "user.name=Contract", "-c", "user.email=contract@example.invalid",
    "commit", "--quiet", "-m", "fixture"]);
  validateUntrackedWorktree(git, codeqlOutputs);
  await mkdir(path.join(root, "obj"));
  await writeFile(path.join(root, "obj", "Generated.cs"), "generated source\n");
  validateUntrackedWorktree(git, codeqlOutputs);
  const ordinary = path.join(root, "ordinary.vue");
  await writeFile(ordinary, "uncommitted source\n");
  assert.throws(() => validateUntrackedWorktree(git, codeqlOutputs), /Untracked analyzable/);
  await rm(ordinary);
  await mkdir(path.join(root, "ignored"));
  await writeFile(path.join(root, "ignored", "added.ipp"), "ignored uncommitted source\n");
  assert.throws(() => validateUntrackedWorktree(git, codeqlOutputs), /Untracked analyzable/);
});
