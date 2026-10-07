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
 *    verifyRun(rec)                   → 复算一遍，给出裁决
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
  var SNAPSHOT_EVERY = 120;      // 每 2 秒封一个快照（一局约 60~120 个）

  /* ---------------------------------------------------------
   *  种子化随机数：mulberry32
   *  只要种子一样，吐出来的序列一定一样 —— 复算的前提。
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
   *  所有引擎结果一致 —— 所以它可以当复算的指纹用。
   * ------------------------------------------------------- */

  function hashInit() { return 2166136261 >>> 0; }
  function hashMix(h, v) {
    h = (h ^ (v >>> 0)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    return (h >>> 0);
  }
  function q3(v) { return Math.round(v * 1000); }   // 量化到 0.001，吸收末位浮点差

  function hashBalls(balls) {
    var h = hashInit();
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      h = hashMix(h, b.tier);
      h = hashMix(h, q3(b.x));
      h = hashMix(h, q3(b.y));
      h = hashMix(h, q3(b.vx));
      h = hashMix(h, q3(b.vy));
    }
    return h >>> 0;
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
    var rng = mulberry32(seed >>> 0);

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
    var nextSnapAt = 0;            // 下一个快照的帧号
    var overFrame = -1;
    var ended = false;

    /* 计分/飘字/音效的钩子。内核不认识 DOM，全部交给外面 */
    var hooks = {
      onScore: null,      // (delta, x, y, text, big) => void
      onMerge: null,      // (tier, x, y) => void
      onMaxMerge: null,   // (x, y) => void
      onReviveGet: null,  // (count) => void
      onGameOver: null    // () => void
    };

    /* ---------- 随机：所有玩法随机都走这里 ---------- */
    var rand = function (a, b) { return a + rng() * (b - a); };

    function rollSpawnTier() {
      var r = rng(), acc = 0;
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
          if (hooks.onMerge) hooks.onMerge(nt, mx, my);
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
      sealSnapshot(frame, true);
      if (hooks.onGameOver) hooks.onGameOver();
    }

    /* ---------- 快照 ---------- */

    function sealSnapshot(atFrame, force) {
      var last = snapshots.length ? snapshots[snapshots.length - 1] : null;
      if (!force && last && last.f === atFrame) return;

      snapshots.push({
        f: atFrame,
        s: state.score,
        n: state.balls.length,
        r: state.revives,
        h: hashBalls(state.balls)
      });
      state.lastSnapshot = snapshots[snapshots.length - 1];
    }

    /* ---------- 主更新 ---------- */

    function update(dt) {
      if (dt === undefined) dt = FIXED;

      /* 清场定格：世界停一下，但帧号照样走（复算时同样对待） */
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
      if (frame >= nextSnapAt) {
        nextSnapAt = frame + SNAPSHOT_EVERY;
        sealSnapshot(frame, false);
      }
    }

    /* ---------- 复位 ---------- */

    function reset(newSeed) {
      if (newSeed !== undefined && newSeed !== null) {
        seed = newSeed >>> 0;
        rng = mulberry32(seed);
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
      nextSnapAt = SNAPSHOT_EVERY;
      overFrame = -1;
      ended = false;
      sealSnapshot(0, true);       // 开局快照：分数必然是 0，堵住「一上来就有一坨分」
      return seed;
    }

    function exportRun() {
      return {
        seed: seedToStr(seed),
        score: state.score,
        frames: frame,
        actions: actions.slice(),
        snapshots: snapshots.slice(),
        final: snapshots.length ? snapshots[snapshots.length - 1] : null,
        overFrame: overFrame,
        revives: state.revives
      };
    }

    function reset0() { return reset(); }

    return {
      state: state,
      hooks: hooks,
      FRUITS: FRUITS,
      MAX_BONUS: MAX_BONUS,
      REVIVE_STEP: REVIVE_STEP,
      CONST: { W: W, H: H, WALL: WALL, DROP_Y: DROP_Y, DANGER_Y: DANGER_Y, DROP_MS: DROP_MS, FIXED: FIXED, SNAPSHOT_EVERY: SNAPSHOT_EVERY },

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
      setSeed: function (s) { seed = s >>> 0; rng = mulberry32(seed); },
      getActions: function () { return actions.slice(); },
      getSnapshots: function () { return snapshots.slice(); },
      sealSnapshot: function (force) { sealSnapshot(frame, force !== false); },
      encodeSnapshot: function () { return snapshots.length ? snapshotLine(snapshots[snapshots.length - 1]) : ''; },
      exportRun: exportRun,
      gameOver: gameOver,
      isEnded: function () { return state.over; }
    };
  }

  /* ---------------------------------------------------------
   *  复算：把玩家存下来的「种子 + 动作序列」重放一遍
   * ------------------------------------------------------- */

  /* 快照压成一行文本存进数据库，省体积、也有点防手改的意思：
       f=帧  s=分数  n=球数  r=复活币  h=状态指纹 */
  function snapshotLine(sn) {
    return 'f' + sn.f + ',s' + sn.s + ',n' + sn.n + ',r' + sn.r + ',h' + sn.h.toString(36);
  }

  function parseSnapshotLine(line) {
    var out = {};
    String(line || '').split(',').forEach(function (kv) {
      var k = kv.charAt(0);
      var v = kv.slice(1);
      if (k === 'h') out.h = parseInt(v, 36) >>> 0;
      else if (k) out[k] = Number(v);
    });
    if (out.f === undefined || out.s === undefined || out.h === undefined) return null;
    return { f: out.f | 0, s: out.s | 0, n: out.n | 0, r: out.r | 0, h: out.h >>> 0 };
  }

  /* 动作压成一行：t,x 投放；t,i 复活 */
  function actionLine(a) {
    return a.k === 'revive' ? (a.t + ',i') : (a.t + ',' + a.x);
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
    if (p.length > 2 && isFinite(Number(p[2]))) a.tier = Number(p[2]) | 0;
    return a;
  }

  /* 复算一局。
     opts.snapTolerance 允许的末位浮点差（分数必须严格相等，这里只管位置指纹）
     返回：
       ok          复算分数与申报分数是否一致
       replayScore 复算出来的分数
       claimed     申报分数
       delta       复算 - 申报
       frameErrors 快照对不上的地方（前几条，供举报展示）
       verdict     'pass' | 'fraud' | 'tamper' | 'malformed'  */
  function verifyRun(rec, opts) {
    opts = opts || {};
    var scoreTol = opts.scoreTolerance === undefined ? 0 : opts.scoreTolerance;

    if (!rec || rec.seed === undefined || rec.seed === null) {
      return { ok: false, verdict: 'malformed', reason: '缺少随机种子', replayScore: 0, claimed: 0, delta: 0, frameErrors: [] };
    }

    var seed = strToSeed(rec.seed);
    var actions = (rec.actions || []).slice().sort(function (a, b) { return a.t - b.t; });
    var snaps = (rec.snapshots || []).slice().sort(function (a, b) { return a.f - b.f; });
    var claimed = Number(rec.score) || 0;

    var g = createGame(seed);
    g.reset(seed);

    /* 动作合法性预检：时间轴不能倒流、不能超速投放 */
    var lastDrop = -1e9;
    var minGapFrames = Math.floor((DROP_MS / 1000) / FIXED) - 1;   // 容 1 帧抖动
    var frameErrors = [];
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      if (a.t < 0 || a.t > 6 * 60 * 60 * 60) {
        return { ok: false, verdict: 'malformed', reason: '动作时间越界', replayScore: 0, claimed: claimed, delta: 0, frameErrors: [] };
      }
      if (a.k === 'drop') {
        if (a.t - lastDrop < minGapFrames) {
          return {
            ok: false, verdict: 'malformed',
            reason: '投放间隔小于冷却（' + (a.t - lastDrop) + ' 帧 < ' + minGapFrames + '）',
            replayScore: 0, claimed: claimed, delta: 0, frameErrors: []
          };
        }
        lastDrop = a.t;
      }
    }

    var maxFrame = snaps.length ? snaps[snaps.length - 1].f : 0;
    for (var j = 0; j < actions.length; j++) maxFrame = Math.max(maxFrame, actions[j].t);
    maxFrame += 2;

    var si = 0;
    var ai = 0;
    var guard = 0;

    /* 复算循环：每帧先对齐快照，再执行这一帧的动作 */
    while (guard++ < maxFrame + 600) {
      var f = g.getFrame();

      while (si < snaps.length && snaps[si].f === f) {
        var sn = snaps[si];
        if (sn.s !== g.state.score) {
          frameErrors.push({ f: f, kind: 'score', claimed: sn.s, actual: g.state.score });
        } else if (sn.h !== hashBalls(g.state.balls)) {
          frameErrors.push({ f: f, kind: 'hash', claimed: sn.h, actual: hashBalls(g.state.balls) });
        }
        si++;
      }

      while (ai < actions.length && actions[ai].t === f) {
        var act = actions[ai];
        if (act.k === 'drop') {
          if (!g.state.ready) {
            frameErrors.push({ f: f, kind: 'cooldown', claimed: 0, actual: 0 });
          }
          g.drop(act.x);
        } else if (act.k === 'revive') {
          g.revive();
        }
        ai++;
      }

      if (si >= snaps.length && ai >= actions.length) break;
      g.update(FIXED);
    }

    /* 动作放完之后再空跑两秒，让盘面落定，避免「最后一颗还在空中」导致误判 */
    for (var w = 0; w < 120; w++) g.update(FIXED);

    var replayScore = g.state.score;
    var delta = replayScore - claimed;
    var ok = Math.abs(delta) <= scoreTol;

    var verdict = 'pass';
    var reason = '';
    if (!ok) {
      verdict = 'fraud';
      reason = '复算得分 ' + replayScore + '，与申报的 ' + claimed + ' 不符';
    } else if (frameErrors.length) {
      verdict = 'tamper';
      reason = '得分对得上，但有 ' + frameErrors.length + ' 处过程快照对不上（疑似伪造过程数据）';
    }

    return {
      ok: ok && frameErrors.length === 0,
      verdict: verdict,
      reason: reason,
      replayScore: replayScore,
      claimed: claimed,
      delta: delta,
      frames: g.getFrame(),
      frameErrors: frameErrors.slice(0, 8),
      frameErrorCount: frameErrors.length
    };
  }

  /* ---------------------------------------------------------
   *  数据库里的紧凑编码
   *  ------------------------------------------------------------
   *  动作序列和快照都要进 GitHub（每人一个文件、前 100 名才有），
   *  体积必须压住：用分号串起来的一行行文本，比 JSON 数组小一半以上，
   *  顺手还能挡掉「手改 JSON 里的分数」这种最低级的作弊。
   *
   *  动作一行：  t,x[,tier]   投放（第几帧、投在哪）
   *              t,i          复活（第几帧）
   *  快照一行：  fN,sN,nN,rN,hN
   * ------------------------------------------------------- */

  function encodeRun(rec) {
    return {
      seed: rec.seed,
      score: rec.score,
      a: (rec.actions || []).map(actionLine).join(';'),
      k: (rec.snapshots || []).map(snapshotLine).join(';')
    };
  }

  function decodeRun(o) {
    if (!o) return null;
    return {
      seed: o.seed,
      score: Number(o.score) || 0,
      actions: String(o.a || '').split(';').filter(Boolean).map(parseActionLine).filter(Boolean),
      snapshots: String(o.k || '').split(';').filter(Boolean).map(parseSnapshotLine).filter(Boolean)
    };
  }

  /* ---------------------------------------------------------
   *  一键校验：结构 + 过程 + 复算
   *  ------------------------------------------------------------
   *  提交、举报、以及别人打开举报面板时都走这一个入口，规则只有一份。
   *  返回 { verdict, ok, ... }：
   *    pass      复算得分与申报一致，且每一条过程快照都对得上
   *    fraud     复算得分对不上（少报/多报）
   *    tamper    得分对得上，但过程快照对不上（伪造过程数据）
   *    malformed 数据本身不合法（缺种子、动作太密、超长……）
   * ------------------------------------------------------- */

  var MIN_DROP_GAP_MS = DROP_MS - 40;      // 容一点网络/帧率抖动
  var MAX_FRAMES = 60 * 60 * 60;           // 1 小时（60fps）—— 再长就不是人玩的了

  function inspectRun(rec) {
    if (!rec || typeof rec !== 'object') {
      return { verdict: 'malformed', ok: false, reason: '没有对局数据' };
    }
    if (rec.seed === undefined || rec.seed === null || rec.seed === '') {
      return { verdict: 'malformed', ok: false, reason: '没有随机种子' };
    }
    var score = Number(rec.score);
    if (!isFinite(score) || score < 0 || score > 1e7) {
      return { verdict: 'malformed', ok: false, reason: '分数不合法' };
    }
    var acts = rec.actions || [];
    var snaps = rec.snapshots || [];
    if (acts.length > 6000) {
      return { verdict: 'malformed', ok: false, reason: '动作数量异常（' + acts.length + '）' };
    }
    if (snaps.length > 3000) {
      return { verdict: 'malformed', ok: false, reason: '快照数量异常（' + snaps.length + '）' };
    }
    var last = -1e9;
    for (var i = 0; i < acts.length; i++) {
      var a = acts[i];
      if (!a || !isFinite(a.t) || a.t < 0 || a.t > MAX_FRAMES) {
        return { verdict: 'malformed', ok: false, reason: '动作帧号越界' };
      }
      if (a.k === 'drop') {
        if (!isFinite(a.x) || a.x < WALL || a.x > W - WALL) {
          return { verdict: 'malformed', ok: false, reason: '投放位置越界' };
        }
        if (a.t - last < Math.floor(MIN_DROP_GAP_MS / 1000 / FIXED)) {
          return { verdict: 'malformed', ok: false, reason: '投放间隔小于冷却' };
        }
        last = a.t;
      }
    }
    for (var j = 0; j < snaps.length; j++) {
      var s = snaps[j];
      if (!s || !isFinite(s.f) || s.f < 0 || s.f > MAX_FRAMES) {
        return { verdict: 'malformed', ok: false, reason: '快照帧号越界' };
      }
      if (!isFinite(s.s) || s.s < 0) {
        return { verdict: 'malformed', ok: false, reason: '快照分数不合法' };
      }
    }
    /* 开局那一帧分数必须是 0：堵住「一上来就凭空有分」 */
    if (snaps.length && snaps[0].f === 0 && snaps[0].s !== 0) {
      return { verdict: 'tamper', ok: false, reason: '开局快照分数不为 0' };
    }
    return { verdict: 'pass', ok: true, reason: '' };
  }

  function validateRun(rec, opts) {
    opts = opts || {};
    var pre = inspectRun(rec);
    if (!pre.ok) return pre;

    var res = verifyRun(rec, opts);
    if (!res.ok && pre.ok) {
      /* 复算判定优先：malformed 已经挡在前头了 */
      return {
        verdict: res.verdict, ok: false, reason: res.reason,
        replayScore: res.replayScore, claimed: res.claimed, delta: res.delta,
        frameErrors: res.frameErrors, frameErrorCount: res.frameErrorCount
      };
    }
    return {
      verdict: 'pass', ok: true, reason: '',
      replayScore: res.replayScore, claimed: res.claimed, delta: res.delta,
      frameErrorCount: res.frameErrorCount
    };
  }

  /* ---------------------------------------------------------
   *  对外
   * ------------------------------------------------------- */

  function hashBallsQ(balls) { return hashBalls(balls); }

  return {
    createGame: createGame,
    verifyRun: verifyRun,
    inspectRun: inspectRun,
    validateRun: validateRun,
    setShapes: setShapes,
    shapeOf: shapeOf,
    makeBall: makeBall,
    hashBalls: hashBallsQ,
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
      DROP_MS: DROP_MS, FIXED: FIXED, SNAPSHOT_EVERY: SNAPSHOT_EVERY,
      MAX_TIER: MAX_TIER, MAX_BONUS: MAX_BONUS, REVIVE_STEP: REVIVE_STEP,
      FRUITS: FRUITS, MERGE_SCORE: MERGE_SCORE
    }
  };
});
