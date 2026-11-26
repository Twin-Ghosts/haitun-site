# 开发测试区（public/dev/）—— 使用与隔离约定

> 这个文件在**仓库根目录**，不在 `public/` 里，所以**不会**被发布到线上。
> 线上只发布 `public/`（Direct Upload，只上传一个目录）。

## 1. 这是什么

站点里的一块「测试中」区域，用来放**开发中的**小游戏。

| | |
|---|---|
| 本地目录 | `public/dev/` |
| 线上地址 | `https://cryv.pages.dev/dev/` （主地址；`https://cryv.tz.kg/dev/` 同内容） |
| 入口页 | `public/dev/index.html` |
| 模板 | `public/dev/starter/index.html` |
| 主站列表 | `public/index.html` —— **开发测试区相关改动一个字节都没动**（该文件仅因 2026-10-03「主地址切到 `cryv.pages.dev`」改过标题与 canonical 两行，见第 5 节） |
| 主地址 | `https://cryv.pages.dev/` —— 站内自称的地址（`<title>` 与 `<link rel="canonical">`）指向它 |

## 2. 目录约定

```
public/
├── index.html                 ← 主站列表（不动）
├── games/                     ← 已上线的游戏（不动）
│   ├── cubetilt/
│   └── guohechaiqiao/
├── tools/counter/
└── dev/                       ← 测试区：所有新东西只写在这里
    ├── index.html             ← 测试区入口（列测试中的游戏）
    ├── starter/index.html     ← 复制这个开新游戏
    ├── _room.js               ← 多人隐藏信息联机服务（RoomNet，多座位 + 每人私密视图）
    ├── werewolf/undercover/   ← 用 _room.js 的两款多人游戏（热座 + 房间码联机）
    └── 你的游戏名/            ← 复制 starter 后改名
        └── index.html
```

### 2.1 多人隐藏信息联机（`_room.js`）

`games/_net.js` 只服务 2 人轮流棋类（固定两席、状态全公开），狼人杀这类「多人 + 身份只给自己」
用不了。`dev/_room.js` 的 `RoomNet.create({ns, minPlayers, maxPlayers, adapter})` 要求页面提供
`initGame(players)` / `act(state, msg)` / `pubView(state)` / `privView(state, seat)` / `over(state)`：

- 房主持完整状态，`pub` 主题只发公开视图；每座位私密视图单独 retain 到 `p/<cid>`，加入者以自己的 cid 订阅。
- 掉线按 cid 最小者接管（`auth` 主题保留完整快照）。
- 注意 MQTT 3.1.1 的 SUBSCRIBE **不编码 topic 数量**（3.1 才编码），多编两个字节会让 broker 立刻断开连接。

## 3. 三条隔离规则（这就是「不影响主界面」的机制）

1. **只写 `public/dev/` 下面。** 主站的 `index.html`、`games/`、`tools/` 不参与开发改动 ——
   开发过程中主站文件的内容**逐字节不变**，所以主站功能不可能被开发中的东西弄坏。
2. **联机用独立主题前缀 `dev/你的游戏名/v1/`。** 主站游戏固定是 `cubetilt/v1/`（倾斜立方）
   与 `ghcq/v1/`（过河拆桥）。两边首段不同，MQTT 通配符订阅无法跨过去，
   测试房间的保留消息不会混进主站的房间主题，反之亦然。
3. **页面保留 `noindex, nofollow`。** 半成品不进搜索引擎。

**毕业流程**（测试通过后才做）：把 `public/dev/<slug>/` 移成 `public/games/<slug>/`，
主题前缀由 `dev/<slug>/v1/` 改成 `<slug>/v1/`，再往 `public/index.html` 的列表加一行。
这三步是唯一会碰主站的时刻，且都是可回退的。

## 4. 部署

Direct Upload：本地 `public/` 就是线上内容，没有 git 自动部署。

```bash
cd <仓库目录>

# 逐字节预检：本地与线上一致才继续（现为 9 条路径）
#   任一 IDENTICAL 不成立就先查清，否则部署会把线上改动回退掉

# 部署（整个 public/ 一次性上传，含主站 + 测试区）
npx wrangler pages deploy public --project-name cryv
```

**注意**：Pages 的 Direct Upload 是**整站原子替换**。部署测试区时会连主站一起重新发布 ——
所以第 5 节的预检与复验不是可选项。要让测试区与主站彻底互不牵连，
可以另开一个 Pages 项目专门放 dev（免费计划允许），代价是有两个地址、两条部署命令。

## 5. 验收 / 回归检查

改动后按顺序做：

