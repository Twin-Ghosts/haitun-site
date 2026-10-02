/* =====================================================================
   倾斜立方 —— 联机层
   —— 公共 MQTT 中继 + 房间内任一台浏览器当「房主」结算，不需要任何自有服务器。
      房主 = 当前负责结算的那台浏览器；房主掉线（关页/断网/关机/休眠）后，
      房间内仍在线的浏览器里 cid 最小的那位自动接管，并从保留的权威快照接着结算。
      所以房间不绑定任何一台机器。

   快照三份：
     pub       —— 人人可见：阶段、回合、玩家表、重心、倾斜方向、日志、聊天、截止时间
     p/<cid>   —— 只发给本人：我自己的待提交选择（移动选择在提交前对别人保密）
     auth      —— 接管续局所需的完整权威状态（界面不展示）

   已知边界：公共中继无鉴权，房号即凭据；别在公开场合贴房号，也别拿它做赌注。
   ===================================================================== */
"use strict";

/* ---------------------------------------------------------------
   极简 MQTT 客户端（MQTT 3.1.1 over WebSocket，QoS0）—— 不加载任何外部库
   --------------------------------------------------------------- */
const _enc = new TextEncoder(), _dec = new TextDecoder();
const _cat = arrs => { let n = 0; arrs.forEach(a => n += a.length); const o = new Uint8Array(n); let p = 0; arrs.forEach(a => { o.set(a, p); p += a.length; }); return o; };
const _u16 = n => new Uint8Array([(n >> 8) & 255, n & 255]);
const _mstr = s => { const b = _enc.encode(s); return _cat([_u16(b.length), b]); };
const _mbin = b => _cat([_u16(b.length), b]);
const _vint = n => { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0); return new Uint8Array(o); };
const _pkt = (type, flags, body) => { const rl = _vint(body.length); const h = new Uint8Array(rl.length + 1); h[0] = (type << 4) | flags; h.set(rl, 1); return _cat([h, body]); };

class MiniMQTT {
  constructor(url, opts) {
    this.url = url; this.opts = opts || {}; this.buf = new Uint8Array(0);
    this.h = {}; this.connected = false; this.tries = 0; this.closed = false;
  }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
  fire(ev, a) { (this.h[ev] || []).forEach(f => { try { f(a); } catch (e) { console.error(e); } }); }
  connect() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(this.url, "mqtt"); } catch (e) { this.fire("error", e); return; }
    this.ws = ws; ws.binaryType = "arraybuffer";
    ws.onopen = () => { this.tries = 0; this._send(this._connectPkt()); };
    ws.onmessage = ev => this._feed(new Uint8Array(ev.data));
    ws.onerror = () => this.fire("error", new Error("ws error"));
    ws.onclose = () => {
      this.connected = false; this.fire("close");
      if (!this.closed) { const d = Math.min(10000, 1200 * Math.pow(1.5, this.tries++)); setTimeout(() => this.connect(), d); }
    };
  }
  _connectPkt() {
    const cid = this.opts.clientId || ("c" + Math.random().toString(16).slice(2, 10));
    let flags = 0x02;                                   // clean session
    const payload = [_mstr(cid)];
    if (this.opts.will) { flags |= 0x04 | 0x20; payload.push(_mstr(this.opts.will.topic), _mbin(_enc.encode(this.opts.will.payload || ""))); }
    const vh = _cat([_mstr("MQTT"), new Uint8Array([4, flags]), _u16(this.opts.keepalive || 40)]);
    return _pkt(1, 0, _cat([vh, _cat(payload)]));
  }
  _send(bytes) { if (this.ws && this.ws.readyState === 1) this.ws.send(bytes); }
  publish(tp, payload, opts) {
    const s = (typeof payload === "string") ? payload : JSON.stringify(payload);
    this._send(_pkt(3, (opts && opts.retain) ? 1 : 0, _cat([_mstr(tp), _enc.encode(s)])));
  }
  subscribe(tps) {
    const id = (this._id = ((this._id || 0) + 1) & 0xffff);
    const parts = [_u16(id)];
    tps.forEach(x => parts.push(_mstr(x), new Uint8Array([0])));
    this._send(_pkt(8, 2, _cat(parts)));
  }
  close() { this.closed = true; try { this._send(new Uint8Array([0xE0, 0])); this.ws.close(); } catch (e) { } }
  _feed(chunk) {
    this.buf = _cat([this.buf, chunk]);
    for (; ;) {
      if (this.buf.length < 2) return;
      const head = this.buf[0];
      let i = 1, mul = 1, len = 0, b;
      do { if (i >= this.buf.length) return; b = this.buf[i++]; len += (b & 127) * mul; mul *= 128; } while (b & 128);
      if (this.buf.length < i + len) return;
      const body = this.buf.slice(i, i + len);
      this.buf = this.buf.slice(i + len);
      this._handle(head >> 4, head & 15, body);
    }
  }
  _handle(type, flags, body) {
    if (type === 2) {                                   // CONNACK
      this.connected = (body[1] === 0);
      if (this.connected) this.fire("connect"); else this.fire("error", new Error("CONNACK " + body[1]));
    } else if (type === 3) {                            // PUBLISH（只用 QoS0）
      const tl = (body[0] << 8) | body[1];
      let off = 2 + tl;
      if ((flags & 6) === 2 || (flags & 6) === 4) off += 2;
      this.fire("message", { topic: _dec.decode(body.slice(2, 2 + tl)), payload: _dec.decode(body.slice(off)) });
    }
  }
}

