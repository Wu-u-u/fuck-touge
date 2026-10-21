"""副本浏览器启动、连接与登录管理（v0.9.13 从答题.py 抽出）。"""

from __future__ import annotations

import os
import subprocess
import time

import cdp
from eduauto import backend
from eduauto.backend import BrowserLike, PageSessionLike
from eduauto.page import Page
from eduauto.util import die, log
from eduauto.config import load_state, remember_name, update_state


def backend_name() -> str:
    """当前浏览器后端：默认 ``cdp``，只有显式 ``EDUAUTO_BACKEND=playwright`` 才切换。"""
    return backend.backend_name()


def playwright_backend() -> bool:
    return backend.is_playwright()


def warn_unknown_backend() -> None:
    """未知后端名回退 cdp，并明确提示，避免拼写错误被静默忽略。"""
    name = backend.unknown_backend()
    if name:
        log(f"  ! 未知的 EDUAUTO_BACKEND={name!r}，已回退到默认 cdp"
            "（可选：cdp / playwright）")


def port_alive(port: int) -> bool:
    try:
        cdp.http_json("/json/version", port, timeout=2)
        return True
    except Exception:
        return False


def stop_browser(port: int, timeout: float = 25) -> bool:
    """请当前浏览器退出并等待端口释放。

    Playwright 后端接管的是用户共享的 Edge，绝不能通过 ``Browser.close``
    误杀它；这里直接跳过关闭并返回 False（端口仍在）。
    """
    if playwright_backend():
        log("  ! Playwright 模式不会关闭共享 Edge（已跳过关闭请求）；"
            "如需切换档案请手动退出 Edge 后重试。")
        return False
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


def playwright_port_hint(port: int) -> str:
    """Playwright 模式连不上调试端口时的统一提示（测试与文档共用措辞）。"""
    return (
        f"Playwright 模式需要 Edge 已经启动并开放调试端口 {port}，当前连不上。\n"
        "  · 不会自动启动浏览器，也不会关闭共享 Edge；\n"
        "  · 不自动切换档案槽（复用当前运行的 Edge）；\n"
        "  · 不管理扩展（沿用浏览器里已加载的扩展）。\n"
        "  请先用 cdp 模式启动一次：EDUAUTO_BACKEND=cdp python3 答题.py browser\n"
        "  或手动带 --remote-debugging-port 启动 Edge。"
    )


def connect_configured(cfg: dict, attempts: int = 20) -> BrowserLike:
    """按 ``EDUAUTO_BACKEND`` 连接**已经在运行**的浏览器（不启动、不关闭）。

    默认走 ``connect_browser``（cdp）；Playwright 模式只接管已开放的调试
    Edge，要求 Edge 已启动，不切槽、不管理扩展。供 ``browser -ls`` 等
    只读入口使用。
    """
    warn_unknown_backend()
    if playwright_backend():
        from eduauto import pw_backend
        port = int(cfg["edge"]["port"])
        if not port_alive(port):
            die(playwright_port_hint(port))
        try:
            return pw_backend.connect_playwright(cfg)
        except cdp.CDPError as e:
            die(f"Playwright 后端连接失败：{e}")
    return connect_browser(int(cfg["edge"]["port"]), attempts=attempts)


def ensure_window_size(browser: BrowserLike, min_w: int = 1400, min_h: int = 900) -> None:
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


