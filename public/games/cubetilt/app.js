/* =====================================================================
   倾斜立方 —— 渲染与界面
   —— Canvas 2D 手写 3D 投影（不加载任何外部库）：343 个格点 + 立方体外框 +
      玩家球体；立方体按「重心朝下」的姿态整体倾斜，并对姿态做平滑动画。
   ===================================================================== */
"use strict";

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const COLORS = ["#7c8cff", "#ff6b8a", "#ffd27a", "#35d07f", "#c39bff", "#54d5e8", "#ff9f4a", "#8de06a"];
const E = CubeEngine;
const CEN = 4;                              // 格中心 (4,4,4) 作为世界原点

/* ---------------- 3D 小工具 ---------------- */
const sub3 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm3 = a => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
function rotAxis(p, axis, th) {             // Rodrigues：绕单位轴转 th
  const ct = Math.cos(th), st = Math.sin(th), d = dot3(p, axis);
  const c = cross3(axis, p);
  return {
    x: p.x * ct + c.x * st + axis.x * d * (1 - ct),
    y: p.y * ct + c.y * st + axis.y * d * (1 - ct),
    z: p.z * ct + c.z * st + axis.z * d * (1 - ct)
  };
}
function cellWorld(n) {                     // 格编号 -> 以立方体中心为原点的世界坐标
  const c = E.n2c(n);
  return c ? { x: c.x - CEN, y: c.y - CEN, z: c.z - CEN } : null;
}

/* ---------------- 视图 / 姿态 ---------------- */
const view = { yaw: 0.70, pitch: 0.42, dist: 26 };
const anim = { axis: { x: 1, y: 0, z: 0 }, angle: 0 };

function camBasis() {
  const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const eye = { x: view.dist * cp * Math.cos(view.yaw), y: view.dist * sp, z: view.dist * cp * Math.sin(view.yaw) };
  const f = norm3({ x: -eye.x, y: -eye.y, z: -eye.z });
  let r = cross3(f, { x: 0, y: 1, z: 0 });
  if (Math.hypot(r.x, r.y, r.z) < 1e-6) r = { x: 1, y: 0, z: 0 };
  r = norm3(r);
  return { eye, f, r, u: cross3(r, f) };
}

