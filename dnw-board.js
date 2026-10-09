/* ============================================================
 *  合成大奶娃 · 排行榜账本逻辑（UMD，纯函数、可单测）
 *  ------------------------------------------------------------
 *  数据库就是 GitHub 仓库本身：
 *
 *    data/board.json              总榜：前 100 名（每条只有摘要，很小）
 *    data/owners/<玩家ID>.json    单个玩家的对局原始数据：
 *                                 随机种子 + 动作序列（时间、投放位置）
 *                                 + 过程快照 + 分数
 *    data/voided.json             被抹除成绩的黑名单（只留指纹，不留数据）
 *
 *  规则（和需求一一对应）：
 *    · 每人（按 IP 区分）在榜上只留最好成绩 —— 一个 IP 一个 owner 文件；
 *    · 榜只记前 100 名，满了就顶掉分数最低的那位；
 *    · 没进前 100 就不写 GitHub（客户端直接显示「101 · 无记录」）；
 *    · 抹除成绩时把种子、动作序列一起删掉，只留一条「曾经因为什么被删」；
 *    · 数据库要抗缺位：board.json 里缺 id/owner/分数都能正常渲染，
 *      取不到 owner 文件就写「无记录」。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DNWBoard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TOP_N = 100;                 // 总榜记录前 100
  var NAME_MAX = 12;               // 按「字」算，不是按 UTF-16 码元 —— 一个表情算一个字

  /* 收拾昵称。三件事：
       1. 去掉控制字符和零宽字符 —— \u200b 这类看不见的东西会让排版看着"飘"；
       2. 去掉**孤立代理项**（半个表情）。它显示出来就是 �，
          而且一旦被写进数据库就永久坏掉 —— 排行榜中文/表情"不稳定"就是这么来的；
       3. 按**码点**截断到 NAME_MAX 个字，绝不把表情劈成两半。
     normalizeBoard 读数据时也走这里，所以库里的历史脏名字在显示时会被顺手修好。 */
  function cleanName(raw) {
    var n = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
      .trim();
    /* Array.from 按码点切：合法的表情是一个长度 2 的元素，
       孤立的半个表情是长度 1、码元落在 D800~DFFF 的元素 —— 这种直接丢掉。 */
    var chars = [];
    var arr = Array.from(n);
    for (var i = 0; i < arr.length; i++) {
      var ch = arr[i];
      var code = ch.charCodeAt(0);
      if (ch.length === 1 && code >= 0xD800 && code <= 0xDFFF) continue;
      chars.push(ch);
    }
    if (chars.length > NAME_MAX) chars = chars.slice(0, NAME_MAX);
    n = chars.join('').trim();
    return n || '匿名玩家';
  }

  /* 玩家标识：只存哈希，不存 IP 本身。
     客户端为了「知道自己是谁」会自己去取公网 IP 再哈希；
     拿不到 IP 时（离线、被拦）退化成浏览器本地随机 ID，
     不影响玩，只是换设备就变成另一个人。 */
  function hashIdentity(ip, salt) {
    var s = String(ip == null ? '' : ip) + '|' + String(salt == null ? '' : salt);
    var h1 = 2166136261 >>> 0, h2 = 2246822519 >>> 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2654435761) >>> 0;
      h2 = (h2 ^ (h2 >>> 13)) >>> 0;
    }
    return (h1.toString(36) + h2.toString(36)).padStart(13, '0').slice(0, 13);
  }

  /* 排序：分高的在前；同分先提交的在前（先到先得，也让名次稳定） */
  function cmpEntry(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    var ta = Number(a.submittedAt) || 0, tb = Number(b.submittedAt) || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  }

  function newBoard() {
    return {
      v: 1,
      updatedAt: 0,
      total: 0,
      topN: TOP_N,
      entries: []
    };
  }

  /* 把任意读到的 JSON 变成能安全渲染的 board —— 缺字段、类型不对都不炸 */
  function normalizeBoard(raw) {
    var b = newBoard();
    if (!raw || typeof raw !== 'object') return b;
    b.updatedAt = Number(raw.updatedAt) || 0;
    b.total = Number(raw.total) || 0;
    if (Number(raw.topN) > 0) b.topN = Number(raw.topN);
    var list = Array.isArray(raw.entries) ? raw.entries : [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || typeof e !== 'object') continue;          // 缺位 → 跳过，不炸
      var score = Number(e.score);
      if (!isFinite(score) || score < 0) continue;
      var id = String(e.id == null ? '' : e.id).trim();
      /* 空 id 是脏数据（早期版本在拿不到玩家标识时写进去的），直接忽略 */
      if (!id || id === 'null' || id === 'undefined') continue;
      if (seen[id]) continue;                       // 同一个玩家只留一条
      seen[id] = 1;
      b.entries.push({
        id: id,
        owner: String(e.owner == null ? '' : e.owner),
        name: cleanName(e.name),
        score: score,
        submittedAt: Number(e.submittedAt) || 0,
        runId: String(e.runId == null ? '' : e.runId),
        run: e.run && typeof e.run === 'object' ? e.run : null,
        flags: Number(e.flags) || 0
      });
    }
    b.entries.sort(cmpEntry);
    if (b.entries.length > b.topN) b.entries = b.entries.slice(0, b.topN);
    return b;
  }

  /* 够不够上榜。
     规则和排序是同一条：榜没满就进；榜满了，必须在这个「总分序」里
     排得比现有的第 100 名更靠前。同分比提交时间，先到的赢 ——
     所以刚投出来的同分成绩挤不掉榜尾（先到先得）。
     at（提交时间）不传时，按「时间上不占优」处理，结果最保守。 */
  function qualifies(board, score, at) {
    var s = Number(score);
    if (!isFinite(s) || s <= 0) return false;
    if (board.entries.length < board.topN) return true;
    var last = board.entries[board.entries.length - 1];
    var hasAt = at !== undefined && at !== null && isFinite(Number(at));
    var key = { score: s, submittedAt: hasAt ? Number(at) : Infinity, id: '' };
    return cmpEntry(key, last) < 0;
  }

  /* 我的名次：
       已经在榜上 → 就是榜上那一行的名次；
       否则按同一条总分序算出插进去会是第几；排不进前 100 就是 101
       （页面按需求写「101 · 无记录」）。 */
  function rankOf(board, id, score, at) {
    if (score === undefined || score === null || !isFinite(Number(score))) return null;
    var s = Number(score);

    for (var i = 0; i < board.entries.length; i++) {
      if (board.entries[i].id === id) return i + 1;
    }
    if (!qualifies(board, s, at)) return board.topN + 1;

    var rank = 1;
    for (var j = 0; j < board.entries.length; j++) {
      if (board.entries[j].score > s) rank++;
    }
    return rank;
  }

  /* 这个分数能不能进榜 —— 判的时候先把"我自己"从榜上摘掉。
     为什么不直接看现成的那条：如果我已经在榜上，而这一局没超过我自己，
     现有实现会把"没被替换"当成"没进榜"，两者是两回事：
       · 没进榜      → 数据库里不该有任何痕迹（初审就不通过）
       · 没刷新纪录  → 榜上已经有我更好的那条，不该重写
     分开之后，"我这条被顶到 101 名"也不会把后来真正该上的成绩误判掉。 */
  function qualifiesStandalone(board, id, score, at) {
    var s = Number(score);
    if (!isFinite(s) || s <= 0) return false;

    var removedMine = false;
    var rest = [];
    for (var i = 0; i < board.entries.length; i++) {
      if (board.entries[i].id === id) removedMine = true;   // 我原来那条被摘掉，等于腾出一个位子
      else rest.push(board.entries[i]);
    }
    /* 摘掉自己之后还有空位 → 进；否则要和剩下那条榜尾比 */
    if (rest.length < board.topN || removedMine) {
      if (rest.length < board.topN) return true;
      var tailMine = rest[rest.length - 1];
      var hasAt0 = at !== undefined && at !== null && isFinite(Number(at));
      return cmpEntry(
        { score: s, submittedAt: hasAt0 ? Number(at) : Infinity, id: '' },
        tailMine
      ) < 0;
    }
    var last = rest[rest.length - 1];
    var hasAt = at !== undefined && at !== null && isFinite(Number(at));
    return cmpEntry(
      { score: s, submittedAt: hasAt ? Number(at) : Infinity, id: '' },
      last
    ) < 0;
  }

  /* 写入一条成绩：同一个人只留最好的一次；榜满则顶掉最低那位。
     返回 { board, entry, rank, made, replaced } —— replaced 是被顶掉的那位（没有则 null）。 */
  function applyEntry(board, entry) {
    var b = normalizeBoard(board);
    var e = {
      id: String(entry.id),
      owner: String(entry.owner || ''),
      name: cleanName(entry.name),
      score: Number(entry.score) || 0,
      submittedAt: Number(entry.submittedAt) || 0,
      runId: String(entry.runId || ''),
      run: entry.run || null,
      flags: Number(entry.flags) || 0
    };

    var prevIdx = -1;
    for (var i = 0; i < b.entries.length; i++) {
      if (b.entries[i].id === e.id) { prevIdx = i; break; }
    }

    var prev = prevIdx >= 0 ? b.entries[prevIdx] : null;
    var rank;
    var replaced = null;

    if (prev && prev.score >= e.score) {
      /* 自己以前那次更好（或者一样），不动榜 —— 但名次照报，
         并把「没被替换」这件事告诉调用方，好让界面上给玩家一句解释。
         made 另外单独算：把"我"摘掉之后，这个分数本来就进不了榜吗？ */
      return {
        board: b, entry: prev, rank: prevIdx + 1, replaced: null,
        /* made：这一局**没有**写进榜（榜上还是我原来那条）。
           qualifiesStandalone：如果只按分数算，这一局够不够格上榜 —— 两件事分开。 */
        made: false,
        qualifiesStandalone: qualifiesStandalone(b, e.id, e.score, e.submittedAt),
        keptPrev: true, prevScore: prev.score
      };
    }

    if (prevIdx >= 0) b.entries.splice(prevIdx, 1);

    b.entries.push(e);
    b.entries.sort(cmpEntry);

    /* 名次要在截断之前算：截断会把垫底那条丢掉，
       如果新来的正好是垫底，截断后数组里就没它了，名次会变成 undefined。 */
    for (var k = 0; k < b.entries.length; k++) {
      if (b.entries[k].id === e.id) { rank = k + 1; break; }
    }

    if (b.entries.length > b.topN) {
      replaced = b.entries.pop();       // 垫底的那位被顶出去
    }

    var made = rank !== undefined && rank <= b.topN;

    return { board: b, entry: e, rank: made ? rank : b.topN + 1, made: made, replaced: replaced };
  }

  /* 抹除某个玩家的成绩（举报 → 复算不通过时用）。
     数据（种子 / 动作序列 / 快照）全部丢掉，黑名单里只留证据摘要。 */
  function voidEntry(board, id, info) {
    var b = normalizeBoard(board);
    var removed = null;
    for (var i = 0; i < b.entries.length; i++) {
      if (b.entries[i].id === id) { removed = b.entries.splice(i, 1)[0]; break; }
    }
    return {
      board: b,
      removed: removed,
      record: {
        id: String(id),
        name: removed ? removed.name : '',
        score: removed ? removed.score : 0,
        at: Number(info && info.at) || 0,
        reason: String((info && info.reason) || '复算不通过'),
        verifier: String((info && info.verifier) || ''),
        claim: (info && info.claim) || null
      }
    };
  }

  /* 名次徽章 */
  function rankLabel(i) { return i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1); }

  /* 没进榜的人横竖都显示这一句 */
  var NO_RECORD = '101 · 无记录（未进总榜，本地不写入 GitHub）';

  function formatScore(n) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return String(Math.round(v));
  }

  function timeAgo(ts, now) {
    var t = Number(ts) || 0;
    if (!t) return '';
    var d = Math.max(0, (now === undefined ? Date.now() : now) - t) / 1000;
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    return Math.floor(d / 86400) + ' 天前';
  }

  return {
    TOP_N: TOP_N,
    NO_RECORD: NO_RECORD,
    qualifiesStandalone: qualifiesStandalone,
    cleanName: cleanName,
    NAME_MAX: NAME_MAX,
    hashIdentity: hashIdentity,
    cmpEntry: cmpEntry,
    newBoard: newBoard,
    normalizeBoard: normalizeBoard,
    rankOf: rankOf,
    qualifies: qualifies,
    applyEntry: applyEntry,
    voidEntry: voidEntry,
    rankLabel: rankLabel,
    formatScore: formatScore,
    timeAgo: timeAgo
  };
});
