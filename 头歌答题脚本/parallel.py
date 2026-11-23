#!/usr/bin/env python3
"""多槽并行 launcher：每个槽独立 Edge、独立 state、独立调试端口。

用法：
    python3 parallel.py --slots 1 2 3 --course Java程序设计-2026秋 --jobs 2
    python3 parallel.py --slots 1 2 --course 4 --jobs 2 --ai
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENTRY = HERE / "答题.py"
STATE_DIR = HERE / "state"


def worker_state(slot: int) -> Path:
    source = Path(os.environ.get("EDUAUTO_STATE_FILE") or (HERE / "state.json")).expanduser()
    state = json.loads(source.read_text(encoding="utf-8")) if source.exists() else {}
    data = {k: state[k] for k in ("slots", "names", "logins", "course_orders")
            if isinstance(state.get(k), dict)}
    data["current"] = str(slot)
    STATE_DIR.mkdir(exist_ok=True)
    target = STATE_DIR / f"worker-{slot}.json"
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def run_slot(slot: int, port: int, course: str, yes: bool, ai: bool, dry: bool) -> int:
    env = os.environ.copy()
    env["EDUAUTO_STATE_FILE"] = str(worker_state(slot))
    env["EDUAUTO_PORT"] = str(port)
    cmd = [sys.executable, str(ENTRY), "worker", str(slot), "--course", course]
    if yes:
        cmd.append("-y")
    if ai:
        cmd.append("--ai")
    cmd += ["--login-timeout", "90"]
    print(f"[槽 {slot}] {' '.join(cmd)}", flush=True)
    if dry:
        return 0
    proc = subprocess.Popen(cmd, cwd=str(HERE), env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    assert proc.stdout is not None
    for line in proc.stdout:
        print(f"[槽 {slot}] {line.rstrip()}", flush=True)
    return proc.wait()


def main() -> None:
    ap = argparse.ArgumentParser(description="多槽并行答题")
    ap.add_argument("--slots", nargs="+", type=int, required=True)
    ap.add_argument("--course", required=True)
    ap.add_argument("--jobs", type=int, default=2)
    ap.add_argument("-y", "--yes", action="store_true")
    ap.add_argument("--ai", action="store_true")
    ap.add_argument("--login-timeout", type=float, default=90)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    slots = list(dict.fromkeys(args.slots))
    if not 1 <= args.jobs <= 6:
        print("--jobs 只支持 1-6", file=sys.stderr)
        raise SystemExit(2)
    for s in slots:
        if not 1 <= s <= 99:
            print(f"槽位只支持 1-99：{s}", file=sys.stderr)
            raise SystemExit(2)
    if args.dry_run:
        for i, slot in enumerate(slots):
            print(f"[槽 {slot}] python3 答题.py worker {slot} --course {args.course}"
                  + (" -y" if args.yes else "") + (" --ai" if args.ai else ""))
        return
    # 简单批次：不引入复杂队列；每批最多 jobs 个独立 Edge。
    failed = 0
    for start in range(0, len(slots), args.jobs):
        batch = slots[start:start + args.jobs]
        procs = []
        for i, slot in enumerate(batch):
            port = 9301 + (start + i)
            procs.append((slot, subprocess.Popen(
                [sys.executable, str(ENTRY), "worker", str(slot),
                 "--course", args.course] + (["-y"] if args.yes else []) + (["--ai"] if args.ai else [])
                + (["--login-timeout", str(args.login_timeout)] if args.login_timeout else []),
                cwd=str(HERE), env=_child_env(slot, port),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
            )))
        def _read(slot: int, p: subprocess.Popen) -> None:
            assert p.stdout is not None
            for line in p.stdout:
                print(f"[槽 {slot}] {line.rstrip()}", flush=True)

        readers = [threading.Thread(target=_read, args=(slot, p), daemon=True)
                   for slot, p in procs]
        for r in readers:
            r.start()
        for slot, p in procs:
            rc = p.wait()
            if rc:
                failed += 1
                print(f"[槽 {slot}] 退出码 {rc}", flush=True)
        for r in readers:
            r.join(timeout=5)
    raise SystemExit(2 if failed else 0)


def _child_env(slot: int, port: int) -> dict:
    env = os.environ.copy()
    env["EDUAUTO_STATE_FILE"] = str(worker_state(slot))
    env["EDUAUTO_PORT"] = str(port)
    return env


if __name__ == "__main__":
    main()