let CW = 700, CH = 560, canvas = null, ctx = null, focal = 900;
function resize() {
  canvas = canvas || $("cv"); ctx = ctx || canvas.getContext("2d");
  const box = $("cvBox");
  const w = Math.max(300, box.clientWidth || 640);
  const h = Math.round(Math.min(640, Math.max(340, w * 0.80)));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  CW = w; CH = h; focal = Math.min(CW, CH) * 1.30;
  if (canvas.width === pw && canvas.height === ph) return;    // 尺寸没变就别动 canvas（动一次闪一下）
  canvas.width = pw; canvas.height = ph;
  canvas.style.height = CH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", () => { resize(); });

function proj(p, cam) {                     // world(含倾斜) -> 屏幕
  const v = sub3(p, cam.eye);
  const zc = dot3(v, cam.f);
  if (zc < 0.5) return null;
  return { x: CW / 2 + focal * dot3(v, cam.r) / zc, y: CH / 2 - focal * dot3(v, cam.u) / zc, z: zc, s: focal / zc };
}
const tiltPt = p => anim.angle < 1e-4 ? p : rotAxis(p, anim.axis, anim.angle);

/* ---------------- 本地状态 ---------------- */
let myChoice = null;                        // 我选中的落点编号（null = 未选 → 原地不动）
let hitTargets = [];                        // [{n,x,y,s}] 供点击拾取
let lastRoundKey = "";

/* ---------------- 由快照推导 ---------------- */
function myPidOf(v) {
  if (!v || !v.seats) return null;
  const m = v.seats.find(s => s.cid && s.cid === Net.NET.cid);
  return m ? m.pid : null;
}
const liveCellOf = me => (me && me.pos !== null && me.pos !== undefined) ? me.pos : E.CENTER_N;

/* ---------------- 渲染 ---------------- */
function draw() {
  if (!ctx) return;
  const v = Net.NET.view;
  const cam = camBasis();
  const seats = (v && v.seats) || [];

  ctx.clearRect(0, 0, CW, CH);
  const bg = ctx.createRadialGradient(CW / 2, CH * 0.42, 20, CW / 2, CH * 0.5, Math.max(CW, CH) * 0.75);
  bg.addColorStop(0, "#141838"); bg.addColorStop(1, "#0b0e22");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, CW, CH);

  /* --- 立方体外框：8 顶点 12 棱 --- */
  const H = 3.5, corners = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
    corners.push({ x: sx * H, y: sy * H, z: sz * H, k: `${sx}${sy}${sz}` });
  const cp = {};
  corners.forEach(c => { cp[c.k] = proj(tiltPt(c), cam); });
  ctx.lineWidth = 1.6;
  for (const a of corners) for (const b of corners) {
    let diff = 0;
    if (a.x !== b.x) diff++; if (a.y !== b.y) diff++; if (a.z !== b.z) diff++;
    if (diff !== 1 || a.k > b.k) continue;
    const pa = cp[a.k], pb = cp[b.k];
    if (!pa || !pb) continue;
    const depth = Math.min(pa.z, pb.z);
    ctx.strokeStyle = `rgba(124,140,255,${Math.max(0.08, Math.min(0.5, 26 / depth))})`;
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  }

  /* --- 343 个格点（远→近，近的更大更亮） --- */
  const zNear = Math.max(1, view.dist - 6.2), zFar = view.dist + 6.2;
  const pts = [];
  for (let n = 1; n <= E.TOTAL; n++) {
    const w = cellWorld(n); if (!w) continue;
    const p = proj(tiltPt(w), cam); if (!p) continue;
    pts.push({ n, p });
  }
  pts.sort((a, b) => b.p.z - a.p.z);
  for (const it of pts) {
    const t = Math.max(0, Math.min(1, (it.p.z - zNear) / (zFar - zNear)));   // 0 近 1 远
    const isCen = it.n === E.CENTER_N;
    const a = 0.60 - 0.48 * t + (isCen ? 0.30 : 0);
    const r = Math.max(0.8, Math.min(3.2, 0.055 * it.p.s)) + (isCen ? 1.4 : 0);
    ctx.fillStyle = isCen ? `rgba(255,210,122,${Math.min(1, a)})` : `rgba(150,168,255,${a})`;
    ctx.beginPath(); ctx.arc(it.p.x, it.p.y, r, 0, 6.2832); ctx.fill();
  }

  /* --- 重心标记（红圈 + 十字） --- */
  if (v && v.tilt && v.tilt.g && v.tilt.len > 1e-9) {
    const gp = proj(tiltPt({ x: v.tilt.g.x - CEN, y: v.tilt.g.y - CEN, z: v.tilt.g.z - CEN }), cam);
    if (gp) {
      const R = Math.max(5, Math.min(14, 0.42 * gp.s));
      ctx.strokeStyle = "rgba(255,107,138,0.95)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(gp.x, gp.y, R, 0, 6.2832); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(gp.x - R * 1.5, gp.y); ctx.lineTo(gp.x + R * 1.5, gp.y);
      ctx.moveTo(gp.x, gp.y - R * 1.5); ctx.lineTo(gp.x, gp.y + R * 1.5);
      ctx.stroke();
    }
  }

  /* --- 玩家 --- */
  const myPid = myPidOf(v);
  const drawn = [];
  for (const s of seats) {
    if (!s.alive) continue;
    const w = cellWorld(s.pos); if (!w) continue;
    const p = proj(tiltPt(w), cam); if (!p) continue;
    drawn.push({ s, p });
  }
  drawn.sort((a, b) => b.p.z - a.p.z);
  for (const { s, p } of drawn) {
    const R = Math.max(5, Math.min(16, 0.34 * p.s));
    const col = COLORS[(s.seat || 0) % COLORS.length];
    if (v && v.tilt && v.tilt.hitPid === s.pid && v.tilt.dmg > 0 && !v.finished) {   // 被压的那位
      ctx.strokeStyle = "rgba(255,107,138,0.9)"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y, R + 5, 0, 6.2832); ctx.stroke();
    }
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, 6.2832); ctx.fill();
    if (s.pid === myPid) {                                                          // 我自己
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(p.x, p.y, R + 2.5, 0, 6.2832); ctx.stroke();
    }
    if (s.B > 0 && s.hp / s.B <= 0.34 && s.alive) {                                 // 血量见底
      ctx.strokeStyle = "rgba(255,107,138,0.85)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, R + 1, 0, 6.2832); ctx.stroke();
    }
    const label = "P" + s.pid;
    ctx.font = "700 11px -apple-system,Segoe UI,Microsoft YaHei,sans-serif";
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(8,10,26,0.72)";
    ctx.fillRect(p.x - tw / 2 - 3, p.y - R - 17, tw + 6, 14);
    ctx.fillStyle = "#e8ebff";
    ctx.fillText(label, p.x - tw / 2, p.y - R - 6);
  }

  /* --- 候选落点：我的 26 邻域 + 原地 --- */
  hitTargets = [];
  const playing = v && v.phase === "playing" && !v.finished;
  const me = seats.find(s => s.pid === myPid);
  if (playing && me && me.alive) {
    const live = liveCellOf(me);
    const cands = [live].concat(E.neighbors(live));
    for (const n of cands) {
      const w = cellWorld(n); if (!w) continue;
      const p = proj(tiltPt(w), cam); if (!p) continue;
      hitTargets.push({ n, x: p.x, y: p.y, s: p.s });
    }
    for (const t of hitTargets) {
      const sel = (myChoice === null ? t.n === live : myChoice === t.n);
      const R = Math.max(6, Math.min(18, 0.42 * t.s));
      ctx.beginPath(); ctx.arc(t.x, t.y, R, 0, 6.2832);
      if (sel) {
        ctx.fillStyle = "rgba(255,210,122,0.30)"; ctx.fill();
        ctx.strokeStyle = "rgba(255,210,122,1)"; ctx.lineWidth = 2.4;
      } else {
        ctx.strokeStyle = "rgba(255,210,122,0.52)"; ctx.lineWidth = 1.4;
      }
      ctx.stroke();
      ctx.fillStyle = "rgba(255,210,122,0.92)";
      ctx.font = "600 10px -apple-system,Segoe UI,sans-serif";
      ctx.fillText(String(t.n), t.x + R + 2, t.y + 3);
    }
  }
}

