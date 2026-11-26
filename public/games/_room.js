/* =====================================================================
   dev 区通用联机服务（多人、隐藏信息、房主权威）
   —— 纯静态：消息只经公共 MQTT 中继（broker.emqx.io）转发，不经过任何自有服务器。
   —— 房主 = 当前负责裁定对局的那台浏览器，持有完整状态（含隐藏身份）。
       公开快照 pub 只放"人人可见"的部分；每个玩家的隐藏信息单独发到 p/<cid>。
       房主掉线后，房间内仍在线的浏览器里 cid 最小的自动接管，从保留的 auth
       快照（完整状态）接着走。
   —— 已知边界：公共中继无鉴权，房号即凭据；别在公开场合贴房号，
       也别拿它做赌注。私信走独立主题，只是"不广播"，不是加密。
   ===================================================================== */
(function (global) {
  "use strict";

  /* ---------------- 极简 MQTT 3.1.1 over WebSocket（QoS0） ---------------- */
  const _enc = new TextEncoder(), _dec = new TextDecoder();
  const _cat = arrs => { let n = 0; arrs.forEach(a => n += a.length); const o = new Uint8Array(n); let p = 0; arrs.forEach(a => { o.set(a, p); p += a.length; }); return o; };
  const _u16 = n => new Uint8Array([(n >> 8) & 255, n & 255]);
  const _mstr = s => { const b = _enc.encode(s); return _cat([_u16(b.length), b]); };
  const _vint = n => { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0); return new Uint8Array(o); };
  const _pkt = (type, flags, body) => { const rl = _vint(body.length); const h = new Uint8Array(rl.length + 1); h[0] = (type << 4) | flags; h.set(rl, 1); return _cat([h, body]); };

  class MiniMQTT {
    constructor(url, opts) { this.url = url; this.opts = opts || {}; this.buf = new Uint8Array(0); this.h = {}; this.connected = false; this.tries = 0; this.closed = false; }
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
      ws.onclose = () => { this.connected = false; this.fire("close"); if (!this.closed) { const d = Math.min(10000, 1200 * Math.pow(1.5, this.tries++)); setTimeout(() => this.connect(), d); } };
    }
    _connectPkt() {
      const cid = this.opts.clientId || ("c" + Math.random().toString(16).slice(2, 10));
      let flags = 0x02; const payload = [_mstr(cid)];
      if (this.opts.will) { flags |= 0x04 | 0x20; payload.push(_mstr(this.opts.will.topic), _mstr(this.opts.will.payload || "")); }
      const vh = _cat([_mstr("MQTT"), new Uint8Array([4, flags]), _u16(this.opts.keepalive || 40)]);
      return _pkt(1, 0, _cat([vh, _cat(payload)]));
    }
    _send(b) { if (this.ws && this.ws.readyState === 1) this.ws.send(b); }
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
        const head = this.buf[0]; let i = 1, mul = 1, len = 0, b;
        do { if (i >= this.buf.length) return; b = this.buf[i++]; len += (b & 127) * mul; mul *= 128; } while (b & 128);
        if (this.buf.length < i + len) return;
        const body = this.buf.slice(i, i + len); this.buf = this.buf.slice(i + len);
        this._handle(head >> 4, head & 15, body);
      }
    }
    _handle(type, flags, body) {
      if (type === 2) {
        this.connected = (body[1] === 0);
        if (this.connected) this.fire("connect"); else this.fire("error", new Error("CONNACK " + body[1]));
      } else if (type === 3) {
        const tl = (body[0] << 8) | body[1]; let off = 2 + tl;
        if ((flags & 6) === 2 || (flags & 6) === 4) off += 2;
        this.fire("message", { topic: _dec.decode(body.slice(2, 2 + tl)), payload: _dec.decode(body.slice(off)) });
      }
    }
  }

  /* ---------------- 房间控制器 ----------------
     游戏页提供 adapter：
       initGame(players)          -> 全新完整状态（房主权威，谈隐藏信息）
       act(state, msg)            -> {ok, state, log}；msg = {type, data, seat, cid, players}
       pubView(state)             -> 公开视图（人人可见）
       privView(state, cid)       -> 该玩家私密视图（身份/夜间行动等）
       over(state)                -> null 或 {winner, reason}
     ------------------------------------------------ */
  const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
  const HB_MS = 5000, STALE_MS = 22000, TAKEOVER_MS = 6000;
  const ROOM_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const ridHex = () => { const a = new Uint8Array(6); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); };
  const newRoom = () => { const a = new Uint8Array(4); crypto.getRandomValues(a); return [...a].map(b => ROOM_ABC[b % ROOM_ABC.length]).join(""); };
  const nowMs = () => Date.now();

  function create(o) {
    const A = o.adapter, NS = o.ns, MAXP = o.maxPlayers || 12, MINP = o.minPlayers || 5;
    const NAMELEN = o.maxLen || 10;
    const TP = s => NS + NET.room + "/" + s;

    const NET = {
      active: false, role: null, client: null, room: null, cid: "", name: "玩家", connected: false,
      seats: [], seat: -1, pub: null, priv: null, chat: [], log: [], phase: "", over: null,
      hostSeen: 0, hostDeclared: false, hostCid: null, hostEpoch: 0, hostGone: 0, auth: null, authSeen: 0,
      presence: new Map(), timers: [], claimEpoch: 0, _hh: 0, _pp: 0, _sig: ""
    };
    const HOST = { seats: [], state: null, log: [], chat: [], seen: new Map(), started: false };
    let renderHook = () => { };

    const flash = m => { if (o.flash) return o.flash(m); let el = document.getElementById("flash"); if (!el) { el = document.createElement("div"); el.id = "flash"; document.body.appendChild(el); } el.textContent = m; el.classList.add("show"); clearTimeout(NET._ft); NET._ft = setTimeout(() => el.classList.remove("show"), 2400); };
    const render = () => { try { renderHook(); } catch (e) { console.error(e); } };
    const mySeat = () => { for (let i = 0; i < NET.seats.length; i++) if (NET.seats[i] && NET.seats[i].cid === NET.cid) return i; return -1; };
    const alive = () => !!NET.hostDeclared && (nowMs() - NET.hostSeen) < STALE_MS;

    /* ---------- 房主广播 ---------- */
    function pubHostAlive() {
      if (!NET.client || !NET.connected) return;
      NET.client.publish(TP("host"), JSON.stringify({ cid: NET.cid, alive: true, ts: nowMs(), epoch: NET.claimEpoch }), { retain: true });
      NET.hostCid = NET.cid; NET.hostEpoch = NET.claimEpoch; NET.hostSeen = nowMs(); NET.hostDeclared = true; NET.hostGone = 0;
      publishPresence(true);
    }
    function publishPresence(a) {
      if (!NET.client || !NET.connected || !NET.room) return;
      NET.client.publish(TP("presence/" + NET.cid), JSON.stringify({ cid: NET.cid, alive: !!a }), { retain: true });
    }
    function hostPublish() {
      if (!NET.client || NET.role !== "host") return;
      const c = NET.client, seats = HOST.seats;
      const pub = { v: 1, ts: nowMs(), room: NET.room, seats, started: HOST.started, over: A.over(HOST.state),
                    view: A.pubView(HOST.state), log: HOST.log.slice(-80), chat: HOST.chat.slice(-30), hostCid: NET.cid };
      const s = JSON.stringify(pub);
      c.publish(TP("pub"), s, { retain: true });
      c.publish(TP("auth"), JSON.stringify({ v: 1, ts: nowMs(), seats, state: HOST.state, log: HOST.log.slice(-60), chat: HOST.chat.slice(-20), started: HOST.started }), { retain: true });
      // 每人的私密视图单独发（按座位序号取，游戏侧无需知道 cid）
      seats.forEach((st, i) => {
        if (!st || !st.cid) return;
        const pv = A.privView(HOST.state, i);
        c.publish(TP("p/" + st.cid), JSON.stringify({ v: 1, ts: nowMs(), seat: i, priv: pv }), { retain: true });
      });
      NET._pp = nowMs();
    }

    /* ---------- 房主收消息 ---------- */
    function hostOn(msg) {
      if (!msg || !msg.cid) return;
      const c = NET.client, seats = HOST.seats;
      const idx = seats.findIndex(s => s && s.cid === msg.cid);
      if (msg.t === "join") {
        if (HOST.started) { if (idx < 0) c.publish(TP("p/" + msg.cid), JSON.stringify({ v: 1, denied: "已开局，等这一局结束再加" }), { retain: true }); return; }
        if (idx < 0) {
          if (seats.length >= MAXP) { c.publish(TP("p/" + msg.cid), JSON.stringify({ v: 1, denied: "房间已满" }), { retain: true }); return; }
          seats.push({ cid: msg.cid, name: String(msg.name || "玩家").slice(0, NAMELEN) });
          HOST.chat.push({ sys: true, text: (msg.name || "玩家") + " 加入了房间" });
        } else if (msg.name) seats[idx].name = String(msg.name).slice(0, NAMELEN);
        HOST.seen.set(msg.cid, nowMs());
        hostPublish(); render(); return;
      }
      if (msg.t === "chat") {
        const txt = String(msg.text || "").slice(0, 90); if (!txt) return;
        const nm = (idx >= 0 ? seats[idx].name : msg.name) || "?";
        HOST.chat.push({ name: String(nm).slice(0, NAMELEN), text: txt, seat: idx });
        if (HOST.chat.length > 40) HOST.chat = HOST.chat.slice(-40);
        hostPublish(); render(); return;
      }
      if (idx < 0 || !HOST.started) return;
      const r = A.act(HOST.state, { type: msg.t, data: msg.data, seat: idx, cid: msg.cid, players: seats });
      if (!r || !r.ok) return;
      HOST.state = r.state;
      if (r.log) HOST.log.push(r.log);
      if (HOST.log.length > 80) HOST.log = HOST.log.slice(-80);
      hostPublish(); render();
    }

    function hostStart() {
      if (NET.role !== "host") return;
      if (HOST.seats.length < MINP) { flash("至少 " + MINP + " 人才能开局"); return; }
      HOST.state = A.initGame(HOST.seats.slice());
      HOST.started = true; HOST.log = ["开局：" + HOST.seats.map(s => s.name).join("、")];
      hostPublish(); render();
    }
    function hostTakeover() {
      const a = NET.auth && NET.auth.v === 1 ? NET.auth : null;
      NET.role = "host"; NET.claimEpoch = nowMs() + Math.floor(Math.random() * 800) + 1;
      HOST.seats = a ? a.seats.slice() : [{ cid: NET.cid, name: NET.name }];
      HOST.state = a ? a.state : null; HOST.started = !!(a && a.started);
      HOST.log = a && a.log ? a.log.slice() : []; HOST.chat = a && a.chat ? a.chat.slice() : [];
      HOST.seen = new Map(); HOST.seats.forEach(s => s.cid && HOST.seen.set(s.cid, nowMs()));
      if (NET.client && NET.connected) { NET.client.subscribe([TP("in")]); NET.client.publish(TP("in"), JSON.stringify({ t: "join", cid: NET.cid, name: NET.name })); }
      pubHostAlive(); hostPublish(); flash("房主离线，本机已接管"); render();
    }
    function stepDown(cid, ep) {
      if (NET.role !== "host") return;
      NET.role = "guest"; NET.hostCid = cid; NET.hostEpoch = ep; NET.hostSeen = nowMs(); NET.hostDeclared = true; NET.hostGone = 0;
      flash("有更新的房主接手，本机转为普通玩家"); render();
    }
    function hostsAlive() { return alive(); }
    function candidate() { if (NET.role !== "guest" || !NET.connected) return false; const t = nowMs(); const live = []; for (const [cid, p] of NET.presence) { if (p.alive && t - p.seen < STALE_MS && cid !== NET.hostCid) live.push(cid); } if (!live.includes(NET.cid)) live.push(NET.cid); return live.sort()[0] === NET.cid; }
    function canTakeover(t) { return candidate() && HOST.started !== null && (NET.auth ? (t - NET.authSeen) < STALE_MS * 2 : false) && (t - NET.hostGone) >= TAKEOVER_MS; }

    /* ---------- 玩家侧 ---------- */
    function start(role, room, name) {
      leave(true);
      NET.active = true; NET.role = role; NET.room = room; NET.name = (name || "玩家").slice(0, NAMELEN);
      NET.cid = ridHex(); NET.seats = []; NET.seat = -1; NET.pub = null; NET.priv = null;
      NET.chat = []; NET.log = []; NET.over = null; NET.hostSeen = 0; NET.hostDeclared = false; NET.hostCid = null;
      NET.hostEpoch = 0; NET.hostGone = 0; NET.auth = null; NET.authSeen = 0; NET.claimEpoch = 0; NET.presence = new Map(); NET._sig = "";
      HOST.seats = role === "host" ? [{ cid: NET.cid, name: NET.name }] : [];
      HOST.state = null; HOST.started = false; HOST.log = []; HOST.chat = []; HOST.seen = new Map();
      const opts = { clientId: (o.clientPrefix || "room") + "_" + NET.cid, keepalive: 40 };
      opts.will = role === "host"
        ? { topic: TP("host"), payload: JSON.stringify({ cid: NET.cid, alive: false, ts: nowMs(), epoch: 0 }) }
        : { topic: TP("presence/" + NET.cid), payload: JSON.stringify({ cid: NET.cid, alive: false }) };
      const c = NET.client = new MiniMQTT(BROKER_URL, opts);
      c.on("error", e => { const m = (e && e.message) ? e.message : String(e); console.warn("[room] " + m); if (m !== "ws error") flash("中继错误：" + m); });
      c.on("connect", () => {
        NET.connected = true;
        const subs = [TP("pub"), TP("host"), TP("auth"), TP("presence/+"), TP("p/" + NET.cid)];
        if (role === "host") subs.push(TP("in"));
        c.subscribe(subs); publishPresence(true);
        c.publish(TP("in"), JSON.stringify({ t: "join", cid: NET.cid, name: NET.name }));
        if (role === "host") { NET.claimEpoch = nowMs() + Math.floor(Math.random() * 800) + 1; pubHostAlive(); hostPublish(); }
        render();
      });
      c.on("close", () => { NET.connected = false; render(); });
      c.on("message", m => {
        let p = null; try { p = JSON.parse(m.payload); } catch (e) { return; }
        if (m.topic === TP("pub")) {
          if (!p || !p.v) return;
          NET.seats = p.seats || []; NET.seat = mySeat(); NET.over = p.over || null;
          if (p.view !== undefined) NET.pub = p.view;
          NET.log = p.log || []; NET.chat = p.chat || [];
          render();
        } else if (m.topic === TP("p/" + NET.cid)) {
          if (p && p.denied) { flash(p.denied); return; }
          NET.priv = p && p.priv !== undefined ? p.priv : null; NET.seat = p ? p.seat : NET.seat; render();
        } else if (m.topic === TP("auth")) {
          if (p && p.v === 1) { NET.auth = p; NET.authSeen = nowMs(); }
        } else if (m.topic === TP("host")) {
          if (!p) return;
          if (p.alive) {
            if (NET.role === "host") { if (p.cid !== NET.cid && (p.epoch || 0) > NET.claimEpoch) stepDown(p.cid, p.epoch); }
            else { NET.hostCid = p.cid; NET.hostEpoch = p.epoch || 0; NET.hostSeen = nowMs(); NET.hostDeclared = true; NET.hostGone = 0; render(); }
          } else if (p.cid === NET.hostCid) { NET.hostDeclared = false; NET.hostSeen = nowMs(); render(); }
        } else if (m.topic.indexOf(TP("presence/")) === 0) {
          if (p && p.cid) { NET.presence.set(p.cid, { alive: !!p.alive, seen: nowMs() }); render(); }
        } else if (m.topic === TP("in") && NET.role === "host") hostOn(p);
      });
      c.connect();
      try { location.hash = "#r=" + room; } catch (e) { }
      NET.timers.push(setInterval(tick, 1000));
      NET.timers.push(setInterval(() => {
        if (!NET.client || !NET.connected) return;
        NET.client.ping();
        if (NET.role === "guest") NET.client.publish(TP("in"), JSON.stringify({ t: "join", cid: NET.cid, name: NET.name }));
        else publishPresence(true);
      }, HB_MS));
      render();
    }
    function tick() {
      if (!NET.active) return;
      const t = nowMs();
      if (NET.role === "host") {
        if (NET.connected && t - NET._hh > HB_MS) { NET._hh = t; pubHostAlive(); }
        if (NET.connected && t - NET._pp > 2500) hostPublish();
      } else {
        if (!hostsAlive()) {
          if (!NET.hostGone) NET.hostGone = t;
          if (candidate() && NET.auth && (t - NET.hostGone) >= TAKEOVER_MS && (t - NET.authSeen) < STALE_MS * 2) hostTakeover();
        } else NET.hostGone = 0;
        if (NET.connected && t - NET._hh > HB_MS) { NET._hh = t; publishPresence(true); }
      }
      render();
    }
    function leave(keep) {
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
      const was = NET.active;
      NET.active = false; NET.client = null; NET.room = null; NET.connected = false;
      NET.seats = []; NET.seat = -1; NET.pub = null; NET.priv = null; NET.chat = []; NET.log = []; NET.over = null;
      NET.hostDeclared = false; NET.hostSeen = 0; NET.hostCid = null; NET.hostEpoch = 0; NET.hostGone = 0;
      NET.auth = null; NET.authSeen = 0; NET.presence = new Map(); NET.claimEpoch = 0;
      HOST.seats = []; HOST.state = null; HOST.started = false; HOST.log = []; HOST.chat = []; HOST.seen = new Map();
      if (location.hash.indexOf("#r=") === 0) try { history.replaceState(null, "", location.pathname); } catch (e) { }
      if (was && !keep) { if (o.onLeave) o.onLeave(); flash("已离开房间"); }
    }

    /* ---------- 动作 ---------- */
    function send(type, data) {
      if (!NET.active) return false;
      if (NET.role === "host") {
        if (!HOST.started) return false;
        const seat = HOST.seats.findIndex(s => s && s.cid === NET.cid);
        if (seat < 0) return false;
        const r = A.act(HOST.state, { type, data, seat, cid: NET.cid, players: HOST.seats });
        if (!r || !r.ok) return false;
        HOST.state = r.state; if (r.log) HOST.log.push(r.log);
        hostPublish(); render(); return true;
      }
      if (!NET.client || !NET.connected) { flash("还没连上中继"); return false; }
      NET.client.publish(TP("in"), JSON.stringify({ t: type, cid: NET.cid, name: NET.name, data }));
      return true;
    }
    function sendChat(text) {
      const s = String(text || "").trim(); if (!s) return;
      if (!NET.active || !NET.client) return;
      NET.client.publish(TP("in"), JSON.stringify({ t: "chat", cid: NET.cid, name: NET.name, text: s.slice(0, 90) }));
    }
    function copyLink(url) {
      const done = () => flash("邀请链接已复制，发给朋友即可进房");
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => { });
      else { try { const t = document.createElement("textarea"); t.value = url; document.body.appendChild(t); t.select(); document.execCommand("copy"); document.body.removeChild(t); done(); } catch (e) { } }
    }

    return {
      net: NET, host: HOST, BROKER_URL, MiniMQTT,
      start, leave, send, sendChat, copyLink, newRoom, nowMs, flash, render,
      setRender: fn => { renderHook = fn; },
      startGame: hostStart,
      isOnline: () => NET.active, isHost: () => NET.role === "host", hostAlive: hostsAlive,
      mySeat, seatCount: () => MAXP, minPlayers: () => MINP,
      roomCode: () => NET.room,
      // 单机模式下：页面对本地权威状态跑同一套 reducer
      reduce: (state, msg) => A.act(state, msg),
      initGame: players => A.initGame(players),
      pubView: state => A.pubView(state),
      privView: (state, cid) => A.privView(state, cid),
      over: state => A.over(state)
    };
  }

  global.RoomNet = { create, MiniMQTT, BROKER_URL };
})(window);
