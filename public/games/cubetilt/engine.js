/* =====================================================================
   倾斜立方 (Tilt Cube) —— 规则引擎
   —— 纯逻辑，不碰 DOM：既能被页面 <script> 加载，也能在 Node 里 require，
      所以规则可以先跑几千局随机仿真验证，再拿去渲染。

   规则（据需求整理，括号内是需求没写死、由本引擎判定的部分）：

   1. 场地 7×7×7 = 343 个小格。编号 1..343：编号 1..49 是「第 1 层」整面，
      自上而下逐层编号。中心格 = 第 4 层第 4 行第 4 列 = 172 号。
   2. N 名玩家各有体重 A_i 与生命值 B_i（默认 A_i = B_i = i）。初始全部站在 172 号。
   3. 每回合各玩家可移动到「距离 ≤ √3」的相邻格（即 3×3×3-1 = 26 邻域），
      也可以原地不动；所有玩家同时提交。
   4. 移动结束后算所有「活跃玩家」的重心（按体重 A 加权 —— 需求用的是「重心」二字，
      A 又是「体重」，故取质量加权；本文件留着 dirUnweighted 开关，需要时可切几何中心）。
   5. 重心不在几何中心 → 立方体朝重心方向整体倾斜，使重心朝下。
      此时「正下方」（沿重心方向投影最深）的玩家受伤：
        第 t 回合伤害 = ⌈t/2⌉  →  1,1,2,2,3,3,4,4,…
      并列最下方时，只有体重最小的那个受伤。
   6. 若重心恰好落在正中心 → 不倾斜，本轮无人受伤。
   7. （HP 降到 0 即出局。）最后存活的玩家获胜；（60 回合上限刹车，剩余 HP 最高者胜。）
   ===================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CubeEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SIDE = 7;
  const TOTAL = SIDE * SIDE * SIDE;                 // 343
  const CENTER = { x: 4, y: 4, z: 4 };              // 172 号格 = (4,4,4)
  const CENTER_N = 172;
  const MAX_ROUNDS = 60;
  const EPS = 1e-9;

  /* ---------------- 编号 <-> 坐标 ----------------
     层号 L = ⌊(n-1)/49⌋ + 1（1..7，1 = 最上面那一层）
     层内 k = (n-1) % 49（行优先：行 r = ⌊k/7⌋，列 c = k%7）
     y 轴朝上，故 y = 8 - L（L=1 在最上 → y=7） */
  function n2c(n) {
    n = Math.round(n);
    if (!(n >= 1 && n <= TOTAL)) return null;
    const L = Math.floor((n - 1) / 49) + 1;
    const k = (n - 1) % 49;
    return { x: (k % 7) + 1, y: 8 - L, z: Math.floor(k / 7) + 1 };
  }
  function c2n(x, y, z) {
    x = Math.round(x); y = Math.round(y); z = Math.round(z);
    if (x < 1 || x > SIDE || y < 1 || y > SIDE || z < 1 || z > SIDE) return null;
    return (7 - y) * 49 + (z - 1) * 7 + (x - 1) + 1;
  }
  const inBounds = c => c && c.x >= 1 && c.x <= SIDE && c.y >= 1 && c.y <= SIDE && c.z >= 1 && c.z <= SIDE;

  /* ---------------- 26 邻域（距离 ≤ √3） ---------------- */
  const DIRS = (() => {
    const out = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          if (dx || dy || dz) out.push([dx, dy, dz]);
    return out;                                      // 26 个方向
  })();
  function neighbors(n) {
    const c = n2c(n); if (!c) return [];
    const out = [];
    for (const [dx, dy, dz] of DIRS) {
      const t = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
      if (inBounds(t)) out.push(c2n(t.x, t.y, t.z));
    }
    return out;                                      // 角上 7 个、棱上 11、面上 17、内部 26
  }

  /* ---------------- 重心 / 倾斜 / 伤害 ---------------- */
  function damageFor(round) { return Math.ceil(round / 2); }   // 1,1,2,2,3,3,…

  /* 活跃玩家的加权重心（权重 = 体重 A）。dirUnweighted=true 时退化为几何平均，
     用于对比两种口径 —— 页面固定用加权那一种。 */
  function centroid(players, dirUnweighted) {
    let sx = 0, sy = 0, sz = 0, sw = 0;
    for (const p of players) {
      if (!p.alive) continue;
      const c = n2c(p.pos); if (!c) continue;
      const w = dirUnweighted ? 1 : Math.max(EPS, p.A);
      sx += c.x * w; sy += c.y * w; sz += c.z * w; sw += w;
    }
    if (sw <= 0) return null;
    return { x: sx / sw, y: sy / sw, z: sz / sw };
  }

  /* 重心相对几何中心的方向；模长≈0 表示重心压在正中心（不倾斜） */
  function tiltVector(players, dirUnweighted) {
    const g = centroid(players, dirUnweighted);
    if (!g) return { g: null, dir: { x: 0, y: 0, z: 0 }, len: 0 };
    const dir = { x: g.x - CENTER.x, y: g.y - CENTER.y, z: g.z - CENTER.z };
    return { g, dir, len: Math.hypot(dir.x, dir.y, dir.z) };
  }

  /* 沿重心方向投影最深的玩家们（通常 1 个，对称局面可能多个并列） */
  function lowestOf(players, dir) {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (len < EPS) return [];
    const ux = dir.x / len, uy = dir.y / len, uz = dir.z / len;
    const scored = [];
    for (const p of players) {
      if (!p.alive) continue;
      const c = n2c(p.pos); if (!c) continue;
      scored.push({ p, d: (c.x - CENTER.x) * ux + (c.y - CENTER.y) * uy + (c.z - CENTER.z) * uz });
    }
    if (!scored.length) return [];
    let best = -Infinity;
    for (const s of scored) if (s.d > best) best = s.d;
    return scored.filter(s => Math.abs(s.d - best) < EPS).map(s => s.p);
  }

  /* 让立方体「重心朝下」的旋转：把单位向量 d̂ 转到世界坐标的 -Y 方向。
     渲染层用它算姿态，动画层对轴角做插值。返回轴(单位)+角(弧度)。 */
  const DOWN = { x: 0, y: -1, z: 0 };
  function tiltAxisAngle(dir) {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (len < EPS) return null;                                  // 不倾斜
    const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    const dot = Math.max(-1, Math.min(1, d.x * DOWN.x + d.y * DOWN.y + d.z * DOWN.z));
    if (dot > 1 - 1e-12) return null;                            // 已经朝下
    if (dot < -1 + 1e-12) {                                      // 正好朝上：绕 X 轴翻 180°
      return { axis: { x: 1, y: 0, z: 0 }, angle: Math.PI };
    }
    let ax = d.y * DOWN.z - d.z * DOWN.y;
    let ay = d.z * DOWN.x - d.x * DOWN.z;
    let az = d.x * DOWN.y - d.y * DOWN.x;
    const al = Math.hypot(ax, ay, az);
    return { axis: { x: ax / al, y: ay / al, z: az / al }, angle: Math.acos(dot) };
  }

  /* ---------------- 对局 ---------------- */
  class CubeGame {
    /* specs: [{pid, name, A, B}] —— pid 从 1 开始 */
    constructor(specs) {
      this.players = new Map();
      (specs || []).forEach((s, i) => {
        const pid = s.pid || (i + 1);
        const A = Number.isFinite(+s.A) && +s.A > 0 ? +s.A : pid;
        const B = Number.isFinite(+s.B) && +s.B > 0 ? +s.B : pid;
        this.players.set(pid, {
          pid, seat: i, name: s.name || ("玩家" + pid),
          A, B, hp: B, alive: true, pos: CENTER_N
        });
      });
      this.round = 0;
      this.finished = false;
      this.winner = null;
      this.log = [];
      this.lastTilt = null;        // {g, dir, len, tied:[pid], hitPid, dmg, noHit}
      this.maxRounds = MAX_ROUNDS;
    }

    list() { return [...this.players.values()].sort((a, b) => a.seat - b.seat); }
    alive() { return this.list().filter(p => p.alive); }

    /* 移动合法性：只能是 26 邻域内的格子；越界/非法一律退回「原地不动」 */
    validate(pid, move) {
      const p = this.players.get(pid);
      if (!p || !p.alive) return null;
      const to = move && move.to;
      if (to === null || to === undefined || to === "" || Number.isNaN(+to)) return { to: p.pos };
      const t = Math.round(+to);
      return neighbors(p.pos).includes(t) ? { to: t } : { to: p.pos };
    }

    /* 结算一回合：moves = { pid: {to} }（缺省 = 不动） */
    resolve(moves) {
      const lines = [];
      if (this.finished) return lines;
      moves = moves || {};
      this.round++;
      const R = this.round;

      /* 1) 同时移动 */
      const movesTxt = [];
      for (const p of this.alive()) {
        const mv = this.validate(p.pid, moves[p.pid]);
        if (!mv) continue;
        if (mv.to !== p.pos) { p.pos = mv.to; movesTxt.push(`${p.name} → ${mv.to}`); }
        else movesTxt.push(`${p.name} 不动`);
      }
      lines.push(`第 ${R} 回合移动：${movesTxt.join("；")}。`);

      /* 2) 重心 → 倾斜 → 判定正下方 */
      const act = this.alive();
      const { g, dir, len } = tiltVector(act);
      const tilt = { g, dir, len, tied: [], hitPid: null, dmg: 0, noHit: false };
      this.lastTilt = tilt;

      if (len < EPS) {
        tilt.noHit = true;
        lines.push("活跃玩家的重心正好压在立方体中心 —— 立方体不倾斜，本轮无人被压。");
      } else {
        const tied = lowestOf(act, dir);
        tilt.tied = tied.map(p => p.pid);
        /* 并列最下方时，体重最小的那个挨压 */
        let hit = tied[0];
        for (const p of tied) if (p.A < hit.A) hit = p;
        const dmg = damageFor(R);
        const hp0 = hit.hp;
        hit.hp = Math.max(0, hit.hp - dmg);
        tilt.hitPid = hit.pid; tilt.dmg = dmg;
        const tieTxt = tied.length > 1
          ? `（有 ${tied.length} 人并列最下方：${tied.map(p => `${p.name}(体重${p.A})`).join("、")}，按规则只有体重最小的挨压）`
          : "";
        lines.push(`立方体朝重心方向倾斜到 ${fmt(g)} —— 正下方是 ${hit.name}（体重 ${hit.A}），`
          + `受到 ${dmg} 点伤害：HP ${hp0} → ${hit.hp}。${tieTxt}`);
        if (hp0 > 0 && hit.hp <= 0) {
          hit.alive = false;
          lines.push(`${hit.name} 被压碎，出局。`);
        }
      }

      /* 3) 胜负 */
      const left = this.alive();
      if (left.length <= 1) {
        this.finished = true;
        this.winner = left.length === 1 ? left[0].pid : null;
        lines.push(left.length === 1 ? `🏆 ${left[0].name} 是最后的幸存者，获胜！` : "全员出局。");
      } else if (R >= this.maxRounds) {
        const sorted = [...left].sort((a, b) => b.hp - a.hp || b.B - a.B || a.A - b.A);
        this.finished = true;
        this.winner = sorted[0].pid;
        lines.push(`达到 ${this.maxRounds} 回合上限，${sorted[0].name} 剩余 HP 最高（${sorted[0].hp}），获胜！`);
      }

      this.log = this.log.concat(lines);
      if (this.log.length > 200) this.log = this.log.slice(-200);
      return lines;
    }
  }

  const fmt = g => g ? `(${g.x.toFixed(2)}, ${g.y.toFixed(2)}, ${g.z.toFixed(2)})` : "(无)";

  /* 默认玩家表：A_i = B_i = i */
  function defaultSpecs(n) {
    const out = [];
    for (let i = 1; i <= n; i++) out.push({ pid: i, name: "玩家" + i, A: i, B: i });
    return out;
  }

  return {
    SIDE, TOTAL, CENTER, CENTER_N, MAX_ROUNDS, DIRS,
    n2c, c2n, inBounds, neighbors, damageFor,
    centroid, tiltVector, lowestOf, tiltAxisAngle,
    CubeGame, defaultSpecs
  };
});