/* ---------------- 姿态动画 ---------------- */
let lastAnimKey = "";
function updateAnim() {
  const v = Net.NET.view;
  /* 规则：每轮初始都是「编号 1-49 的那一面朝上」——
     所以回合一变就先让立方体复位到正位，再朝新的重心方向倾倒。 */
  const ak = v ? `${v.phase}#${v.finished ? "F" : ""}#${v.round || 0}` : "";
  if (ak !== lastAnimKey) {
    lastAnimKey = ak;
    anim.angle = 0;
    const t0 = (v && v.tilt && v.tilt.dir) ? E.tiltAxisAngle(v.tilt.dir) : null;
    if (t0) anim.axis = t0.axis;
  }
  let target = null;
  if (v && v.phase !== "lobby" && v.tilt && v.tilt.len > 1e-9) target = E.tiltAxisAngle(v.tilt.dir);
  if (!target) {                                   // 不倾斜 / 尚未开局 → 回到正位
    anim.angle += (0 - anim.angle) * 0.12;
    if (Math.abs(anim.angle) < 1e-3) anim.angle = 0;
    return;
  }
  let axis = target.axis, angle = target.angle;
  if (dot3(anim.axis, axis) < 0) { axis = { x: -axis.x, y: -axis.y, z: -axis.z }; angle = -angle; }  // 走近路
  const k = 0.13;
  anim.angle += (angle - anim.angle) * k;
  anim.axis = norm3({
    x: anim.axis.x + (axis.x - anim.axis.x) * k,
    y: anim.axis.y + (axis.y - anim.axis.y) * k,
    z: anim.axis.z + (axis.z - anim.axis.z) * k
  });
}

