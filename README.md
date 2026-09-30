# deploy-me

一个「能被 Render 直接吃下去」的最小仓库：静态站 + 零依赖 Python 服务。

```
render.yaml          # Render Blueprint（根目录，必需）
public/index.html    # 静态站发布目录（改这个文件就是改网站内容）
server.py            # 最小 Web Service，只用标准库
.gitignore
```

## 本地验证

```bash
# 静态站：直接用浏览器打开 public/index.html
# 后端：
python server.py          # 然后访问 http://127.0.0.1:10000/
PORT=8080 python server.py  # 换端口
```

## 部署

见上层的 `DEPLOY-CHECKLIST.md`。一句话版：

1. 推到 GitHub
2. Render 控制台 → New → Blueprint → 选中本仓库 → Apply
3. 得到 `https://<name>.onrender.com`

## 改内容

改 `public/index.html` → `git commit && git push` → Render 自动重新部署（`autoDeploy: true`）。
