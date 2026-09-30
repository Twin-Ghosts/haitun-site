"""最小可用的 Render Web Service —— 只用 Python 标准库，零第三方依赖。

为什么刻意不用 FastAPI/Flask：
  1. 没有 pip 依赖 → 构建步骤不可能因为装包失败而挂掉，第一次部署必过；
  2. 本机任何 Python 都能直接跑起来验证。

Render 的硬性要求（照做即可）：
  * 必须监听 0.0.0.0，不能是 127.0.0.1 —— 否则 Render 探不到端口，部署会报 "no open ports detected"
  * 端口必须读环境变量 PORT（Render 默认注入 10000），不要写死

想要 FastAPI 就把本文件换掉，并在 render.yaml 里加一行
  buildCommand: pip install -r requirements.txt
"""

import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STARTED_AT = datetime.now(timezone.utc)


class Handler(BaseHTTPRequestHandler):
    server_version = "haitun-minimal/1.0"

    # ---- 路由表：路径 -> (状态码, content-type, 返回内容) ----
    def _routes(self):
        host = self.headers.get("Host", "unknown")
        return {
            "/": (
                200,
                "text/html; charset=utf-8",
                f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>API 已上线</title><style>
body{{font:16px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#0b1220;
color:#e6edf7;margin:0;padding:48px;}}
code{{background:#111c30;padding:2px 6px;border-radius:5px;color:#9fd0ff;}}
a{{color:#5ce1a0;}}</style></head><body>
<h1>✅ Web Service 已上线</h1>
<p>当前域名：<code>{host}</code></p>
<p>可用接口：</p>
<ul>
  <li><a href="/healthz">/healthz</a> — 健康检查，Render 用它判断服务是否活着</li>
  <li><a href="/api/time">/api/time</a> — 返回 JSON，验证这是动态后端而不是静态页</li>
</ul>
<p>⚠️ 免费实例 15 分钟没流量会休眠，下次访问要等约 1 分钟冷启动。域名不会失效。</p>
</body></html>""",
            ),
            "/healthz": (200, "application/json; charset=utf-8", '{"status":"ok"}'),
            "/api/time": (
                200,
                "application/json; charset=utf-8",
                json.dumps(
                    {
                        "now_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "uptime_seconds": int(
                            (datetime.now(timezone.utc) - STARTED_AT).total_seconds()
                        ),
                        "host": host,
                        "python": sys.version.split()[0],
                        "pid": os.getpid(),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            ),
        }

    def _respond(self):
        routes = self._routes()
        path = self.path.split("?")[0].rstrip("/") or "/"
        if path in routes:
            status, ctype, body = routes[path]
        else:
            status, ctype, body = 404, "application/json; charset=utf-8", '{"error":"not found"}'

        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _respond
    do_HEAD = _respond

    def log_message(self, fmt, *args):  # 让日志进 Render 的 Logs 面板，格式干净点
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


def main():
    port = int(os.environ.get("PORT", "10000"))
    host = "0.0.0.0"  # 必须；改成 127.0.0.1 会导致 Render 部署失败
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"listening on http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