/* ---------------- 大厅 ---------------- */
/* 设置来源：优先用房主广播下来的那份（guest 也能看到房主的设置） */
function curSetup() {
  const v = Net.NET.view;
  if (v && v.setup && Array.isArray(v.setup.A)) return v.setup;
  return Net.ensureSetup();
}
const setupA = i => { const s = curSetup(); return s.A[i] === undefined ? i + 1 : s.A[i]; };
const setupB = i => { const s = curSetup(); return s.B[i] === undefined ? i + 1 : s.B[i]; };
/* 规则：A1..AN 与 B1..BN 各自互不相同。
   dupSeat 返回与「第 i 位、kind 组、值 val」撞车的那个座位下标，没有则 -1。 */
function dupSeat(i, kind, val) {
  const s = curSetup(), arr = (kind === "A" ? s.A : s.B) || [];
  for (let j = 0; j < arr.length; j++) {
    if (j === i) continue;
    const v = arr[j] === undefined ? j + 1 : arr[j];
    if (Math.round(+v) === Math.round(+val)) return j;
  }
  return -1;
}
/* 当前设置里如果有重复，返回给人看的说明（用于禁用「开始」按钮） */
function dupHint(n) {
  const label = { A: "体重 A", B: "生命值 B" };
  for (const kind of ["A", "B"]) {
    for (let i = 0; i < n; i++) {
      const val = kind === "A" ? setupA(i) : setupB(i);
      const j = dupSeat(i, kind, val);
      if (j >= 0 && j < n) return `${label[kind]} 有重复：P${i + 1} 与 P${j + 1} 都是 ${val}`;
    }
  }
  return "";
}

function renderLobby() {
  $("setup").classList.remove("hidden");
  $("game").classList.add("hidden");
  $("netPanel").classList.toggle("hidden", !Net.NET.room);
  $("entryCard").classList.toggle("hidden", !!Net.NET.room);
  if (!Net.NET.room) return;

  const v = Net.NET.view, isHost = Net.NET.role === "host";
  $("roomCodeShow").textContent = Net.NET.room;
  $("netRole").textContent = isHost ? "身份：房主（本机结算）"
    : (Net.hostAlive() ? "身份：玩家" : (Net.isCandidate() ? "身份：玩家（房主离线，本机将接管）" : "身份：玩家（房主离线）"));
  $("netStatus").innerHTML = (Net.NET.connected ? '<span class="dot ok"></span>中继已连接' : '<span class="dot bad"></span>连接中继…')
    + (!isHost && Net.NET.connected ? (Net.hostAlive() ? " · 房主在线" : " · 等待房主…") : "");
  const link = location.origin + location.pathname + "#r=" + Net.NET.room;
  if ($("roomLink").value !== link) $("roomLink").value = link;

  const seats = (v && v.seats) || [];
  $("lobbyCount").textContent = seats.length ? `（${seats.length}/${Net.MAXP}）` : "";
  $("lobbyList").innerHTML = seats.length
    ? seats.map((s, i) => `<div><span class="${s.cid === Net.NET.cid ? "me" : ""}">`
      + `<span class="chipcolor" style="background:${COLORS[i % COLORS.length]}"></span>`
      + `P${i + 1} ${esc(s.name)}${s.cid === Net.NET.cid ? " (我)" : ""}</span>`
      + `<span class="seat">体重 A=${setupA(i)} · 生命 B=${setupB(i)}</span></div>`).join("")
    : '<div><span class="seat">还没有人…</span></div>';

  renderSetupEditor(isHost, seats);

  const enough = seats.length >= Net.MINP;
  const dh = enough ? dupHint(seats.length) : "";
  $("startNetBtn").classList.toggle("hidden", !isHost);
  $("startNetBtn").disabled = !enough || !!dh;
  $("startNetBtn").textContent = enough ? `开始对局（${seats.length} 人）` : `开始对局（还差 ${Net.MINP - seats.length} 人）`;
  $("startHint").textContent = isHost
    ? (dh ? `${dh} —— 按规则 A、B 各组内不能重复，改好才能开局` : "至少 2 人即可开局")
    : (enough ? "等房主开始…" : `至少 ${Net.MINP} 人才能开局`);
  if (!isHost && Net.NET.connected && !Net.NET.hostSeen && (Date.now() - Net.NET._joinAt) > 4000)
    $("netStatus").innerHTML = '<span class="dot bad"></span>房间里没有房主 —— 检查房号，或自己创建一间';
  renderChat();
}

