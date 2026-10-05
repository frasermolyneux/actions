"""Validate commit-bound self references with the released actionlint parser."""

import argparse
from pathlib import Path
import re
import subprocess
import tempfile

import yaml
from yaml.nodes import MappingNode, ScalarNode, SequenceNode


def entries(node, key):
    if isinstance(node, MappingNode):
        return [(name, value) for name, value in node.value
                if isinstance(name, ScalarNode) and name.value == key]
    return []


def reference_nodes(document, workflow):
    if workflow:
        for _, jobs in entries(document, "jobs"):
            if not isinstance(jobs, MappingNode):
                continue
            for _, job in jobs.value:
                yield from ((key, value, True) for key, value in entries(job, "uses"))
                yield from step_references(job)
    else:
        for _, runs in entries(document, "runs"):
            yield from step_references(runs)


def step_references(node):
    for _, steps in entries(node, "steps"):
        if isinstance(steps, SequenceNode):
            for step in steps.value:
                yield from ((key, value, False) for key, value in entries(step, "uses"))


def lint_copy(text, workflow, files=None):
    documents = list(yaml.compose_all(text, Loader=yaml.SafeLoader))
    if len(documents) != 1:
        raise ValueError("Expected exactly one YAML document")
    replacements = {}
    for key, value, reusable in reference_nodes(documents[0], workflow):
        if not isinstance(value, ScalarNode) or not value.value.startswith("$"):
            continue
        reference = value.value
        if not re.fullmatch(r"\$/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", reference):
            raise ValueError(f"Malformed self-repository reference: {reference!r}")
        if any(part in (".", "..") for part in reference[2:].split("/")):
            raise ValueError(f"Self-repository path traversal: {reference!r}")
        if reusable and not re.fullmatch(r"\$/\.github/workflows/[^/]+\.(?:yml|yaml)", reference):
            raise ValueError(f"Self-repository job must reference a reusable workflow: {reference!r}")
        if files is not None:
            target = reference[2:]
            candidates = {target} if reusable else {f"{target}/action.yml", f"{target}/action.yaml"}
            if not candidates.intersection(files):
                raise ValueError(f"Self-repository target metadata is missing: {reference!r}")
        start, end = value.start_mark.index, value.end_mark.index
        original = text[start:end]
        if start < key.end_mark.index or original not in (
                reference, f'"{reference}"', f"'{reference}'"):
            raise ValueError("Self-repository references must be literal, untagged, unanchored uses values")
        replacements[start] = (end, original.replace(reference, "." + reference[1:], 1))
    for start, (end, replacement) in sorted(replacements.items(), reverse=True):
        text = text[:start] + replacement + text[end:]
    return text


def prepare_copy(source, destination):
    result = subprocess.run(
        ["git", "-C", str(source), "ls-files", "-z", "--cached", "--others",
         "--exclude-standard"],
        check=True, capture_output=True,
    )
    files = sorted(set(result.stdout.decode("utf-8").split("\0")) - {""})
    workflows = 0
    (destination / ".git").mkdir()
    for name in files:
        relative = Path(name)
        workflow = relative.parent == Path(".github/workflows") and relative.suffix in (".yml", ".yaml")
        metadata = relative.name in ("action.yml", "action.yaml")
        config = relative in (Path(".github/actionlint.yml"), Path(".github/actionlint.yaml"))
        if not (workflow or metadata or config):
            continue
        original = source / relative
        if original.is_symlink() or not original.resolve().is_relative_to(source.resolve()):
            raise ValueError(f"Lint input must be an originating-repository file: {name}")
        text = original.read_text(encoding="utf-8")
        if not config:
            text = lint_copy(text, workflow, set(files))
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="")
        workflows += int(workflow)
    if not workflows:
        raise ValueError("No repository workflows to validate")


def run(actionlint, source):
    executable = Path(actionlint).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="actionlint-self-") as directory:
        destination = Path(directory)
        prepare_copy(Path(source).resolve(strict=True), destination)
        return subprocess.run([str(executable), "-color"], cwd=destination).returncode


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--actionlint", required=True)
    parser.add_argument("--source", default=str(Path(__file__).resolve().parents[1]))
    args = parser.parse_args()
    raise SystemExit(run(args.actionlint, args.source))
