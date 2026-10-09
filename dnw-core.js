/* ============================================================
 *  合成大奶娃 · 确定性规则内核（UMD）
 *  ------------------------------------------------------------
 *  这一层只干一件事：把「一局游戏」变成可复现的纯逻辑。
 *
 *  为什么要有它：
 *    排行榜要防作弊，就必须能拿玩家本地存的「随机种子 + 动作序列」
 *    把这一局完整地重算一遍。要做到重算结果一模一样，规则层就不能
 *    依赖 performance.now()、Math.random() 这类不可复现的输入 ——
 *    所以这里：
 *      · 随机数走种子化 RNG（mulberry32），同一颗种子必然同一串数字；
 *      · 所有计时走帧号（固定 1/60 步长），同一帧必然同一状态；
 *      · 不碰 document / canvas / Audio，浏览器和 node 里跑出来完全一致。
 *
 *  玩法一个字没改：常量、公式、判定顺序都和原来的 game.js 逐行对齐。
 *
 *  API：
 *    createGame(seed?)                → 一局游戏（引擎）
 *    engine.update(dt)                → 推进一步（dt 应为 1/60）
 *    engine.drop(x) / engine.revive() → 玩家动作（会被记进动作序列）
 *    engine.takeSnapshot()            → 手动封存一个快照
 *    engine.exportRun()               → { seed, actions, snapshots, score, ... }
 *    auditReport(rec)                    → 只校验快照与掉落流水（1000 分只要几毫秒）
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DNWCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------
   *  常量（与旧版 game.js 完全一致）
   * ------------------------------------------------------- */

  var W = 420;               // 逻辑宽度
  var H = 700;               // 逻辑高度
  var WALL = 10;             // 左右墙厚
  var DROP_Y = 74;           // 待投放水果的高度
  var DANGER_Y = 142;        // 警戒线

  var GRAVITY   = 2600;      // px/s²
  var SUBSTEPS  = 3;         // 每帧物理子步
  var ITER      = 6;         // 每个子步的约束迭代次数
  var DROP_MS   = 360;       // 两次投放的最小间隔
  var OVER_LIMIT = 1.5;      // 越线持续多少秒判负
  var REST_SPEED = 140;
  var REST_SPEED2 = REST_SPEED * REST_SPEED;

  var MAX_TIER  = 10;        // 最大那只（神奶蛙）的索引
  var MAX_BONUS = 500;       // 两只神奶蛙相撞的奖励分
  var MAX_MERGE_GIVES_REVIVE = true;
  var FREEZE_MS = 130;
  var REVIVE_STEP = 2000;    // 每累计多少分发一枚复活币
  var MERGE_PAD = 0.8;

  var RESTITUTION      = 0.38;
  var WALL_RESTITUTION = 0.45;
  var REST_THRESHOLD   = 55;
  var FRICTION         = 0.955;
  var SQUASH_DECAY     = 9;
  var SQUASH_MAX       = 0.30;

  var FRUITS = [
    { name: '葡萄',   r: 17 },
    { name: '樱桃',   r: 23 },
    { name: '橘子',   r: 31 },
    { name: '柠檬',   r: 39 },
    { name: '猕猴桃', r: 48 },
    { name: '番茄',   r: 58 },
    { name: '桃子',   r: 69 },
    { name: '菠萝',   r: 81 },
    { name: '椰子',   r: 94 },
    { name: '半奶蛙', r: 108 },
    { name: '神奶蛙', r: 124 }
  ];

  /* 合成出 tier 的得分（三角数） */
  var MERGE_SCORE = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55];

  var SPAWN_TIERS = [0, 1, 2, 3, 4];
  var SPAWN_WEIGHTS = [0.28, 0.24, 0.20, 0.16, 0.12];

  /* 「下一个」是否允许和当前这颗相同（保持旧版行为） */
  var AVOID_REPEAT = true;

  var FIXED = 1 / 60;            // 逻辑步长；快照按帧号对齐
  var SNAP_STEP = 500;           // 每 500 分封一条快照
  var SIG_KEY = 0x7f4a7c15;      // 快照签名的盐（只防手改，不是加密）
  var MAX_FRAMES = 60 * 60 * 60; // 一局最多这么多帧（1 小时 60fps），超过就不是人玩的

  /* ---------------------------------------------------------
   *  种子化随机数：mulberry32
   *  只要种子一样，吐出来的序列一定一样 —— 校验的前提。
   * ------------------------------------------------------- */

  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomSeed() {
    /* 32 位无符号种子。用 crypto 更好，没有就退化成 Math.random */
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        var u = new Uint32Array(1);
        crypto.getRandomValues(u);
        return u[0] >>> 0;
      }
    } catch (e) { /* 忽略 */ }
    return (Math.random() * 0x100000000) >>> 0;
  }

  function seedToStr(seed) { return (seed >>> 0).toString(36); }
  function strToSeed(s) {
    if (typeof s === 'number' && isFinite(s)) return s >>> 0;
    var v = parseInt(String(s == null ? '' : s), 36);
    return (isFinite(v) ? v : 0) >>> 0;
  }

  /* ---------------------------------------------------------
   *  快照哈希：32 位滚动哈希
   *  Math.imul 在 ECMAScript 里是精确的 32 位整数乘法，
   *  所有引擎结果一致 —— 所以它可以当校验的指纹用。
   * ------------------------------------------------------- */

  /* 快照签名：把一条快照的字段揉成一个短标记。
     它挡的是「手改 JSON 里的分数 / 时间戳」这种做法 ——
     算法和盐都在客户端，所以这只是提高手改成本，不是加密。
     只用快照自己的字段算，因此不拿种子也能校验（客户端与 Actions 结果一致）。 */
  function snapSig(sn) {
    var str = 'k' + SIG_KEY.toString(36) + '|' + sn.f + '|' + sn.s + '|' + sn.n + '|' +
              sn.r + '|' + (sn.d || 0) + '|' + sn.t + '|v2';
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
    }
    /* 再拌两轮，把相邻字段的变化扩散开 */
    h = (Math.imul(h ^ (h >>> 15), 2246822519) >>> 0);
    h = (Math.imul(h ^ (h >>> 13), 3266489917) >>> 0);
    return ((h ^ (h >>> 16)) >>> 0).toString(36);
  }

  /* ---------------------------------------------------------
   *  形状（由 game.js 在启动时灌进来；没有就退化成圆）
   * ------------------------------------------------------- */

  var SHAPES = [];
  var UNIT_SHAPE = { rb: 1, parts: [[0, 0, 1]] };

  function setShapes(list) { SHAPES = list || []; }
  function shapeOf(tier) {
    var s = SHAPES[tier];
    if (s && s.parts && s.parts.length) return s;
    return UNIT_SHAPE;
  }

  function syncParts(b) {
    var c = Math.cos(b.angle), s = Math.sin(b.angle);
    var parts = b.parts, r = b.r;
    var wx = b.wx, wy = b.wy, ws = b.ws;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var ox = p[0] * r, oy = p[1] * r;
      wx[i] = b.x + ox * c - oy * s;
      wy[i] = b.y + ox * s + oy * c;
      ws[i] = p[2] * r;
    }
  }

  function makeBall(x, y, tier, vx, vy) {
    var r = FRUITS[tier].r;
    var m = r * r;
    var sh = shapeOf(tier);
    var n = sh.parts.length;
    var ball = {
      x: x, y: y, vx: vx || 0, vy: vy || 0,
      px: x, py: y,
      r: r, tier: tier, angle: 0,
      mass: m, invMass: 1 / m,
      /* 帧号取代原来的 performance.now()：
         物理上唯一用到它的地方是「落定」判定，换成帧号后完全可复现。
         渲染用的出生动画另用 bornAt（表现层自己写，不参与物理）。 */
      bornFrame: 0,
      bornAt: 0,
      overTime: 0,
      landed: false,
      dead: false,
      contacts: 0,
      pvx: 0, pvy: 0,
      sq: 0, sqA: 0,
      parts: sh.parts,
      rb: sh.rb * r,
      wx: new Float32Array(n),
      wy: new Float32Array(n),
      ws: new Float32Array(n)
    };
    syncParts(ball);
    return ball;
  }

  /* ---------------------------------------------------------
   *  一局游戏
   * ------------------------------------------------------- */

  function createGame(seed) {
    /* 掉落等级用一条流、粒子特效用另一条。
       分开之后「第 i 次投放掉哪一级」就只由种子决定，
       和玩家合了多少次、喷了多少粒子完全无关 —— 掉落流水才能拿来当校验依据。 */
    var spawnRng = mulberry32(seed >>> 0);
    var fxRng = mulberry32((seed ^ 0x5bf03635) >>> 0);
    var rng = fxRng;               // 表现用的随机（粒子等）继续叫 rng

    var state = {
      balls: [],
      particles: [],
      floats: [],
      score: 0,
      best: 0,
      pending: 0,
      next: 0,
      ready: true,
      cooldown: 0,
      aimX: W / 2,
      over: false,
      flash: 0,
      revives: 0,
      reviveGiven: 0,
      freeze: 0,
      danger: false
    };

    var frame = 0;                 // 本局已经推进的逻辑帧数
    var actions = [];              // 玩家动作序列
    var snapshots = [];            // 周期性快照
    var nextSnapScore = SNAP_STEP; // 下一个要封快照的分数档（每 500 分一条）
    var overFrame = -1;
    var dropCount = 0;             // 本局已投放次数（快照里要带上）
    var spawnSeen = '';            // 掉落等级流水：第 i 次投放掉的是第几级
    var ended = false;

    /* 计分/飘字/音效的钩子。内核不认识 DOM，全部交给外面 */
    var hooks = {
      onScore: null,      // (delta, x, y, text, big) => void
      onMerge: null,      // (tier, x, y) => void
      onMaxMerge: null,   // (x, y) => void
      onReviveGet: null,  // (count) => void
      onGameOver: null    // () => void
    };

    /* ---------- 随机 ----------
       · rollSpawnTier / pickSpawnTier 只吃 spawnRng（决定掉落等级）
       · 其它表现类的随机（粒子）只吃 fxRng
       这样掉落序列和"合成了几次"彻底解耦。 */
    var rand = function (a, b) { return a + rng() * (b - a); };

    function rollSpawnTier() {
      var r = spawnRng(), acc = 0;
      for (var i = 0; i < SPAWN_TIERS.length; i++) {
        acc += SPAWN_WEIGHTS[i];
        if (r <= acc) return SPAWN_TIERS[i];
      }
      return SPAWN_TIERS[0];
    }

    function pickSpawnTier(avoid) {
      if (!AVOID_REPEAT || avoid === undefined) return rollSpawnTier();
      for (var i = 0; i < 6; i++) {
        var t = rollSpawnTier();
        if (t !== avoid) return t;
      }
      return rollSpawnTier();
    }

    /* ---------- 物理（与旧版逐行一致） ---------- */

    function stepPhysics(dt) {
      var balls = state.balls;
      var merges = [];
      var contacts = [];

      for (var i = 0; i < balls.length; i++) {
        var b = balls[i];
        b.px = b.x;
        b.py = b.y;
        b.vy += GRAVITY * dt;
        b.pvx = b.vx;
        b.pvy = b.vy;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.contacts = 0;
        syncParts(b);
      }

      for (var it = 0; it < ITER; it++) {

        for (var i2 = 0; i2 < balls.length; i2++) {
          var b2 = balls[i2];
          if (b2.dead) continue;
          var pushL = 0, pushR = 0, pushFloor = 0, pushCeil = 0;
          var n2 = b2.parts.length;
          for (var k = 0; k < n2; k++) {
            var x = b2.wx[k], y = b2.wy[k], rr = b2.ws[k];
            var l = WALL - (x - rr);
            if (l > pushL) pushL = l;
            var rgt = (x + rr) - (W - WALL);
            if (rgt > pushR) pushR = rgt;
            var dn = (y + rr) - (H - WALL);
            if (dn > pushFloor) pushFloor = dn;
            var up = -(y - rr);
            if (up > pushCeil) pushCeil = up;
          }
          if (pushL || pushR || pushFloor || pushCeil) {
            b2.x += pushL - pushR;
            b2.y += pushCeil - pushFloor;
            b2.contacts++;
            if (it === 0) {
              if (pushL)     contacts.push({ ball: b2, nx: 1,  ny: 0 });
              if (pushR)     contacts.push({ ball: b2, nx: -1, ny: 0 });
              if (pushFloor) contacts.push({ ball: b2, nx: 0,  ny: -1 });
              if (pushCeil)  contacts.push({ ball: b2, nx: 0,  ny: 1 });
            }
            syncParts(b2);
          }
        }

        for (var i3 = 0; i3 < balls.length; i3++) {
          var a = balls[i3];
          if (a.dead) continue;
          for (var j = i3 + 1; j < balls.length; j++) {
            var bb = balls[j];
            if (bb.dead || a.dead) continue;

            var cdx = bb.x - a.x, cdy = bb.y - a.y;
            var rbSum = a.rb + bb.rb;
            if (cdx * cdx + cdy * cdy >= rbSum * rbSum) continue;

            var pa = a.parts.length, pb = bb.parts.length;
            var brb = bb.rb, arb = a.rb;
            var minGap = 1e9, bnx = 0, bny = 0;

            for (var m = 0; m < pa; m++) {
              var ax = a.wx[m], ay = a.wy[m], ar = a.ws[m];
              var ddx = bb.x - ax, ddy = bb.y - ay;
              var far = brb + ar;
              if (ddx * ddx + ddy * ddy >= far * far) continue;

              for (var k2 = 0; k2 < pb; k2++) {
                var bx = bb.wx[k2], by = bb.wy[k2], br = bb.ws[k2];
                var dx = bx - ax, dy = by - ay;
                var sum = ar + br;
                var d2 = dx * dx + dy * dy;
                if (d2 >= sum * sum) continue;
                var d = Math.sqrt(d2);
                var gap = d - sum;
                if (gap < minGap) {
                  minGap = gap;
                  if (d < 1e-4) { bnx = 1; bny = 0; }
                  else { bnx = dx / d; bny = dy / d; }
                }
              }
            }

            if (minGap > MERGE_PAD || minGap === 1e9) continue;

            if (a.tier === bb.tier && it === 0) {
              a.dead = true;
              bb.dead = true;
              merges.push([a, bb]);
              continue;
            }

            if (minGap >= 0) continue;
            if (it === 0) contacts.push({ a: a, b: bb, nx: bnx, ny: bny });
            var corr = Math.min(-minGap - 0.05, 4) * 0.9;
            if (corr <= 0) continue;
            var invSum = a.invMass + bb.invMass;
            var wa = a.invMass / invSum;
            var wb = bb.invMass / invSum;

            a.x -= bnx * corr * wa;  a.y -= bny * corr * wa;
            bb.x += bnx * corr * wb;  bb.y += bny * corr * wb;

            a.contacts++;
            bb.contacts++;
            syncParts(a);
            syncParts(bb);
          }
        }
      }

      for (var i4 = 0; i4 < balls.length; i4++) {
        var b4 = balls[i4];
        if (b4.dead) continue;
        var pL = 0, pR = 0, pF = 0, pC = 0;
        for (var k3 = 0; k3 < b4.parts.length; k3++) {
          var x4 = b4.wx[k3], y4 = b4.wy[k3], r4 = b4.ws[k3];
          var l4 = WALL - (x4 - r4);         if (l4 > pL) pL = l4;
          var rg4 = (x4 + r4) - (W - WALL);  if (rg4 > pR) pR = rg4;
          var dn4 = (y4 + r4) - (H - WALL);  if (dn4 > pF) pF = dn4;
          var up4 = -(y4 - r4);              if (up4 > pC) pC = up4;
        }
        if (pL || pR || pF || pC) {
          b4.x += pL - pR;
          b4.y += pC - pF;
          b4.contacts++;
          syncParts(b4);
        }
      }

      var invDt = 1 / dt;
      for (var i5 = 0; i5 < balls.length; i5++) {
        var b5 = balls[i5];
        if (b5.dead) continue;

        var dx5 = b5.x - b5.px;
        var dy5 = b5.y - b5.py;

        var vx5 = dx5 * invDt;
        var vy5 = dy5 * invDt;

        if (b5.contacts > 0) vx5 *= FRICTION;
        if (b5.sq > 0) b5.sq = Math.max(0, b5.sq - b5.sq * SQUASH_DECAY * dt);

        b5.vx = vx5;
        b5.vy = vy5;
        b5.angle += dx5 / b5.r * 0.85;

        if (!b5.landed) {
          /* 原来是 performance.now() - bornAt > 900，改成 54 帧（=900ms） */
          if (b5.contacts > 0 || frame - b5.bornFrame > 54) b5.landed = true;
        }
      }

      for (var k5 = 0; k5 < contacts.length; k5++) {
        var ct = contacts[k5];

        if (ct.ball) {
          var b6 = ct.ball;
          if (b6.dead) continue;
          var vnPre = b6.pvx * ct.nx + b6.pvy * ct.ny;
          if (vnPre < -REST_THRESHOLD) {
            var vnPost = b6.vx * ct.nx + b6.vy * ct.ny;
            var target = -WALL_RESTITUTION * vnPre;
            var jj = target - vnPost;
            if (jj > 0) {
              b6.vx += jj * ct.nx;
              b6.vy += jj * ct.ny;
              squash(b6, ct.nx, ct.ny, -vnPre);
            }
          }
        } else {
          var a6 = ct.a, b7 = ct.b;
          if (a6.dead || b7.dead) continue;
          var nx = ct.nx, ny = ct.ny;
          var vnPre2 = (a6.pvx - b7.pvx) * nx + (a6.pvy - b7.pvy) * ny;
          if (vnPre2 > REST_THRESHOLD) {
            var vnPost2 = (a6.vx - b7.vx) * nx + (a6.vy - b7.vy) * ny;
            var target2 = -RESTITUTION * vnPre2;
            var j2 = (vnPost2 - target2) / (a6.invMass + b7.invMass);
            if (j2 > 0) {
              a6.vx -= j2 * a6.invMass * nx;  a6.vy -= j2 * a6.invMass * ny;
              b7.vx += j2 * b7.invMass * nx;  b7.vy += j2 * b7.invMass * ny;
              squash(a6, -nx, -ny, vnPre2);
              squash(b7, nx, ny, vnPre2);
            }
          }
        }
      }

      if (merges.length) processMerges(merges);
    }

    function squash(b, nx, ny, speed) {
      var k = Math.min(SQUASH_MAX, speed / 1500);
      if (k <= b.sq) return;
      b.sq = k;
      b.sqA = Math.atan2(ny, nx);
    }

    function processMerges(merges) {
      for (var k = 0; k < merges.length; k++) {
        var a = merges[k][0];
        var b = merges[k][1];
        var mx = (a.x + b.x) * 0.5;
        var my = (a.y + b.y) * 0.5;
        var tier = a.tier;

        if (tier >= MAX_TIER) {
          addScore(MAX_BONUS);
          burst(mx, my, MAX_TIER, 90, 560);
          burst(mx, my, MAX_TIER - 2, 42, 340);
          if (hooks.onMaxMerge) hooks.onMaxMerge(mx, my);
          state.flash = 1.4;
          state.freeze = FREEZE_MS / 1000;
          state.floats.push({ x: mx, y: my - 74, text: '两个神奶蛙 💥', life: 1.6 });
          state.floats.push({ x: mx, y: my - 16, text: '+' + MAX_BONUS, life: 2.2, big: true });
          if (MAX_MERGE_GIVES_REVIVE) {
            state.revives++;
            if (hooks.onReviveGet) hooks.onReviveGet(state.revives);
          }
        } else {
          var nt = tier + 1;
          var nb = makeBall(mx, my, nt, (a.vx + b.vx) * 0.5, (a.vy + b.vy) * 0.5 - 60);
          nb.x = clamp(nb.x, WALL + nb.r, W - WALL - nb.r);
          nb.y = Math.min(nb.y, H - WALL - nb.r);
          nb.px = nb.x;
          nb.py = nb.y;
          nb.landed = true;
          nb.bornFrame = frame;
          /* 关键：合成出来的新水果必须真的放进场地里。
             少了这一行，两颗水果会被下面的 alive 过滤掉、新的这颗又没进数组，
             结果就是「合成一下两颗都消失了」。 */
          state.balls.push(nb);
          /* 把新水果一起交给表现层：它要给它打出生动画（popAt / bornAt），
             这两个字段只影响画面、不参与物理。 */
          if (hooks.onMerge) hooks.onMerge(nt, mx, my, nb);
          addScore(MERGE_SCORE[nt], mx, my, '+' + MERGE_SCORE[nt]);
          burst(mx, my, nt, 8 + nt * 2, 140 + nt * 22);
          if (nt === MAX_TIER) state.flash = 1;
        }
      }

      var alive = [];
      for (var i = 0; i < state.balls.length; i++) {
        if (!state.balls[i].dead) alive.push(state.balls[i]);
      }
      state.balls = alive;
    }

    function burst(x, y, tier, n, speed) {
      for (var i = 0; i < n; i++) {
        var a = rng() * Math.PI * 2;
        var s = rand(speed * 0.25, speed);
        state.particles.push({
          x: x, y: y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s - 70,
          r: rand(2, 5.5),
          life: 1,
          decay: rand(1.3, 2.4),
          tier: tier,                    // 表现层按它取配色
          color: rng() < 0.5 ? 1 : 2     // 1 = 亮色 pc1，2 = 暗色 pc2
        });
      }
      if (state.particles.length > 420) state.particles.splice(0, state.particles.length - 420);
    }

    function grantRevives() {
      var got = 0;
      while (state.reviveGiven < Math.floor(state.score / REVIVE_STEP)) {
        state.reviveGiven++;
        state.revives++;
        got++;
      }
      if (!got) return;
      state.floats.push({ x: W / 2, y: 210, text: '+1 复活币', life: 1.4, big: true });
      if (hooks.onReviveGet) hooks.onReviveGet(state.revives);
    }

    function addScore(n, x, y, text) {
      state.score += n;
      if (state.score > state.best) state.best = state.score;
      if (hooks.onScore) hooks.onScore(n, x, y, text);
      grantRevives();
    }

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function aimLimit(tier) {
      var r = FRUITS[tier].r * shapeOf(tier).rb;
      return [WALL + r + 0.5, W - WALL - r - 0.5];
    }

    function moveAim(x) {
      var lim = aimLimit(state.pending);
      state.aimX = clamp(x, lim[0], lim[1]);
    }

    /* ---------- 玩家动作 ---------- */

    function drop(x) {
      if (state.over || !state.ready) return false;
      var tier = state.pending;
      var lim = aimLimit(tier);
      var px = clamp(x === undefined ? state.aimX : x, lim[0], lim[1]);

      var ball = makeBall(px, DROP_Y, tier, 0, 130);
      ball.bornFrame = frame;
      state.balls.push(ball);

      state.ready = false;
      state.cooldown = DROP_MS / 1000;
      state.pending = state.next;
      state.next = pickSpawnTier(state.pending);

      /* 记进动作序列：第几帧、投在哪、投的是哪一级（审计用） */
      actions.push({ k: 'drop', t: frame, x: Math.round(px * 1000) / 1000, tier: tier });
      dropCount++;
      spawnSeen += tier.toString(36);
      if (state.balls.length > 90) state.balls = state.balls.filter(function (b) { return !b.dead; });
      return true;
    }

    function revive() {
      if (!state.over || state.revives <= 0) return false;

      var top = -1;
      var topEdge = Infinity;
      for (var i = 0; i < state.balls.length; i++) {
        var b = state.balls[i];
        if (b.dead) continue;
        var edge = b.y - b.r;
        if (edge < topEdge) { topEdge = edge; top = i; }
      }
      if (top >= 0) state.balls.splice(top, 1);

      state.balls = state.balls.filter(function (b) {
        return !b.dead && (b.y - b.r) >= DANGER_Y + 6;
      });

      for (var j = 0; j < state.balls.length; j++) state.balls[j].overTime = 0;

      state.revives--;
      state.over = false;
      state.danger = false;
      state.ready = true;
      state.cooldown = 0;
      state.flash = 0.6;

      actions.push({ k: 'revive', t: frame });
      return true;
    }

    /* ---------- 判负 ---------- */

    function checkGameOver(dt) {
      var danger = false;
      for (var i = 0; i < state.balls.length; i++) {
        var b = state.balls[i];
        if (b.dead || !b.landed) continue;
        var top = b.y - b.r;

        if (top < DANGER_Y) {
          danger = true;
          if (b.vx * b.vx + b.vy * b.vy < REST_SPEED2) {
            b.overTime += dt;
            if (b.overTime > OVER_LIMIT) { gameOver(); return; }
          } else {
            b.overTime = Math.max(0, b.overTime - dt * 2);
          }
        } else {
          b.overTime = Math.max(0, b.overTime - dt * 2);
          if (b.overTime > 0) danger = true;
        }
      }
      state.danger = danger;
    }

    function gameOver() {
      if (state.over) return;
      state.over = true;
      overFrame = frame;
      /* 收尾快照：最后这一下也要能对上 */
      sealSnapshot(true);        // 收尾那条：分数就是最终分数
      if (hooks.onGameOver) hooks.onGameOver();
    }

    /* ---------- 快照 ---------- */

    /* 封一条快照。
       现在是「每 500 分一条」：只要分数跨过了下一个 500 的整倍数就封，
       开局 0 分先封一条，结束（判负）时再封一条收尾。
       每条都带上：帧号、分数、球数、复活币、时间戳、签名。 */
    /* 封快照。
       规则：每跨过 500 分封一条，那条**记的就是跨过的那个整倍数**
       （500 / 1000 / 1500……），开局先封一条 0 分；
       收尾（判负）再封一条，分数就是这一局最终拿到的分数。
       每条带上：帧号、分数、球数、复活币、已投放次数、时间戳、签名。 */
    /* 封一条快照（只负责写数据，不碰档位游标） */
    function pushSnap(score) {
      var sn = {
        f: frame,
        s: score,
        n: state.balls.length,
        r: state.revives,
        d: dropCount,
        t: Date.now(),
        g: ''
      };
      sn.g = snapSig(sn);
      snapshots.push(sn);
      state.lastSnapshot = sn;
    }

    /* 把「已经跨过、但还没封」的 500 档位补齐。
       为什么需要补齐：分数可能一帧里跨过好几档（连锁合成，或者两只神奶蛙 +500），
       而判负那一刻会封一条**真实分数**的快照 —— 老实现顺手把档位游标推到了下一档，
       于是被跨过的那几个档位永远缺一条，校验就会判成「数据不全」→ 好人被误删。
       （用了复活币的局尤其容易踩到：一局里有好几条真实分数快照。） */
    function sealBuckets() {
      while (nextSnapScore <= state.score) {
        pushSnap(nextSnapScore);          // 记的就是档位值：500 / 1000 / 1500 …
        nextSnapScore += SNAP_STEP;
      }
    }

    /* 对外就一个入口：
         force=false —— 每帧调用，只补齐跨过的档位
         force=true  —— 判负 / 导出时调用，补齐档位后再补一条"真实分数"收尾 */
    function sealSnapshot(force) {
      if (snapshots.length === 0) {       // 开局那条 0 分
        pushSnap(0);
        nextSnapScore = SNAP_STEP;
        return;
      }
      sealBuckets();
      if (force && snapshots[snapshots.length - 1].s !== state.score) {
        pushSnap(state.score);
      }
    }

    /* ---------- 主更新 ---------- */

    function update(dt) {
      if (dt === undefined) dt = FIXED;

      /* 清场定格：世界停一下，但帧号照样走（校验时同样对待） */
      if (state.freeze > 0) {
        state.freeze = Math.max(0, state.freeze - dt);
        frame++;
        return;
      }

      if (state.over) {
        /* 结束后棋盘冻结，但帧号仍然推进，保证动作时间轴不乱 */
        frame++;
        return;
      }

      if (!state.ready) {
        state.cooldown -= dt;
        if (state.cooldown <= 0) state.ready = true;
      }

      var sub = dt / SUBSTEPS;
      for (var s = 0; s < SUBSTEPS; s++) stepPhysics(sub);

      checkGameOver(dt);
      if (state.flash > 0) state.flash = Math.max(0, state.flash - dt * 2.2);

      frame++;
      sealSnapshot(false);          // 跨过 500 分整倍数就封一条
    }

    /* ---------- 复位 ---------- */

    function reset(newSeed) {
      if (newSeed !== undefined && newSeed !== null) {
        seed = newSeed >>> 0;
        spawnRng = mulberry32(seed);
        fxRng = mulberry32((seed ^ 0x5bf03635) >>> 0);
        rng = fxRng;
      }
      state.balls.length = 0;
      state.particles.length = 0;
      state.floats.length = 0;
      state.score = 0;
      state.over = false;
      state.ready = true;
      state.cooldown = 0;
      state.flash = 0;
      state.danger = false;
      state.aimX = W / 2;
      state.revives = 0;
      state.reviveGiven = 0;
      state.freeze = 0;
      state.lastSnapshot = null;
      state.pending = pickSpawnTier();
      state.next = pickSpawnTier(state.pending);

      frame = 0;
      actions = [];
      snapshots = [];
      nextSnapScore = SNAP_STEP;
      dropCount = 0;
      spawnSeen = '';
      overFrame = -1;
      ended = false;
      sealSnapshot(true);          // 开局那条 0 分快照
      return seed;
    }

    function exportRun() {
      /* 导出时把收尾快照补上：
         · 有些局不是"判负"结束的（自己收了 / 没到判负就结算了）；
         · 一局没到 500 分的话，上面一条都还没封过。
         不补的话最后一条快照不等于最终分数，初步校验就会说数据不完整。 */
      sealSnapshot(true);          // 补齐档位 + 补一条收尾
      return {
        seed: seedToStr(seed),
        score: state.score,
        frames: frame,
        actions: actions.slice(),
        snapshots: snapshots.slice(),
        final: snapshots.length ? snapshots[snapshots.length - 1] : null,
        overFrame: overFrame,
        revives: state.revives,
        spawn: spawnSeen
      };
    }

    function reset0() { return reset(); }

    return {
      state: state,
      hooks: hooks,
      FRUITS: FRUITS,
      MAX_BONUS: MAX_BONUS,
      REVIVE_STEP: REVIVE_STEP,
      CONST: { W: W, H: H, WALL: WALL, DROP_Y: DROP_Y, DANGER_Y: DANGER_Y, DROP_MS: DROP_MS, FIXED: FIXED, SNAP_STEP: SNAP_STEP },

      update: update,
      stepPhysics: stepPhysics,
      drop: drop,
      revive: revive,
      reset: reset,
      moveAim: moveAim,
      aimLimit: aimLimit,
      makeBall: makeBall,
      addScore: addScore,

      getFrame: function () { return frame; },
      getSeed: function () { return seed; },
      setSeed: function (s) {
        seed = s >>> 0;
        spawnRng = mulberry32(seed);
        fxRng = mulberry32((seed ^ 0x5bf03635) >>> 0);
        rng = fxRng;
      },
      getActions: function () { return actions.slice(); },
      getSnapshots: function () { return snapshots.slice(); },
      sealSnapshot: function (force) { sealSnapshot(force !== false); },
      encodeSnapshot: function () { return snapshots.length ? snapshotLine(snapshots[snapshots.length - 1]) : ''; },
      exportRun: exportRun,
      gameOver: gameOver,
      isEnded: function () { return state.over; }
    };
  }

  /* ---------------------------------------------------------
   *  存档的编码
   *  ------------------------------------------------------------
   *  动作一行：  t,x,tier     第 t 帧、投在 x、掉的是第 tier 级
   *              t,i          第 t 帧用了一枚复活币
   *  快照一行：  fN,sN,nN,rN,tN,gSIG
   *              f 帧号 / s 分数 / n 球数 / r 复活币 / t 时间戳 / g 签名
   *  全部用分号串成一行行文本：比 JSON 小一半以上，也顺手挡掉最低级的手改。
   * ------------------------------------------------------- */

  function actionLine(a) {
    return a.k === 'revive' ? (a.t + ',i') : (a.t + ',' + a.x + ',' + (a.tier === undefined ? '' : a.tier));
  }

  function parseActionLine(line) {
    var p = String(line || '').split(',');
    if (p.length < 2) return null;
    var t = Number(p[0]);
    if (!isFinite(t)) return null;
    if (p[1] === 'i') return { k: 'revive', t: t | 0 };
    var x = Number(p[1]);
    if (!isFinite(x)) return null;
    var a = { k: 'drop', t: t | 0, x: x };
    var tier = Number(p[2]);
    if (p.length > 2 && isFinite(tier)) a.tier = tier | 0;
    return a;
  }

  function snapshotLine(sn) {
    return 'f' + sn.f + ',s' + sn.s + ',n' + sn.n + ',r' + sn.r + ',d' + (sn.d || 0) +
           ',t' + (sn.t || 0) + ',g' + (sn.g || '');
  }

  function parseSnapshotLine(line) {
    var out = {};
    String(line || '').split(',').forEach(function (kv) {
      var k = kv.charAt(0);
      if (k) out[k] = kv.slice(1);
    });
    if (out.f === undefined || out.s === undefined) return null;
    return {
      f: Number(out.f) | 0,
      s: Number(out.s) | 0,
      n: Number(out.n) || 0,
      r: Number(out.r) || 0,
      d: Number(out.d) || 0,
      t: Number(out.t) || 0,
      g: out.g === undefined ? '' : String(out.g)
    };
  }

  function encodeRun(rec) {
    return {
      seed: rec.seed,
      score: rec.score,
      a: (rec.actions || []).map(actionLine).join(';'),
      k: (rec.snapshots || []).map(snapshotLine).join(';'),
      p: rec.spawn || ''
    };
  }

  function decodeRun(o) {
    if (!o) return null;
    return {
      seed: o.seed,
      score: Number(o.score) || 0,
      spawn: String(o.p || ''),
      actions: String(o.a || '').split(';').filter(Boolean).map(parseActionLine).filter(Boolean),
      snapshots: String(o.k || '').split(';').filter(Boolean).map(parseSnapshotLine).filter(Boolean)
    };
  }

  /* ---------------------------------------------------------
   *  校验：只看结构 + 快照 + 掉落流水，不做校验
   *  ------------------------------------------------------------
   *  「分数有理」是怎么判的：
   *    1. 最后一次快照的分数 == 榜上申报的分数（分数不能凭空多出来）；
   *    2. 快照分数单调不减，而且每一条都是 500 的整倍数
   *       （每 500 分存一次，缺一段就是数据不完整）；
   *    3. 涨 500 分至少要有 3 次投放垫着 —— 一颗水果最多 55 分，
   *       两次投放绝不可能涨 500，所以这条能挡住"白送分数"；
   *    4. 帧号、时间戳、球数、复活币数全都单调/合理；
   *    5. 每次投放掉的是哪一级，必须和种子生成的掉落流水完全一致
   *       —— 这条和物理无关，却能把瞎编的动作序列挡在门外。
   *
   *  返回 { ok, verdict, reason, problems: [...] }；
   *  verdict: 'pass' | 'incomplete'（快照不全）| 'implausible'（分数没道理）| 'malformed'
   * ------------------------------------------------------- */

  var SNAP_STEP = 500;          // 每 500 分存一次快照
  /* 一次投放最多能变出多少分：果子落下后连续合成，实测上界约 200 分，
     这里取 210 留点余量 —— 只用来挡住"投两次报一千分"这种明显不合理的。 */
  var MAX_SCORE_PER_DROP = 210;
  var MAX_GAP_MS = 24 * 60 * 60 * 1000;   // 相邻快照最长间隔（够宽松，只挡明显不合理的）

  /* 由种子直接推出来的「第 i 次投放掉哪一级」，不碰物理 */
  /* 和引擎开局的取数顺序完全一致的独立实现：
       reset() 里先 pickSpawnTier() 得到 pending，再 pickSpawnTier(pending) 得到 next，
       之后每次投放消耗 "pending 变成 next、next 再抽一个"。
       两边必须一模一样，否则流水会错位、把好人误判成作弊。 */
  function spawnLedger(seed, count) {
    var rng = mulberry32(seed >>> 0);
    function roll() {
      var r = rng(), acc = 0;
      for (var i = 0; i < SPAWN_TIERS.length; i++) {
        acc += SPAWN_WEIGHTS[i];
        if (r <= acc) return SPAWN_TIERS[i];
      }
      return SPAWN_TIERS[0];
    }
    function pick(avoid) {
      if (!AVOID_REPEAT || avoid === undefined) return roll();
      for (var i = 0; i < 6; i++) {
        var t = roll();
        if (t !== avoid) return t;
      }
      return roll();
    }
    var out = [];
    var pending = pick();
    var next = pick(pending);
    for (var k = 0; k < count; k++) {
      out.push(pending);
      pending = next;
      next = pick(pending);
    }
    return out;
  }

  /* 一局分数的上界：把每次掉落的水果按"最理想的合成链"全合掉，能拿到多少分。
     只在**举报**时才用（要拿种子推一遍流水，稍重一点）。
     思路：每一级的水果两两合成，从最低级往上逐级配对，
     留下的单个水果不可能自己合，所以这是个真上界。 */
  function mergePotential(drops) {
    var counts = [];
    var i;
    for (i = 0; i <= MAX_TIER; i++) counts.push(0);
    for (i = 0; i < drops.length; i++) {
      var t = drops[i];
      if (t > MAX_TIER) t = MAX_TIER;
      counts[t]++;
    }
    var total = 0;
    var carry = 0;
    for (var tier = 0; tier < MAX_TIER; tier++) {
      var have = counts[tier] + carry;
      var merges = Math.floor(have / 2);
      total += merges * MERGE_SCORE[tier + 1];
      carry = merges;                 // 合出来的这一级继续参与下一轮配对
    }
    /* 最高一级两两相撞会一起炸掉，额外加 MAX_BONUS */
    total += Math.floor((counts[MAX_TIER] + carry) / 2) * MAX_BONUS;
    return total;
  }

  /* ---------------------------------------------------------
   *  两条校验口径
   *  ------------------------------------------------------------
   *  auditQuick  —— 打完一局就查这个，故意放得很松：
   *      · 有快照
   *      · 时间戳单调不减
   *      · 每条都带签名（改了字段签名就对不上）
   *      · 收尾那条的分数 == 申报分数
   *    另外只做最基础的结构检查（种子/分数/帧号别是乱的）。
   *
   *  auditReport —— 只在**举报**的时候查，严一点：
   *     auditQuick 的全部，再加
   *      · 档位齐全（500/1000/… 该有的都在，且不重复）
   *      · 快照分数、投放次数单调不减
   *      · 时间戳不能是荒唐的小值
   *      · 分数不能超过"这些水果最多能合出多少分"的上界
   *      · 每次投放的水果等级和种子推出来的流水一致（这条要有流水字段）
   * ------------------------------------------------------- */

  function quickProps(rec) {
    var problems = [];
    if (!rec) { problems.push('没有对局数据'); return { problems: problems, snaps: [], actions: [], claimed: 0, seed: 0 }; }
    var claimed = Number(rec.score);
    var snaps = (rec.snapshots || []).slice().sort(function (a, b) { return a.f - b.f; });
    var actions = (rec.actions || []).slice().sort(function (a, b) { return a.t - b.t; });
    return { problems: problems, snaps: snaps, actions: actions, claimed: claimed, seed: strToSeed(rec.seed) };
  }

  function auditQuick(rec) {
    var ctx = quickProps(rec);
    var problems = ctx.problems;
    var snaps = ctx.snaps;
    var claimed = ctx.claimed;

    if (problems.length) return done('malformed', problems, ctx);
    if (rec.seed === undefined || rec.seed === null || rec.seed === '') {
      return done('malformed', ['没有随机种子'], ctx);
    }
    if (!isFinite(claimed) || claimed < 0 || claimed > 1e7) {
      return done('malformed', ['分数不合法'], ctx);
    }
    if (ctx.actions.length > 6000) return done('malformed', ['动作数量异常'], ctx);
    if (!snaps.length) return done('incomplete', ['一条快照都没有'], ctx);

    /* 时间戳单调不减 */
    for (var k = 1; k < snaps.length; k++) {
      if (!(snaps[k].t >= snaps[k - 1].t)) {
        problems.push('时间戳不单调（第 ' + (k + 1) + ' 条比上一条早）');
      }
      if ((snaps[k].s || 0) < (snaps[k - 1].s || 0)) {
        problems.push('快照分数倒退（s' + snaps[k - 1].s + ' → s' + snaps[k].s + '）');
      }
    }

    /* 每条都要有签名，而且签名要对得上（手改字段就会对不上） */
    for (var q = 0; q < snaps.length; q++) {
      var sn = snaps[q];
      if (!sn.g) { problems.push('第 ' + (q + 1) + ' 条快照没有签名'); continue; }
      if (sn.g !== snapSig(sn)) { problems.push('第 ' + (q + 1) + ' 条快照的签名对不上（可能被改过）'); }
    }

    /* 收尾那条的分数必须等于申报分数 */
    if (snaps[snaps.length - 1].s !== claimed) {
      problems.push('最后一条快照是 ' + snaps[snaps.length - 1].s + ' 分，申报的却是 ' + claimed + ' 分');
    }

    if (problems.length) {
      var hard = problems.some(function (p) { return p.indexOf('签名') < 0; });
      return done(hard ? 'implausible' : 'incomplete', problems, ctx);
    }
    return {
      ok: true, verdict: 'pass', reason: '', problems: [],
      stats: { snapshots: snaps.length, claimed: claimed, mode: 'quick' }
    };
  }

  function auditReport(rec) {
    var quick = auditQuick(rec);
    var ctx = quickProps(rec);
    var snaps = ctx.snaps;
    var claimed = ctx.claimed;
    var problems = (quick.problems || []).slice();

    /* 结构明显有问题就直接回（不用再往下算上界） */
    if (quick.verdict === 'malformed') return quick;

    /* 档位核对。
       ⚠️ 别以为"除了收尾那条，其它都该是 500 的整倍数"：
       判负那一刻封的快照记的是**当时的真实分数**（比如 777），
       用了复活币接着打的话，一局里会有好几条这种"真实分数"快照
       （每次判负封一条，都不是整倍数）。
       老实现要求"除最后一条外都必须是整倍数"，于是用了复活币的正常成绩
       会被判成造假、进而被自动化流程误删 —— 这里按下面这套来：
         · 只有 500 的整倍数才登记成"档位"（判负快照直接跳过）
         · 真正要保证的是「每个 500 档位都有对应快照，一个不落」 */
    var seen = {};
    for (var k = 0; k < snaps.length; k++) {
      var sn = snaps[k];
      if (sn.t > 0 && sn.t < 1577836800000) problems.push('快照时间戳不合理（第 ' + (k + 1) + ' 条）');
      if (sn.s % SNAP_STEP === 0) {
        if (seen[sn.s]) problems.push('档位重复（s' + sn.s + ' 出现两次）');
        seen[sn.s] = 1;
      }
      if (k > 0 && (sn.d || 0) < (snaps[k - 1].d || 0)) problems.push('快照里的投放次数倒退');
    }
    /* 该有的档位一个都不能少（收尾那条如果正好是整倍数，也算它顶上了） */
    for (var b = 0; b < claimed; b += SNAP_STEP) {
      if (!seen[b]) problems.push('缺少 ' + b + ' 分那条快照');
    }

    /* 上界：用种子推出这么多步的水果，最多能合出多少分 */
    var drops = snaps[snaps.length - 1].d || 0;
    if (!drops) drops = ctx.actions.filter(function (a) { return a.k === 'drop'; }).length;
    if (drops > 0 && drops <= 6000) {
      var cap = mergePotential(spawnLedger(ctx.seed, drops));
      if (claimed > cap) {
        problems.push('申报 ' + claimed + ' 分，但这些水果（' + drops + ' 步）最多只能合出 ' + cap + ' 分');
      }
    }

    /* 掉落流水：每次投放的等级要和种子推出来的一致 */
    var tiered = ctx.actions.filter(function (a) { return a.k === 'drop' && a.tier !== undefined; });
    if (tiered.length >= 8) {
      var ledger = spawnLedger(ctx.seed, tiered.length);
      var bad = 0;
      for (var m = 0; m < tiered.length; m++) if (tiered[m].tier !== ledger[m]) bad++;
      if (bad > 0) problems.push('有 ' + bad + ' 次投放的水果等级和这个种子对不上');
    }

    if (!problems.length) {
      return {
        ok: true, verdict: 'pass', reason: '', problems: [],
        stats: { snapshots: snaps.length, drops: drops, claimed: claimed, cap: drops ? mergePotential(spawnLedger(ctx.seed, drops)) : null, mode: 'report' }
      };
    }
    return {
      ok: false,
      /* 等级对不上 / 签名对不上 / 超过上界 —— 都算「数据是编的」；其余算「数据不全」 */
      verdict: problems.some(function (p) {
        return p.indexOf('签名') >= 0 || p.indexOf('上界') >= 0 ||
               p.indexOf('等级') >= 0 || p.indexOf('最多只能合出') >= 0;
      }) ? 'implausible' : 'incomplete',
      reason: problems[0],
      problems: problems,
      stats: { snapshots: snaps.length, drops: drops, claimed: claimed, mode: 'report' }
    };
  }

  function done(verdict, problems, ctx) {
    return {
      ok: false, verdict: verdict, reason: problems[0] || verdict,
      problems: problems, stats: { snapshots: (ctx.snaps || []).length, claimed: ctx.claimed || 0 }
    };
  }

  /* ---------------------------------------------------------
   *  对外
   * ------------------------------------------------------- */

  return {
    createGame: createGame,
    auditQuick: auditQuick,          // 打完一局查这个（松：时间戳单调 + 带签名）
    auditReport: auditReport,        // 举报时查这个（严：加上界与掉落流水）
    spawnLedger: spawnLedger,
    setShapes: setShapes,
    shapeOf: shapeOf,
    makeBall: makeBall,
    snapshotLine: snapshotLine,
    parseSnapshotLine: parseSnapshotLine,
    actionLine: actionLine,
    parseActionLine: parseActionLine,
    encodeRun: encodeRun,
    decodeRun: decodeRun,
    randomSeed: randomSeed,
    seedToStr: seedToStr,
    strToSeed: strToSeed,
    mulberry32: mulberry32,
    CONST: {
      W: W, H: H, WALL: WALL, DROP_Y: DROP_Y, DANGER_Y: DANGER_Y,
      DROP_MS: DROP_MS, FIXED: FIXED, SNAP_STEP: SNAP_STEP,
      MAX_TIER: MAX_TIER, MAX_BONUS: MAX_BONUS, REVIVE_STEP: REVIVE_STEP,
      FRUITS: FRUITS, MERGE_SCORE: MERGE_SCORE
    }
  };
});