/* 只在「成员/人数」变化时重建表格，免得把房主正在输入的框冲掉 */
function renderSetupEditor(isHost, seats) {
  const ed = $("setupEditor");
  if (!isHost) {
    if (ed._struct !== "guest") { ed._struct = "guest"; ed.innerHTML = `<h3>开局设置</h3><div class="sub">由房主设置每位的体重 A 与生命值 B；默认 A=B=i。</div>`; }
    return;
  }
  const rows = Math.max(Net.MINP, seats.length);
  const struct = "host:" + rows + ":" + seats.map(x => x.name).join("|");
  if (ed._struct !== struct) {
    ed._struct = struct;
    let html = `<h3>开局设置（房主）</h3>
      <div class="sub" style="margin-bottom:6px">人数以房间内实际成员为准（至少 ${Net.MINP} 人）</div>
      <table class="setup"><tr><th>玩家</th><th>体重 A</th><th>生命值 B</th></tr>`;
    for (let i = 0; i < rows; i++) {
      const nm = seats[i] ? seats[i].name : `（空位 ${i + 1}）`;
      html += `<tr><td><span class="chipcolor" style="background:${COLORS[i % COLORS.length]}"></span>P${i + 1} ${esc(nm)}</td>`
        + `<td><input type="number" min="1" max="99" value="${setupA(i)}" data-kind="A" data-i="${i}"></td>`
        + `<td><input type="number" min="1" max="99" value="${setupB(i)}" data-kind="B" data-i="${i}"></td></tr>`;
    }
    html += `</table><div class="row"><button class="ghost sm" id="resetAB">恢复默认 A=B=i</button></div>`;
    ed.innerHTML = html;
    ed.querySelectorAll("input[data-kind]").forEach(inp => {
      inp.addEventListener("change", () => {
        const i = +inp.dataset.i, kind = inp.dataset.kind;
        const val = Math.max(1, Math.min(99, Math.round(+inp.value) || (i + 1)));
        const dup = dupSeat(i, kind, val);
        if (dup >= 0) {                         // 规则：同一组内互不相同 → 直接拒绝，退回原值
          inp.value = kind === "A" ? setupA(i) : setupB(i);
          flash(`${kind === "A" ? "体重 A" : "生命值 B"} 不能重复：P${dup + 1} 已经是 ${val}`);
          return;
        }
        inp.value = val;
        Net.localSetup(s => { s[kind][i] = val; });
      });
    });
    $("resetAB").onclick = () => {
      Net.localSetup(s => { s.A = s.A.map((_, i) => i + 1); s.B = s.B.map((_, i) => i + 1); });
      ed._struct = null; renderLobby();
    };
  } else {
    /* 结构没变：只把非聚焦输入框同步到最新值 */
    ed.querySelectorAll("input[data-kind]").forEach(inp => {
      if (inp === document.activeElement) return;
      const want = inp.dataset.kind === "A" ? setupA(+inp.dataset.i) : setupB(+inp.dataset.i);
      if (+inp.value !== want) inp.value = want;
    });
  }
}

function renderChat() {
  const chats = (Net.NET.view && Net.NET.view.chat) || [];
  const html = chats.map(c => c.sys
    ? `<div class="chatline sys">${esc(c.text)}</div>`
    : `<div class="chatline"><span class="who">${esc(c.name)}</span>：${esc(c.text)}</div>`).join("");
  ["chatList", "chatListGame"].forEach(id => {
    const el = $(id); if (!el) return;
    if (el._html !== html) { el._html = html; el.innerHTML = html; el.scrollTop = el.scrollHeight; }
  });
}

