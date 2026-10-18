"""头歌自动答题脚本（半自动 · Python + CDP）。

配套文档：脚本详细.md
用法：
    python3 答题.py browser                    # 启动/检查专用副本浏览器（可加槽位：browser 1）
    python3 答题.py browser -ls                # 列出各档案槽登录的账号名（浏览器在跑时实时刷新）
    python3 答题.py run -y [章节...]           # 按答案档案自动答题（开跑前会列出每关答案状态）
    python3 答题.py harvest [章节...]          # 扫描并采集：自动补骨架，采集已满分关卡答案（-f 覆盖）

章节参数是位置参数，可写多个、可以是名称片段（省略=全部章节），例如：
    python3 答题.py run -y 五 七        python3 答题.py harvest 八 -f

设计原则：
    · 复用 Fuck头歌 扩展：脚本自动把它装进副本浏览器；通过扩展的
      "已为您自动跳转至下一关 / 已经是最后一关了" 提示判断结果；扩展不在时
      由脚本自己点弹层按钮兜底。
    · 不直接改答案内容的保存动作：用 Monaco 官方 API 写编辑器（等效粘贴），
      点「评测」由页面完成保存。
    · 任何失败（未通过/超时/找不到答案）都停下来提示，不盲目继续。
"""

from __future__ import annotations

from pathlib import Path
import argparse
import sys

from eduauto.util import die, log
from eduauto.browser import classroom_page, connect_browser, ensure_browser, ensure_login, port_alive, read_account_name
from eduauto.config import SLOT_RE, apply_current_profile, load_config, load_state, remember_name, setup_slot
from eduauto.flows import cmd_harvest, cmd_run, cmd_scan_retired

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def cmd_browser_list(cfg: dict) -> None:
    """browser -ls：列出各档案槽的路径、登录账号名与当前/运行状态。"""
    state = load_state()
    slots: dict = state.get("slots", {})
    names: dict = state.get("names", {})
    current = state.get("current")
    running = state.get("running")
    port = cfg["edge"]["port"]
    alive = port_alive(port)
    live = ""
    if alive:
        try:
            browser = connect_browser(port, attempts=1)
            live = read_account_name(browser) or ""
            if live and current:
                remember_name(current, live)
                names = load_state().get("names", {})
        except Exception:
            live = ""
    log("档案槽列表（账号名在登录时自动记录；浏览器在跑时会实时刷新）：")
    if not slots:
        log("  （还没有任何槽位记录）")

    def sort_key(k: str):
        return (0, int(k)) if k.isdigit() else (1, k)

    for k in sorted(slots, key=sort_key):
        nm = names.get(k) or "未知"
        mark = []
        if k == current:
            mark.append("当前")
        if k == running and alive:
            mark.append("运行中")
        tail = f"　[{'、'.join(mark)}]" if mark else ""
        log(f"  {str(k):>3}. {nm}  — {slots[k]}{tail}")
    if live:
        log(f"  运行中的浏览器账号：{live}")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="头歌自动答题脚本（半自动）",
        epilog="示例：python3 答题.py run -y 五 七 ｜ harvest 五 -f ｜ harvest（扫描并采集全部）",
    )
    ap.add_argument("-c", "--config", default=str(HERE / "config.toml"), help="配置文件路径")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_chapter_args(p):
        """章节参数：位置参数为主（可多个、可用片段），--chapter 保留为旧写法。"""
        p.add_argument("chapters", nargs="*", metavar="章节名",
                       help="要处理的章节，可写多个、支持名称片段；省略=全部")
        p.add_argument("--chapter", action="append", default=[], dest="chapter_opt",
                       help="兼容旧写法，等价于位置参数（可多次）")

    p_browser = sub.add_parser("browser", help="启动/检查专用副本浏览器（可带档案槽参数）")
    p_browser.add_argument(
        "slot", nargs="?", default=None,
        help="1-99 记住并切换对应档案；new 每次全新；1new~99new 清除该槽记忆换全新",
    )
    p_browser.add_argument("-ls", "--list", action="store_true", dest="list_slots",
                           help="不启动浏览器，列出各档案槽和登录账号名")
    p_scan = sub.add_parser("scan", help="（已并入 harvest，仅保留兼容提示）")
    add_chapter_args(p_scan)
    p_scan.add_argument("-a", "--all", action="store_true", help=argparse.SUPPRESS)
    p_harvest = sub.add_parser("harvest", help="扫描并采集：缺骨架补骨架，有已满分关卡就采集答案")
    add_chapter_args(p_harvest)
    p_harvest.add_argument("-f", "--force", action="store_true", help="覆盖档案里已有答案")
    p_run = sub.add_parser("run", help="按答案档案自动答题（开跑前会列出每关答案状态）")
    add_chapter_args(p_run)
    p_run.add_argument("-y", "--yes", action="store_true", help="不询问直接开始")

    args = ap.parse_args()
    if hasattr(args, "chapters"):
        args.chapter = list(args.chapters) + list(args.chapter_opt)   # 位置参数 + 旧写法合并
    cfg_path = Path(args.config).expanduser()
    if not cfg_path.exists():
        die(f"配置文件不存在：{cfg_path}")
    cfg = load_config(cfg_path)
    apply_current_profile(cfg)      # 记住的档案槽优先于 config 里的 profile

    if args.cmd == "browser":
        if getattr(args, "list_slots", False):
            cmd_browser_list(cfg)
            return
        if args.slot and not SLOT_RE.fullmatch(args.slot):
            die("槽位参数只支持：1-99（记住对应档案）、new（每次全新）、1new～99new（清除该槽记忆换全新）")
        slot, profile, note = setup_slot(cfg, args.slot)
        if note:
            log(f"→ 档案槽『{slot}』：{note}")
        cfg["edge"]["profile"] = profile
        browser = ensure_browser(cfg)
        classroom = classroom_page(browser, cfg)
        ensure_login(browser, classroom.ws)
        log(f"✓ 副本浏览器就绪，已记住档案槽「{slot}」，之后 harvest/run 都会用它。")
    elif args.cmd == "scan":
        cmd_scan_retired()
    elif args.cmd == "harvest":
        cmd_harvest(args, cfg)
    elif args.cmd == "run":
        cmd_run(args, cfg)


if __name__ == "__main__":
    main()
