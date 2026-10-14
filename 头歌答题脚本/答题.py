#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""头歌自动答题脚本（半自动 · Python + CDP）。

配套文档：脚本详细.md
用法：
    python3 答题.py browser                    # 启动/检查专用副本浏览器（可加槽位：browser 1）
    python3 答题.py scan -a                    # 扫描所有"开始学习"章节，生成答案档案骨架（-a = 全部）
    python3 答题.py scan "Java语言基础（八）- 数组基础"
    python3 答题.py run -y [章节...]           # 按答案档案自动答题（开跑前会列出每关答案状态）
    python3 答题.py harvest [章节...]          # 采集已满分关卡的答案，写回档案（-f 覆盖）

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

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import cdp  # noqa: E402

# ─────────────────────────── 常量 ───────────────────────────

LEVEL_RE = re.compile(r"第(\d+)关\s*[：:]\s*([^\n]{1,60})")
PASS_STATUS = {"已通过", "已提交"}
TOAST_NEXT = "已为您自动跳转至下一关"
TOAST_LAST = "已经是最后一关了"
FAIL_TEXT = "评测未通过"

STATE_FILE = HERE / "state.json"                      # 档案槽位记忆
PROFILE_BASE = Path("~/.config/educoder-auto").expanduser()   # 脚本自建档案的存放目录
SLOT_RE = re.compile(r"^(new|[1-9][0-9]?|[1-9][0-9]?new)$")   # 1-99 / new / 1new

DEFAULT_CONFIG = {
    "edge": {
        "binary": "/usr/bin/microsoft-edge-stable",
        "profile": "~/.config/microsoft-edge-debug",
        "port": 9222,
        "extension": str(HERE.parent / "Fuck头歌"),
        "classroom": "https://www.educoder.net/classrooms/JODEM6CH/shixun_homework",
    },
    "run": {
        "answers": str(HERE / "answers.toml"),
        "eval_timeout": 180,      # 单次评测最长等待（秒）
        "level_timeout": 60,      # 页面加载/跳转最长等待（秒）
    },
}


def log(msg: str) -> None:
    print(msg, flush=True)


def die(msg: str, code: int = 2) -> None:
    log(f"\n✗ {msg}")
    sys.exit(code)


def fmt_secs(s: float) -> str:
    """秒数格式化成易读短串（用于日志里的用时统计）。"""
    s = float(s)
    return f"{s:.0f} 秒" if s < 90 else f"{s / 60:.1f} 分钟"


def norm(s: str) -> str:
    """归一化：去掉所有空白（含全角空格）。"""
    return re.sub(r"[\s\u3000]+", "", s or "")


CN_NUM = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
          "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def cn_to_int(s: str) -> int | None:
    """中文数字转整数，支持 一~九十九（章节名里够用了）。"""
    s = s.strip()
    if not s:
        return None
    if "十" in s:
        left, _, right = s.partition("十")
        tens = CN_NUM.get(left, 1) if left else 1
        ones = CN_NUM.get(right, 0) if right else 0
        return tens * 10 + ones
    if s in CN_NUM:
        return CN_NUM[s]
    return None


def chapter_sort_key(name: str, idx: int = 0):
    """章节排序：按名字里的中文数字（一、二、…）；没有数字的排最后（保持原顺序）。"""
    m = re.search(r"[（(]\s*([零一二两三四五六七八九十]+)\s*[）)]", name or "")
    if m:
        n = cn_to_int(m.group(1))
        if n:
            return (0, n, idx)
    return (1, 0, idx)


def sort_chapter_blocks(text: str) -> str:
    """把答案档案里的章节块按章节顺序重排（只挪块，不改块内内容）。"""
    lines = text.splitlines(keepends=True)
    starts = [i for i, l in enumerate(lines) if l.strip() == "[[chapters]]"]
    if len(starts) < 2:
        return text
    header = "".join(lines[:starts[0]])
    blocks = []
    for bi, s in enumerate(starts):
        e = starts[bi + 1] if bi + 1 < len(starts) else len(lines)
        name = None
        for k in range(s, e):
            m = re.match(r"\s*name\s*=\s*(.*)", lines[k])
            if m:
                try:
                    name = json.loads(m.group(1))
                except Exception:
                    name = None
                break
        blocks.append((name or "", "".join(lines[s:e])))
    ordered = sorted(enumerate(blocks), key=lambda t: chapter_sort_key(t[1][0], t[0]))
    return header + "".join(block for _, (_, block) in ordered)


def load_config(path: Path) -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))     # 深拷贝默认值
    if path.exists():
        with open(path, "rb") as f:
            user = tomllib.load(f)
        for section, values in user.items():
            if isinstance(values, dict):
                cfg.setdefault(section, {}).update(values)
            else:
                cfg[section] = values
    return cfg


# ─────────────────────────── 浏览器档案槽位 ───────────────────────────

def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state: dict) -> None:
    try:
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as e:
        log(f"  ! 槽位状态写入失败：{e}")


def apply_current_profile(cfg: dict) -> str:
    """把「当前记住的档案槽」应用进配置，返回槽位名（没有则空串）。"""
    state = load_state()
    cur = state.get("current")
    slots = state.get("slots", {})
    if cur and slots.get(cur):
        cfg["edge"]["profile"] = slots[cur]
        return cur
    return ""


def setup_slot(cfg: dict, arg: str | None) -> tuple[str, str, str]:
    """解析 browser 的槽位参数并记住，返回 (槽位名, 档案路径, 备注)。

      browser 1       记住并切到 1 号档案（1 号默认就是 config 里的档案）
      browser 2~99    记住并切到对应档案；新槽会新建一个干净档案（需登录一次）
      browser new     每次都开一个全新档案（本次记住为 new，下次再全新）
      browser 1new    清除 1 号的记忆，换成全新档案（旧档案不删）
    """
    state = load_state()
    slots = state.setdefault("slots", {})

    if arg is None:
        cur = state.get("current")
        if cur and slots.get(cur):
            return cur, slots[cur], ""
        prof = os.path.expanduser(cfg["edge"]["profile"])
        slots["1"] = prof
        state["current"] = "1"
        save_state(state)
        return "1", prof, "（首次使用：当前 config 档案已记为槽 1）"

    if arg == "new":
        prof = str(PROFILE_BASE / f"guest-{time.strftime('%Y%m%d-%H%M%S')}")
        slots["new"] = prof
        state["current"] = "new"
        save_state(state)
        return "new", prof, "（全新档案；下次 browser new 又是一个全新的）"

    m = re.fullmatch(r"([1-9][0-9]?)new", arg)
    if m:
        n = m.group(1)
        old = slots.get(n)
        prof = str(PROFILE_BASE / f"slot{n}-{time.strftime('%Y%m%d-%H%M%S')}")
        slots[n] = prof
        state["current"] = n
        save_state(state)
        note = f"（已清除槽 {n} 的记忆，改用全新档案"
        if old:
            note += f"；旧档案未删除，在 {old}"
        note += "）"
        return n, prof, note

    n = arg
    if n in slots:
        state["current"] = n
        save_state(state)
        return n, slots[n], ""
    if n == "1":
        prof = os.path.expanduser(cfg["edge"]["profile"])
        note = "（当前 config 档案已记为槽 1）"
    else:
        prof = str(PROFILE_BASE / f"slot{n}")
        note = "（新槽位：干净档案，需要登录一次）"
    os.makedirs(prof, exist_ok=True)
    slots[n] = prof
    state["current"] = n
    save_state(state)
    return n, prof, note


# ─────────────────────────── 浏览器管理 ───────────────────────────

def port_alive(port: int) -> bool:
    try:
        cdp.http_json("/json/version", port, timeout=2)
        return True
    except Exception:
        return False


def stop_browser(port: int, timeout: float = 25) -> bool:
    """请当前浏览器退出并等待端口释放。"""
    try:
        browser = cdp.Browser(port)
        browser.close_browser()
    except Exception:
        pass
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.5)
        if not port_alive(port):
            return True
    return False