/* ---------------------------------------------------------------
   房间状态
   --------------------------------------------------------------- */
const Net = (() => {
  const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
  const NS = "cubetilt/v1/";
  const ROUND_MS = 30000, HB_MS = 5000, STALE_MS = 25000, TAKEOVER_MS = 6000, AUTH_MS = 3000;
  const ROOM_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const MAXP = 8, MINP = 2;

  const NET = {
    active: false, role: null, client: null, room: null, cid: "", name: "玩家",
    myPid: null, view: null, priv: null, connected: false,
    hostSeen: 0, hostDeclared: false, hostCid: null, hostEpoch: 0, hostGone: 0,
    presence: new Map(), auth: null, authSeen: 0, claimEpoch: 0,
    lastTs: 0, offset: 0, _presHb: 0, _joinAt: 0, _lastPub: 0, _lastAuth: 0, _lastHb: 0
  };
  const HOST = {
    players: [], phase: "lobby", game: null, submitted: new Map(),
    deadline: 0, chat: [], log: [], setup: null
  };
  let onUpdate = () => { };

  /* ---- 工具 ---- */
  const ridHex = () => { const a = new Uint8Array(6); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); };
  /* 规则：A1..AN 与 B1..BN 各自互不相同 */
  const dupIn = arr => new Set(arr).size !== arr.length;
  const dupPairs = arr => { const seen = {}, out = []; arr.forEach((v, i) => { if (seen[v] !== undefined) out.push(`P${seen[v] + 1}/P${i + 1}=${v}`); else seen[v] = i; }); return out; };
  const newRoom = () => { const a = new Uint8Array(4); crypto.getRandomValues(a); return [...a].map(b => ROOM_ABC[b % ROOM_ABC.length]).join(""); };
  const now = () => Date.now();
  const TP = s => NS + NET.room + "/" + s;
  const hostAlive = () => !!NET.hostDeclared && (now() - NET.hostSeen) < STALE_MS;

  function livePresence() {
    const t = now(), out = [];
    for (const [cid, p] of NET.presence) {
      if (!p.alive || t - p.seen >= STALE_MS) continue;
      if (cid === NET.hostCid) continue;
      out.push(cid);
    }
    if (!out.includes(NET.cid)) out.push(NET.cid);
    return out.sort();
  }
  const isCandidate = () => NET.role === "guest" && livePresence()[0] === NET.cid;
  function canTakeover(t) {
    if (!isCandidate() || !NET.connected) return false;
    if (t - NET.hostGone < TAKEOVER_MS) return false;
    const freshAuth = !!(NET.auth && (t - NET.authSeen) < STALE_MS * 2);
    return !!(NET.hostSeen || freshAuth);
  }

  /* ---- 默认设置：A_i = B_i = i ---- */
  function defaultSetup(n) {
    return { n, A: Array.from({ length: n }, (_, i) => i + 1), B: Array.from({ length: n }, (_, i) => i + 1) };
  }
  function ensureSetup() {
    if (!HOST.setup) HOST.setup = defaultSetup(Math.max(MINP, HOST.players.length));
    // 人数变化时补齐/截断（保留人手改过的值）
    const n = HOST.setup.n;
    while (HOST.setup.A.length < n) HOST.setup.A.push(HOST.setup.A.length + 1);
    while (HOST.setup.B.length < n) HOST.setup.B.push(HOST.setup.B.length + 1);
    return HOST.setup;
  }

  /* ---- 在线标记 / 房主声明 ---- */
  function publishPresence(alive) {
    if (!NET.client || !NET.connected || !NET.room) return;
    NET.client.publish(TP("presence/" + NET.cid), JSON.stringify({ cid: NET.cid, alive: !!alive }), { retain: true });
  }
  function pubHostAlive() {
    if (!NET.client || !NET.connected) return;
    NET.client.publish(TP("host"), JSON.stringify({ cid: NET.cid, alive: true, ts: now(), epoch: NET.claimEpoch }), { retain: true });
    NET.hostCid = NET.cid; NET.hostEpoch = NET.claimEpoch;
    NET.hostSeen = now(); NET.hostDeclared = true; NET.hostGone = 0;
    publishPresence(true);
  }

  /* ---- 建房 / 加入 ---- */
  function start(role, room, name) {
    leave(true);
    NET.active = true; NET.role = role; NET.room = room; NET.name = (name || "玩家").slice(0, 12);
    NET.cid = ridHex(); NET.hostSeen = 0; NET.hostDeclared = false; NET.hostCid = null;
    NET.hostEpoch = 0; NET.hostGone = 0; NET.presence = new Map(); NET.auth = null; NET.authSeen = 0;
    NET.claimEpoch = 0; NET.lastTs = 0; NET.offset = 0; NET._joinAt = now();
    NET.myPid = null; NET.view = null; NET.priv = null;
    HOST.players = []; HOST.game = null; HOST.phase = "lobby"; HOST.submitted = new Map();
    HOST.chat = []; HOST.log = []; HOST.deadline = 0; HOST.setup = defaultSetup(MINP);
    HOST.players.push({ pid: 1, name: NET.name, cid: NET.cid, ready: true, seen: now() });

    const opts = { clientId: "ct_" + NET.cid, keepalive: 40 };
    opts.will = (role === "host")
      ? { topic: TP("host"), payload: JSON.stringify({ cid: NET.cid, alive: false, ts: now(), epoch: 0 }) }
      : { topic: TP("presence/" + NET.cid), payload: JSON.stringify({ cid: NET.cid, alive: false }) };

    const c = NET.client = new MiniMQTT(BROKER_URL, opts);
    c.on("connect", () => {
      NET.connected = true;
      const subs = [TP("pub"), TP("p/" + NET.cid), TP("host"), TP("auth"), TP("presence/+")];
      if (role === "host") subs.push(TP("in"));
      c.subscribe(subs);
      publishPresence(true);
      c.publish(TP("in"), JSON.stringify({ t: "join", cid: NET.cid, name: NET.name }));
      if (role === "host") { NET.claimEpoch = now() + Math.floor(Math.random() * 800) + 1; pubHostAlive(); publish(); }
      onUpdate();
    });
    c.on("close", () => { NET.connected = false; onUpdate(); });
    c.on("message", m => {
      let o = null; try { o = JSON.parse(m.payload); } catch (e) { return; }
      if (m.topic === TP("pub")) {
        NET.view = o;
        if (o && o.ts && o.ts !== NET.lastTs) { NET.lastTs = o.ts; NET.offset = o.ts - now(); }
        onUpdate();
      } else if (m.topic === TP("p/" + NET.cid)) {
        if (o && o.cid === NET.cid) { NET.priv = o; onUpdate(); }
      } else if (m.topic === TP("auth")) {
        if (o && o.v === 1) { NET.auth = o; NET.authSeen = now(); }
      } else if (m.topic === TP("host")) {
        if (!o || !o.cid) return;
        if (o.cid !== NET.hostCid || (o.epoch || 0) > NET.hostEpoch) {
          NET.hostCid = o.cid; NET.hostEpoch = o.epoch || 0;
          if (o.cid !== NET.cid && NET.role === "host") { stepDown(o.cid, o.epoch || 0); return; }
        }
        NET.hostSeen = now(); NET.hostDeclared = true; NET.hostGone = 0;
        onUpdate();
      } else if (m.topic.indexOf(TP("presence/")) === 0) {
        NET.presence.set(o.cid, { alive: !!o.alive, seen: now() });
      } else if (m.topic === TP("in") && NET.role === "host") {
        hostOnMessage(o);
      }
    });
    c.connect();                 // 真正建立 WebSocket —— 回调都注册好了却不连，联机永远通不了
  }

  function leave(keepMode) {
    if (NET.client) {
      try {
        if (NET.connected && NET.room) {
          NET.client.publish(TP("presence/" + NET.cid), JSON.stringify({ cid: NET.cid, alive: false }), { retain: true });
          NET.client.publish(TP("p/" + NET.cid), "", { retain: true });
          if (NET.role === "host") NET.client.publish(TP("host"), JSON.stringify({ cid: NET.cid, alive: false, ts: now(), epoch: 0 }), { retain: true });
        }
        NET.client.close();
      } catch (e) { }
    }
    const wasActive = NET.active;
    Object.assign(NET, {
      active: false, client: null, room: null, view: null, priv: null, connected: false,
      hostDeclared: false, hostSeen: 0, hostCid: null, hostEpoch: 0, hostGone: 0,
      presence: new Map(), auth: null, authSeen: 0, claimEpoch: 0, myPid: null,
      lastTs: 0, offset: 0, _joinAt: 0, _lastPub: 0, _lastAuth: 0, _lastHb: 0
    });
    HOST.game = null; HOST.players = []; HOST.phase = "lobby"; HOST.submitted = new Map();
    HOST.chat = []; HOST.log = []; HOST.deadline = 0; HOST.setup = defaultSetup(MINP);
    if (location.hash.indexOf("#r=") === 0) history.replaceState(null, "", location.pathname);
    if (wasActive && !keepMode) onUpdate();
  }

  /* ---- 交接 ---- */
  function stepDown(cid, epoch) {
    if (NET.role !== "host") return;
    NET.role = "guest";
    NET.hostCid = cid; NET.hostEpoch = epoch; NET.hostSeen = now(); NET.hostDeclared = true; NET.hostGone = 0;
    HOST.game = null; HOST.players = []; HOST.phase = "lobby"; HOST.submitted = new Map();
    HOST.chat = []; HOST.log = []; HOST.deadline = 0;
    NET.view = null;
    if (NET.client && NET.connected) NET.client.publish(TP("in"), JSON.stringify({ t: "join", cid: NET.cid, name: NET.name }));
    onUpdate();
  }

  function takeover() {
    const a = (NET.auth && NET.auth.v === 1) ? NET.auth : null;
    NET.role = "host";
    NET.claimEpoch = now() + Math.floor(Math.random() * 800) + 1;
    HOST.players = []; HOST.game = null; HOST.phase = "lobby"; HOST.submitted = new Map();
    HOST.chat = []; HOST.log = []; HOST.deadline = 0; HOST.setup = defaultSetup(MINP);
    if (a) {
      HOST.phase = ["lobby", "playing", "over"].includes(a.phase) ? a.phase : "lobby";
      HOST.players = (a.players || []).map(p => ({ pid: p.pid, name: p.name, cid: p.cid, ready: !!p.ready, seen: now() }));
      HOST.chat = (a.chat || []).slice();
      HOST.log = (a.log || []).slice();
      HOST.submitted = new Map((a.submitted || []).map(x => [x[0], x[1]]));
      if (a.setup && a.setup.n) HOST.setup = { n: a.setup.n, A: (a.setup.A || []).slice(), B: (a.setup.B || []).slice() };
      if (HOST.phase !== "lobby" && a.game) {
        try { HOST.game = gameFromAuth(a.game); } catch (e) { HOST.game = null; }
      }
    }
    if (!HOST.players.length) HOST.players.push({ pid: 1, name: NET.name, cid: NET.cid, ready: true, seen: now() });
    if (!HOST.players.some(p => p.cid === NET.cid)) HOST.players.push({ pid: 0, name: NET.name, cid: NET.cid, ready: true, seen: now() });
    HOST.players.forEach((p, i) => { p.pid = i + 1; });
    if (HOST.phase !== "lobby" && !HOST.game) HOST.phase = "lobby";
    if (HOST.phase !== "lobby" && HOST.game && !HOST.game.finished) {
      const rest = Math.max(3000, (a.game.deadline || 0) - (a.ts || 0));
      HOST.deadline = now() + rest;
    }
    HOST.chat.push({ sys: true, text: HOST.phase === "lobby" ? "房主掉线，已由房间内另一位接管。" : "房主掉线，已由房间内另一位接管，对局继续。" });
    if (NET.client && NET.connected) {
      NET.client.subscribe([TP("in")]);
      NET.client.publish(TP("in"), JSON.stringify({ t: "join", cid: NET.cid, name: NET.name }));
    }
    pubHostAlive();
    publish();
    onUpdate();
  }

  function gameFromAuth(ag) {
    const specs = (ag.specs || []).map((s, i) => ({ pid: i + 1, name: s.name, A: s.A, B: s.B }));
    if (!specs.length) throw new Error("no specs");
    const g = new CubeEngine.CubeGame(specs);
    g.round = ag.round || 0;
    g.finished = !!ag.finished;
    g.winner = (ag.winner === undefined ? null : ag.winner);
    g.maxRounds = ag.maxRounds || CubeEngine.MAX_ROUNDS;
    g.log = (ag.log || []).slice();
    (ag.players || []).forEach((ps, i) => {
      const p = g.players.get(i + 1); if (!p) return;
      p.pos = ps.pos; p.hp = ps.hp; p.alive = !!ps.alive;
    });
    return g;
  }

  /* ---- 快照 ---- */
  function pubView() {
    const v = { room: NET.room, phase: HOST.phase, ts: now(), hostCid: NET.cid,
      chat: HOST.chat.slice(-40), round: 0, finished: false, winner: null,
      deadline: 0, log: [], seats: [], tilt: null, submitted: [], setup: null };
    if (HOST.phase === "lobby") {
      v.setup = ensureSetup();
      v.seats = HOST.players.map((p, i) => ({ pid: i + 1, seat: i, name: p.name, cid: p.cid, ready: true, alive: true }));
      return v;
    }
    const g = HOST.game;
    if (!g) { v.phase = "lobby"; return v; }
    v.round = g.round; v.finished = g.finished; v.winner = (g.winner === undefined ? null : g.winner);
    v.deadline = HOST.deadline;
    v.log = HOST.log.slice(-120);
    v.submitted = HOST.players.filter(p => HOST.submitted.has(p.pid)).map(p => p.pid);
    v.seats = g.list().map(p => {
      const meta = HOST.players.find(q => q.pid === p.pid) || {};
      return { pid: p.pid, seat: p.seat, name: p.name, A: p.A, B: p.B, hp: p.hp,
               alive: p.alive, pos: p.pos, ready: true, cid: meta.cid || "" };
    });
    const t = g.lastTilt;
    if (t) v.tilt = { g: t.g, dir: t.dir, len: t.len, tied: t.tied, hitPid: t.hitPid, dmg: t.dmg, noHit: !!t.noHit };
    return v;
  }
  function privView(pid) {
    const meta = HOST.players.find(q => q.pid === pid) || {};
    const s = HOST.submitted.get(pid);
    return { cid: meta.cid || "", pid, submitted: HOST.submitted.has(pid), choice: s ? s.to : null };
  }
  function authSnapshot() {
    const g = HOST.game;
    return { v: 1, ts: now(), hostCid: NET.cid, phase: HOST.phase,
      players: HOST.players.map(p => ({ pid: p.pid, name: p.name, cid: p.cid, ready: !!p.ready })),
      chat: HOST.chat.slice(-40), log: HOST.log.slice(-120), setup: ensureSetup(),
      submitted: [...HOST.submitted].map(x => [x[0], x[1]]),
      game: g ? { round: g.round, finished: g.finished, winner: (g.winner === undefined ? null : g.winner),
        deadline: HOST.deadline, maxRounds: g.maxRounds, log: g.log.slice(-120),
        specs: g.list().map(p => ({ name: p.name, A: p.A, B: p.B })),
        players: g.list().map(p => ({ pos: p.pos, hp: p.hp, alive: p.alive })) } : null };
  }
  function publish() {
    if (!NET.client || NET.role !== "host" || !NET.connected) return;
    NET.client.publish(TP("pub"), JSON.stringify(pubView()), { retain: true });
    for (const p of HOST.players) {
      if (!p.cid) continue;
      NET.client.publish(TP("p/" + p.cid), JSON.stringify(privView(p.pid)), { retain: true });
    }
    NET.client.publish(TP("auth"), JSON.stringify(authSnapshot()), { retain: true });
  }

  /* ---- 房主动作 ---- */
  function startGame() {
    if (NET.role !== "host" || HOST.phase !== "lobby") return { ok: false, msg: "只有房主能开局" };
    /* 开局只算还在线的人：掉线的不占座位、不拖满 30 秒 */
    HOST.players = HOST.players.filter(p => p.cid === NET.cid || (now() - p.seen) < STALE_MS);
    const n = HOST.players.length;
    if (n < MINP) return { ok: false, msg: `至少 ${MINP} 人才能开局` };
    const s = ensureSetup();
    s.n = n;
    const specs = HOST.players.map((p, i) => ({
      pid: i + 1, name: p.name,
      A: Math.max(1, Math.round(s.A[i] || i + 1)),
      B: Math.max(1, Math.round(s.B[i] || i + 1))
    }));
    /* 规则：A、B 各自都不能有重复 —— 房主改坏了就在这里拦住，不开局 */
    for (const [kind, arr] of [["体重 A", specs.map(x => x.A)], ["生命值 B", specs.map(x => x.B)]]) {
      if (dupIn(arr)) {
        HOST.chat.push({ sys: true, text: `开局失败：${kind} 必须各不相同（${dupPairs(arr).join("、")} 重复）。请房主在开局设置里改好再开。` });
        publish();
        return { ok: false, msg: `${kind} 有重复` };
      }
    }
    HOST.players.forEach((p, i) => { p.pid = i + 1; });
    HOST.game = new CubeEngine.CubeGame(specs);
    HOST.phase = "playing"; HOST.submitted = new Map();
    HOST.log = [`对局开始：${n} 人。体重 A = ${specs.map(x => x.A).join("/")}，生命值 B = ${specs.map(x => x.B).join("/")}。`,
                `所有人起手都在 172 号（立方体正中心）。`];
    HOST.deadline = now() + ROUND_MS;
    publish();
    return { ok: true };
  }

  function resolveRound() {
    const g = HOST.game;
    if (!g || g.finished) return;
    const moves = {};
    for (const p of HOST.players) {
      const pp = g.players.get(p.pid);
      if (!pp || !pp.alive) continue;
      const s = HOST.submitted.get(p.pid);
      moves[p.pid] = s ? { to: s.to } : { to: pp.pos };      // 没提交 = 原地不动
    }
    const lines = g.resolve(moves);
    HOST.log = HOST.log.concat(lines);
    HOST.submitted = new Map();
    /* 结算之后再看有没有人被「晾」下：活人只剩一个还在线 → 判他胜，
       否则对手一关页面，剩下的人还得自己打满 60 回合才结束。 */
    if (!g.finished) {
      const t = now(), alive = g.alive();
      const here = alive.filter(p => {
        const meta = HOST.players.find(q => q.pid === p.pid);
        return meta && (t - meta.seen) < STALE_MS;
      });
      if (alive.length > 1 && here.length === 1) {
        g.finished = true; g.winner = here[0].pid;
        HOST.log.push(`${here[0].name} 的对手都已离线，判定获胜。`);
      }
    }
    if (g.finished) { HOST.phase = "over"; HOST.deadline = 0; HOST.log.push("—— 对局结束 ——"); }
    else HOST.deadline = now() + ROUND_MS;
    publish();
  }

  /* 本轮可否结算：在线的活人都提交了；掉线者按「不动」提前结算，不拖着大家等满 30 秒 */
  function roundReady(t) {
    const g = HOST.game; if (!g) return false;
    const alive = g.alive().map(p => p.pid);
    if (!alive.length) return false;
    return alive.every(pid => {
      if (HOST.submitted.has(pid)) return true;
      const meta = HOST.players.find(p => p.pid === pid);
      return !meta || !meta.cid || (t - meta.seen) >= STALE_MS;
    });
  }

  /* ---- 入站消息 ---- */
  function hostOnMessage(o) {
    if (!o || !o.t) return;
    const who = HOST.players.find(p => p.cid && p.cid === o.cid);
    if (who) who.seen = now();
    if (o.t === "join") {
      if (HOST.phase !== "lobby") return;                     // 开局后不再收人
      if (!who) {
        if (HOST.players.length >= MAXP) return;
        HOST.players.push({ pid: 0, name: String(o.name || "玩家").slice(0, 12), cid: o.cid, ready: true, seen: now() });
        HOST.chat.push({ sys: true, text: `${String(o.name || "玩家").slice(0, 12)} 加入了房间` });
        ensureSetup();
      } else if (o.name && who.name !== String(o.name).slice(0, 12)) {
        who.name = String(o.name).slice(0, 12);
      }
      HOST.players.forEach((p, i) => { p.pid = i + 1; });
      publish();
    } else if (o.t === "chat") {
      const txt = String(o.text || "").slice(0, 90).trim();
      if (!txt) return;
      HOST.chat.push({ name: who ? who.name : "?", text: txt });
      if (HOST.chat.length > 60) HOST.chat = HOST.chat.slice(-60);
      publish();
    } else if (o.t === "setup") {
      if (!who || HOST.phase !== "lobby") return;
      if (who.pid !== 1) return;                              // 只有房主能改设置
      const s = ensureSetup();
      if (o.setup && Array.isArray(o.setup.A) && Array.isArray(o.setup.B)) {
        const n = Math.max(MINP, Math.min(MAXP, Math.round(+o.setup.n || s.n)));
        s.n = n;
        for (let i = 0; i < MAXP; i++) {
          if (o.setup.A[i] !== undefined) s.A[i] = Math.max(1, Math.min(99, Math.round(+o.setup.A[i] || i + 1)));
          if (o.setup.B[i] !== undefined) s.B[i] = Math.max(1, Math.min(99, Math.round(+o.setup.B[i] || i + 1)));
        }
        while (s.A.length < n) s.A.push(s.A.length + 1);
        while (s.B.length < n) s.B.push(s.B.length + 1);
      }
      publish();
    } else if (o.t === "start") {
      if (!who || HOST.phase !== "lobby") return;
      HOST.players.forEach((p, i) => { p.pid = i + 1; });
      if (who.pid !== 1) return;                              // 只有房主能开局
      startGame();
    } else if (o.t === "move") {
      if (HOST.phase !== "playing" || !HOST.game || HOST.game.finished || !who) return;
      const p = HOST.game.players.get(who.pid);
      if (!p || !p.alive) return;
      const vr = HOST.game.validate(who.pid, { to: o.to });
      HOST.submitted.set(who.pid, { to: vr ? vr.to : p.pos });
      publish();
      if (roundReady(now())) resolveRound();
    } else if (o.t === "again") {
      if (!who || who.pid !== 1) return;
      HOST.phase = "lobby"; HOST.game = null; HOST.submitted = new Map(); HOST.deadline = 0;
      HOST.log = []; HOST.chat.push({ sys: true, text: "房主重开了一局。" });
      publish();
    }
  }

  /* ---- 心跳 / 接管 ---- */
  function tick() {
    if (!NET.active) return;
    const t = now();
    if (NET.role === "host") {
      if (NET.connected && t - NET._lastHb > HB_MS) { NET._lastHb = t; pubHostAlive(); }
      if (HOST.phase === "lobby") {
        const before = HOST.players.length;
        HOST.players = HOST.players.filter(p => p.cid === NET.cid || t - p.seen < STALE_MS);
        if (HOST.players.length !== before) { HOST.players.forEach((p, i) => { p.pid = i + 1; }); publish(); }
        else if (NET.connected && t - NET._lastPub > 2500) { NET._lastPub = t; publish(); }
      } else if (HOST.phase === "playing" && HOST.game && !HOST.game.finished) {
        if (t > HOST.deadline) { HOST.log.push("本轮超时：未提交者的行动按「不动」结算。"); resolveRound(); }
        else if (roundReady(t)) resolveRound();
      }
      if (NET.connected && t - NET._lastAuth > AUTH_MS) { NET._lastAuth = t; publish(); }
    } else {
      if (NET.connected && t - NET._presHb > HB_MS) { NET._presHb = t; publishPresence(true); }
      if (hostAlive()) NET.hostGone = 0;
      else {
        if (!NET.hostGone) NET.hostGone = t;
        if (canTakeover(t)) takeover();
      }
    }
  }

  /* ---- 对外动作 ---- */
  function send(payload) {
    if (!NET.client || !NET.connected) return false;
    NET.client.publish(TP("in"), JSON.stringify(Object.assign({ cid: NET.cid, name: NET.name }, payload)));
    return true;
  }
  function chat(text) {
    const s = String(text || "").trim();
    if (!s) return false;
    return send({ t: "chat", text: s.slice(0, 90) });
  }
  function submitMove(to) { return send({ t: "move", to }); }
  function rename(name) {
    const s = String(name || "").trim().slice(0, 12);
    if (!s || s === NET.name) return;
    NET.name = s;
    if (NET.active) send({ t: "join" });          // 房主在 lobby 阶段会据此改名
  }
  function startGameReq() { return send({ t: "start" }); }
  function againReq() { return send({ t: "again" }); }
  function pushSetup(s) { return send({ t: "setup", setup: s }); }

  /* 房主本地改设置（立即生效，并广播） */
  function localSetup(mut) {
    if (NET.role !== "host" || HOST.phase !== "lobby") return;
    const s = ensureSetup();
    mut(s);
    publish();
  }

  return {
    NET, HOST, MINP, MAXP, ROUND_MS,
    start, leave, tick, chat, submitMove, startGameReq, againReq, pushSetup, localSetup,
    set onUpdate(fn) { onUpdate = fn; },
    get onUpdateFn() { return onUpdate; },
    hostAlive, isCandidate, newRoom, defaultSetup, ensureSetup,
    get myPid() { return NET.myPid; }, set myPid(v) { NET.myPid = v; }
  };
})();