1. **改前预检**：线上路径（现为 9 条）与本地 `public/` 逐字节一致。
2. **改后本地检查**：主站那 7 个文件的 sha256 与改前完全一样（表见下），新增路径 200。
3. **部署后复验**：老路径仍逐字节一致，`/dev/` 与 `/dev/starter/` 返回 200。

改前基线（2026-10-03，部署 `4e19314b` → `8d9f35b3`）：

| 文件 | sha256（前 16 位） |
|---|---|
| `public/index.html` | `a7ee09b33d7776a9`（2026-10-03 主地址切换后；切换前为 `bdd285704e681831`） |
| `public/games/cubetilt/index.html` | `c188d8c641cdc702` |
| `public/games/cubetilt/app.js` | `5e026aa606f921bc` |
| `public/games/cubetilt/engine.js` | `2ade5e659a9ba158` |
| `public/games/cubetilt/net.js` | `d73c5c6d8639abb0` |
| `public/games/guohechaiqiao/index.html` | `cc45645d1889c62c` |
| `public/tools/counter/index.html` | `abe8e8650f9538bc` |
| `public/dev/index.html` | `e3969f7175044b1d` |
| `public/dev/starter/index.html` | `5666f4537414846e` |

（主站以后正常更新时，这张表会过期 —— 它是**当次**回归的基线，不是永久期望值。）
**注意**：取 `https://<域名>/index.html` 会返回 308（Pages 把 `/x/index.html` 规范化到 `/x/`），
比对首页要用 `/` 而不是 `/index.html`，否则会误判成不一致。

## 6. 回滚

- **只回退回滚**：Cloudflare 控制台 → Pages → 项目 `cryv` → Deployments → 选中上一个部署 → Rollback。
  回滚锚点（新→旧）：
  - `1bce50d8` —— 2026-10-03 18:5x 主地址切到 `cryv.pages.dev`（首页标题 + canonical）
  - `8d9f35b3` —— 2026-10-03 建测试区（主站逐字节未动）
  - `4e19314b` —— 2026-10-03 更早的生产部署

  要**只撤主地址切换**：`git revert` 首页那两行（或把 `public/index.html` 的标题改回 `cryv.tz.kg`、
  删掉 canonical 行）再部署一次，回滚锚点 `1bce50d8` 之前的 `8d9f35b3` 也仍然可整站回退。
- **只删测试区**：删掉本地 `public/dev/` 整个目录 → 重新部署一次，`/dev/*` 就没了（返回 404）。
  主站文件从未改变，所以这一路上主站一直是好的。
- **注意**：回滚是**整站**回退，不是按文件。`1bce50d8` 的 diff 只动了一行标题 + 加了一行 canonical，
  所以"回到 `8d9f35b3`"与"只撤那两行"效果相同；一旦主站另有更新，这个等价关系就不再成立。

## 7. 边界 / 反例（别把这两件事搞混）

- **「不影响主界面功能」≠「不影响主站部署」**。按第 3 节写的只动 `dev/`，主站文件就逐字节不变；
  但 Direct Upload 每次都是整站发布，所以**部署动作本身**仍然扫过主站。降低风险靠第 5 节的预检
  （本地与线上不一致就不部署），不是靠"我这次只改了两个文件"。
- **测试区不是私密区域**。它是公开 URL，`noindex` 只是不被收录，不是访问控制。
  想真正挡住，要在 Cloudflare 侧加 Access 策略 —— 但那会让访问者需要登录，不适合"随手看一眼"。
- **公共中继上的保留消息是跨会话留存的**。测试期中继时留下的房间快照会继续躺在 broker 上，
  和主站一样。主题前缀分开只保证**不串房间**，不保证**不留痕**。
- **`cryv.pages.dev` 与 `cryv.tz.kg` 是同一份部署的两个地址**，不是两个站点：改内容两边同时变，
  没有"只改主地址"这回事。所以「主地址切到 pages.dev」只能靠**站内自称**（标题、canonical）
  与**你对外发哪个链接**来表达 —— 域名层没有任何开关。
- **`cryv.tz.kg` 上没有自动跳转到 `cryv.pages.dev`**：Pages 的 `_redirects` 不支持按 host 匹配，
  能做到的只有 Pages Functions（`functions/_middleware.js` 里判 hostname 后 302）——
  而 Functions 会让**全部请求**都进 Worker 记账（免费额度 10 万次/天），
  等于放弃"纯静态、请求不计费"这个性质。要哪一边，是一个明确的取舍。
- **游戏内的"分享链接"跟着当前域名走**（代码里是 `location.origin + location.pathname`），
  所以在 `cryv.tz.kg` 打开页面复制出来的房间链接就是 tz.kg 的。这不是 bug，
  但意味着**只要两个域名都活着，链接就会两种都流传出去**。
  （`public/tools/counter/index.html` 也只是把 `location.host` 显示在页面上，同理。）
