#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List


TASK_LINE_RE = re.compile(r"^(?P<prefix>\s*-\s*\[(?P<state>[ xX])\]\s*)(?P<body>.+?)\s*$")
TASK_ID_RE = re.compile(r"^(?P<id>[A-Za-z0-9_-]+)\s+(?P<title>.+)$")


@dataclass
class Task:
    line_index: int
    checked: bool
    raw_body: str
    task_id: str
    title: str
    prefix: str


def parse_tasks(lines: List[str]) -> List[Task]:
    tasks: List[Task] = []
    for i, line in enumerate(lines):
        match = TASK_LINE_RE.match(line)
        if not match:
            continue
        body = match.group("body").strip()
        id_match = TASK_ID_RE.match(body)
        if id_match:
            task_id = id_match.group("id")
            title = id_match.group("title")
        else:
            task_id = f"LINE{i + 1}"
            title = body
        tasks.append(
            Task(
                line_index=i,
                checked=match.group("state").lower() == "x",
                raw_body=body,
                task_id=task_id,
                title=title,
                prefix=match.group("prefix"),
            )
        )
    return tasks


def load_lines(path: Path) -> List[str]:
    if not path.exists():
        raise FileNotFoundError(f"Task file not found: {path}")
    return path.read_text(encoding="utf-8").splitlines(keepends=True)


def save_lines(path: Path, lines: List[str]) -> None:
    path.write_text("".join(lines), encoding="utf-8")


def mark_task(lines: List[str], task: Task, checked: bool) -> None:
    line = lines[task.line_index]
    lines[task.line_index] = re.sub(r"\[(?: |x|X)\]", "[x]" if checked else "[ ]", line, count=1)


def find_task(tasks: List[Task], selector: str) -> Task | None:
    selector_norm = selector.strip().lower()
    for t in tasks:
        if t.task_id.lower() == selector_norm:
            return t
    for t in tasks:
        if selector_norm in t.title.lower():
            return t
    return None


def cmd_list(path: Path) -> int:
    lines = load_lines(path)
    tasks = parse_tasks(lines)
    if not tasks:
        print("No tasks found")
        return 1
    for t in tasks:
        status = "x" if t.checked else " "
        print(f"[{status}] {t.task_id} {t.title}")
    return 0


def cmd_next(path: Path) -> int:
    lines = load_lines(path)
    tasks = parse_tasks(lines)
    next_task = next((t for t in tasks if not t.checked), None)
    if not next_task:
        print("ALL_DONE")
        return 0
    print(f"{next_task.task_id}|{next_task.title}")
    return 0


def cmd_done(path: Path, selector: str) -> int:
    lines = load_lines(path)
    tasks = parse_tasks(lines)
    task = find_task(tasks, selector)
    if not task:
        print(f"Task not found: {selector}", file=sys.stderr)
        return 1
    mark_task(lines, task, True)
    save_lines(path, lines)
    print(f"DONE {task.task_id}")
    return 0


def cmd_undo(path: Path, selector: str) -> int:
    lines = load_lines(path)
    tasks = parse_tasks(lines)
    task = find_task(tasks, selector)
    if not task:
        print(f"Task not found: {selector}", file=sys.stderr)
        return 1
    mark_task(lines, task, False)
    save_lines(path, lines)
    print(f"TODO {task.task_id}")
    return 0


def cmd_run(path: Path, command_template: str) -> int:
    lines = load_lines(path)
    tasks = parse_tasks(lines)
    while True:
        next_task = next((t for t in tasks if not t.checked), None)
        if not next_task:
            print("ALL_DONE")
            return 0

        print(f"RUN {next_task.task_id}: {next_task.title}")
        command = command_template.format(
            task_id=next_task.task_id,
            task_title=next_task.title,
            task_body=next_task.raw_body,
        )
        result = subprocess.run(command, shell=True)
        if result.returncode != 0:
            print(f"STOP {next_task.task_id}: command failed with exit code {result.returncode}", file=sys.stderr)
            return result.returncode

        lines = load_lines(path)
        tasks = parse_tasks(lines)
        current = find_task(tasks, next_task.task_id)
        if not current:
            print(f"STOP {next_task.task_id}: task disappeared from file", file=sys.stderr)
            return 1
        mark_task(lines, current, True)
        save_lines(path, lines)
        tasks = parse_tasks(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Task queue helper for docs/TASKS.md",
    )
    parser.add_argument(
        "--file",
        default="docs/TASKS.md",
        help="Path to tasks markdown file (default: docs/TASKS.md)",
    )

    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="List all tasks")
    sub.add_parser("next", help="Print next open task or ALL_DONE")

    done = sub.add_parser("done", help="Mark task done by ID or title fragment")
    done.add_argument("selector")

    undo = sub.add_parser("undo", help="Mark task open by ID or title fragment")
    undo.add_argument("selector")

    run = sub.add_parser("run", help="Auto-run command for each task and stop when all are done")
    run.add_argument(
        "--cmd",
        required=True,
        help='Command template, e.g. \'echo "{task_id} {task_title}"\'',
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    path = Path(args.file)

    if args.command == "list":
        return cmd_list(path)
    if args.command == "next":
        return cmd_next(path)
    if args.command == "done":
        return cmd_done(path, args.selector)
    if args.command == "undo":
        return cmd_undo(path, args.selector)
    if args.command == "run":
        return cmd_run(path, args.cmd)
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