/* ---------------- 对局 ---------------- */
function renderGame() {
  const v = Net.NET.view;
  $("setup").classList.add("hidden");
  $("game").classList.remove("hidden");
  resize();                                   // 面板显示出来后才量得到宽度

  /* 换回合 → 清掉上一轮的选择 */
  const rk = Net.NET.room + "#" + v.round + "#" + (v.finished ? "F" : "");
  if (rk !== lastRoundKey) { lastRoundKey = rk; myChoice = null; }

  const isHost = Net.NET.role === "host";
  const myPid = myPidOf(v);
  const seats = v.seats || [];
  const alive = seats.filter(s => s.alive).length;
  const subs = (v.submitted || []).length;

  $("nbRoom").textContent = Net.NET.room;
  $("nbRound").textContent = v.round || 0;
  $("nbSub").textContent = v.finished ? "已结束" : `已提交 ${subs}/${alive}`;
  const left = v.deadline ? Math.max(0, Math.ceil((v.deadline - (Date.now() + Net.NET.offset)) / 1000)) : 0;
  $("nbClock").textContent = v.finished ? "—" : (left + " 秒");
  const ok = Net.NET.connected && (isHost || Net.hostAlive());
  $("nbConn").innerHTML = `<span class="dot ${ok ? "ok" : "bad"}"></span>`
    + (!Net.NET.connected ? "连接中…" : (isHost ? "本机结算" : (Net.hostAlive() ? "已连接" : "房主离线 · 正在移交…")));

  /* 玩家表 */
  $("players").innerHTML = seats.map(s => {
    const pct = s.B > 0 ? Math.max(0, Math.min(100, 100 * s.hp / s.B)) : 0;
    const done = (v.submitted || []).includes(s.pid);
    return `<div class="prow ${s.alive ? "" : "dead"}">`
      + `<span class="chip" style="background:${COLORS[(s.seat || 0) % COLORS.length]}"></span>`
      + `<span class="nm">P${s.pid} ${esc(s.name)}${s.pid === myPid ? " <span class='tag me'>我</span>" : ""}</span>`
      + `<span class="sub" style="font-size:12px">A${s.A}</span>`
      + `<span class="hp"><span class="hpbar"><i style="width:${pct}%;background:${pct <= 34 ? "var(--hot)" : "var(--ok)"}"></i></span>`
      + `<span class="sub" style="font-size:12px">${s.hp}/${s.B}</span></span>`
      + `<span class="tag ${done && s.alive ? "done" : ""}">${s.alive ? (done ? "已提交" : "等待") : "出局"}</span></div>`;
  }).join("");

  /* 本回合信息 */
  const t = v.tilt;
  if (!t) $("tiltInfo").innerHTML = "等待第一回合结算…";
  else if (t.noHit) $("tiltInfo").innerHTML = `重心 <b>(${fmtN(t.g)})</b> 正好压在立方体中心 → <b>不倾斜</b>，本轮无人被压。`;
  else {
    const hit = seats.find(s => s.pid === t.hitPid);
    $("tiltInfo").innerHTML = `重心 <b>(${fmtN(t.g)})</b>，偏离中心 <b>${t.len.toFixed(2)}</b><br>`
      + `立方体朝重心方向倾斜 → 正下方是 <b style="color:var(--hot)">${hit ? esc(hit.name) : "?"}</b>，本轮扣 <b>${t.dmg}</b> 点`
      + (t.tied && t.tied.length > 1 ? `<br><span class="sub">（${t.tied.length} 人并列最下方，按规则只有体重最小的挨压）</span>` : "");
  }

  /* 战报 */
  const box = $("logBox"), lines = v.log || [];
  if (box._n !== lines.length) {
    box._n = lines.length;
    box.innerHTML = lines.map(x => `<div>${esc(x)}</div>`).join("");
    box.scrollTop = box.scrollHeight;
  }

  /* 操作栏 */
  const playing = v.phase === "playing" && !v.finished;
  const me = seats.find(s => s.pid === myPid);
  const sent = (v.submitted || []).includes(myPid);
  $("submitBtn").disabled = !playing || !me || !me.alive || sent;
  $("stayBtn").disabled = !playing || !me || !me.alive || sent;
  $("againBtn").classList.toggle("hidden", !(isHost && v.finished));
  if (v.finished) {
    const w = seats.find(s => s.pid === v.winner);
    $("moveInfo").innerHTML = `对局结束 —— 🏆 <b>${w ? esc(w.name) : "无人"}</b> 获胜`;
  } else if (!me) {
    $("moveInfo").innerHTML = "对局已经开始，你在旁观战 —— 等这局结束、房主重开，或现在退出另建一间。";
  } else if (!me.alive) {
    $("moveInfo").innerHTML = "你已出局，可以继续观战。";
  } else if (sent) {
    $("moveInfo").innerHTML = `已提交：<b>${myChoiceOut(me)}</b> —— 等其他人…`;
  } else {
    $("moveInfo").innerHTML = myChoice === null
      ? "拖动画面旋转视角 · 点击黄圈选落点（不选则原地不动）"
      : `已选 <b>${myChoice} 号格</b>${myChoice === liveCellOf(me) ? "（原地不动）" : ""} · 点「确认移动」提交`;
  }

  /* 顶部横幅：结算播报 */
  const bn = $("banner");
  if (v.finished) {
    const w = seats.find(s => s.pid === v.winner);
    bn.classList.remove("hidden");
    bn.innerHTML = `🏆 ${w ? esc(w.name) : "无人"} 获胜`;
  } else if (t && !t.noHit && t.dmg > 0 && v.round > 0) {
    const hit = seats.find(s => s.pid === t.hitPid);
    bn.classList.remove("hidden");
    bn.innerHTML = `第 ${v.round} 回合：立方体倾斜 → <b>${hit ? esc(hit.name) : "?"}</b> 被压，-${t.dmg} HP`;
  } else bn.classList.add("hidden");

  renderChat();
}
const fmtN = g => g ? `${g.x.toFixed(2)}, ${g.y.toFixed(2)}, ${g.z.toFixed(2)}` : "?";
const myChoiceOut = me => (myChoice === null || myChoice === liveCellOf(me)) ? "原地不动" : myChoice + " 号格";

