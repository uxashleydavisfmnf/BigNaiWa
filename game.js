/* ============================================================
 *  合成大奶娃 · Suika Game —— 表现层
 *  纯原生 HTML + CSS + JavaScript，无任何依赖。
 *
 *  玩法规则全部在 dnw-core.js 里（确定性、可复现、能被复算）；
 *  这个文件只负责：画出来、听输入、出声音、跟排行榜对接。
 *  两边的常量必须一致，改手感请改 dnw-core.js 后同步这里。
 * ============================================================ */
(function () {
  'use strict';

  const Core = (typeof window !== 'undefined' && window.DNWCore) || null;
  if (!Core) {
    /* 内核没加载就别装作能玩：给一句明确的提示，比白屏好debug */
    if (window.console) console.error('[danaiwa] dnw-core.js 未加载，游戏无法启动');
    return;
  }

  /* ---------------------------------------------------------
   *  常量（规则常量在 Core.CONST 里，这里只留表现相关的）
   * ------------------------------------------------------- */

  const W = Core.CONST.W;
  const H = Core.CONST.H;
  const WALL = Core.CONST.WALL;
  const DROP_Y = Core.CONST.DROP_Y;
  const DANGER_Y = Core.CONST.DANGER_Y;

  const MAX_TIER  = Core.CONST.MAX_TIER;
  const MAX_BONUS = Core.CONST.MAX_BONUS;
  const ASSET_FILL = 0.92;   // 贴图里主体占画布长边的比例，与生成脚本保持一致

  /* 视觉定义：半径必须和内核一致（内核只认 r） */
  const FRUITS = [
    { name: '葡萄',   r: 17,  c1: '#c084f5', c2: '#7a3fb0', line: 'rgba(74,26,120,.35)',
      file: 'assets/fruits/01-grape.webp',     pc1: '#e9c466', pc2: '#b8903a' },
    { name: '樱桃',   r: 23,  c1: '#ff8a99', c2: '#c62346', line: 'rgba(120,10,40,.35)',
      file: 'assets/fruits/02-cherry.webp',    pc1: '#ffe684', pc2: '#d8b44f' },
    { name: '橘子',   r: 31,  c1: '#ffc06a', c2: '#e0741a', line: 'rgba(140,62,0,.32)',
      file: 'assets/fruits/03-orange.webp',    pc1: '#fdd865', pc2: '#cfa63f' },
    { name: '柠檬',   r: 39,  c1: '#fff285', c2: '#e0b000', line: 'rgba(140,110,0,.32)',
      file: 'assets/fruits/04-lemon.webp',     pc1: '#f6cd63', pc2: '#c9a040' },
    { name: '猕猴桃', r: 48,  c1: '#b9e05a', c2: '#5d8c1c', line: 'rgba(60,90,10,.32)',
      file: 'assets/fruits/05-kiwi.webp',      pc1: '#c4a559', pc2: '#94793c' },
    { name: '番茄',   r: 58,  c1: '#ff8a66', c2: '#c62f28', line: 'rgba(120,20,10,.32)',
      file: 'assets/fruits/06-tomato.webp',    pc1: '#fbd75a', pc2: '#cba63c' },
    { name: '桃子',   r: 69,  c1: '#ffd0d0', c2: '#ea7f93', line: 'rgba(160,60,80,.3)',
      file: 'assets/fruits/07-peach.webp',     pc1: '#f7c45a', pc2: '#c99a3e' },
    { name: '菠萝',   r: 81,  c1: '#ffe07a', c2: '#c88a12', line: 'rgba(130,80,0,.32)',
      file: 'assets/fruits/08-pineapple.webp', pc1: '#ffd37b', pc2: '#d1a252' },
    { name: '椰子',   r: 94,  c1: '#f0e2c6', c2: '#9b7b4f', line: 'rgba(90,64,32,.35)',
      file: 'assets/fruits/09-coconut.webp',   pc1: '#ffd771', pc2: '#d3a94e' },
    { name: '半奶蛙', r: 108, c1: '#ff9d78', c2: '#c23a2c', line: 'rgba(120,24,16,.32)',
      file: 'assets/fruits/10-halfmelon.webp', pc1: '#ccab68', pc2: '#9c8047' },
    { name: '神奶蛙', r: 124, c1: '#7ce878', c2: '#1c8a33', line: 'rgba(12,70,24,.4)',
      file: 'assets/fruits/11-watermelon.webp', pc1: '#eece9b', pc2: '#c0a271' }
  ];

  const BEST_KEY = 'danaiwa.best.v1';
  const MUTE_KEY = 'danaiwa.mute.v1';

  /* ---------------------------------------------------------
   *  DOM
   * ------------------------------------------------------- */

  const canvas    = document.getElementById('game');
  const ctx       = canvas.getContext('2d');
  const stage     = document.getElementById('stage');
  const scoreEl   = document.getElementById('score');
  const bestEl    = document.getElementById('best');
  const finalScoreEl = document.getElementById('finalScore');
  const finalBestEl  = document.getElementById('finalBest');
  const nextCanvas = document.getElementById('next');
  const nextCtx    = nextCanvas.getContext('2d');
  const chainCanvas = document.getElementById('chain');
  const chainCtx    = chainCanvas.getContext('2d');
  const soundBtn   = document.getElementById('soundBtn');
  const resetBtn   = document.getElementById('resetBtn');
  const restartBtn = document.getElementById('restartBtn');
  const overlayEl     = document.getElementById('overlay');
  const revivePromptEl = document.getElementById('revivePrompt');
  const overPanelEl    = document.getElementById('overPanel');
  const reviveScoreEl  = document.getElementById('reviveScore');
  const reviveLeftEl   = document.getElementById('reviveLeft');
  const reviveBtn      = document.getElementById('reviveBtn');
  const giveUpBtn      = document.getElementById('giveUpBtn');
  const reviveBadge    = document.getElementById('reviveBadge');
  const reviveCountEl  = document.getElementById('reviveCount');

  /* ---------------------------------------------------------
   *  内核 & 状态
   * ------------------------------------------------------- */

  /* 碰撞形状（按贴图轮廓生成，不是圆形）先灌给内核，再开一局 */
  Core.setShapes((typeof window !== 'undefined' && window.SUIKA_PARTS) || []);

  const engine = Core.createGame(Core.randomSeed());
  const state = engine.state;
  state.best = Number(localStorage.getItem(BEST_KEY) || 0);

  /* runSeq：第几局（重开 +1）。带上它就等于给这一局的存档做了个天然乱序前缀，
     同一个种子在不同局也不会互相覆盖；排行榜记录会用它当 runId。 */
  let runSeq = 0;
  function newRunId() { runSeq++; return Date.now().toString(36) + '-' + runSeq.toString(36); }
  let runId = newRunId();
  let lastDropTier = -1;

  /* 结束时先记个账，等这一帧画完再弹结算窗 ——
     这样画面停在「越线那一刻」，而不是提前冻住 */
  let pendingOver = false;

  /* ---------------------------------------------------------
   *  音效（WebAudio，无外部资源）
   * ------------------------------------------------------- */

  const Sound = {
    ctx: null,
    muted: localStorage.getItem(MUTE_KEY) === '1',

    ensure() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { this.ctx = new AC(); } catch (e) { this.ctx = null; }
      return this.ctx;
    },

    tone(freq, freq2, dur, vol, type) {
      if (this.muted) return;
      const c = this.ensure();
      if (!c) return;
      if (c.state === 'suspended') c.resume();
      const t = c.currentTime;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      if (freq2 && freq2 !== freq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq2), t + dur);
      }
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    },

    merge(tier) {
      const base = 240 * Math.pow(1.1225, tier * 2);
      this.tone(base, base * 1.7, 0.2, 0.16, 'sine');
      this.tone(base * 2, base * 3, 0.12, 0.06, 'triangle');
    },

    drop()   { this.tone(180, 120, 0.08, 0.05, 'sine'); },
    over()   { this.tone(420, 90, 0.7, 0.16, 'sawtooth'); },
    bonus()  { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, f, 0.22, 0.12, 'triangle'), i * 90)); }
  };

  /* 手机上的轻微震动反馈（跟着静音开关走；不支持的浏览器自动忽略） */
  function haptic(ms) {
    if (Sound.muted) return;
    if (navigator.vibrate) {
      try { navigator.vibrate(ms); } catch (e) { /* 忽略 */ }
    }
  }

  /* ---------------------------------------------------------
   *  内核回调 → 表现
   * ------------------------------------------------------- */

  engine.hooks.onScore = (n, x, y, text) => {
    scoreEl.textContent = state.score;
    bump(scoreEl);
    const b = Number(localStorage.getItem(BEST_KEY) || 0);
    if (state.score > b) {
      localStorage.setItem(BEST_KEY, String(state.score));
      bestEl.textContent = state.score;
    }
    if (x !== undefined) state.floats.push({ x, y, text: text || ('+' + n), life: 1 });
  };

  engine.hooks.onMerge = (tier, x, y, ball) => {
    /* 出生动画：合成出来的这颗要"弹一下"，而且它的出生时间就是现在 */
    if (ball) {
      ball.popAt = performance.now();
      ball.bornAt = performance.now();
    }
    Sound.merge(tier);
    haptic(6 + tier);
  };

  engine.hooks.onMaxMerge = (x, y) => {
    Sound.bonus();
    haptic(70);
    paintRevives(true);
  };

  engine.hooks.onReviveGet = () => paintRevives(true);

  engine.hooks.onGameOver = () => {
    Sound.over();
    pendingOver = true;
    overShown = false;          // 新的一次结束，结算画面允许再端一次
  };

  /* ---------------------------------------------------------
   *  画布尺寸
   * ------------------------------------------------------- */

  const view = { scale: 1, dpr: 1 };

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = Math.max(1, Math.round(rect.width  * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    view.dpr = dpr;
    view.scale = (rect.width * dpr) / W;
  }

  /* ---------------------------------------------------------
   *  复活币胶囊
   * ------------------------------------------------------- */

  function paintRevives(pop) {
    if (!reviveBadge) return;
    if (reviveCountEl) reviveCountEl.textContent = '×' + state.revives;
    if (state.revives > 0) {
      reviveBadge.hidden = false;
      if (pop) {
        reviveBadge.classList.remove('pop');
        void reviveBadge.offsetWidth;
        reviveBadge.classList.add('pop');
      }
    } else {
      reviveBadge.hidden = true;
      reviveBadge.classList.remove('pop');
    }
  }

  function bump(el) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  /* ---------------------------------------------------------
   *  结算 / 复活
   * ------------------------------------------------------- */

  /* 正式结算：弹结算窗 + 把成绩交给排行榜 */
  function settle() {
    if (revivePromptEl) revivePromptEl.hidden = true;
    if (overPanelEl) overPanelEl.hidden = false;
    if (overlayEl) overlayEl.classList.add('show');
    /* 交给排行榜模块（没加载也不影响） */
    if (window.DanaiwaBoard && window.DanaiwaBoard.onGameOver) {
      window.DanaiwaBoard.onGameOver({ score: state.score, engine, runId });
    }
  }

  /* 越线那一屏：有复活币就先问一句 */
  function askRevive() {
    if (reviveScoreEl) reviveScoreEl.textContent = state.score;
    if (reviveLeftEl) reviveLeftEl.textContent = '还剩 ' + state.revives + ' 枚';
    if (revivePromptEl) revivePromptEl.hidden = false;
    if (overPanelEl) overPanelEl.hidden = true;
    if (overlayEl) overlayEl.classList.add('show');
  }

  /* 一帧画完后才真正处理「结束了」这件事 */
  function flushOver() {
    if (!pendingOver) return;
    showOver();
  }

  /* 把结算画面端上来（幂等：重复调用不会重复提交成绩） */
  let overShown = false;
  function showOver() {
    if (!state.over) return false;
    pendingOver = false;
    finalScoreEl.textContent = state.score;
    finalBestEl.textContent = state.best;
    if (overShown) return false;
    overShown = true;
    if (state.revives > 0) { askRevive(); return false; }
    settle();
    return true;
  }

  function revive() {
    if (!engine.revive()) return false;
    paintRevives(false);
    if (revivePromptEl) revivePromptEl.hidden = true;
    if (overlayEl) overlayEl.classList.remove('show');
    pendingOver = false;
    overShown = false;
    Sound.ensure();
    return true;
  }

  /* ---------------------------------------------------------
   *  重开
   * ------------------------------------------------------- */

  function reset() {
    engine.setSeed(Core.randomSeed());
    engine.reset();
    runId = newRunId();
    lastDropTier = -1;
    pendingOver = false;
    overShown = false;
    if (overlayEl) overlayEl.classList.remove('show');
    if (revivePromptEl) revivePromptEl.hidden = true;
    if (overPanelEl) overPanelEl.hidden = false;
    paintRevives(false);
    scoreEl.textContent = '0';
    bestEl.textContent = state.best;
    drawNext();
    Sound.ensure();
    if (window.DanaiwaBoard && window.DanaiwaBoard.onRunStart) window.DanaiwaBoard.onRunStart();
  }

  /* ---------------------------------------------------------
   *  绘制
   * ------------------------------------------------------- */

  function drawFruit(c, x, y, r, tier, angle, scale, squashShape) {
    const f = FRUITS[tier];
    const s = scale === undefined ? 1 : scale;

    c.save();
    c.translate(x, y);
    /* 撞击挤压：沿法线压扁、垂直拉伸（世界坐标，先于水果自身旋转） */
    if (squashShape && squashShape.k > 0.004) {
      c.rotate(squashShape.a);
      c.scale(1 - squashShape.k, 1 + squashShape.k * 0.85);
      c.rotate(-squashShape.a);
    }
    if (s !== 1) c.scale(s, s);
    c.rotate(angle || 0);

    /* —— 贴图模式：主体直接画 PNG，画布边长按 ASSET_FILL 换算，保证视觉大小 = 物理直径 —— */
    if (f.img) {
      const box = (r * 2) / ASSET_FILL;
      c.drawImage(f.img, -box / 2, -box / 2, box, box);
      c.restore();
      return;
    }

    /* —— 兜底一：贴图还没到位时，先画一张极模糊的同形状缩略图 ——
       观感是「图正在慢慢变清晰」，而不是「图挂了」看到一堆卡通脸。
       这张缩略图是内联的 data URL（assets/fruits/blur.js，约 8KB），不走网络。 */
    if (blurImg && blurCfg && blurCfg.cols > 0) {
      const idx = tier < blurCfg.cols ? tier : blurCfg.cols - 1;
      const box = (r * 2) / ASSET_FILL;
      const cell = blurCfg.cell;
      c.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in c) c.imageSmoothingQuality = 'high';
      c.drawImage(blurImg, idx * cell, 0, cell, cell, -box / 2, -box / 2, box, box);
      c.restore();
      return;
    }

    /* —— 兜底二：连缩略图都没有（blur.js 被拦了）才画程序化的圆形水果 —— */
    const g = c.createRadialGradient(-r * 0.34, -r * 0.40, r * 0.12, 0, 0, r * 1.12);
    g.addColorStop(0, f.c1);
    g.addColorStop(1, f.c2);
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fillStyle = g;
    c.fill();

    if (tier === MAX_TIER) {
      c.save();
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.clip();
      c.strokeStyle = 'rgba(10,60,20,.30)';
      c.lineWidth = r * 0.13;
      for (let k = -2; k <= 2; k++) {
        c.beginPath();
        c.ellipse(k * r * 0.42, 0, r * 0.16, r * 1.05, 0, 0, Math.PI * 2);
        c.stroke();
      }
      c.restore();
    } else if (tier === MAX_TIER - 1) {
      c.save();
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.clip();
      c.strokeStyle = 'rgba(20,110,45,.85)';
      c.lineWidth = r * 0.16;
      c.beginPath();
      c.arc(0, 0, r * 0.93, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }

    c.lineWidth = Math.max(1.4, r * 0.055);
    c.strokeStyle = f.line;
    c.beginPath();
    c.arc(0, 0, r - c.lineWidth * 0.5, 0, Math.PI * 2);
    c.stroke();

    c.beginPath();
    c.ellipse(-r * 0.34, -r * 0.40, r * 0.30, r * 0.19, -0.7, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,255,255,.55)';
    c.fill();

    if (r >= 20) {
      const eyeR = r * 0.135;
      const eyeX = r * 0.33;
      const eyeY = -r * 0.06;

      c.fillStyle = 'rgba(46,32,24,.88)';
      c.beginPath(); c.arc(-eyeX, eyeY, eyeR, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc( eyeX, eyeY, eyeR, 0, Math.PI * 2); c.fill();

      c.fillStyle = 'rgba(255,255,255,.9)';
      c.beginPath(); c.arc(-eyeX - eyeR * 0.3, eyeY - eyeR * 0.35, eyeR * 0.34, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc( eyeX - eyeR * 0.3, eyeY - eyeR * 0.35, eyeR * 0.34, 0, Math.PI * 2); c.fill();

      c.beginPath();
      c.arc(0, r * 0.08, r * 0.20, 0.18 * Math.PI, 0.82 * Math.PI);
      c.lineWidth = Math.max(1.2, r * 0.055);
      c.lineCap = 'round';
      c.strokeStyle = 'rgba(46,32,24,.72)';
      c.stroke();

      c.fillStyle = 'rgba(255,120,120,.30)';
      c.beginPath(); c.ellipse(-r * 0.56, r * 0.16, r * 0.16, r * 0.11, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse( r * 0.56, r * 0.16, r * 0.16, r * 0.11, 0, 0, Math.PI * 2); c.fill();
    } else {
      c.fillStyle = 'rgba(46,32,24,.85)';
      c.beginPath(); c.arc(-r * 0.3, -r * 0.06, r * 0.13, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc( r * 0.3, -r * 0.06, r * 0.13, 0, Math.PI * 2); c.fill();
    }

    c.restore();
  }

  function drawBoard() {
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#fffaf0');
    bg.addColorStop(0.55, '#fff2dc');
    bg.addColorStop(1, '#ffe7c6');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const top = ctx.createLinearGradient(0, 0, 0, 190);
    top.addColorStop(0, 'rgba(255,255,255,.85)');
    top.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, W, 190);

    ctx.save();
    ctx.strokeStyle = 'rgba(196,150,100,.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(WALL, 0);
    ctx.lineTo(WALL, H - WALL);
    ctx.lineTo(W - WALL, H - WALL);
    ctx.lineTo(W - WALL, 0);
    ctx.stroke();
    ctx.restore();

    const danger = state.danger;
    ctx.save();
    ctx.setLineDash([9, 9]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = danger
      ? 'rgba(255,72,72,' + (0.55 + 0.45 * Math.abs(Math.sin(performance.now() / 140))) + ')'
      : 'rgba(226,152,120,.42)';
    ctx.beginPath();
    ctx.moveTo(WALL, DANGER_Y);
    ctx.lineTo(W - WALL, DANGER_Y);
    ctx.stroke();
    ctx.restore();
  }

  function drawBalls() {
    const now = performance.now();
    const balls = state.balls;
    const sorted = balls.slice().sort((a, b) => a.r - b.r);

    for (let i = 0; i < sorted.length; i++) {
      const b = sorted[i];
      if (b.dead) continue;

      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#7a4a1e';
      ctx.beginPath();
      ctx.ellipse(b.x, H - WALL - 1, b.r * 0.86, Math.max(3, b.r * 0.17), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      let scale = 1;
      if (b.popAt) {
        const t = (now - b.popAt) / 220;
        if (t < 1) scale = 1 + 0.28 * (1 - t);
        else b.popAt = 0;
      }
      const shape = b.sq > 0.004 ? { a: b.sqA, k: b.sq } : null;
      drawFruit(ctx, b.x, b.y, b.r, b.tier, b.angle, scale, shape);
    }
  }

  function drawAim() {
    if (state.over) return;
    const tier = state.pending;
    const r = FRUITS[tier].r;
    const lim = engine.aimLimit(tier);
    const x = Math.min(Math.max(state.aimX, lim[0]), lim[1]);
    const bob = Math.sin(performance.now() / 320) * 2.5;
    const ready = state.ready;

    if (ready) {
      ctx.save();
      ctx.setLineDash([5, 8]);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = 'rgba(200,140,90,.45)';
      ctx.beginPath();
      ctx.moveTo(x, DROP_Y + r + 4);
      ctx.lineTo(x, H - WALL);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = FRUITS[tier].c1;
      ctx.beginPath();
      ctx.arc(x, DROP_Y + bob, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    if (!ready) ctx.globalAlpha = 0.4;
    drawFruit(ctx, x, DROP_Y + bob, r, tier, 0, 1);
    ctx.restore();
  }

  function drawEffects(dt) {
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.vy += 1400 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.99;
      p.life -= p.decay * dt;
      if (p.life <= 0) { state.particles.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life) * 0.9;
      const pf = FRUITS[Math.min(p.tier || 0, MAX_TIER)];
      ctx.fillStyle = p.color === 1 ? (pf.pc1 || pf.c1) : (pf.pc2 || pf.c2);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    for (let i = state.floats.length - 1; i >= 0; i--) {
      const f = state.floats[i];
      const big = !!f.big;
      f.y -= (big ? 24 : 46) * dt;
      f.life -= dt * (big ? 0.55 : 1.05);
      if (f.life <= 0) { state.floats.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, f.life * 1.4);
      ctx.font = big
        ? '900 40px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
        : '700 20px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
      ctx.lineWidth = big ? 9 : 4;
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = big ? '#e8342f' : '#f4623a';
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;

    drawTopPreview();
  }

  function drawTopPreview() {
    const tier = state.next;
    const r = 15;
    const x = W - WALL - 30;
    const y = 32;

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.font = '600 11px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(150,110,80,.85)';
    ctx.fillText('下一个', x - r - 10, y);
    ctx.restore();

    drawFruit(ctx, x, y, r, tier, 0, 1);
  }

  function drawNext() {
    const w = nextCanvas.width;
    const h = nextCanvas.height;
    nextCtx.setTransform(1, 0, 0, 1, 0, 0);
    nextCtx.clearRect(0, 0, w, h);
    const tier = state.next;
    const r = FRUITS[tier].r;
    const k = (Math.min(w, h) * 0.42) / r;
    drawFruit(nextCtx, w / 2, h / 2, r * k, tier, 0, 1);
  }

  function drawChain() {
    const cw = chainCanvas.width;
    const ch = chainCanvas.height;
    chainCtx.setTransform(1, 0, 0, 1, 0, 0);
    chainCtx.clearRect(0, 0, cw, ch);

    const slot = cw / FRUITS.length;
    const r = slot * 0.36;
    const cy = ch * 0.5;

    for (let i = 0; i < FRUITS.length; i++) {
      const x = slot * (i + 0.5);
      drawFruit(chainCtx, x, cy, r, i, 0, 1);
      if (i < FRUITS.length - 1) {
        chainCtx.save();
        chainCtx.globalAlpha = 0.45;
        chainCtx.fillStyle = '#b08a68';
        chainCtx.font = '600 ' + Math.round(ch * 0.2) + 'px system-ui, sans-serif';
        chainCtx.textAlign = 'center';
        chainCtx.textBaseline = 'middle';
        chainCtx.fillText('›', x + slot * 0.5, cy);
        chainCtx.restore();
      }
    }
  }

  /* ---------------------------------------------------------
   *  主循环：固定步长推进内核，然后画
   * ------------------------------------------------------- */

  let last = performance.now();
  let acc = 0;
  const FIXED = Core.CONST.FIXED;

  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;      // 切后台回来不要瞬移
    acc += dt;

    let guard = 0;
    while (acc >= FIXED && guard < 5) {
      engine.update(FIXED);
      acc -= FIXED;
      guard++;
    }
    if (guard >= 5) acc = 0;

    render(dt);
    flushOver();
    requestAnimationFrame(frame);
  }

  function render(dt) {
    ctx.setTransform(view.scale, 0, 0, view.scale, 0, 0);
    ctx.clearRect(0, 0, W, H);

    drawBoard();
    drawBalls();
    drawAim();
    /* 定格期间把特效的 dt 也压成 0，让它跟世界一起停住 */
    drawEffects(state.freeze > 0 ? 0 : dt);

    if (state.flash > 0) {
      ctx.save();
      ctx.globalAlpha = state.flash * 0.35;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  /* ---------------------------------------------------------
   *  输入
   * ------------------------------------------------------- */

  function pointerToX(clientX) {
    const rect = canvas.getBoundingClientRect();
    return (clientX - rect.left) * (W / rect.width);
  }

  /* 触屏是「拖动瞄准、松手投放」——手指不会挡住落点，也方便微调；
     鼠标保持「移动瞄准、按下即投」的桌面手感。 */
  let touchAiming = false;

  function tryDrop() {
    if (state.over || !state.ready) return false;
    const tier = state.pending;
    const from = state.aimX;
    if (!engine.drop(state.aimX)) return false;
    /* 刚投下去那颗的出生时间（只用于渲染，内核靠帧号） */
    const fresh = state.balls[state.balls.length - 1];
    if (fresh) fresh.bornAt = performance.now();
    lastDropTier = tier;
    Sound.drop();
    drawNext();
    return true;
  }

  stage.addEventListener('pointermove', (e) => {
    if (state.over) return;
    if (e.pointerType === 'touch' && !touchAiming) return;
    engine.moveAim(pointerToX(e.clientX));
  });

  stage.addEventListener('pointerdown', (e) => {
    if (state.over) return;
    Sound.ensure();
    engine.moveAim(pointerToX(e.clientX));
    if (e.pointerType === 'touch') {
      touchAiming = true;
      if (stage.setPointerCapture) {
        try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      }
    } else {
      tryDrop();
    }
  });

  stage.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    if (!touchAiming) return;
    touchAiming = false;
    if (state.over) return;
    engine.moveAim(pointerToX(e.clientX));
    tryDrop();
  });

  stage.addEventListener('pointercancel', () => { touchAiming = false; });

  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  /* 在输入框里打字时不要抢按键 */
  function isTyping(e) {
    const t = e.target;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || t.isContentEditable === true;
  }

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;

    if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
      state.aimX = Math.min(Math.max(state.aimX - 14, WALL), W);
      e.preventDefault();
    } else if (e.code === 'ArrowRight' || e.code === 'KeyD') {
      state.aimX = Math.min(Math.max(state.aimX + 14, WALL), W);
      e.preventDefault();
    } else if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ArrowDown') {
      if (!state.over) { tryDrop(); e.preventDefault(); }
    } else if (e.code === 'KeyR') {
      reset();
      e.preventDefault();
    }
  });

  function paintSoundBtn() {
    const ico = soundBtn.querySelector('.ico');
    const lbl = soundBtn.querySelector('.lbl');
    if (ico) ico.textContent = Sound.muted ? '🔇' : '🔊';
    if (lbl) lbl.textContent = Sound.muted ? '音效关' : '音效开';
    soundBtn.setAttribute('aria-pressed', String(!Sound.muted));
  }

  soundBtn.addEventListener('click', () => {
    Sound.muted = !Sound.muted;
    localStorage.setItem(MUTE_KEY, Sound.muted ? '1' : '0');
    paintSoundBtn();
    if (!Sound.muted) Sound.merge(1);
  });

  resetBtn.addEventListener('click', reset);
  restartBtn.addEventListener('click', reset);

  /* ---------------------------------------------------------
   *  素材加载
   * ------------------------------------------------------- */

  const SPRITE_RETRY = 3;

  let blurImg = null;
  const blurCfg = window.FRUIT_BLUR || null;

  function loadBlur() {
    if (!blurCfg || !blurCfg.src) return;
    const im = new Image();
    im.onload = () => { blurImg = im; };
    im.src = blurCfg.src;
  }

  function loadSprites() {
    let left = 0;

    function fetchOne(f, attempt) {
      const img = new Image();
      img.onload = () => {
        const ready = () => {
          f.img = img;
          if (--left === 0) refreshPreviews();
        };
        if (img.decode) img.decode().then(ready, ready);
        else ready();
      };
      img.onerror = () => {
        if (attempt < SPRITE_RETRY) {
          const wait = 600 * Math.pow(2.4, attempt - 1) + Math.random() * 300;
          setTimeout(() => fetchOne(f, attempt + 1), wait);
          return;
        }
        left--;
        if (window.console) console.warn('[danaiwa] 素材载入失败，已回退为程序化水果：' + f.file);
        if (left === 0) refreshPreviews();
      };
      img.src = attempt > 1 ? (f.file + '?retry=' + attempt) : f.file;
    }

    for (let i = 0; i < FRUITS.length; i++) {
      const f = FRUITS[i];
      if (!f.file) continue;
      left++;
      fetchOne(f, 1);
    }
    return left;
  }

  function refreshPreviews() {
    drawNext();
    drawChain();
  }

  /* ---------------------------------------------------------
   *  启动
   * ------------------------------------------------------- */

  function boot() {
    resizeCanvas();
    if (window.ResizeObserver) {
      new ResizeObserver(resizeCanvas).observe(stage);
    }
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 120));

    paintSoundBtn();

    if (reviveBtn) reviveBtn.addEventListener('click', revive);
    if (giveUpBtn) giveUpBtn.addEventListener('click', settle);

    drawChain();
    reset();
    loadBlur();
    loadSprites();
    requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 调试句柄（控制台可用）：__DNW__.state / .reset() / .drop() / .FRUITS / .render() */
  window.__DNW__ = {
    state, reset, revive, settle, tryDrop, FRUITS,
    stepPhysics: engine.stepPhysics, update: engine.update,
    render, resizeCanvas, shapeOf: Core.shapeOf, makeBall: Core.makeBall,
    paintRevives, addScore: engine.addScore,
    MAX_BONUS, REVIVE_STEP: Core.REVIVE_STEP,
    gameOver: engine.gameOver,
    showOver, flushOver,
    /* 复算 / 防作弊相关的句柄 */
    Core, engine,
    exportRun: engine.exportRun,
    runId: () => runId,
    seed: () => engine.getSeed(),
    frame: () => engine.getFrame(),
    blurReady: () => !!blurImg
  };
})();
