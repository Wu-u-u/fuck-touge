#!/usr/bin/env python3
"""多槽并行 launcher：每个槽独立 Edge、独立 state、独立调试端口。

默认只允许唯一账号/唯一 profile 的槽位并行；同一 login 默认拒绝。
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENTRY = HERE / "答题.py"
STATE_DIR = HERE / "state"
LOCK_DIR = STATE_DIR / "locks"
RUNS_DIR = STATE_DIR / "runs"


def _load_main_state() -> dict:
    source = Path(os.environ.get("EDUAUTO_STATE_FILE") or (HERE / "state.json")).expanduser()
    try:
        return json.loads(source.read_text(encoding="utf-8")) if source.exists() else {}
    except (OSError, json.JSONDecodeError):
        print(f"无法读取主 state：{source}", file=sys.stderr)
        raise SystemExit(4)


def _atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def worker_state(slot: int, run_id: str, state: dict) -> Path:
    data = {k: state[k] for k in ("slots", "names", "logins", "course_orders")
            if isinstance(state.get(k), dict)}
    data["current"] = str(slot)
    data["run_id"] = run_id
    target = RUNS_DIR / run_id / f"worker-{slot}.json"
    _atomic_write(target, data)
    return target


def _acquire_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path, "a+")
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return f
    except OSError:
        f.close()
        return None


def _release_locks(locks: list) -> None:
    for f in locks:
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
            f.close()
        except OSError:
            pass


def _clean_state_timeout(value: float) -> float:
    if not (0 < value <= 600):
        print("--login-timeout 必须在 (0, 600] 秒", file=sys.stderr)
        raise SystemExit(2)
    return value


def main() -> None:
    ap = argparse.ArgumentParser(description="多槽并行答题")
    ap.add_argument("--slots", nargs="+", type=int, required=True)
    ap.add_argument("--course", required=True)
    ap.add_argument("--jobs", type=int, default=2)
    ap.add_argument("-y", "--yes", action="store_true")
    ap.add_argument("--ai", action="store_true")
    ap.add_argument("--login-timeout", type=float, default=90)
    ap.add_argument("--allow-shared-login", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    _clean_state_timeout(args.login_timeout)
    slots = list(dict.fromkeys(args.slots))
    if not 1 <= args.jobs <= 3:
        print("--jobs 只支持 1-3（平台冷却/风控，不建议更多）", file=sys.stderr)
        raise SystemExit(2)
    for s in slots:
        if not 1 <= s <= 99:
            print(f"槽位只支持 1-99：{s}", file=sys.stderr)
            raise SystemExit(2)
    state = _load_main_state()
    logins = state.get("logins") if isinstance(state.get("logins"), dict) else {}
    if not args.allow_shared_login:
        seen = {}
        for s in slots:
            login = str(logins.get(str(s)) or "")
            if login and login in seen:
                print(f"槽位 {seen[login]} 和 {s} 共用同一 login，默认拒绝并行；"
                      "如确认允许请加 --allow-shared-login", file=sys.stderr)
                raise SystemExit(4)
            if login:
                seen[login] = s
    if args.dry_run:
        for i, slot in enumerate(slots):
            print(f"[槽 {slot}] port={9301+i} state=state/runs/<run>/worker-{slot}.json "
                  f"python3 答题.py worker {slot} --course {args.course}"
                  + (" -y" if args.yes else "") + (" --ai" if args.ai else ""))
        return

    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    failures = 0
    summary = []
    for start in range(0, len(slots), args.jobs):
        batch = slots[start:start + args.jobs]
        locks = []
        try:
            # 槽位 + profile 双重租约，避免两个 launcher 抢同一账号/档案。
            for slot in batch:
                f = _acquire_lock(LOCK_DIR / f"slot-{slot}.lock")
                if f is None:
                    print(f"槽位 {slot} 正在被其他 worker 使用", file=sys.stderr)
                    raise SystemExit(4)
                locks.append(f)
                profile = str((state.get("slots") or {}).get(str(slot)) or "")
                if profile:
                    key = uuid.uuid5(uuid.NAMESPACE_URL, profile).hex[:12]
                    f = _acquire_lock(LOCK_DIR / f"profile-{key}.lock")
                    if f is None:
                        print(f"profile 正在被其他 worker 使用：{profile}", file=sys.stderr)
                        raise SystemExit(4)
                    locks.append(f)
            procs = []
            for i, slot in enumerate(batch):
                port = 9301 + i
                env = os.environ.copy()
                env["EDUAUTO_STATE_FILE"] = str(worker_state(slot, run_id, state))
                env["EDUAUTO_PORT"] = str(port)
                env["EDUAUTO_BACKEND"] = "cdp"
                cmd = [sys.executable, str(ENTRY), "worker", str(slot),
                       "--course", args.course]
                if args.yes:
                    cmd.append("-y")
                if args.ai:
                    cmd.append("--ai")
                cmd += ["--login-timeout", str(args.login_timeout)]
                print(f"[槽 {slot}] start port={port}", flush=True)
                procs.append((slot, port, time.time(), subprocess.Popen(
                    cmd, cwd=str(HERE), env=env,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, bufsize=1, start_new_session=True)))

            def _read(slot: int, p: subprocess.Popen) -> None:
                assert p.stdout is not None
                for line in p.stdout:
                    print(f"[槽 {slot}] {line.rstrip()}", flush=True)

            readers = [threading.Thread(target=_read, args=(slot, p), daemon=True)
                       for slot, _, _, p in procs]
            for r in readers:
                r.start()
            for slot, port, started, p in procs:
                rc = p.wait()
                if rc:
                    failures += 1
                item = {"slot": slot, "port": port, "exit": rc,
                        "started": round(started, 3),
                        "finished": round(time.time(), 3),
                        "profile": str((state.get("slots") or {}).get(str(slot)) or ""),
                        "login": str(logins.get(str(slot)) or "")}
                summary.append(item)
                _atomic_write(RUNS_DIR / run_id / f"result-{slot}.json", item)
                print(f"[槽 {slot}] 退出码 {rc}", flush=True)
            for r in readers:
                r.join(timeout=5)
        finally:
            _release_locks(locks)

    print(f"\nrun_id={run_id}", flush=True)
    for x in summary:
        print(f"[槽 {x['slot']}] exit={x['exit']} port={x['port']}", flush=True)
    raise SystemExit(2 if failures else 0)


if __name__ == "__main__":
    main()
