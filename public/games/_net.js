/* =====================================================================
   棋盘类游戏共用联机层（围棋 / 中国象棋 / 国际象棋）
   —— 纯静态：消息只经公共 MQTT 中继（broker.emqx.io）转发，不经过任何自有服务器。
   —— 房主 = 当前负责裁定对局的那台浏览器。房主掉线（关页面/断网/关机/休眠）后，
      房间内仍在线的浏览器里 cid 最小的那位会自动接管，并从保留的 auth 快照接着走。
   —— 座位模型：房主维护 seats = [{cid,name}]，第 0 位先行、第 1 位后手。
      每个客户端从公开快照里按自己的 cid 找座位，即得自己的执子方。
   —— 快照：pub 人人可见（含棋局状态）、auth 接管续局用（含棋局状态）。
   —— 已知边界：公共中继无鉴权，房号即凭据；别在公开场合贴房号，也别拿它做赌注。
   ===================================================================== */
(function (global) {
  "use strict";

  /* ---------------- 极简 MQTT 3.1.1 over WebSocket（QoS0） ---------------- */
  const _enc = new TextEncoder();
  const _dec = new TextDecoder();
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
      let flags = 0x02;
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
    ping() { if (this.connected) this._send(new Uint8Array([0xC0, 0])); }
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
      if (type === 2) {
        this.connected = (body[1] === 0);
        if (this.connected) this.fire("connect"); else this.fire("error", new Error("CONNACK " + body[1]));
      } else if (type === 3) {
        const tl = (body[0] << 8) | body[1];
        let off = 2 + tl;
        if ((flags & 6) === 2 || (flags & 6) === 4) off += 2;
        this.fire("message", { topic: _dec.decode(body.slice(2, 2 + tl)), payload: _dec.decode(body.slice(off)) });
      }
    }
  }

  /* ---------------- 对局联机控制器 ----------------
     游戏页提供 adapter：
       seatCount()      -> 座位数（棋类固定 2）
       initGame()       -> 新建「零状态」对局并把状态写回本地
       state()          -> 当前本地对局的可序列化状态（房主权威）
       loadState(s)     -> 用状态整体替换本地对局并重绘
       applyMove(mv)    -> 在本地对局上执行一步（房主裁定用），返回是否合法
       turnSeat()       -> 当前该谁走：0=先行方，1=后手方
       describeMove(mv,side) -> 棋谱文字（可选）
       onControl(ctl,side,{host}) -> 悔棋/重开等（可选），返回是否生效
       onLeave()        -> 离开房间时复位（可选）
  ------------------------------------------------ */
  const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
  const HB_MS = 5000, STALE_MS = 25000, TAKEOVER_MS = 6000;
  const ROOM_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

  const ridHex = () => { const a = new Uint8Array(6); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); };
  const newRoom = () => { const a = new Uint8Array(4); crypto.getRandomValues(a); return [...a].map(b => ROOM_ABC[b % ROOM_ABC.length]).join(""); };
  const nowMs = () => Date.now();

  function create(o) {
    const A = o.adapter;
    const NS = o.namespace;
    const SEATS = A.seatCount ? A.seatCount() : 2;
    const NAMELEN = o.maxLen || 12;
    const TP = s => NS + NET.room + "/" + s;

    const NET = {
      active: false, role: null, client: null, room: null, cid: "", name: "玩家", connected: false,
      hostSeen: 0, hostDeclared: false, hostCid: null, hostEpoch: 0, hostGone: 0, joinAt: 0,
      presence: new Map(), auth: null, authSeen: 0, claimEpoch: 0,
      seats: [], seatIdx: -1, state: null, ply: 0, log: [], chat: [], timers: [],
      hostLastHb: 0, hostLastPub: 0, _presHb: 0, _lastMergeSig: ""
    };
    const HOST = { seats: [], state: null, ply: 0, seen: new Map(), log: [], chat: [] };
    let renderHook = () => { };

    const hostsAlive = () => !!NET.hostDeclared && (nowMs() - NET.hostSeen) < STALE_MS;
    const mySeat = () => (NET.role === "host") ? netSeatFromSeats() : NET.seatIdx;
    function netSeatFromSeats() {
      for (let i = 0; i < (NET.seats || []).length; i++) if (NET.seats[i] && NET.seats[i].cid === NET.cid) return i;
      return -1;
    }
    function livePresence() {
      const t = nowMs(), out = [];
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
      // 只有「正在对局中」才接管：大厅阶段房主走了，谁都可以新开一局，不必抢
      if (!isCandidate() || !NET.connected) return false;
      if (NET.state === null) return false;
      if (t - NET.hostGone < TAKEOVER_MS) return false;
      const freshAuth = !!(NET.auth && (t - NET.authSeen) < STALE_MS * 2);
      return !!(NET.hostSeen || freshAuth);
    }
    function flash(msg) {
      let el = document.getElementById("flash");
      if (!el) { el = document.createElement("div"); el.id = "flash"; document.body.appendChild(el); }
      el.textContent = msg; el.classList.add("show");
      clearTimeout(NET._ft); NET._ft = setTimeout(() => el.classList.remove("show"), 2400);
    }
    function render() { try { renderHook(); } catch (e) { console.error(e); } }

    /* ---------- 房主：广播 ---------- */
    function hostSeats() {
      if (!HOST.seats.length) HOST.seats = [{ cid: NET.cid, name: NET.name }];
      return HOST.seats.slice(0, SEATS);
    }
    function pubHostAlive() {
      if (!NET.client || !NET.connected) return;
      NET.client.publish(TP("host"), JSON.stringify({ cid: NET.cid, alive: true, ts: nowMs(), epoch: NET.claimEpoch }), { retain: true });
      NET.hostCid = NET.cid; NET.hostEpoch = NET.claimEpoch;
      NET.hostSeen = nowMs(); NET.hostDeclared = true; NET.hostGone = 0;
      publishPresence(true);
    }
    function hostPublish() {
      if (!NET.client || NET.role !== "host") return;
      const snap = {
        v: 1, ts: nowMs(), room: NET.room, hostCid: NET.cid,
        seats: hostSeats(), inGame: HOST.state !== null,
        state: HOST.state, ply: HOST.ply,
        log: HOST.log.slice(-120), chat: HOST.chat.slice(-40)
      };
      const s = JSON.stringify(snap);
      NET.client.publish(TP("pub"), s, { retain: true });
      NET.client.publish(TP("auth"), s, { retain: true });   // 接管直接用同一份完整快照
      NET.hostLastPub = nowMs();
    }
    function publishPresence(alive) {
      if (!NET.client || !NET.connected || !NET.room) return;
      NET.client.publish(TP("presence/" + NET.cid), JSON.stringify({ cid: NET.cid, alive: !!alive }), { retain: true });
    }

    /* ---------- 房主：收消息 ---------- */
    function hostOnMessage(msg) {
      if (!msg || !msg.cid) return;
      const who = HOST.seats.find(s => s.cid === msg.cid);
      if (who) HOST.seen.set(msg.cid, nowMs());
      if (msg.t === "join") {
        if (HOST.state !== null) return;                          // 已开局，不再收人
        if (!who) {
          if (hostSeats().length >= SEATS) return;                 // 满座
          HOST.seats.push({ cid: msg.cid, name: String(msg.name || "玩家").slice(0, NAMELEN) });
          HOST.chat.push({ sys: true, text: (msg.name || "玩家") + " 加入了房间" });
        } else if (msg.name) { who.name = String(msg.name).slice(0, NAMELEN); }
        HOST.seen.set(msg.cid, nowMs());
        hostPublish(); render();
      } else if (msg.t === "chat") {
        const txt = String(msg.text || "").slice(0, 90);
        if (!txt) return;
        HOST.chat.push({ name: String(msg.name || "?").slice(0, NAMELEN), text: txt });
        if (HOST.chat.length > 60) HOST.chat = HOST.chat.slice(-60);
        hostPublish(); render();
      } else if (msg.t === "move") {
        if (HOST.state === null) return;
        const seat = hostSeats().findIndex(s => s.cid === msg.cid);
        if (seat < 0) return;
        const want = A.turnSeat ? A.turnSeat() : 0;
        if (seat !== want) return;                                // 不是你的回合
        if (!A.applyMove(msg.mv, { host: true })) return;
        HOST.ply++; HOST.state = A.state();
        const txt = A.describeMove ? A.describeMove(msg.mv, seat) : null;
        if (txt) HOST.log.push(txt);
        hostPublish(); render();
      } else if (msg.t === "ctl") {
        const seat = hostSeats().findIndex(s => s.cid === msg.cid);
        if (seat < 0) return;
        if (A.onControl && A.onControl(msg.ctl, seat, { host: true })) {
          HOST.ply++; HOST.state = A.state();
          const t = A.describeControl ? A.describeControl(msg.ctl, seat) : null;
          if (t) HOST.log.push(t);
          hostPublish(); render();
        }
      }
    }

    /* ---------- 房主：开局 / 接管 ---------- */
    function hostStartGame() {
      if (NET.role !== "host") return;
      if (hostSeats().length < SEATS) { flash("还缺对手，先等另一位加入"); return; }
      HOST.state = null;
      A.initGame();                                   // 重置本地棋局
      HOST.state = A.state();
      HOST.ply = 0;
      HOST.log = ["对局开始：" + hostSeats().map(s => s.name).join(" vs "), hostSeats()[0].name + " 先行。"];
      HOST.chat.push({ sys: true, text: "对局开始，祝好运。" });
      hostPublish(); render();
    }
    function hostTakeover() {
      const a = (NET.auth && NET.auth.v === 1) ? NET.auth : null;
      NET.role = "host";
      NET.claimEpoch = nowMs() + Math.floor(Math.random() * 800) + 1;
      HOST.seats = (a && a.seats ? a.seats.slice() : [{ cid: NET.cid, name: NET.name }]);
      HOST.state = (a && a.state !== undefined) ? a.state : null;
      HOST.ply = (a && a.ply) || 0;
      HOST.log = (a && a.log ? a.log.slice() : []);
      HOST.chat = (a && a.chat ? a.chat.slice() : []);
      HOST.seen = new Map();
      if (HOST.state !== null) {
        A.loadState(HOST.state);
        HOST.log.push("房主掉线，已由房间内另一位接管，对局继续。");
      } else {
        HOST.seats = [{ cid: NET.cid, name: NET.name }];
      }
      HOST.seats.forEach(s => { if (s.cid) HOST.seen.set(s.cid, nowMs()); });
      if (NET.client && NET.connected) {
        NET.client.subscribe([TP("in")]);
        NET.client.publish(TP("in"), JSON.stringify({ t: "join", cid: NET.cid, name: NET.name }));
      }
      pubHostAlive(); hostPublish();
      flash("房主离线，本机已接管");
      render();
    }
    function stepDown(cid, epoch) {
      if (NET.role !== "host") return;
      const keep = HOST.state;
      NET.role = "guest";
      NET.hostCid = cid; NET.hostEpoch = epoch;
      NET.hostSeen = nowMs(); NET.hostDeclared = true; NET.hostGone = 0;
      flash("有更新的房主接手，本机转为普通玩家");
      render();
    }

    /* ---------- 公开快照 → 本地 ---------- */
    function mergePub(p) {
      if (!p || !p.v) return;
      NET.seats = p.seats || [];
      NET.ply = p.ply || 0;
      NET.log = p.log || [];
      NET.chat = p.chat || [];
      NET.seatIdx = netSeatFromSeats();
      const st = (p.state === undefined) ? null : p.state;
      NET.state = st;
      const sig = JSON.stringify([p.ply, st]);
      if (st !== null && sig !== NET._lastMergeSig) {
        NET._lastMergeSig = sig;
        if (NET.role !== "host") A.loadState(st);      // 房主自己已经是权威状态，不重载
      }
      render();
    }

    /* ---------- 生命周期 ---------- */
    function start(role, room, name) {
      leave(true);
      NET.active = true; NET.role = role; NET.room = room; NET.name = (name || "玩家").slice(0, NAMELEN);
      NET.cid = ridHex(); NET.hostSeen = 0; NET.hostDeclared = false; NET.hostCid = null;
      NET.hostEpoch = 0; NET.hostGone = 0; NET.presence = new Map(); NET.auth = null; NET.authSeen = 0;
      NET.claimEpoch = 0; NET.joinAt = nowMs(); NET.seats = []; NET.seatIdx = -1;
      NET.state = null; NET.ply = 0; NET.log = []; NET.chat = []; NET._lastMergeSig = "";
      HOST.seats = []; HOST.state = null; HOST.ply = 0; HOST.log = []; HOST.chat = []; HOST.seen = new Map();
      if (role === "host") HOST.seats = [{ cid: NET.cid, name: NET.name }];
      const opts = { clientId: (o.clientPrefix || "board") + "_" + NET.cid, keepalive: 40 };
      opts.will = (role === "host")
        ? { topic: TP("host"), payload: JSON.stringify({ cid: NET.cid, alive: false, ts: nowMs(), epoch: 0 }) }
        : { topic: TP("presence/" + NET.cid), payload: JSON.stringify({ cid: NET.cid, alive: false }) };
      const c = NET.client = new MiniMQTT(BROKER_URL, opts);
      c.on("connect", () => {
        NET.connected = true;
        const subs = [TP("pub"), TP("host"), TP("auth"), TP("presence/+")];
        if (role === "host") subs.push(TP("in"));
        c.subscribe(subs);
        publishPresence(true);
        c.publish(TP("in"), JSON.stringify({ t: "join", cid: NET.cid, name: NET.name }));
        if (role === "host") { NET.claimEpoch = nowMs() + Math.floor(Math.random() * 800) + 1; pubHostAlive(); hostPublish(); }
        render();
      });
      c.on("close", () => { NET.connected = false; if (NET.active) render(); });
      c.on("message", m => {
        let p = null; try { p = JSON.parse(m.payload); } catch (e) { return; }
        if (m.topic === TP("pub")) {
          if (p && p.ts) mergePub(p);
        } else if (m.topic === TP("auth")) {
          if (p && p.v === 1) { NET.auth = p; NET.authSeen = nowMs(); }
        } else if (m.topic === TP("host")) {
          if (!p) return;
          const ep = p.epoch || 0;
          if (p.alive) {
            if (NET.role === "host") {
              if (p.cid !== NET.cid && ep > NET.claimEpoch) stepDown(p.cid, ep);
            } else {
              NET.hostCid = p.cid; NET.hostEpoch = ep; NET.hostSeen = nowMs(); NET.hostDeclared = true; NET.hostGone = 0;
              render();
            }
          } else if (p.cid === NET.hostCid) {
            NET.hostDeclared = false; NET.hostSeen = nowMs(); render();
          }
        } else if (m.topic.indexOf(TP("presence/")) === 0) {
          if (!p || !p.cid) return;
          NET.presence.set(p.cid, { alive: !!p.alive, seen: nowMs() });
          render();
        } else if (m.topic === TP("in") && NET.role === "host") {
          hostOnMessage(p);
        }
      });
      c.connect();
      location.hash = "#r=" + room;
      NET.timers.push(setInterval(netTick, 1000));
      NET.timers.push(setInterval(() => {
        if (!NET.client || !NET.connected) return;
        NET.client.ping();
        if (NET.role === "guest") NET.client.publish(TP("in"), JSON.stringify({ t: "join", cid: NET.cid, name: NET.name }));
        else publishPresence(true);
      }, HB_MS));
      render();
    }
    function netTick() {
      if (!NET.active) return;
      const t = nowMs();
      if (NET.role === "host") {
        if (NET.connected && t - NET.hostLastHb > HB_MS) { NET.hostLastHb = t; pubHostAlive(); }
        if (NET.connected && t - NET.hostLastPub > 2500) hostPublish();
      } else {
        if (NET.connected && t - NET._presHb > HB_MS) { NET._presHb = t; publishPresence(true); }
        if (hostsAlive()) NET.hostGone = 0;
        else {
          if (!NET.hostGone) NET.hostGone = t;
          if (canTakeover(t)) hostTakeover();
        }
      }
      render();
    }
    function leave(keepMode) {
      NET.timers.forEach(t => clearInterval(t)); NET.timers = [];
      if (NET.client) {
        try {
          if (NET.connected && NET.room) {
            NET.client.publish(TP("presence/" + NET.cid), JSON.stringify({ cid: NET.cid, alive: false }), { retain: true });
            if (NET.role === "host") NET.client.publish(TP("host"), JSON.stringify({ cid: NET.cid, alive: false, ts: nowMs(), epoch: 0 }), { retain: true });
          }
          NET.client.close();
        } catch (e) { }
      }
      const wasActive = NET.active;
      NET.active = false; NET.client = null; NET.room = null; NET.connected = false;
      NET.hostDeclared = false; NET.hostSeen = 0; NET.hostCid = null; NET.hostEpoch = 0; NET.hostGone = 0;
      NET.presence = new Map(); NET.auth = null; NET.authSeen = 0; NET.claimEpoch = 0;
      NET.seats = []; NET.seatIdx = -1; NET.state = null; NET.ply = 0; NET.log = []; NET.chat = []; NET._lastMergeSig = "";
      HOST.seats = []; HOST.state = null; HOST.ply = 0; HOST.log = []; HOST.chat = []; HOST.seen = new Map();
      if (location.hash.indexOf("#r=") === 0) history.replaceState(null, "", location.pathname);
      if (wasActive && !keepMode) { if (A.onLeave) A.onLeave(); flash("已离开房间"); }
    }

    /* ---------- 玩家动作 ---------- */
    function sendMove(mv) {
      if (!NET.client || !NET.connected) { flash("还没连上中继"); return false; }
      if (NET.role === "host") {
        const seat = mySeat();
        if (seat < 0) return false;
        const want = A.turnSeat ? A.turnSeat() : 0;
        if (seat !== want) { flash("现在不是你的回合"); return false; }
        if (!A.applyMove(mv, { host: true })) { flash("这一步不合规则"); return false; }
        HOST.ply++; HOST.state = A.state();
        const txt = A.describeMove ? A.describeMove(mv, seat) : null;
        if (txt) HOST.log.push(txt);
        hostPublish(); render();
        return true;
      }
      if (NET.seatIdx < 0) { flash("正在同步座位，稍候…"); return false; }
      if (A.turnSeat && NET.seatIdx !== A.turnSeat()) { flash("现在不是你的回合"); return false; }
      NET.client.publish(TP("in"), JSON.stringify({ t: "move", cid: NET.cid, name: NET.name, mv }));
      return true;
    }
    function sendControl(ctl) {
      if (!NET.client || !NET.connected) { flash("还没连上中继"); return false; }
      if (NET.role === "host") {
        const seat = mySeat();
        if (A.onControl && A.onControl(ctl, seat, { host: true })) {
          HOST.ply++; HOST.state = A.state();
          const t = A.describeControl ? A.describeControl(ctl, seat) : null;
          if (t) HOST.log.push(t);
          hostPublish(); render();
          return true;
        }
        return false;
      }
      NET.client.publish(TP("in"), JSON.stringify({ t: "ctl", cid: NET.cid, name: NET.name, ctl }));
      return true;
    }
    function sendChat(text) {
      const s = String(text || "").trim();
      if (!s) return;
      if (!NET.client || !NET.connected) { flash("还没连上中继"); return; }
      NET.client.publish(TP("in"), JSON.stringify({ t: "chat", cid: NET.cid, name: NET.name, text: s.slice(0, 90) }));
      document.querySelectorAll("#chatInput,#chatInputLobby").forEach(el => el.value = "");
    }
    function copyLink() {
      const el = document.getElementById("roomLink");
      if (!el) return;
      const done = () => flash("邀请链接已复制，发给朋友即可进房");
      if (navigator.clipboard) navigator.clipboard.writeText(el.value).then(done, () => { el.select(); done(); });
      else { el.select(); document.execCommand("copy"); done(); }
    }

    return {
      net: NET, host: HOST, MiniMQTT, BROKER_URL, seats: SEATS,
      start, leave, sendMove, sendControl, sendChat, copyLink,
      newRoom, flash, nowMs, render,
      isOnline: () => NET.active,
      isHost: () => NET.role === "host",
      hostAlive: hostsAlive,
      isCandidate,
      mySide: () => mySeat(),
      seatCount: () => SEATS,
      startGame: () => hostStartGame(),
      inGame: () => NET.state !== null,
      roomCode: () => NET.room,
      setRender: fn => { renderHook = fn; }
    };
  }

  global.BoardNet = { create, MiniMQTT, BROKER_URL };
})(window);