/* ---------------- 总渲染 ---------------- */
function render() {
  const v = Net.NET.view;
  if (!Net.NET.active) {
    $("setup").classList.remove("hidden"); $("game").classList.add("hidden");
    $("netPanel").classList.add("hidden"); $("entryCard").classList.remove("hidden");
    resize();
    return;
  }
  if (!v || v.phase === "lobby") { renderLobby(); resize(); return; }
  renderGame();
}

/* ---------------- 交互：拖动旋转 + 点击拾取 ---------------- */
(function bindCanvas() {
  const el = () => $("cv");
  let dragging = false, moved = 0, lx = 0, ly = 0;
  el().addEventListener("pointerdown", e => {
    dragging = true; moved = 0; lx = e.clientX; ly = e.clientY;
    try { el().setPointerCapture(e.pointerId); } catch (err) { }
  });
  el().addEventListener("pointermove", e => {
    if (!dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    view.yaw -= dx * 0.008;
    view.pitch = Math.max(-1.35, Math.min(1.35, view.pitch + dy * 0.006));
  });
  el().addEventListener("pointerup", e => {
    dragging = false;
    if (moved > 6) return;                                   // 拖动过就不当点击
    const r = el().getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 26;
    for (const t of hitTargets) {
      const d = Math.hypot(t.x - mx, t.y - my);
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) return;
    const v = Net.NET.view;
    if (!v || v.finished) return;
    const me = (v.seats || []).find(s => s.pid === myPidOf(v));
    if (!me || !me.alive) return;
    if ((v.submitted || []).includes(myPidOf(v))) { flash("本回合已经提交过了，等下一轮"); return; }
    myChoice = best.n;
    $("moveInfo").innerHTML = `已选 <b>${best.n} 号格</b>${best.n === liveCellOf(me) ? "（原地不动）" : ""} · 点「确认移动」提交`;
  });
  el().addEventListener("wheel", e => {
    e.preventDefault();
    view.dist = Math.max(15, Math.min(46, view.dist + Math.sign(e.deltaY) * 1.4));
  }, { passive: false });
})();

function flash(msg) {
  let el = $("flash");
  if (!el) { el = document.createElement("div"); el.id = "flash"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(flash._t); flash._t = setTimeout(() => el.classList.remove("show"), 2400);
}

/* ---------------- 动作 ---------------- */
function submitMove() {
  const v = Net.NET.view;
  if (!v || v.finished) return;
  const myPid = myPidOf(v);
  const me = (v.seats || []).find(s => s.pid === myPid);
  if (!me || !me.alive) return;
  if ((v.submitted || []).includes(myPid)) { flash("本回合已经提交过了"); return; }
  const live = liveCellOf(me);
  const to = (myChoice === null) ? live : myChoice;
  if (!Net.submitMove(to)) { flash("还没连上中继"); return; }
  myChoice = to;
  $("moveInfo").innerHTML = `已提交：<b>${myChoiceOut(me)}</b> —— 等其他人…`;
}
function sendChat(inputId) {
  const s = ($(inputId).value || "").trim();
  if (!s) return;
  if (!Net.chat(s)) { flash("还没连上中继"); return; }
  $(inputId).value = "";
}
function copyLink() {
  const txt = $("roomLink").value;
  const done = () => flash("邀请链接已复制，发给朋友即可进房");
  if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, () => { $("roomLink").select(); done(); });
  else { $("roomLink").select(); try { document.execCommand("copy"); } catch (e) { } done(); }
}

/* ---------------- 绑定 ---------------- */
$("createRoomBtn").onclick = () => Net.start("host", Net.newRoom(), ($("netName").value || "玩家").trim());
$("joinRoomBtn").onclick = () => {
  const code = ($("netRoom").value || "").trim().toUpperCase();
  if (code.length !== 4) { flash("房号是 4 位字母数字"); return; }
  Net.start("guest", code, ($("netName").value || "玩家").trim());
};
$("netRoom").addEventListener("keydown", e => { if (e.key === "Enter") $("joinRoomBtn").click(); });
$("netName").addEventListener("change", () => Net.rename(($("netName").value || "玩家").trim()));
$("startNetBtn").onclick = () => { if (!Net.startGameReq()) flash("还没连上中继"); };
$("againBtn").onclick = () => Net.againReq();
$("leaveBtn").onclick = () => Net.leave(false);
$("leaveBtn2").onclick = () => Net.leave(false);
$("copyLinkBtn").onclick = copyLink;
$("stayBtn").onclick = () => {
  const v = Net.NET.view;
  const me = (v && v.seats || []).find(s => s.pid === myPidOf(v));
  if (me) myChoice = liveCellOf(me);
  submitMove();
};
$("submitBtn").onclick = submitMove;
$("chatSend").onclick = () => sendChat("chatInput");
$("chatSendLobby").onclick = () => sendChat("chatInputLobby");
["chatInput", "chatInputLobby"].forEach(id =>
  $(id).addEventListener("keydown", e => { if (e.key === "Enter") sendChat(id); }));

/* 邀请链接：#r=房号 打开即自动进房 */
if (location.hash.indexOf("#r=") === 0) {
  const code = location.hash.slice(3).trim().toUpperCase();
  if (code.length === 4) { $("netRoom").value = code; Net.start("guest", code, "玩家"); }
}

/* ---------------- 主循环 ---------------- */
Net.onUpdate = render;
resize();
(function loop() { updateAnim(); draw(); requestAnimationFrame(loop); })();
setInterval(() => { Net.tick(); if (Net.NET.active) render(); }, 250);
render();