def _ensure_browser_playwright(cfg: dict) -> BrowserLike:
    """Playwright 模式：只接管已运行的 Edge，不启动、不关闭共享浏览器。"""
    from eduauto import pw_backend

    port = int(cfg["edge"]["port"])
    if not port_alive(port):
        die(playwright_port_hint(port))

    state = load_state()
    cur = state.get("current") or "1"
    running = state.get("running")
    running_profile = state.get("running_profile")
    cur_profile = os.path.expanduser(str(cfg["edge"]["profile"]))
    same_profile = bool(running_profile) and \
        os.path.expanduser(str(running_profile)) == cur_profile

    if running and running != cur:
        log(f"  ! Playwright 模式不切换档案槽：运行中的浏览器是「{running}」号，"
            f"当前槽是「{cur}」号；继续复用现有浏览器"
            "（如需切换请先手动退出 Edge，或用 cdp 模式运行 browser）。")
    elif running_profile and not same_profile:
        log("  ! Playwright 模式不关闭共享 Edge：运行中的档案与当前槽不一致，"
            "继续复用现有浏览器（如需切换请先手动退出 Edge）。")
    elif not running_profile:
        log("  · Playwright 模式不启动/不切换档案，直接复用调试端口上的现有 Edge。")
    else:
        log(f"  ✓ 复用已打开的浏览器（档案槽「{cur}」）")

    try:
        browser = pw_backend.connect_playwright(cfg)
    except cdp.CDPError as e:
        die(f"Playwright 后端连接失败：{e}")

    # 只有确认「运行中就是当前槽」时才更新状态；槽位不一致时保留原记录，
    # 避免把实际在用的档案误写成目标槽，影响后续 cdp 模式的判断。
    if not running and not running_profile:
        update_state(running=cur, running_profile=cur_profile)
    elif running == cur and same_profile:
        update_state(running=cur, running_profile=cur_profile)

    ensure_window_size(browser)
    try:
        ext = browser.ensure_extension(cfg["edge"]["extension"])
        if ext:
            log(f"  ✓ Fuck头歌 已加载（v{ext.get('version', '?')}）")
    except RuntimeError as e:
        log(f"  ! {e}（继续运行，脚本会自行兜底跳关）")
    return browser


def ensure_browser(cfg: dict) -> BrowserLike:
    """按 ``EDUAUTO_BACKEND`` 准备浏览器；默认 cdp，不设置环境变量行为不变。

    · ``cdp``（默认）：可自动启动/关闭/切换副本浏览器，并自动加载扩展；
    · ``playwright``（显式设置才生效）：只接管已在调试端口上运行的 Edge，
      不自动启动、不关闭共享 Edge、不自动切换档案槽、不管理扩展。
    """
    warn_unknown_backend()
    if playwright_backend():
        return _ensure_browser_playwright(cfg)
    port = int(cfg["edge"]["port"])
    state = load_state()
    cur = state.get("current") or "1"
    need_launch = False
    if port_alive(port):
        running = state.get("running")
        running_profile = state.get("running_profile")
        cur_profile = os.path.expanduser(str(cfg["edge"]["profile"]))
        same_profile = bool(running_profile) and \
            os.path.expanduser(str(running_profile)) == cur_profile
        if running and running != cur:
            log(f"→ 当前浏览器是「{running}」号档案，要切换到「{cur}」号，先关掉它…")
            if not stop_browser(port):
                die("旧的副本浏览器关不掉，请手动关闭那个 Edge 窗口后重试。")
            time.sleep(1)
            need_launch = True
        elif not same_profile:
            log(f"→ 运行中的浏览器档案与当前槽「{cur}」不一致，先关掉重开…")
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
    update_state(running=cur,
                 running_profile=os.path.expanduser(str(cfg["edge"]["profile"])))
    browser = connect_browser(port)
    ensure_window_size(browser)
    try:
        ext = browser.ensure_extension(cfg["edge"]["extension"])
        if ext:
            log(f"  ✓ Fuck头歌 已加载（v{ext.get('version', '?')}）")
    except RuntimeError as e:
        log(f"  ! {e}（继续运行，脚本会自行兜底跳关）")
    return browser


def classroom_page(browser: BrowserLike, cfg: dict, old: "Page | None" = None,
                   url: str | None = None) -> "Page":
    """开一个全新的课堂/课程标签页；old 传入则顺手关掉旧页。

    url 为空时使用课程列表页；课程页/详情页由调用方传入自己的 URL。
    实测：课堂页被导航去详情页再返回后，React 交互可能失效（点击无反应），
    所以每章都从干净的新标签页开始最稳。
    """
    if old and old.target.get("id"):
        browser.close_target(old.target["id"])
    url = url or cfg["edge"]["courses"]
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


