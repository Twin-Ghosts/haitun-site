/* =====================================================================
   对局记录（纯本地）—— games/_record.js
   —— 记录存在**本机浏览器**的 localStorage 里，不上传、不经过任何服务器。
      站点里所有游戏共用这一个模块；/record 页面读同一份数据来统计。
   —— 每条记录只保留四件事：
        参加者人数 n、每个参加者用户名 players[]、参加时间 at、结果 result
      （外加「这是哪个游戏」game / name，否则统计页没法分组）
   —— 每局结束时由各游戏调用 GAME_RECORD.tick({...}) 落盘。
   —— 硬约束：整份记录按 UTF-8 字节数计算，一旦超过 1 MiB 就**强制清空所有记录**，
      只把触发清空的那一局留作新起点。
   ===================================================================== */
(function (global) {
  "use strict";

  const KEY = "cryv.record.v1";
  const MAX_BYTES = 1024 * 1024;   // 1 MiB —— 超过就强制清空
  const MAX_PLAYERS = 16;          // 单局最多记多少人
  const MAX_NAME = 24;             // 用户名最长多少字
  const MAX_RESULT_CHARS = 200;

  const enc = new TextEncoder();
  const bytes = s => enc.encode(s).length;
  const nowMs = () => Date.now();

  function safeGet() { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
  function safeSet(s) { try { localStorage.setItem(KEY, s); return true; } catch (e) { return false; } }

  const empty = () => ({ v: 1, records: [], clearedAt: 0, clearedCount: 0, clearedWhy: "" });

  /* 坏数据（被手改、被别的版本写过）一律当空处理，不让页面炸掉 */
  function read() {
    const raw = safeGet();
    if (!raw) return empty();
    try {
      const o = JSON.parse(raw);
      if (!o || o.v !== 1 || !Array.isArray(o.records)) return empty();
      return {
        v: 1, records: o.records,
        clearedAt: o.clearedAt || 0,
        clearedCount: o.clearedCount || 0,
        clearedWhy: o.clearedWhy || ""
      };
    } catch (e) { return empty(); }
  }
  function write(o) { return safeSet(JSON.stringify(o)); }

  const size = () => bytes(safeGet());

  /* 人类可读的字节数 */
  function human(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  function rand() {
    const a = new Uint8Array(6);
    try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < 6; i++) a[i] = Math.floor(Math.random() * 256); }
    return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function str(v, n) { return String(v === undefined || v === null ? "" : v).slice(0, n); }

  function clear() {
    const old = read();
    const o = empty();
    o.clearedAt = nowMs();
    o.clearedCount = old.records.length;
    o.clearedWhy = "manual";     // 页面要区分「手动清空」和「超过 1 MB 被强制清空」
    write(o);
    return o;
  }

  /* 同一局的重复落盘保护。
     问题：render() 每帧都调 tick()，同一局会被喊很多次；页面刷新后又会重来一遍。
     做法：把「这一局的临时身份」存进 sessionStorage —— 刷新后仍是同一个 id，
           于是同局不会重复落盘；而同一标签页里重新开局时，over() 先变回 false，
           身份就被作废，下一局会拿到新 id（所以真正的再战一局不会被误吞）。 */
  function ssKey(spec) { return "cryv.rec." + str(spec.game, 32); }
  function ssGet(k) { try { return sessionStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function ssSet(k, v) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch (e) { } }

  function push(rec) {
    let st = read();
    if (st.records.some(r => r.id === rec.id)) return { ok: true, skipped: "dup-id" };

    st.records.push(rec);
    let s = JSON.stringify(st);

    if (bytes(s) > MAX_BYTES) {
      /* 超过 1 MiB —— 强制清空所有记录，只保留触发清空的这一局作为新起点 */
      const wiped = st.records.length - 1;
      st = empty();
      st.clearedAt = nowMs();
      st.clearedCount = wiped;
      st.clearedWhy = "auto";
      st.records = [rec];
      write(st);
      return { ok: true, cleared: true, wiped: wiped };
    }
    if (!write(st)) return { ok: false, reason: "quota" };
    return { ok: true };
  }

  /* ---------------- 游戏侧入口 ----------------
     spec 里的取值全部写成「函数」，因为 render() 每帧都会调用本函数，
     必须在调用那一刻才取值。
       over()    -> 本局是否已结束（必填）
       game      -> 目录名，如 'weiqi'
       name      -> 中文名，如 '围棋'
       result()  -> 对局结果文字
       players() -> 每个参加者的用户名（字符串数组）
  ---------------------------------------------- */
  let sid = null;        // 本次「一局」的临时身份，对局重置后作废
  let lastResult = null;

  function tick(spec) {
    if (!spec || typeof spec.over !== "function") return;
    let over = false;
    try { over = !!spec.over(); } catch (e) { over = false; }

    const k = ssKey(spec);
    if (!over) {                       // 对局已重置 / 还没结束：作废本次身份
      if (sid !== null) ssSet(k, "");
      sid = null;
      return;
    }
    if (sid === null) {
      sid = ssGet(k);                  // 刷新页面后沿用同一个身份，避免重复记一遍
      if (!sid) { sid = "r-" + rand(); ssSet(k, sid); }
    }

    const st = read();
    if (st.records.some(r => r.id === sid)) return;

    const call = (fn, d) => { try { return fn ? fn() : d; } catch (e) { return d; } };

    const players = (call(spec.players, []) || [])
      .map(p => str(typeof p === "string" ? p : (p && p.name), MAX_NAME).trim())
      .filter(Boolean)
      .slice(0, MAX_PLAYERS);

    let result = str(call(spec.result, ""), MAX_RESULT_CHARS);
    if (!result) result = "对局结束";

    const rec = {
      id: sid,
      game: str(spec.game, 32),
      name: str(spec.name, 24),
      at: nowMs(),                     // 参加时间
      n: players.length,               // 参加者人数
      players: players,                // 每个参加者用户名
      result: result                   // 结果
    };

    const r = push(rec);
    lastResult = r;
    return r;
  }

  const api = {
    KEY, MAX_BYTES, MAX_PLAYERS,
    size, human, read, write, clear, push, tick, bytes,
    count: () => read().records.length,
    last: () => lastResult,
    resetForTest: () => {
      sid = null; lastResult = null;
      try {
        const kill = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && k.indexOf("cryv.rec.") === 0) kill.push(k);
        }
        kill.forEach(k => sessionStorage.removeItem(k));
      } catch (e) { }
    }
  };
  global.GAME_RECORD = api;
  global.GameRecord = api;      // 两个名字都挂上，游戏里怎么写都能用
})(window);
