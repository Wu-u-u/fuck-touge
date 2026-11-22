#!/usr/bin/env python3
"""Fuck头歌 本地只读状态面板（标准库）。

启动：
    python3 webui.py --port 8765
打开 http://127.0.0.1:8765

只读 state.status.json，不启动/停止脚本，不接触头歌页面。
"""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_STATE = HERE / "state.status.json"

HTML = """<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<title>Fuck 头歌 · 脚本状态</title>
<style>
body{font:14px/1.6 system-ui,sans-serif;background:#17171c;color:#e6e6f0;margin:2rem}
.wrap{max-width:900px;margin:auto}h1{font-size:1.2rem;margin:0 0 1rem}
.card{padding:1.2rem 1.4rem;border:1px solid #3a3a48;border-radius:16px;background:#202029;margin-bottom:1rem}
#state{font-size:1.2rem;font-weight:600}.running{color:#9ee493}.waiting,.stopped{color:#f0d98c}.error{color:#ff9a9a}
#meta,#msg{color:#b8b8c8;margin-top:.4rem}#logs{white-space:pre-wrap;word-break:break-word;color:#c8c8d8;font:12px/1.5 ui-monospace,monospace}
.log{border-top:1px solid #30303b;padding:.35rem 0}.log:first-child{border-top:0}
</style>
<div class="wrap"><h1>Fuck 头歌 · 脚本状态</h1>
<div class="card"><div id="state">加载中…</div><div id="meta"></div><div id="msg"></div></div>
<div class="card"><div style="color:#b8b8c8;margin-bottom:.5rem">最近日志</div><div id="logs">暂无</div></div></div>
<script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function tick(){
 try{
  const r=await fetch('/status',{cache:'no-store'}); const d=await r.json();
  const st=d.state||'unknown'; const el=document.getElementById('state');
  el.textContent={running:'运行中',waiting:'等待中',stopped:'已停止',error:'脚本错误'}[st]||st;
  el.className=st;
  document.getElementById('meta').textContent=['槽位 '+(d.slot||'--'),d.course,d.chapter,d.level].filter(Boolean).join(' · ');
  document.getElementById('msg').textContent=d.message||'';
  const logs=Array.isArray(d.logs)?d.logs:[];
  document.getElementById('logs').innerHTML=logs.length?logs.map(x=>'<div class="log">['+esc(x.level||'info')+'] '+esc(x.text||'')+'</div>').join(''):'暂无';
 }catch(e){document.getElementById('state').textContent='无法读取状态：'+e}
}
tick(); setInterval(tick,1000);
</script></html>"""


def create_server(port: int = 8765, state_path: Path = DEFAULT_STATE) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?", 1)[0] == "/":
                body = HTML.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path.split("?", 1)[0] == "/status":
                try:
                    data = json.loads(state_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    data = {}
                body = json.dumps(data, ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_error(404)

        def log_message(self, *args):
            pass

    return ThreadingHTTPServer(("127.0.0.1", int(port)), Handler)


def main() -> None:
    ap = argparse.ArgumentParser(description="Fuck头歌 只读状态面板")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--state", default=str(DEFAULT_STATE))
    ap.add_argument("--check", action="store_true", help="只做导入/参数检查")
    args = ap.parse_args()
    if args.check:
        print("webui ok")
        return
    srv = create_server(args.port, Path(args.state).expanduser())
    print(f"状态面板：http://127.0.0.1:{args.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