def launch_edge(cfg: dict) -> None:
    binary = os.path.expanduser(cfg["edge"]["binary"])
    profile = os.path.expanduser(cfg["edge"]["profile"])
    port = int(cfg["edge"]["port"])
    if not os.path.exists(binary):
        die(f"找不到浏览器：{binary}（请在 config.toml 里修改 edge.binary）")
    os.makedirs(profile, exist_ok=True)
    log(f"→ 启动副本浏览器（档案：{profile}）…")
    subprocess.Popen(
        [
            binary,
            f"--user-data-dir={profile}",
            f"--remote-debugging-port={port}",
            "--disable-popup-blocking",     # 点「开始学习」依赖新开标签页，别让弹窗拦截坏事
            "--window-size=1600,1000",      # 头歌是宽布局，保证按钮都在视口内
            "--no-first-run",
            "--no-default-browser-check",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(60):
        time.sleep(0.5)
        if port_alive(port):
            return
    die(
        "浏览器启动后没有开放调试端口。可能该档案已被另一个 Edge 窗口占用：\n"
        "  请先完全退出占用该档案的 Edge，再重试；或换一个档案槽（browser 2 等）。"
    )


def connect_browser(port: int, attempts: int = 20) -> cdp.Browser:
    for _ in range(attempts):
        try:
            return cdp.Browser(port)
        except Exception:
            time.sleep(0.5)
    die(f"连不上浏览器调试端口 {port}，请重试或先运行 python3 答题.py browser。")


def ensure_window_size(browser: cdp.Browser, min_w: int = 1400, min_h: int = 900) -> None:
    """窗口太小时最大化：头歌是宽布局，窗口窄会把按钮挤出视口导致点不到。"""
    pages = browser.pages()
    if not pages:
        return
    try:
        info = browser.ws.call("Browser.getWindowForTarget", {"targetId": pages[0]["id"]})
        bounds = info.get("bounds", {})
        if bounds.get("width", 0) < min_w or bounds.get("height", 0) < min_h:
            browser.ws.call("Browser.setWindowBounds", {
                "windowId": info["windowId"],
                "bounds": {"windowState": "maximized"},
            })
            time.sleep(1)
            log("  ✓ 已把副本浏览器窗口最大化（保证页面按钮都在视口内）")
    except Exception:
        pass


def ensure_browser(cfg: dict) -> cdp.Browser:
    port = int(cfg["edge"]["port"])
    state = load_state()
    cur = state.get("current") or "1"
    need_launch = False
    if port_alive(port):
        running = state.get("running")
        if running and running != cur:
            log(f"→ 当前浏览器是「{running}」号档案，要切换到「{cur}」号，先关掉它…")
            if not stop_browser(port):
                die("旧的副本浏览器关不掉，请手动关闭那个 Edge 窗口后重试。")
            time.sleep(1)
            need_launch = True
        else:
            log(f"  ✓ 复用已打开的副本浏览器（档案槽「{cur}」）")
    else:
        need_launch = True
    if need_launch:
        launch_edge(cfg)
    state = load_state()
    state["running"] = cur
    save_state(state)
    browser = connect_browser(port)
    ensure_window_size(browser)
    try:
        ext = browser.ensure_extension(cfg["edge"]["extension"])
        if ext:
            log(f"  ✓ Fuck头歌 已加载（v{ext.get('version', '?')}）")
    except RuntimeError as e:
        log(f"  ! {e}（继续运行，脚本会自行兜底跳关）")
    return browser


def classroom_page(browser: cdp.Browser, cfg: dict, old: "Page | None" = None) -> "Page":
    """开一个全新的课堂（实训作业列表）标签页；old 传入则顺手关掉旧页。

    实测：课堂页被导航去详情页再返回后，React 交互可能失效（点击无反应），
    所以每章都从干净的新标签页开始最稳。
    """
    if old and old.target.get("id"):
        browser.close_target(old.target["id"])
    url = cfg["edge"]["classroom"]
    target = browser.create_target(url)
    ws = browser.attach(target)
    ws.wait_for("document.readyState === 'complete'", timeout=40)
    for _ in range(60):          # 等 ant-spin 加载遮罩消失
        try:
            if not ws.eval("!!document.querySelector('.ant-spin-spinning')"):
                break
        except cdp.CDPError:
            break
        time.sleep(0.4)
    time.sleep(0.3)
    return Page(ws, target)


def ensure_login(ws: cdp.WS, timeout: float = 600) -> None:
    """确认头歌已登录；未登录则提示用户在窗口里登录并等待。"""
    def logged() -> bool:
        try:
            return bool(ws.eval(
                "!!document.querySelector('.task-user-info') || "
                "(document.body && document.body.innerText.includes('退出课堂'))"
            ))
        except cdp.CDPError:
            return False

    if logged():
        return
    log("\n！检测到副本浏览器里还没有登录头歌。")
    log("   请在弹出的浏览器窗口里完成登录（扫码/账号密码均可），脚本会自动等待…")
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(3)
        if logged():
            log("  ✓ 已登录")
            return
    die("等待登录超时，请登录后重新运行。")


# ─────────────────────────── 页面探针 ───────────────────────────

# 一次求值返回页面全部关键状态（JSON 字符串），减少往返
STATE_JS = r"""
JSON.stringify((function(){
  const text = (document.body ? document.body.innerText : '') || '';
  const m = text.match(/第(\d+)关\s*[：:]\s*([^\n]{1,60})/);
  const models = (window.Monaco && window.Monaco.editor) ? window.Monaco.editor.getModels() : [];
  const btns = [...document.querySelectorAll('button,[role=button]')];
  const evalBtn = btns.find(b => (b.innerText||'').trim() === '评测');
  const cd = btns.find(b => /^\d+\s*S$/.test((b.innerText||'').trim()));
  const next = [...document.querySelectorAll('a,button')].find(el =>
    (el.innerText||'').trim() === '下一关' && !el.closest('.evaluate-result-container'));
  const prev = [...document.querySelectorAll('a,button')].find(el =>
    (el.innerText||'').trim() === '上一关' && !el.closest('.evaluate-result-container'));
  const popup = [...document.querySelectorAll('.evaluate-result-container')].find(b => {
    const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const popupBtns = popup ? [...popup.querySelectorAll('a,button,[role=button]')]
      .map(el => (el.innerText||'').trim()).filter(Boolean) : [];
  const toasts = [...document.querySelectorAll('div')]
      .filter(d => d.style && d.style.position === 'fixed' && d.style.top === '26px')
      .map(d => d.textContent || '');
  const failMsgs = [...document.querySelectorAll('.ant-message-notice')]
      .filter(el => (el.innerText||'').includes('评测未通过')).length;
  const options = [...document.querySelectorAll('.option')];
  const checked = [...document.querySelectorAll('.option input[type=radio]')].filter(i => i.checked).length;
  return {
    url: location.href,
    ready: document.readyState,
    index: m ? +m[1] : 0,
    name: m ? m[2].trim() : '',
    hasEditor: !!document.querySelector('.monaco-editor'),
    models: models.length,
    hasEval: !!evalBtn,
    countdown: cd ? (cd.innerText||'').trim() : null,
    hasNext: !!next,
    hasPrev: !!prev,
    choiceCount: options.length,
    checkedCount: checked,
    popup: !!popup,
    popupBtns: popupBtns,
    toasts: toasts,
    failMsgs: failMsgs,
    fontPrompt: !!document.querySelector('.fuck-touge-ui-prompt'),
  };
})())
"""


# 结果探针：在页面里常驻一个 MutationObserver，记录扩展 toast 与庆祝弹层，
# 避免"秒完成"的选择题评测把信号漏掉（轮询 0.4s 也可能错过）。
# 要点：每个 toast 元素只记一次并打标 __aaSeen，重置日志不会让上一关的残留提示语
# 再次被计入（踩过坑：最后一关被上一关的"已跳转"提示骗过）。
PROBE_JS = r"""
(function(){
  if (!window.__aaObs) {
    window.__aaObs = new MutationObserver(function(){
      var L = window.__aaLog; if (!L) return;
      var ds = document.querySelectorAll('div');
      for (var i = 0; i < ds.length; i++) {
        var d = ds[i], s = d.style;
        if (s && s.position === 'fixed' && s.top === '26px' && !d.__aaSeen) {
          d.__aaSeen = true;
          var t = d.textContent || '';
          if (t && L.toasts.indexOf(t) < 0) L.toasts.push(t);
        }
      }
      var p = document.querySelector('.evaluate-result-container');
      var vis = false;
      if (p) { var r = p.getBoundingClientRect(); vis = r.width > 0 && r.height > 0; }
      if (vis && !L.popupVisible) L.popups++;
      L.popupVisible = vis;
    });
    window.__aaObs.observe(document.documentElement,
      {childList: true, subtree: true, characterData: true});
  }
  var p = document.querySelector('.evaluate-result-container');
  var r = p ? p.getBoundingClientRect() : null;
  window.__aaLog = {
    toasts: [],
    popups: 0,
    popupVisible: !!(r && r.width > 0 && r.height > 0)
  };
  return 'ok';
})()
"""


def probe_state(ws: cdp.WS) -> dict:
    try:
        return ws.eval_json("JSON.stringify(window.__aaLog || {toasts: [], popups: 0})")
    except cdp.CDPError:
        return {"toasts": [], "popups": 0}


class Page:
    """对某个页面会话的便捷封装（状态、点击、跳关等）。"""

    def __init__(self, ws: cdp.WS, target: dict | None = None):
        self.ws = ws
        self.target = target or {}

    def state(self) -> dict:
        return self.ws.eval_json(STATE_JS) or {}

    # ---------- 等待 ----------

    def wait_level(self, want_index: int | None = None, timeout: float = 60,
                   need_editor: bool | None = None) -> dict:
        """等待任务页就绪。want_index 指定则必须是对应关卡。"""
        deadline = time.time() + timeout
        last = {}
        while time.time() < deadline:
            try:
                st = self.state()
            except cdp.CDPError:
                st = {}
            if st:
                last = st
                if st.get("fontPrompt"):
                    self.ws.eval(
                        "(function(){const p=document.querySelector('.fuck-touge-ui-prompt');"
                        "if(p){const b=[...p.querySelectorAll('button')].find(x=>/暂不|关闭/.test(x.innerText));"
                        "if(b)b.click();}})()"
                    )
                ready = (
                    st.get("ready") == "complete"
                    and st.get("index", 0) > 0
                    and (st.get("hasEditor") or st.get("choiceCount", 0) > 0)
                )
                if want_index is not None:
                    ready = ready and st.get("index") == want_index
                if need_editor is True:
                    ready = ready and st.get("models", 0) >= 1
                if ready:
                    return st
            time.sleep(0.5)
        return last

    # ---------- 点击 ----------

    def click_expr(self, expr: str) -> bool:
        """按 JS 表达式找到元素并用真实鼠标点击；失败回退 DOM click。

        窗口窄时元素可能被挤出视口，这里取「元素与视口的交集」中心点来点，
        避免在屏幕外坐标上点击（elementFromPoint 会返回 null）。
        """
        info = self.ws.eval(
            "(function(){const el=(" + expr + "); if(!el) return null;"
            "el.scrollIntoView({block:'center', inline:'center'});"
            "const r=el.getBoundingClientRect();"
            "const x1=Math.max(r.left,0), x2=Math.min(r.right,innerWidth);"
            "const y1=Math.max(r.top,0), y2=Math.min(r.bottom,innerHeight);"
            "if(x2-x1<2||y2-y1<2) return null;"
            "return JSON.stringify({x:(x1+x2)/2,y:(y1+y2)/2});})()"
        )
        if info:
            pos = json.loads(info)
            self.ws.mouse_click(pos["x"], pos["y"])
            return True
        return bool(self.ws.eval(
            "(function(){const el=(" + expr + "); if(!el) return false; el.click(); return true;})()"
        ))

    def click_toolbar(self, text: str) -> bool:
        """点击工具栏的 上一关/下一关（排除弹层内）。"""
        expr = (
            "[...document.querySelectorAll('a,button')].find(el=>"
            f"(el.innerText||'').trim()==={json.dumps(text)} && "
            "!el.closest('.evaluate-result-container'))"
        )
        return self.click_expr(expr)

    def click_eval(self) -> bool:
        """点「评测」并确认已开始。先 DOM click（实测最稳），没有反应再补真实鼠标点击。"""
        expr = ("[...document.querySelectorAll('button,[role=button]')].find("
                "b=>(b.innerText||'').trim()==='评测')")
        self.ws.eval(PROBE_JS)                    # 重置结果探针

        def started(st0: dict) -> bool:
            """判断评测是否已经开始/结束（选择题可能瞬间完成）。"""
            try:
                st = self.state()
            except cdp.CDPError:
                return False
            if st.get("countdown") or st.get("popup"):
                return True
            if st.get("failMsgs", 0) > st0.get("failMsgs", 0):
                return True
            if st.get("index") != st0.get("index") or st.get("url") != st0.get("url"):
                return True
            pr = probe_state(self.ws)
            return bool(pr.get("popups") or pr.get("toasts"))

        st0 = self.state()
        fired = bool(self.ws.eval(
            "(function(){const b=(" + expr + "); if(!b) return false; b.click(); return true;})()"
        ))
        for _ in range(10):
            time.sleep(1)
            if started(st0):
                return True
        # 兜底：真实鼠标点击一次
        self.click_expr(expr)
        for _ in range(10):
            time.sleep(1)
            if started(st0):
                return True
        return fired


# ─────────────────────────── 课堂/关卡操作 ───────────────────────────

def card_pos_js(name: str) -> str:
    return r"""
(function(){
  const norm = s => (s||'').replace(/[\s\u3000]+/g,'');
  const target = norm(__NAME__);
  const cards = [...document.querySelectorAll('[class*="listItem"]')];
  const card = cards.find(c => norm(c.innerText).includes(target));
  if (!card) return JSON.stringify({ok:false, reason:'card-not-found'});
  card.scrollIntoView({block:'center'});
  const cands = [...card.querySelectorAll('*')].filter(el => norm(el.innerText) === '开始学习');
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    // 窗口窄时按钮可能被挤出视口：取"元素与视口的交集"中心点来点
    const x1 = Math.max(r.left, 0), x2 = Math.min(r.right, innerWidth);
    const y1 = Math.max(r.top, 0), y2 = Math.min(r.bottom, innerHeight);
    if (x2 - x1 < 2 || y2 - y1 < 2) continue;
    const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
    const at = document.elementFromPoint(x, y);
    const hit = !!(at && at.closest && at.closest('[class*="actionIcon"]'));
    return JSON.stringify({ok:true, x, y, hit});
  }
  return JSON.stringify({ok:false, reason:'start-button-not-found',
                         text: (card.innerText||'').replace(/\n+/g,' | ').slice(0,120)});
})()
""".replace("__NAME__", json.dumps(name, ensure_ascii=False))


def enter_chapter(browser: cdp.Browser, classroom: Page, chapter_name: str,
                  timeout: float = 20) -> tuple[dict, cdp.WS]:
    """在课堂页点某章的「开始学习」，返回（新标签页 target, 其会话）。

    课堂列表刷新时有 ant-spin 遮罩会挡住点击，这里会等遮罩消失并校验落点，失败自动重试。
    """
    before = {t["id"] for t in browser.pages()}
    last_reason = ""
    for attempt in range(4):
        # 等加载遮罩消失
        for _ in range(30):
            try:
                if not classroom.ws.eval(
                    "!!document.querySelector('.ant-spin-spinning')"
                ):
                    break
            except cdp.CDPError:
                break
            time.sleep(0.5)
        try:
            data = json.loads(classroom.ws.eval(card_pos_js(chapter_name)) or "{}")
        except cdp.CDPError:
            data = {}
        if not data.get("ok"):
            last_reason = data.get("reason", "未知")
            if data.get("text"):
                last_reason += "：" + data["text"]
            time.sleep(0.5)
            continue
        if not data.get("hit"):
            last_reason = "按钮被加载遮罩挡住"
            time.sleep(0.5)
            continue
        classroom.ws.mouse_click(data["x"], data["y"])
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.3)
            for t in browser.pages():
                if t["id"] not in before:
                    u = t.get("url", "")
                    if "/tasks/" in u or re.search(r"/shixun_homework/\d+", u):
                        ws = browser.attach(t)
                        return t, ws
        last_reason = "点击后没有等到新标签页"
    die(f"找不到章节「{chapter_name}」的「开始学习」按钮（{last_reason}）。\n"
        "  请确认浏览器停在课堂-实训作业列表页，且该章状态为“提交中”。")


def close_extra_tabs(browser: cdp.Browser, keep_ids: set[str]) -> None:
    for t in browser.pages():
        if "/tasks/" in t.get("url", "") and t["id"] not in keep_ids:
            browser.close_target(t["id"])


def wait_index_change(page: Page, old_index: int, timeout: float = 60) -> dict:
    """等待关卡序号变化（用于上一关/下一关/评测后跳转）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.4)
        try:
            st = page.state()
        except cdp.CDPError:
            continue
        if st.get("index") and st.get("index") != old_index:
            return page.wait_level(want_index=st.get("index"), timeout=timeout)
    return page.state()


def _click_toolbar_and_wait(page: Page, label: str, old_index: int,
                            attempts: int = 3, per: float = 20) -> dict:
    """点工具栏按钮并等待关卡变化；页面刚加载时点击可能不生效，自动重试。"""
    st = page.state()
    for i in range(attempts):
        if page.click_toolbar(label):
            st = wait_index_change(page, old_index, timeout=per)
            if st.get("index") != old_index:
                return st
        time.sleep(1)
        st = page.wait_level(want_index=old_index, timeout=10)
    return st


def rewind_to_first(page: Page, timeout: float = 60) -> dict:
    """不断点「上一关」，直到第 1 关（或没有上一关）。"""
    st = page.wait_level(timeout=timeout)
    for _ in range(20):
        if st.get("index", 0) <= 1 or not st.get("hasPrev"):
            return st
        old = st.get("index")
        st = _click_toolbar_and_wait(page, "上一关", old)
        if st.get("index") == old:
            break
    return st


def advance_level(page: Page, old_index: int, timeout: float = 60) -> dict:
    """点工具栏「下一关」，等待关卡变化（带重试）。"""
    return _click_toolbar_and_wait(page, "下一关", old_index)


# ─────────────────── 多代码文件关卡支持 ───────────────────
#
# 平台行为（2026-10 实测，见 脚本详细.md「多代码文件关卡」一节）：
# · 编辑器顶部有「代码文件」下拉；出现过的菜单项常驻 DOM，隐藏时宽高为 0；
# · 下拉是 hover 触发：mouseMoved 悬停展开（点击也能兜底）；后台标签页（visibilityState=hidden）
#   既不响应 hover 也展不开下拉 → ensure_file_menu 会先把标签页切到前台；
# · 点击某个文件项：若它不是当前文件 → 新建一个 Monaco model（内容 = 平台里该文件当前代码），
#   若是当前文件 → 什么都不做；
# · 新建的 model 编号最大，因此"最新 model"就是刚点开文件的内容；
# · 切换文件时平台会把上一个文件的内容存进自己的状态（评测/刷新后仍在）；
# · 当前文件由菜单项内层 span 的 class 含 pathActive 标记；
# · 必须用真实鼠标点击文件项，DOM click 不会走平台的切换逻辑。

MODEL_NUM_RE = re.compile(r"model/(\d+)")

FILE_ITEMS_JS = r"""
JSON.stringify([...document.querySelectorAll('.ant-dropdown-menu-item')].map(e => {
  const r = e.getBoundingClientRect();
  return {path: (e.innerText||'').trim(), visible: r.width > 2 && r.height > 2,
          x: r.x + r.width/2, y: r.y + r.height/2};
}).filter(x => x.path))
"""

FILE_TRIGGER_JS = r"""
JSON.stringify((function(){
  const s = [...document.querySelectorAll('span')]
      .find(x => (x.textContent||'').trim() === '代码文件');
  const t = s && s.parentElement.querySelector('.ant-dropdown-trigger');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  return {x: r.x + r.width/2, y: r.y + r.height/2};
})())
"""

FILE_ACTIVE_JS = r"""
JSON.stringify((function(){
  const el = document.querySelector('[class*="pathActive"]');
  return el ? (el.innerText||'').trim() : null;
})())
"""

FILE_HIT_JS = r"""
JSON.stringify((function(){
  const e = document.elementFromPoint(%s, %s);
  if (!e) return null;
  const it = e.closest('.ant-dropdown-menu-item');
  return it ? (it.innerText||'').trim() : null;
})())
"""


def _file_items(page: Page) -> list[dict]:
    return page.ws.eval_json(FILE_ITEMS_JS) or []


def ensure_file_menu(page: Page, timeout: float = 5) -> list[dict]:
    """确保「代码文件」下拉已展开，返回菜单项（含 visible 标记与坐标）。

    下拉是懒渲染（没打开过时 DOM 里没有菜单项）且 **hover 触发**：
    实测后台标签页（visibilityState=hidden）既不响应 hover 也不展开下拉，
    所以这里先把隐藏标签页切到前台，再用 mouseMoved 悬停展开；悬停没反应才补一次点击。
    撑不开或没有该下拉则返回现有项（可能为空）。
    """
    items = _file_items(page)
    if any(it.get("visible") for it in items):
        return items
    try:
        if page.ws.eval("document.visibilityState") != "visible":
            page.ws.call("Page.bringToFront")
            time.sleep(0.3)
    except cdp.CDPError:
        pass
    deadline = time.time() + timeout
    clicked = False
    while time.time() < deadline:
        pos = page.ws.eval_json(FILE_TRIGGER_JS)
        if not pos:
            time.sleep(0.25)
            continue
        # 虚拟鼠标若已停在触发器上，再发 mouseMoved 不会产生 mouseenter
        # （Chrome 对同坐标去重），下拉不会展开 —— 先移到中性点再悬停。
        page.ws.mouse_move(20, 400)
        time.sleep(0.1)
        page.ws.mouse_move(pos["x"], pos["y"])       # hover 展开
        for _ in range(4):
            time.sleep(0.15)
            items = _file_items(page)
            if any(it.get("visible") for it in items):
                return items
        if not clicked:                              # 悬停无效时补一次点击
            page.ws.mouse_click(pos["x"], pos["y"])
            clicked = True
    return items


def close_file_menu(page: Page) -> None:
    """把「代码文件」下拉收起来（hover 触发，鼠标移开就会收）。"""
    for _ in range(3):
        items = _file_items(page)
        if not any(it.get("visible") for it in items):
            return
        page.ws.mouse_move(20, 400)                  # 移开鼠标
        time.sleep(0.3)
        items = _file_items(page)
        if not any(it.get("visible") for it in items):
            return
        pos = page.ws.eval_json(FILE_TRIGGER_JS)     # 兜底：点一下触发器
        if not pos:
            return
        page.ws.mouse_click(pos["x"], pos["y"])
        time.sleep(0.3)


def list_code_files(page: Page) -> tuple[list[str], str]:
    """返回（本关代码文件路径列表, 当前显示的文件）。没有「代码文件」下拉则 ([], "")。

    单文件关卡也有这个下拉（只有 1 项），所以可以用它判断是否多文件关卡。
    """
    items = ensure_file_menu(page)
    vis = [it for it in items if it.get("visible")]
    if not items and page.ws.eval_json(FILE_TRIGGER_JS):
        log("    ！「代码文件」下拉没能展开，暂按单文件处理"
            "（页面不在前台时可能发生）")
    paths = [it["path"] for it in (vis or items)]
    active = page.ws.eval_json(FILE_ACTIVE_JS) or ""
    return paths, active


def _same_path(a: str, b: str) -> bool:
    a = (a or "").strip().replace("\\", "/")
    b = (b or "").strip().replace("\\", "/")
    if not a or not b:
        return False
    return a == b or a.rsplit("/", 1)[-1] == b.rsplit("/", 1)[-1]


def _find_item(items: list[dict], want: str) -> dict | None:
    want = (want or "").strip().replace("\\", "/")
    if not want:
        return None
    for it in items:
        if it["path"].replace("\\", "/") == want:
            return it
    base = want.rsplit("/", 1)[-1]
    cands = [it for it in items
             if it["path"].replace("\\", "/").rsplit("/", 1)[-1] == base]
    return cands[0] if len(cands) == 1 else None


def _model_uris(page: Page) -> list[str]:
    return page.ws.eval_json(
        "JSON.stringify(window.Monaco.editor.getModels().map(m => m.uri.toString()))"
    ) or []


def _newest_uri(uris: list[str]) -> str | None:
    if not uris:
        return None

    def num(u: str) -> int:
        m = MODEL_NUM_RE.search(u)
        return int(m.group(1)) if m else -1
    return max(uris, key=num)


def click_code_file(page: Page, path: str, timeout: float = 5) -> str | None:
    """展开下拉、真实点击某个文件项，返回该文件对应的 model uri。

    点已激活的文件不会新建 model（正常），此时返回最新的 model；
    点不动（既没新 model、激活标记也没变）会重试，最终失败返回 None。
    """
    for _ in range(3):
        before = set(_model_uris(page))
        items = ensure_file_menu(page)
        vis = [it for it in items if it.get("visible")]
        it = _find_item(vis, path)
        if it is None:
            if vis and _find_item(items, path) is None:
                return None                 # 下拉里确实没有这个文件
            time.sleep(0.5)                 # 菜单没撑开或目标还藏着，重试
            continue
        # 下拉有展开动画：等目标项坐标连续两次一致再点，防止点到滑动中的位置。
        # 注意 menu 可能中途自己收起（平台 re-render），一旦目标消失就重来，
        # 绝不使用上一次抓到的陈旧坐标去点（会点穿到编辑器上）。
        fresh = None
        pos_prev = None
        for _ in range(8):
            cur = _find_item([x for x in _file_items(page) if x.get("visible")], path)
            if cur is None:
                break
            if pos_prev is not None and abs(cur["x"] - pos_prev[0]) < 1.5 \
                    and abs(cur["y"] - pos_prev[1]) < 1.5:
                fresh = cur
                break
            pos_prev = (cur["x"], cur["y"])
            fresh = cur
            time.sleep(0.12)
        if fresh is None:
            time.sleep(0.3)                 # 菜单收了，下一轮重新 ensure
            continue
        # 点击前最后确认：该坐标下确实还是这个菜单项
        hit = page.ws.eval_json(FILE_HIT_JS % (fresh["x"], fresh["y"]))
        if hit is None or not _same_path(hit, path):
            time.sleep(0.3)
            continue
        page.ws.mouse_click(fresh["x"], fresh["y"])      # 必须真实点击
        deadline = time.time() + timeout
        while time.time() < deadline:
            new = [u for u in _model_uris(page) if u not in before]
            if new:
                return _newest_uri(new)
            time.sleep(0.25)
        active = page.ws.eval_json(FILE_ACTIVE_JS) or ""
        if _same_path(active, path):
            return _newest_uri(_model_uris(page))
        time.sleep(0.5)
    return None


def wait_uri_settled(page: Page, uri: str, timeout: float = 8,
                     need_stable: int = 2) -> str | None:
    """等某个 model 的内容稳定（刚点开的文件可能还在从平台状态载入）。"""
    last, stable = None, 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            cur = page.ws.eval_json(
                "JSON.stringify((function(){const ms=window.Monaco.editor.getModels()"
                f".filter(m=>m.uri.toString()==={json.dumps(uri)});"
                "return ms.length ? ms[0].getValue() : null;})())"
            )
        except cdp.CDPError:
            cur = None
        if isinstance(cur, str) and cur == last:
            stable += 1
            if stable >= need_stable:
                return cur
        else:
            stable = 0
        last = cur
        time.sleep(0.4)
    return last


def write_uri_code(page: Page, uri: str, code: str) -> int:
    """对指定 model 做整文件覆盖写入，写完回读校验（不一致重试一次）。"""
    def write_and_read() -> tuple[bool, int]:
        expr = (
            "(function(){const ms=window.Monaco.editor.getModels()"
            f".filter(m=>m.uri.toString()==={json.dumps(uri)});"
            "if(!ms.length) return JSON.stringify({ok:false});"
            f"ms[0].setValue({json.dumps(code)});"
            "const got=ms[0].getValue();"
            "return JSON.stringify({ok: got === " + json.dumps(code) + ", len: got.length});})()"
        )
        r = page.ws.eval_json(expr) or {}
        return bool(r.get("ok")), int(r.get("len") or 0)

    ok, n = write_and_read()
    if not ok:
        time.sleep(0.5)
        ok, n = write_and_read()
    if not ok:
        raise RuntimeError("代码写入后回读校验不一致，已停止（防止只写进去一部分）")
    return n


def read_saved_files(page: Page, paths: list[str]) -> tuple[str | None, object, str]:
    """多文件关卡：逐个点开文件，从新 model 读代码。"""
    out, notes = [], []
    for path in paths:
        uri = click_code_file(page, path)
        if not uri:
            return None, None, f"点开文件「{path}」失败（下拉菜单里没反应）"
        code = wait_uri_settled(page, uri)
        if not isinstance(code, str) or not code.strip():
            return None, None, f"文件「{path}」读不到内容"
        out.append((path, code))
        notes.append(f"{path}（{len(code)} 字符）")
    return "files", out, "；".join(notes)


def write_files(page: Page, live_paths: list[str], entries: list[dict]) -> None:
    """多文件关卡：逐文件真实点击切换 + 整文件覆盖，最后同步并核对。

    entries 来自答案档案：[{"path": ..., "answer": ...}, ...]。
    写入后把每个文件再点一遍：既让平台把自己的状态同步完整，也顺便核对
    新点开的 model 内容确实等于档案答案（不等就补写一次）。
    """
    plan = []
    for live in live_paths:
        ent = next((e for e in entries if _same_path(str(e.get("path") or ""), live)), None)
        if ent is None:
            raise RuntimeError(f"档案里没有文件「{live}」的条目，请先 harvest 或手动补全")
        code = str(ent.get("answer") or "")
        if not code.strip():
            raise RuntimeError(f"档案里文件「{ent.get('path') or live}」的答案是空的")
        plan.append((live, code))
    extra = [str(e.get("path")) for e in entries
             if not any(_same_path(str(e.get("path") or ""), p) for p in live_paths)]
    if extra:
        raise RuntimeError("档案里的这些文件在本关不存在：" + "；".join(extra)
                           + "（可用 harvest 重新采集）")

    for path, code in plan:
        uri = click_code_file(page, path)
        if not uri:
            raise RuntimeError(f"点开文件「{path}」失败（下拉菜单里没反应）")
        wait_uri_settled(page, uri, timeout=6)    # 先等平台内容载入，防止写后被覆盖
        n = write_uri_code(page, uri, code)
        log(f"    已写入 {path}（{n} 字符）")
        time.sleep(0.3)                           # 让平台先消化这次修改再切文件

    for path, code in plan:
        uri = click_code_file(page, path)
        if not uri:
            raise RuntimeError(f"同步核对时点开文件「{path}」失败")
        got = wait_uri_settled(page, uri, timeout=6)
        if (got or "").strip("\n") != code.strip("\n"):
            uri = click_code_file(page, path)     # 补救一次
            if not uri:
                raise RuntimeError(f"文件「{path}」回读不一致后重写失败")
            write_uri_code(page, uri, code)
            got = wait_uri_settled(page, uri, timeout=6) or ""
            if got.strip("\n") != code.strip("\n"):
                raise RuntimeError(f"文件「{path}」写入后回读不一致，已停止")
        log(f"    ✓ 核对 {path}：平台状态与档案一致（{len(got)} 字符）")


def wait_model_settled(page: Page, timeout: float = 10, need_stable: int = 3) -> str | None:
    """等 Monaco 编辑器内容稳定下来再读写。

    平台打开关卡时会先塞一段示例/占位代码，稍后才加载服务器上的真实代码；
    读太早会采到占位代码（真实踩坑：五章第 5 关采成了 public class Demo），
    写太早则可能被随后加载的真实代码覆盖掉。
    """
    last, stable = None, 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            cur = page.ws.eval(
                "(window.Monaco && window.Monaco.editor.getModels().length === 1)"
                " ? window.Monaco.editor.getModels()[0].getValue() : null"
            )
        except cdp.CDPError:
            cur = None
        if isinstance(cur, str) and cur.strip() and cur == last:
            stable += 1
            if stable >= need_stable:
                return cur
        else:
            stable = 0
        last = cur
        time.sleep(0.5)
    return last if isinstance(last, str) else None


def set_code(page: Page, code: str) -> None:
    """把完整代码整体覆盖进 Monaco（等效一次性全选粘贴）。

    说明：这里用的是 model.setValue()，**整文件覆盖**而不是只改 Begin-End 中间那段；
    写入前等编辑器内容稳定，写完立刻回读校验，确保写入内容和档案完全一致
    （不一致就重试一次，仍不行则报错暂停）。
    """
    wait_model_settled(page, timeout=8)      # 防止平台随后加载的真实代码覆盖我们

    def write_and_read() -> tuple[bool, int]:
        expr = (
            "(function(){const ms=window.Monaco.editor.getModels();"
            "if(!ms.length) return JSON.stringify({ok:false});"
            f"ms[0].setValue({json.dumps(code)});"
            "const got = ms[0].getValue();"
            "return JSON.stringify({ok: got === "
            f"{json.dumps(code)}"
            ", len: got.length});})()"
        )
        r = page.ws.eval_json(expr) or {}
        return bool(r.get("ok")), int(r.get("len") or 0)

    ok, n = write_and_read()
    if not ok:
        time.sleep(0.5)
        ok, n = write_and_read()          # 偶尔遇到编辑器重载，重试一次
    if not ok:
        raise RuntimeError("代码写入后回读校验不一致，已停止（防止只写进去一部分）")
    log(f"    已整文件覆盖写入并校验通过（{n} 字符）")


def answer_choice(page: Page, items: list) -> None:
    """选择题：按题号顺序点选选项。

    items 每题一项：可以是 'A'，也可以是 ['A','B','D']（多选题）。
    关键：页面会回显历史勾选，而 checkbox 点击是"切换"，所以必须
    先清掉不在答案里的已勾选项，再补勾缺少的（radio 点目标即切换，无需清）。
    """
    norm_items = []
    for it in items:
        if isinstance(it, list):
            norm_items.append([str(x).strip().upper()[:1] for x in it])
        else:
            norm_items.append([str(it).strip().upper()[:1]])
    payload = json.dumps(norm_items)

    def apply_and_check() -> tuple[list, list]:
        result = page.ws.eval_json(
            "(function(ls){"
            "const groups=[...document.querySelectorAll('.option')];"
            "const out=[];"
            "groups.forEach((g,gi)=>{"
            "  const letters=ls[gi]; if(!letters) return;"
            "  const inputs=[...g.querySelectorAll('input')];"
            "  const want=new Set(letters.map(L=>L.charCodeAt(0)-65));"
            "  const isRadio=inputs.length>0 && inputs[0].type==='radio';"
            "  if(!isRadio){"
            "    inputs.forEach((inp,i)=>{ if(inp.checked && !want.has(i)) (inp.closest('label')||inp).click(); });"
            "  }"
            "  want.forEach(i=>{"
            "    const inp=inputs[i];"
            "    if(inp && !inp.checked) (inp.closest('label')||inp).click();"
            "  });"
            "  out.push({q:gi+1, letters:letters});"
            "});"
            "return JSON.stringify(out);"
            f"}})({payload})"
        ) or []
        time.sleep(0.5)
        checked = page.ws.eval_json(r"""
JSON.stringify([...document.querySelectorAll('.option')].map(g =>
  [...g.querySelectorAll('input')].map((inp,i)=>inp.checked?i:-1).filter(i=>i>=0)))
""") or []
        return result, checked

    result, checked = apply_and_check()
    # 校验：每题勾选集合必须与答案完全一致；不一致再重试一次
    def bad() -> bool:
        for gi, letters in enumerate(norm_items):
            want = sorted(ord(L) - 65 for L in letters)
            got = sorted(checked[gi]) if gi < len(checked) else []
            if want != got:
                return True
        return False

    if bad():
        result, checked = apply_and_check()
    if bad():
        raise RuntimeError(f"选项勾选与答案不一致（实际 {checked}，应为 {norm_items}）")
    log(f"    已选择：{[{'q': i+1, 'letters': items} for i, items in enumerate(norm_items)]}（勾选数已核对）")


def choice_letters(answer) -> list:
    """把档案里的选择题答案规整成「每题一项」的列表；多选题为子列表。"""
    if isinstance(answer, list):
        return answer
    s = str(answer or "").strip()
    if not s:
        return []
    if "," in s or "，" in s:
        return [x.strip().upper()[:1] for x in re.split(r"[,，]", s) if x.strip()]
    return [s.upper()[:1]]


def status_of(page: Page, text: str) -> str | None:
    """从页面文本里抓某关的通过状态（详情页表格用）。"""
    return None


def card_progress_js(name: str) -> str:
    """按名字片段找课堂卡片，返回 {done, total, name}（name 为卡片完整标题）。"""
    return r"""
JSON.stringify((function(){
  const norm = s => (s||'').replace(/[\s\u3000]+/g,'');
  const card = [...document.querySelectorAll('[class*="listItem"]')]
      .find(c => norm(c.innerText).includes(norm(__NAME__)));
  if (!card) return {done: 0, total: 0, name: ''};
  const m = (card.innerText||'').match(/(\d+)\s*\/\s*(\d+)/);
  const t = (card.innerText||'').split('\n').map(s=>s.trim()).filter(Boolean);
  return {done: m ? +m[1] : 0, total: m ? +m[2] : 0, name: t[1] || ''};
})())
""".replace("__NAME__", json.dumps(name, ensure_ascii=False))


def scrape_status(browser: cdp.Browser, classroom: Page, detail_url: str,
                  expect: int | None = None) -> list[dict]:
    """打开章节详情页，按顺序返回 [{'name','full','score','status'}, ...]。"""
    classroom.ws.call("Page.navigate", {"url": detail_url})
    ok = classroom.ws.wait_for(
        "!!document.querySelector('.ant-table-row')", timeout=45
    )
    if not ok:
        log("  ! 详情页表格未加载，跳过状态检查")
        return []
    last, stable = -1, 0
    t0 = time.time()
    deadline = t0 + (40 if expect else 30)
    while time.time() < deadline:
        try:
            if classroom.ws.eval("!!document.querySelector('.ant-spin-spinning')"):
                time.sleep(0.4)
                continue
            n = classroom.ws.eval("document.querySelectorAll('.ant-table-row').length")
            ready = bool(n) and bool(classroom.ws.eval(
                "[...document.querySelectorAll('.ant-table-row')].every(tr => {"
                "  const td = tr.querySelectorAll('td');"
                "  return td.length >= 5 && (td[4].innerText || '').trim().length > 0;})"
            ))
        except cdp.CDPError:
            n, ready = last, False
        if n:
            if n == last:
                stable += 1
            else:
                stable = 0
            last = n
            if expect and n >= expect and ready:
                break
            # 表格分批渲染：行数稳定还不够，要等状态列有字（否则会读出空状态）
            if not expect and ready and stable >= 3 and time.time() - t0 >= 3:
                break
        time.sleep(0.6)
    rows = classroom.ws.eval_json(r"""
JSON.stringify([...document.querySelectorAll('.ant-table-row')].map(tr => {
  const tds = [...tr.querySelectorAll('td')];
  return {name: (tds[1]?.innerText || '').replace(/\s+/g,' ').trim(),
          full: (tds[2]?.innerText || '').trim(),
          score: (tds[3]?.innerText || '').trim(),
          status: (tds[4]?.innerText || '').trim()};
}).filter(r => r.name))
""") or []
    if expect and len(rows) < expect:
        log(f"  ! 详情页只读到 {len(rows)} 行（课堂卡片显示共 {expect} 关），可能有遗漏")
    return rows


def _num(s) -> float | None:
    try:
        return float(str(s).strip())
    except (TypeError, ValueError):
        return None


def is_passed_row(row: dict | None) -> bool:
    """这一关是否真正拿到满分。

    · 「已通过」= 满分；
    · 选择题/测试题显示「已提交」，可能是部分得分——必须比对 得分>=分值。
    """
    if not row:
        return False
    status = (row.get("status") or "").strip()
    if status == "已通过":
        return True
    if status == "已提交":
        full, score = _num(row.get("full")), _num(row.get("score"))
        return full is not None and score is not None and full > 0 and score >= full - 0.005
    return False


def row_at(rows: list[dict], index: int, name: str = "") -> dict | None:
    """按关卡序号取详情行；序号越界时退回按名字找。"""
    if 0 < index <= len(rows):
        return rows[index - 1]
    for r in rows:
        if norm(r.get("name", "")) == norm(name):
            return r
    return None


# ─────────────────────────── 评测结果等待 ───────────────────────────

def wait_outcome(page: Page, ctx: dict, timeout: float) -> dict:
    """评测后等待结果。

    返回 {'kind': 'next'|'last'|'fail'|'timeout', 'detail': ...}

    判定原则（实测总结）：
    · 「关卡变化」是最硬的信号，优先信；
    · 「已经是最后一关了」提示（探针按元素去重）直接判定 last；
    · 「已为您自动跳转至下一关」只当作"通过"提示，必须再等到关卡变化才算 next，
      否则会被上一关残留的提示语骗（真实踩坑）；
    · 庆祝弹层仍活着 → 按按钮文案判定，并兜底帮扩展点掉；
    · 出现新的「评测未通过」消息 → fail。
    """
    deadline = time.time() + timeout
    popup_seen_at = 0.0
    fail_seen_at = 0.0
    next_hint_at = 0.0
    while time.time() < deadline:
        time.sleep(0.4)
        try:
            st = page.state()
        except cdp.CDPError:
            continue
        pr = probe_state(page.ws)
        toast_text = " ".join(list(pr.get("toasts", [])))
        if TOAST_LAST in toast_text:
            return {"kind": "last", "detail": TOAST_LAST}
        if TOAST_NEXT in toast_text and not next_hint_at:
            next_hint_at = time.time()
        if st.get("popup"):
            btns = st.get("popupBtns", [])
            kind = "last" if any(b in ("最后一关", "完成") for b in btns) else "next"
            if not popup_seen_at:
                popup_seen_at = time.time()
            # 扩展不在时，弹层会一直留着：1.5 秒后由我们点掉
            if time.time() - popup_seen_at > 1.5:
                page.click_expr(
                    "[...document.querySelectorAll('.evaluate-result-container')]"
                    " .flatMap(b=>[...b.querySelectorAll('a,button,[role=button]')])"
                    ".find(el=>/下一关|最后一关|完成/.test((el.innerText||'').trim()))"
                )
                return {"kind": kind, "detail": "self-clicked:" + ",".join(btns)}
            continue
        if st.get("failMsgs", 0) > ctx.get("fail0", 0):
            if not fail_seen_at:
                fail_seen_at = time.time()
            # 未通过不会再出庆祝弹层；给 1.2 秒宽限防止消息早于弹层
            if time.time() - fail_seen_at > 1.2 and not st.get("popup"):
                return {"kind": "fail", "detail": FAIL_TEXT}
        if st.get("index") and st.get("index") != ctx.get("index0"):
            return {"kind": "next", "detail": "关卡已跳转"}
        if st.get("url") != ctx.get("url0"):
            if ctx.get("is_last"):
                return {"kind": "last", "detail": "最后一关已结束"}
            return {"kind": "next", "detail": "页面已跳转"}
        if pr.get("popups", 0) > 0 and ctx.get("is_last"):
            # 最后一关：弹层已被扩展点掉、却没等到「最后一关」提示（理论少见）
            return {"kind": "last", "detail": "弹层已被扩展点掉（最后一关）"}
        if next_hint_at and time.time() - next_hint_at > 12:
            # 有"已跳转"提示却迟迟没有关卡变化：交给外层用工具栏兜底
            return {"kind": "next", "detail": "提示已跳转但未检测到关卡变化"}
    return {"kind": "timeout", "detail": "等待评测结果超时"}


# ─────────────────────────── 答案档案 ───────────────────────────

class Level:
    def __init__(self, raw: dict):
        self.name = str(raw.get("name", "")).strip()
        self.skip = bool(raw.get("skip", False))
        self.type = str(raw.get("type", "")).strip()
        self.answer = raw.get("answer", "")
        files = []
        for f in raw.get("files") or []:
            if isinstance(f, dict):
                files.append({"path": str(f.get("path", "")).strip(),
                              "answer": f.get("answer", "")})
        self.files = files          # 多代码文件关卡的答案：[{path, answer}]

    def answer_empty(self) -> bool:
        if self.files:
            return all(not str(f.get("answer") or "").strip() for f in self.files)
        if isinstance(self.answer, list):
            return not self.answer or all(not str(x).strip() for x in self.answer)
        return not str(self.answer or "").strip()


class Chapter:
    def __init__(self, raw: dict):
        self.name = str(raw.get("name", "")).strip()
        self.homework_id = str(raw.get("homework_id", "")).strip()
        self.levels = [Level(x) for x in raw.get("levels", [])]


def load_answers(path: Path) -> list[Chapter]:
    if not path.exists():
        die(f"答案档案不存在：{path}\n  先运行：python3 答题.py scan -a")
    try:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        die(f"答案档案 TOML 语法错误：{path}\n  {e}")
    chapters = [Chapter(c) for c in data.get("chapters", [])]
    if not chapters:
        die("答案档案里没有任何 [[chapters]] 条目。")
    return chapters


def find_level(chapter: Chapter, index: int, name: str) -> Level | None:
    """按关卡序号（1 基）匹配档案条目；序号越界时退回按名字找。

    注意：同一章可能有重名关卡（八章有两个「选择题」），所以序号优先。
    """
    if 0 < index <= len(chapter.levels):
        return chapter.levels[index - 1]
    n = norm(name)
    for lv in chapter.levels:
        if lv.name and norm(lv.name) == n:
            return lv
    return None


def write_scan_skeleton(path: Path, scanned: list[dict]) -> None:
    """把扫描结果并入答案档案。

    · 文件不存在：生成完整骨架；
    · 已存在：只追加缺的章节/关卡，绝不改写用户已填内容；
    · 写入前用 tomllib 校验，失败则保留原文件。
    """
    def block(ch: dict) -> str:
        lines = ["[[chapters]]", f'name = {json.dumps(ch["name"], ensure_ascii=False)}']
        if ch.get("homework_id"):
            lines.append(f'homework_id = {json.dumps(ch["homework_id"], ensure_ascii=False)}')
        lines.append("")
        for lv in ch["levels"]:
            lines.append("[[chapters.levels]]")
            lines.append(f'name = {json.dumps(lv["name"], ensure_ascii=False)}')
            lines.append('answer = ""')
            lines.append("")
        return "\n".join(lines)

    if not path.exists():
        header = (
            "# 头歌自动答题 · 标准答案档案（通用版）\n"
            "# ─────────────────────────────────────────────\n"
            "# · 这份档案只记录：章节顺序 + 每关答案，不记录任何人的答题进度。\n"
            "#   已通过的关卡由脚本运行时查详情页状态自动跳过，所以同一份档案\n"
            "#   可以发给进度不同的人使用。\n"
            "# · 代码题：answer 用三个单引号原样包住完整代码（若代码里出现 '''，改用三个双引号）。\n"
            "# · 选择题：answer 填选项字母；多题填列表，如 answer = [\"B\", \"A\", \"D\"]。\n"
            "# · 不想跑某关/某章：删掉对应条目，或自行加 skip = true（一般不需要）。\n\n"
            "version = 1\n\n"
        )
        text = header + "\n".join(
            block(ch) for ch in sorted(scanned, key=lambda c: chapter_sort_key(c["name"]))
        )
    else:
        text = path.read_text(encoding="utf-8")
        existing = tomllib.loads(text)
        exists_ch = {c.get("name"): c for c in existing.get("chapters", [])}
        additions = []
        for ch in scanned:
            if ch["name"] not in exists_ch:
                additions.append(block(ch))
                continue
            have_names = [lv.get("name") for lv in exists_ch[ch["name"]].get("levels", [])]
            scan_names = [lv["name"] for lv in ch["levels"]]
            # 按顺序对齐：已有条目必须是扫描结果的前缀，多出来的尾巴才补写
            if have_names != scan_names[:len(have_names)]:
                log(f"  ! 章节「{ch['name']}」的档案条目与扫描结果顺序/名字不一致，"
                    "未自动改动，请手动核对")
                continue
            missing = ch["levels"][len(have_names):]
            if missing:
                lines = []
                for lv in missing:
                    lines.append("[[chapters.levels]]")
                    lines.append(f'name = {json.dumps(lv["name"], ensure_ascii=False)}')
                    lines.append('answer = ""')
                    lines.append("")
                # 插到该章块的末尾（下一个 [[chapters]] 之前）
                src = text.splitlines(keepends=True)
                ch_start = None
                for i, line in enumerate(src):
                    if line.strip() == "[[chapters]]":
                        # 往后找 name 行
                        for j in range(i + 1, min(i + 8, len(src))):
                            m = re.match(r'\s*name\s*=\s*(.*)', src[j])
                            if m:
                                try:
                                    if json.loads(m.group(1)) == ch["name"]:
                                        ch_start = i
                                except Exception:
                                    pass
                                break
                        if ch_start is not None:
                            break
                if ch_start is None:
                    additions.append(block({"name": ch["name"],
                                            "homework_id": ch.get("homework_id"),
                                            "levels": missing}))
                else:
                    end = len(src)
                    for k in range(ch_start + 1, len(src)):
                        if src[k].strip() == "[[chapters]]":
                            end = k
                            break
                    insert = "".join(lines)
                    if end > 0 and not src[end - 1].endswith("\n\n"):
                        insert = "\n" + insert
                    src.insert(end, insert)
                    text = "".join(src)
        if additions:
            text = text.rstrip() + "\n\n" + "\n".join(additions) + "\n"
    text = sort_chapter_blocks(text)      # 章节按顺序排好，看着舒服
    # 校验后落盘
    try:
        tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        die(f"生成档案时 TOML 校验失败，未写入原文件：{e}")
    path.write_text(text, encoding="utf-8")


# ─────────────────────────── 子命令：scan ───────────────────────────

def scan_chapters(browser: cdp.Browser, classroom: Page, cfg: dict,
                  names: list[str]) -> tuple[list[dict], Page]:
    """扫描指定章节，返回 (扫描结果, 最新的课堂页对象)。"""
    scanned = []
    for name in names:
        classroom = classroom_page(browser, cfg, old=classroom)   # 每章都用干净的课堂页
        prog = classroom.ws.eval_json(card_progress_js(name)) or {}
        full = (prog.get("name") or "").strip() or name   # 用卡片完整标题，避免档案里出现片段名
        log(f"\n→ 扫描章节：{full}")
        target, _ = enter_chapter(browser, classroom, full)
        url = target["url"]
        m = re.search(r"/tasks/[^/]+/(\d+)/", url) or \
            re.search(r"/shixun_homework/(\d+)/detail", url)
        browser.close_target(target["id"])
        if not m:
            die(f"无法从 URL 解析 homework_id：{url}")
        hid = m.group(1)
        detail_url = cfg["edge"]["classroom"] + f"/{hid}/detail?tabs=1"
        rows = scrape_status(browser, classroom, detail_url, expect=prog.get("total"))
        if not rows:
            die(f"章节「{name}」详情页没有读到关卡列表。")
        levels = [{"name": r["name"]} for r in rows]
        log(f"  读到 {len(levels)} 关：" + "，".join(
            f"{i+1}.{r['name']}{'(已满分，运行时会自动跳过)' if is_passed_row(r) else ''}"
            for i, r in enumerate(rows)))
        scanned.append({"name": full, "homework_id": hid, "levels": levels})
    return scanned, classroom


def cmd_scan(args, cfg: dict) -> None:
    browser = ensure_browser(cfg)
    classroom = classroom_page(browser, cfg)
    ensure_login(classroom.ws)

    if args.all:
        cards = classroom.ws.eval_json(r"""
JSON.stringify([...document.querySelectorAll('[class*="listItem"]')].map(c => {
  const t = (c.innerText||'').split('\n').map(s=>s.trim()).filter(Boolean);
  const hasStart = [...c.querySelectorAll('*')].some(el => (el.innerText||'').trim() === '开始学习');
  const prog = (c.innerText||'').match(/(\d+)\s*\/\s*(\d+)/);
  return {name: t[1] || '', hasStart,
          done: prog ? +prog[1] : 0, total: prog ? +prog[2] : 0};
}).filter(c => c.hasStart && c.name && !(c.total > 0 && c.done >= c.total)))
""") or []
        names = [c["name"] for c in cards]
    else:
        names = args.chapter or []
    if not names:
        die("没有指定章节。用法：scan 章节名…（可多个）；或 scan -a 扫描全部")

    scanned, _ = scan_chapters(browser, classroom, cfg, names)
    write_scan_skeleton(Path(cfg["run"]["answers"]), scanned)
    log(f"\n✓ 已更新答案档案：{cfg['run']['answers']}")
    log("  请打开它，把各关的 answer 填成标准答案；选择题填选项字母（多题用列表）。")


# ─────────────────────────── 子命令：harvest ───────────────────────────

def read_submitted_code(page: Page, timeout: float = 15) -> str | None:
    """从『记录』里最近一次"评测通过"的提交中读取当时提交的代码。

    比编辑器更可靠：有些关卡平台不回显已提交代码（编辑器只剩模板，实测五章第 5 关）。
    原理：点开「查看代码」后平台会新建一个 Monaco model，直接读那个 model 的完整内容，
    避免抓带行号和 &nbsp; 的展示文本。
    """
    def click_expr(expr: str) -> bool:
        pos = page.ws.eval_json(
            "JSON.stringify((function(){const el=(" + expr + "); if(!el) return null;"
            "const r=el.getBoundingClientRect(); if(!(r.width>0&&r.height>0)) return null;"
            "return {x:r.x+r.width/2,y:r.y+r.height/2};})())"
        )
        if not pos:
            return False
        page.ws.mouse_click(pos["x"], pos["y"])
        return True

    try:
        before = set(page.ws.eval_json(
            "JSON.stringify(window.Monaco.editor.getModels().map(m=>m.uri.toString()))"
        ) or [])
        # 1) 切到「记录」页签
        if not click_expr(
            "[...document.querySelectorAll('*')].find(e=>(e.innerText||'').trim()==='记录')"
        ):
            return None
        page.ws.wait_for("!!document.querySelector('.ant-table-row')", timeout=timeout)
        # 2) 点最近一次"评测通过"那一行的「查看代码」
        if not click_expr(
            "(function(){const rows=[...document.querySelectorAll('.ant-table-row')];"
            "const row=rows.find(r=>(r.innerText||'').includes('评测通过'));"
            "if(!row) return null;"
            "return [...row.querySelectorAll('*')].find(e=>(e.innerText||'').trim()==='查看代码');})()"
        ):
            return None
        # 3) 等新 model 出现并读取
        code = None
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.4)
            models = page.ws.eval_json(
                "JSON.stringify(window.Monaco.editor.getModels().map(m=>({uri:m.uri.toString(), value:m.getValue()})))"
            ) or []
            new = [m for m in models if m["uri"] not in before]
            if new:
                code = new[-1]["value"]
                break
        return code or None
    finally:
        # 4) 关掉弹窗（无论成功失败，别把弹窗留给后续步骤）
        click_expr("document.querySelector('.ant-modal .ant-modal-close')")
        time.sleep(0.4)


def read_saved_answer(page: Page, st: dict) -> tuple[str | None, str | None, str]:
    """读取当前关卡服务器上已保存的答案。

    返回 (kind, value, note)：kind = 'code'（完整代码）或 'choice'（每题字母列表）；
    读不到则 kind=None。
    """
    if st.get("hasEditor"):
        paths, _ = list_code_files(page)          # 单文件关卡也会有 1 项
        if len(paths) > 1:
            return read_saved_files(page, paths)  # 多文件：逐个点开读
        close_file_menu(page)
        if st.get("models", 0) != 1:
            return None, None, f"有 {st.get('models')} 个文件，暂不支持采集"
        code = read_submitted_code(page)          # 首选：评测记录里的提交代码
        src = "评测记录"
        if not code:
            code = wait_model_settled(page)       # 兜底：编辑器当前内容
            src = "编辑器"
        if not code or not code.strip():
            return None, None, "编辑器是空的"
        return "code", code, f"{len(code)} 字符（{src}）"
    if st.get("choiceCount", 0) > 0:
        # 等服务器保存的选项回显
        for _ in range(12):
            groups = page.ws.eval_json(r"""
JSON.stringify([...document.querySelectorAll('.option')].map(g => {
  const ins = [...g.querySelectorAll('input')];
  const checked = [];
  ins.forEach((inp, i) => { if (inp.checked) checked.push(String.fromCharCode(65 + i)); });
  return checked;
}))
""")
            if groups and any(groups):
                return "choice", groups, json.dumps(groups, ensure_ascii=False)
            time.sleep(0.5)
        return None, None, "没有已保存的选项"
    return None, None, "未知题型"


def answer_to_toml(kind: str, value) -> str:
    """把采集到的答案转成 TOML 里的 answer 行（多文件则是 files 子块）。"""
    if kind == "files":
        blocks = []
        for path, code in value:
            text = str(code).strip("\n")
            if "'''" in text:
                raise RuntimeError(
                    f"文件 {path} 的代码里含有三个单引号，无法用字面量字符串写入，请手动粘贴")
            blocks.append(
                "[[chapters.levels.files]]\n"
                f"path = {json.dumps(path, ensure_ascii=False)}\n"
                "answer = '''\n" + text + "\n'''"
            )
        return "\n".join(blocks)
    if kind == "choice":
        return "answer = " + json.dumps(value, ensure_ascii=False)
    text = str(value).strip("\n")
    if "'''" in text:
        raise RuntimeError("代码里含有三个单引号，无法用字面量字符串写入，请手动粘贴")
    return "answer = '''\n" + text + "\n'''"


def write_back_answers(path: Path, changes: dict[str, dict[int, str]], force: bool) -> None:
    """把采集结果写回答案档案：按章节块、按关卡顺序精确替换 answer。

    · 默认只填空答案，已有答案不动；force=True 才覆盖；
    · 只动对应关卡块的行，文件其它内容（注释、格式）原样保留；
    · 写入前用 tomllib 校验，失败则不动原文件。
    """
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)

    # 1) 扫描出行级结构：章节块 / 关卡块
    chapters: list[dict] = []
    cur_ch: dict | None = None
    cur_lv: dict | None = None

    def close_level(end: int) -> None:
        nonlocal cur_lv
        if cur_lv is not None:
            cur_lv["end"] = end
            if cur_ch is not None:
                cur_ch["levels"].append(cur_lv)
            cur_lv = None

    def close_chapter(end: int) -> None:
        nonlocal cur_ch
        close_level(end)
        if cur_ch is not None:
            cur_ch["end"] = end
            chapters.append(cur_ch)
            cur_ch = None

    for i, line in enumerate(lines):
        s = line.strip()
        if s == "[[chapters]]":
            close_chapter(i)
            cur_ch = {"start": i, "levels": [], "name": None}
        elif s == "[[chapters.levels]]":
            close_level(i)
            cur_lv = {"start": i, "name": None}
        else:
            m = re.match(r"\s*name\s*=\s*(.*)", line)
            if m:
                try:
                    nm = json.loads(m.group(1))
                except Exception:
                    nm = None
                if nm is not None:
                    if cur_lv is not None and cur_lv["name"] is None:
                        cur_lv["name"] = nm
                    elif cur_ch is not None and cur_ch["name"] is None:
                        cur_ch["name"] = nm
    close_chapter(len(lines))

    # 2) 收集要替换的编辑（从后往前改，避免行号漂移）
    edits = []   # (level_start, level_end, new_block_lines, name)
    for ch in chapters:
        want = changes.get(ch.get("name") or "")
        if not want:
            continue
        for idx, ans in sorted(want.items(), reverse=True):
            if not (1 <= idx <= len(ch["levels"])):
                log(f"  ! 章节「{ch.get('name')}」没有第 {idx} 关，跳过")
                continue
            level = ch["levels"][idx - 1]
            lstart, lend = level["start"], level["end"]
            block = "".join(lines[lstart:lend])
            try:
                parsed = tomllib.loads('[[chapters]]\nname = "x"\n' + block)
                existing = parsed["chapters"][0]["levels"][0].get("answer", "")
            except tomllib.TOMLDecodeError:
                existing = ""
            is_empty = not str(existing).strip()
            if not is_empty and not force:
                log(f"  ! 「{level['name']}」已有答案，未覆盖（--force 可强制覆盖）")
                continue
            # 重建块：header + name + [skip] + answer
            name_line = None
            has_skip = False
            for k in range(lstart + 1, lend):
                s = lines[k].strip()
                if s.startswith("skip"):
                    has_skip = True
                if s.startswith("name =") and name_line is None:
                    name_line = k
            new_block = ["[[chapters.levels]]\n"]
            if name_line is not None:
                new_block.append(lines[name_line])
            if has_skip:
                new_block.append("skip = true\n")
            new_block.append(ans if ans.endswith("\n") else ans + "\n")
            new_block.append("\n")
            edits.append((lstart, lend, new_block, level["name"]))

    if not edits:
        return
    # 3) 从后往前替换
    for lstart, lend, new_block, name in sorted(edits, key=lambda e: e[0], reverse=True):
        lines[lstart:lend] = new_block
        log(f"  ✓ 已写回：「{name}」")

    new_text = "".join(lines)
    new_text = sort_chapter_blocks(new_text)      # 章节按顺序排好
    try:
        tomllib.loads(new_text)
    except tomllib.TOMLDecodeError as e:
        die(f"写回答案时 TOML 校验失败，未改动原文件：{e}")
    path.write_text(new_text, encoding="utf-8")


def cmd_harvest(args, cfg: dict) -> None:
    answers_path = Path(cfg["run"]["answers"])
    browser = ensure_browser(cfg)
    classroom = classroom_page(browser, cfg)
    ensure_login(classroom.ws)

    # 显式指定的章节如果还不在档案里，先自动扫描一遍骨架，省得两步操作
    if args.chapter:
        names = [c.name for c in load_answers(answers_path)]
        missing = [n for n in args.chapter
                   if not any(n in nm or nm in n for nm in names)]
        if missing:
            log("→ 以下章节不在档案里，先自动扫描骨架：")
            for n in missing:
                log(f"    · {n}")
            scanned, classroom = scan_chapters(browser, classroom, cfg, missing)
            write_scan_skeleton(answers_path, scanned)

    chapters = load_answers(answers_path)
    todo = [c for c in chapters
            if not args.chapter or any(x in c.name for x in args.chapter)]
    if not todo:
        die("答案档案里找不到指定章节。")

    all_changes: dict[str, dict[int, str]] = {}
    for ch in todo:
        if not ch.homework_id:
            die(f"章节「{ch.name}」缺少 homework_id，请先 scan。")
        log(f"\n→ 采集章节：{ch.name}")
        classroom = classroom_page(browser, cfg, old=classroom)
        prog = classroom.ws.eval_json(card_progress_js(ch.name)) or {}
        rows = scrape_status(browser, classroom,
                             cfg["edge"]["classroom"] + f"/{ch.homework_id}/detail?tabs=1",
                             expect=prog.get("total"))
        passed = {i for i, r in enumerate(rows, 1) if is_passed_row(r)}
        if not passed:
            log("  → 没有已满分的关卡，跳过")
            continue
        log(f"  已满分关卡：{sorted(passed)}")
        classroom = classroom_page(browser, cfg, old=classroom)
        target, ws = enter_chapter(browser, classroom, ch.name)
        page = Page(ws, target)
        # 全部满分的章节点「开始学习」会落到详情页，需要再点「查看实战/继续挑战/进入实训」进关卡
        if "/detail" in target["url"]:
            page.ws.wait_for(
                "['查看实战','继续挑战','进入实训'].some(t => "
                "[...document.querySelectorAll('button,a')].some(e => "
                "(e.innerText||'').trim() === t && e.getBoundingClientRect().width > 0))",
                timeout=45,
            )
            before = {p["id"] for p in browser.pages()}
            entered = False
            for label in ("查看实战", "继续挑战", "进入实训"):
                pos = page.ws.eval_json(
                    "JSON.stringify((function(){"
                    "const el=[...document.querySelectorAll('button,a')]"
                    f".find(e=>(e.innerText||'').trim()==={json.dumps(label)});"
                    "if(!el) return null;"
                    "const r=el.getBoundingClientRect();"
                    "if(!(r.width>0&&r.height>0)) return null;"
                    "return {x:r.x+r.width/2,y:r.y+r.height/2};})())"
                )
                if not pos:
                    continue
                page.ws.mouse_click(pos["x"], pos["y"])
                for _ in range(30):
                    time.sleep(0.4)
                    newtab = next((p for p in browser.pages()
                                   if p["id"] not in before and "/tasks/" in p.get("url", "")), None)
                    if newtab:
                        browser.close_target(target["id"])
                        target, ws = newtab, browser.attach(newtab)
                        page = Page(ws, target)
                        entered = True
                        break
                if entered:
                    break
            if not entered:
                browser.close_target(target["id"])
                log("  ! 详情页上没找到进入关卡的按钮，跳过本章")
                continue
        collected: dict[int, str] = {}
        try:
            st = rewind_to_first(page)
            guard = 0
            while guard < 50:
                guard += 1
                idx = st.get("index")
                if not idx:
                    log("  ! 页面状态读取失败，停止采集本章")
                    break
                if idx in passed:
                    kind, value, note = read_saved_answer(page, st)
                    if kind:
                        try:
                            collected[idx] = answer_to_toml(kind, value)
                            log(f"  ✓ 第{idx}关「{st.get('name')}」：{note}")
                        except RuntimeError as e:
                            log(f"  ! 第{idx}关采集失败：{e}")
                    else:
                        log(f"  ! 第{idx}关没采到答案：{note}")
                if not st.get("hasNext"):
                    break
                st = advance_level(page, idx)
        finally:
            browser.close_target(target["id"])
        all_changes[ch.name] = collected

    total = {n: len(v) for n, v in all_changes.items() if v}
    if total:
        write_back_answers(Path(cfg["run"]["answers"]), all_changes, force=args.force)
        log("\n✓ 已写回答案档案：" + "、".join(f"{n} {c} 关" for n, c in total.items()))
    else:
        log("\n没有采集到可写回的答案。")


# ─────────────────────────── 子命令：run ───────────────────────────

def process_chapter(browser: cdp.Browser, classroom: Page, cfg: dict,
                    ch: Chapter, status: list[dict]) -> dict:
    """跑完一章。返回统计 {done, skipped, failed}。

    注意：正常结束才关掉本章标签页；中途失败（die）保留页面给用户排查。
    """
    stats = {"done": 0, "skipped": 0, "failed": 0}
    target, ws = enter_chapter(browser, classroom, ch.name)
    page = Page(ws)
    ok = False
    try:
        st = rewind_to_first(page)
        if not st.get("index"):
            die(f"章节「{ch.name}」进入后未能读到关卡信息。")
        log(f"  从第{st.get('index')}关开始：{st.get('name')}")
        guard = 0
        while guard < 50:
            guard += 1
            t_level = time.time()
            cur = st.get("index") or None
            st = page.wait_level(want_index=cur, timeout=30)
            idx, lname = st.get("index"), st.get("name")
            if not idx:
                die(f"章节「{ch.name}」页面状态读取失败。")
            lv = find_level(ch, idx, lname)
            row = row_at(status, idx, lname)
            row_status = (row or {}).get("status", "")
            if lv is None:
                stats["failed"] += 1
                die(f"第{idx}关「{lname}」不在答案档案里。请先 scan 补全档案。")
            need_skip = lv.skip or is_passed_row(row)
            log(f"  第{idx}关 {lname}："
                f"{'跳过（' + (row_status or '档案标记') + '）' if need_skip else '作答'}")
            if need_skip:
                stats["skipped"] += 1
                if not st.get("hasNext"):
                    log("  → 已是最后一关，本章结束")
                    break
                st = advance_level(page, idx)
                if st.get("index") == idx:
                    die(f"第{idx}关跳过时无法跳到下一关，已暂停。")
                continue

            # 作答
            if st.get("hasEditor"):
                paths, _ = list_code_files(page)
                if len(paths) > 1:
                    log(f"    检测到 {len(paths)} 个代码文件：" + "、".join(paths))
                    if not lv.files:
                        close_file_menu(page)
                        snippet = "\n".join(
                            "    [[chapters.levels.files]]\n"
                            f"    path = {json.dumps(p, ensure_ascii=False)}\n"
                            "    answer = '''…'''"
                            for p in paths)
                        stats["failed"] += 1
                        die(f"第{idx}关「{lname}」有多个代码文件，档案里还没有对应的 files 条目。\n"
                            f"  可运行 harvest 采集（已满分时），或参照下面的格式补全：\n{snippet}\n"
                            f"  档案：{cfg['run']['answers']}")
                    missing = [f.get("path") for f in lv.files
                               if not str(f.get("answer") or "").strip()]
                    if missing:
                        close_file_menu(page)
                        stats["failed"] += 1
                        die(f"第{idx}关「{lname}」还有代码文件没填答案："
                            + "、".join(missing) + f"\n  请填写：{cfg['run']['answers']}")
                    try:
                        write_files(page, paths, lv.files)
                    except RuntimeError as e:
                        stats["failed"] += 1
                        die(f"第{idx}关「{lname}」写入代码失败，已暂停：{e}")
                else:
                    close_file_menu(page)
                    code = str(lv.answer or "")
                    if not code.strip() and len(lv.files) == 1:
                        code = str(lv.files[0].get("answer") or "")
                    if not code.strip():
                        stats["failed"] += 1
                        die(f"第{idx}关「{lname}」的 answer 是空的，已暂停。\n"
                            f"  请填写：{cfg['run']['answers']}")
                    try:
                        set_code(page, code)
                    except RuntimeError as e:
                        stats["failed"] += 1
                        die(f"第{idx}关「{lname}」写入代码失败，已暂停：{e}")
            elif st.get("choiceCount", 0) > 0:
                if lv.answer_empty():
                    stats["failed"] += 1
                    die(f"第{idx}关「{lname}」的 answer 是空的，已暂停。\n"
                        f"  请填写：{cfg['run']['answers']}")
                try:
                    answer_choice(page, choice_letters(lv.answer))
                except RuntimeError as e:
                    stats["failed"] += 1
                    die(f"第{idx}关「{lname}」选项勾选失败，已暂停：{e}")
            else:
                stats["failed"] += 1
                die(f"第{idx}关「{lname}」既没有编辑器也没有选择题，无法作答，已暂停。")

            fail0 = st.get("failMsgs", 0)
            ctx = {"index0": idx, "url0": st.get("url"), "fail0": fail0,
                   "is_last": not st.get("hasNext")}
            log("    点「评测」…")
            page.click_eval()
            outcome = wait_outcome(page, ctx, float(cfg["run"]["eval_timeout"]))
            log(f"    结果：{outcome['kind']}（{outcome['detail']}）")
            if outcome["kind"] == "fail":
                stats["failed"] += 1
                die(f"第{idx}关「{lname}」评测未通过，已暂停。\n"
                    f"  请查看浏览器里的错误详情，或修改答案档案后重新运行。")
            if outcome["kind"] == "timeout":
                stats["failed"] += 1
                die(f"第{idx}关「{lname}」等待评测结果超时，已暂停。")
            stats["done"] += 1
            if outcome["kind"] == "last":
                log("  → 本章最后一关已通过，本章结束"
                    f"（本关用时 {time.time() - t_level:.1f} 秒）")
                break
            # next：等待进入下一关
            nxt = wait_index_change(page, idx, timeout=float(cfg["run"]["level_timeout"]))
            if nxt.get("index") == idx:
                log("  ! 评测通过但页面没有跳到下一关，尝试点工具栏「下一关」…")
                nxt = advance_level(page, idx)
            if nxt.get("index") == idx:
                die(f"第{idx}关评测已通过，但页面无法进入下一关，已暂停。")
            st = nxt
            log(f"    （本关用时 {time.time() - t_level:.1f} 秒）")
        ok = True
        return stats
    finally:
        if ok:
            browser.close_target(target["id"])


def cmd_run(args, cfg: dict) -> None:
    chapters = load_answers(Path(cfg["run"]["answers"]))
    todo = [c for c in chapters
            if not args.chapter or any(x in c.name for x in args.chapter)]
    if not todo:
        die("答案档案里找不到指定章节。")

    t0 = time.time()

    # 计划预览（原 check 命令并入：先看每关答案状态，再决定是否开跑）
    log("\n将按档案顺序处理：")
    print_archive_status(todo)
    if not args.yes:
        input("\n回车开始（Ctrl+C 取消）…")

    browser = ensure_browser(cfg)
    classroom = classroom_page(browser, cfg)
    ensure_login(classroom.ws)

    results = {}
    status_page = classroom     # 复用登录用的课堂页做状态检查标签，全程不重复开
    for ch in todo:
        log(f"\n══ 章节：{ch.name} ══")
        if not ch.homework_id:
            die(f"章节「{ch.name}」缺少 homework_id，请先 scan。")
        log("  → 检查平台状态…")
        rows = scrape_status(browser, status_page,
                             cfg["edge"]["classroom"] + f"/{ch.homework_id}/detail?tabs=1")
        to_run = [lv for i, lv in enumerate(ch.levels, 1)
                  if not lv.skip and not is_passed_row(row_at(rows, i, lv.name))]
        if not to_run:
            log("  → 本章所有关卡都已通过或在档案里标了 skip，跳过")
            results[ch.name] = {"done": 0, "skipped": len(ch.levels), "failed": 0}
            continue
        missing = [lv.name for lv in to_run if lv.answer_empty()]
        if missing:
            die(f"章节「{ch.name}」还有关卡没填答案：{'、'.join(missing)}\n"
                f"  请填写后重新运行：{cfg['run']['answers']}")
        # 只有真的要跑时，才开一个干净的课堂页去点「开始学习」
        entry_classroom = classroom_page(browser, cfg)
        t_ch = time.time()
        try:
            results[ch.name] = process_chapter(browser, entry_classroom, cfg, ch, rows)
            results[ch.name]["secs"] = time.time() - t_ch
        finally:
            if entry_classroom.target.get("id"):
                browser.close_target(entry_classroom.target["id"])

    log("\n══════ 汇总 ══════")
    for name, s in results.items():
        extra = f"（用时 {fmt_secs(s['secs'])}）" if s.get("secs") else ""
        log(f"  {name}：作答 {s['done']} 关，跳过 {s['skipped']} 关，失败 {s['failed']} 关{extra}")
    log(f"\n完成（总用时 {fmt_secs(time.time() - t0)}）。浏览器保持打开，可自行检查。")


def print_archive_status(chapters: list) -> None:
    """打印每章的关卡与答案状态（run 开跑前预览用；原 check 命令并入）。"""
    for ch in chapters:
        log(f"\n【{ch.name}】homework_id={ch.homework_id or '(缺)'}")
        for i, lv in enumerate(ch.levels, 1):
            kind = lv.type or "auto"
            if lv.skip:
                desc = "skip"
            elif lv.files:
                parts = [f"{f.get('path', '?').rsplit('/', 1)[-1]}"
                         f"{'✓' if str(f.get('answer') or '').strip() else ' 缺'}"
                         for f in lv.files]
                desc = f"{len(lv.files)} 个文件（{'，'.join(parts)}）"
            elif lv.answer_empty():
                desc = "缺答案"
            elif isinstance(lv.answer, list):
                desc = f"答案 {lv.answer}"
            else:
                text = str(lv.answer)
                desc = f"答案 {len(text)} 字符" if kind != "choice" and "\n" in text \
                    else f"答案 {text[:30]}"
            log(f"  {i:>2}. {lv.name:<32} [{kind:<4}] {desc}")


# ─────────────────────────── CLI ───────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="头歌自动答题脚本（半自动）",
        epilog="示例：python3 答题.py run -y 五 七 ｜ harvest 五 -f ｜ scan -a",
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
    p_scan = sub.add_parser("scan", help="扫描章节生成答案档案骨架")
    add_chapter_args(p_scan)
    p_scan.add_argument("-a", "--all", action="store_true", help="扫描所有“开始学习”的章节")
    p_harvest = sub.add_parser("harvest", help="采集已满分关卡在服务器上保存的答案，写回档案")
    add_chapter_args(p_harvest)
    p_harvest.add_argument("-f", "--force", action="store_true", help="覆盖档案里已有答案")
    p_run = sub.add_parser("run", help="按答案档案自动答题（开跑前会列出每关答案状态）")
    add_chapter_args(p_run)
    p_run.add_argument("-y", "--yes", action="store_true", help="不询问直接开始")

    args = ap.parse_args()
    if hasattr(args, "chapters"):
        args.chapter = list(args.chapters) + list(args.chapter_opt)   # 位置参数 + 旧写法合并
    cfg = load_config(Path(args.config).expanduser())
    apply_current_profile(cfg)      # 记住的档案槽优先于 config 里的 profile

    if args.cmd == "browser":
        if args.slot and not SLOT_RE.fullmatch(args.slot):
            die("槽位参数只支持：1-99（记住对应档案）、new（每次全新）、1new～99new（清除该槽记忆换全新）")
        slot, profile, note = setup_slot(cfg, args.slot)
        if note:
            log(f"→ 档案槽『{slot}』：{note}")
        cfg["edge"]["profile"] = profile
        browser = ensure_browser(cfg)
        classroom = classroom_page(browser, cfg)
        ensure_login(classroom.ws)
        log(f"✓ 副本浏览器就绪，已记住档案槽「{slot}」，之后 scan/run 都会用它。")
    elif args.cmd == "scan":
        cmd_scan(args, cfg)
    elif args.cmd == "harvest":
        cmd_harvest(args, cfg)
    elif args.cmd == "run":
        cmd_run(args, cfg)


if __name__ == "__main__":
    main()