def account_name_js() -> str:
    """读出当前页面里的登录账号名（任务页/用户页两种来源），找不到返回空串。"""
    return (
        "(function(){"
        "try{const v=JSON.parse(localStorage.getItem('userInfo')||'null');"
        "if(v){const m=((v.real_name||v.username)||'').trim(); if(m) return m;}}catch(e){}"
        "const ui=document.querySelector('.task-user-info');"
        "if(ui){for(const s of ((ui.innerText||'').split('\\n'))){"
        "const m=s.trim().replace(/\\s*\\d+\\s*$/,'').trim();"
        "if(m && !/^\\d+$/.test(m)) return m;}}"
        "const BAD=/个人主页|职业认证|实名认证|经验值|我的|课堂|课程|认证|首页|作业|考试|实验|竞赛|设置|消息|退出|登录|注册|学习|报告|管理|中心|帮助/;"
        "const el=[...document.querySelectorAll('*')].find(e=>{const t=(e.innerText||'').trim();"
        "return t.includes('个人主页') && t.length<=40;});"
        "if(el){let n=el;"
        "for(let u=0;u<3 && n;u++){"
        "n=n.parentElement; if(!n) break;"
        "const ls=(n.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean);"
        "const i=ls.findIndex(x=>x.includes('个人主页'));"
        "if(i<0) continue;"
        "for(let k=i+1;k<ls.length;k++){const s=ls[k];"
        "if(s && s.length<=12 && !BAD.test(s) && /[\\u4e00-\\u9fa5]/.test(s)) return s;}}}"
        "return '';})()"
    )


def read_account_name(browser: BrowserLike) -> str:
    """遍历所有 educoder 标签，尽量读出当前登录账号名；找不到返回空串。"""
    try:
        targets = browser.pages()
    except cdp.CDPError:
        targets = []
    for t in targets:
        if "educoder.net" not in (t.get("url") or ""):
            continue
        w = None
        try:
            w = browser.attach(t)
            name = (w.eval(account_name_js()) or "").strip()
            if name:
                return name
        except cdp.CDPError:
            continue
        finally:
            if w is not None:
                try:
                    w.close()
                except Exception:
                    pass
    return ""


def ensure_login(browser: BrowserLike, ws: PageSessionLike, timeout: float = 600) -> None:
    """确认头歌已登录；未登录则提示用户在窗口里登录并等待。

    关键：登录常常发生在别的标签页，原课堂标签的 DOM 不会自己更新——
    所以每一轮都会遍历所有 educoder 标签找登录信号；长时间没找到时，
    如果原标签是课堂页且不在前台，会周期性刷新它。登录成功后顺手记录账号名。
    """
    def page_logged(w: PageSessionLike) -> bool:
        try:
            return bool(w.eval(
                "(function(){const t=(document.body&&document.body.innerText)||'';"
                "return !!(document.querySelector('.task-user-info')"
                "|| t.includes('退出课堂')"
                "|| (t.includes('个人主页') && t.includes('我的经验值')));})()"
            ))
        except cdp.CDPError:
            return False

    def any_logged() -> bool:
        if page_logged(ws):
            return True
        try:
            targets = browser.pages()
        except cdp.CDPError:
            targets = []
        for t in targets:
            if "educoder.net" not in (t.get("url") or ""):
                continue
            w = None
            try:
                w = browser.attach(t)
                if page_logged(w):
                    return True
            except cdp.CDPError:
                continue
            finally:
                if w is not None:
                    try:
                        w.close()
                    except Exception:
                        pass
        return False

    def success() -> None:
        name = read_account_name(browser)
        if name:
            remember_name(load_state().get("current"), name)
            log(f"  ✓ 已登录（账号：{name}）")
        else:
            log("  ✓ 已登录")

    if any_logged():
        success()
        return
    log("\n！检测到副本浏览器里还没有登录头歌。")
    log("   请在弹出的浏览器窗口里完成登录（扫码/账号密码均可），脚本会自动等待…")
    deadline = time.time() + timeout
    tick = 0
    while time.time() < deadline:
        time.sleep(3)
        tick += 1
        if any_logged():
            success()
            return
        # 每 9 秒：若原标签是课堂页且不在前台，刷新一次（避免 DOM 停在未登录状态）
        if tick % 3 == 0:
            try:
                if ws.eval(
                    "(function(){const h=location.href;"
                    "return (h.includes('shixun_homework')||h.includes('/classrooms/'))"
                    "&& document.visibilityState==='hidden';})()"
                ):
                    ws.eval("location.reload()")
            except cdp.CDPError:
                pass
    die("等待登录超时，请登录后重新运行。")
