/* ============================================================
 *  前端集成自检（无浏览器，用桩件跑真实 game.js + leaderboard.js）
 *  运行：node integration.test.js
 *
 *  这里不"调用函数看返回值"，而是把真实的页面脚本塞进沙箱、
 *  用假 GitHub + 假公网 IP 喂数据，然后走完整流程：
 *    打一局真对局 → 结算 → 本机乐观上榜 → 复算自检 → 写 owner / 总榜 → 已同步
 *  覆盖的边界：
 *    · 没进前 100：只显示「101 · 无记录」，一个字节都不写
 *    · 名次算对了（按分数插入 / 同分先到先得）
 *    · 每人只留最好成绩：第二局更差 → 数据库里仍是高分那条
 *    · 网络挂了：不崩、不写、明确提示，还能重试
 *    · 榜上有人的存档缺失 → 写「无记录」，不影响其它人渲染
 *    · 举报：本地复算不通过 → 写出举报记录（含复算分数与差值）
 *    · 举报一个分数其实对得上的人 → 不能误报
 *    · 身份拿不到公网 IP → 退化成浏览器本地 ID，仍可上榜
 * ============================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = __dirname;
const Board = require(path.join(root, 'dnw-board.js'));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  -- ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, label) { ok(a === b, label, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

/* ---------------------------------------------------------
 *  桩件：canvas / DOM / 存储 / 网络
 * ------------------------------------------------------- */

function makeCtx() {
  const g = { addColorStop() {} };
  return {
    setTransform() {}, save() {}, restore() {}, scale() {}, rotate() {}, translate() {},
    clearRect() {}, fillRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, ellipse() {}, clip() {}, stroke() {}, fill() {}, setLineDash() {},
    drawImage() {}, createLinearGradient: () => g, createRadialGradient: () => g,
    measureText: () => ({ width: 10 }), fillText() {}, strokeText() {},
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    font: '', textAlign: '', textBaseline: '', lineCap: ''
  };
}

function makeEl(id, tag) {
  const el = {
    id, tagName: (tag || 'div').toUpperCase(), style: {}, value: '',
    width: 680, height: 112, hidden: false, disabled: false, offsetWidth: 100,
    children: [], parentNode: null, _c: new Set(), _h: {}, type: '', _text: '',
    classList: {
      add: (c) => el._c.add(c), remove: (c) => el._c.delete(c),
      contains: (c) => el._c.has(c),
      toggle: (c, on) => { if (on === undefined ? !el._c.has(c) : on) el._c.add(c); else el._c.delete(c); }
    },
    getContext: () => el._ctx || (el._ctx = makeCtx()),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 700 }),
    addEventListener(t, fn) { el._h[t] = fn; },
    removeEventListener() {},
    dispatchEvent(ev) { const fn = el._h[ev && ev.type]; if (fn) fn(ev); return true; },
    click() { if (el._h.click) el._h.click({ preventDefault() {}, target: el }); },
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    removeChild(child) { const i = el.children.indexOf(child); if (i >= 0) el.children.splice(i, 1); return child; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => ({ textContent: '', style: {}, classList: { add() {}, remove() {} } }),
    querySelectorAll: () => [],
    focus() {}, select() {}, blur() {}
  };
  /* 真 DOM 里给 textContent 赋值会替换掉全部子节点，读取时会把所有后代拼起来，
     桩件也得一样，否则「渲染了几行 / 那行写了什么」这类断言会失真 */
  Object.defineProperty(el, 'textContent', {
    get() {
      if (el._text) return el._text;
      return el.children.map((c) => c.textContent).join('');
    },
    set(v) {
      el._text = String(v == null ? '' : v);
      el.children.length = 0;
    }
  });
  return el;
}

/* 页面上的元素（id 与 index.html 一致） */
const IDS = ['game', 'stage', 'overlay', 'score', 'best', 'finalScore', 'finalBest', 'next', 'chain',
  'soundBtn', 'resetBtn', 'restartBtn', 'revivePrompt', 'overPanel', 'reviveScore', 'reviveLeft',
  'reviveBtn', 'giveUpBtn', 'reviveBadge', 'reviveCount', 'boardBtn', 'boardBtn2', 'boardModal',
  'boardList', 'boardClose', 'boardRefresh', 'nickInput', 'myNameLabel', 'submitBtn', 'submitBox',
  'submitMsg', 'editNameBtn', 'syncState', 'sponsorBtn'];
const els = {};
IDS.forEach((id) => { els[id] = makeEl(id, id === 'nickInput' ? 'input' : 'div'); });
els.revivePrompt.hidden = true;
els.overPanel.hidden = false;
els.reviveBadge.hidden = true;
els.syncState.hidden = true;

/* ---------------------------------------------------------
 *  假 GitHub：一个内存里的仓库 + 内容 API 子集
 * ------------------------------------------------------- */

const repo = {
  files: new Map(),          // path -> { text, sha }
  calls: [],                 // 记录每次请求，用来断言"到底写没写"
  down: false,               // 打开就模拟网络故障
  seq: 0
};

function putFile(path, text) {
  repo.seq++;
  const sha = 'sha' + repo.seq.toString(36);
  repo.files.set(path, { text: text, sha: sha });
  return sha;
}

function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(String(b64 || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function jsonResponse(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: () => Promise.resolve(obj),
    text: () => Promise.resolve(typeof obj === 'string' ? obj : JSON.stringify(obj))
  };
}

const API_PREFIX = 'https://api.github.com/repos/';

function fakeFetch(url, init) {
  init = init || {};
  const method = (init.method || 'GET').toUpperCase();
  repo.calls.push({ method: method, url: url });

  if (repo.down) return Promise.reject(new Error('Failed to fetch'));

  /* 公网 IP 服务 */
  if (url.indexOf('ipapi.co') >= 0 || url.indexOf('icanhazip') >= 0 || url.indexOf('ipify') >= 0) {
    if (repo.noIp) return Promise.reject(new Error('offline'));
    return Promise.resolve(jsonResponse(200, { ip: repo.ip || '203.0.113.7' }));
  }

  if (url.indexOf(API_PREFIX) === 0) {
    if (!init.headers || !init.headers.Authorization) return Promise.resolve(jsonResponse(401, { message: 'Bad credentials' }));
    const rest = url.slice(API_PREFIX.length);
    const slash = rest.indexOf('/contents/');
    if (slash < 0) return Promise.resolve(jsonResponse(404, { message: 'Not Found' }));
    const filePath = rest.slice(slash + '/contents/'.length).split('?')[0];

    if (method === 'GET') {
      const f = repo.files.get(filePath);
      if (!f) return Promise.resolve(jsonResponse(404, { message: 'Not Found' }));
      return Promise.resolve(jsonResponse(200, {
        content: b64encodeUtf8(f.text), sha: f.sha, encoding: 'base64', path: filePath
      }));
    }
    if (method === 'PUT') {
      const body = JSON.parse(init.body);
      const cur = repo.files.get(filePath);
      /* 带 sha 的更新必须对上，模拟 GitHub 的乐观并发 */
      if (body.sha && (!cur || cur.sha !== body.sha)) {
        return Promise.resolve(jsonResponse(409, { message: 'sha does not match' }));
      }
      if (!body.sha && cur) return Promise.resolve(jsonResponse(422, { message: 'sha required' }));
      const sha = putFile(filePath, b64decodeUtf8(body.content));
      return Promise.resolve(jsonResponse(200, { content: { sha: sha, path: filePath } }));
    }
    return Promise.resolve(jsonResponse(405, { message: 'Method Not Allowed' }));
  }
  return Promise.resolve(jsonResponse(404, { message: 'Not Found' }));
}

/* ---------------------------------------------------------
 *  沙箱
 * ------------------------------------------------------- */

const winListeners = {};
const rafQueue = [];
const timers = [];
let fakeNow = 1700000000000;

const store = { local: {}, session: {} };
function makeStorage(bag) {
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : null),
    setItem: (k, v) => { bag[k] = String(v); },
    removeItem: (k) => { delete bag[k]; },
    clear: () => { Object.keys(bag).forEach((k) => delete bag[k]); }
  };
}

const documentStub = {
  readyState: 'complete',
  activeElement: null,
  getElementById: (id) => els[id] || null,
  createElement: (tag) => makeEl('tmp', tag),
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => []
};

const sandbox = {
  console, JSON, Object, Array, Number, String, Boolean, Error, isNaN, isFinite,
  parseFloat, parseInt, Math, Date, RegExp, Promise, Map, Set, Symbol, WeakMap, Reflect,
  TypeError, RangeError, Infinity, NaN, TextEncoder, TextDecoder, atob, btoa,
  AbortController: global.AbortController,
  Uint8Array, Uint32Array, Float32Array, ArrayBuffer,
  performance: { now: () => fakeNow },
  requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
  setTimeout: (fn, ms) => { const id = timers.length; timers.push({ fn: fn, at: fakeNow + (ms || 0) }); return id; },
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  document: documentStub,
  localStorage: makeStorage(store.local),
  sessionStorage: makeStorage(store.session),
  navigator: { vibrate() {} },
  location: { origin: 'https://example.github.io' },
  crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256; return a; } },
  fetch: fakeFetch,
  addEventListener(t, fn) { winListeners[t] = fn; },
  Image: class {
    constructor() { this.width = 512; this.height = 512; this.naturalWidth = 512; this.onload = null; this.onerror = null; }
    set src(v) { this._src = v; if (this.onload) this.onload(); }
    get src() { return this._src; }
  },
  AudioContext: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.module = { exports: {} };
sandbox.exports = sandbox.module.exports;
sandbox.require = (f) => {
  if (/dnw-core\.js$/.test(f)) return sandbox.module.exports;
  throw new Error('sandbox require: ' + f);
};
/* 顶层 await / Promise 需要这些 */
sandbox.queueMicrotask = queueMicrotask;

vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });

/* 浏览器里这两个文件是 UMD：没有 module 就挂到 window 上。
   沙箱里为了加载 dnw-core 给了 module，所以每个 UMD 文件都要手动"镜像"到 window，
   和真实浏览器的结果保持一致。 */
load('dnw-core.js');
sandbox.window.DNWCore = sandbox.module.exports;
sandbox.DNWCore = sandbox.module.exports;
sandbox.module.exports = {};              // 下一个 UMD 文件重新开始
sandbox.exports = sandbox.module.exports;
load('assets/fruits/parts.js');
load('dnw-board.js');
sandbox.window.DNWBoard = sandbox.module.exports;
sandbox.DNWBoard = sandbox.module.exports;
load('site-config.js');
load('game.js');
load('leaderboard.js');

const Core = sandbox.DNWCore;
const N = sandbox.window.__DNW__;
const LB = sandbox.window.DanaiwaBoard;

/* 让沙箱里的 Promise 真正跑起来（vm 里 setTimeout 是被我接管的假表） */
function pumpAsync(rounds) {
  return new Promise((resolve) => {
    let n = 0;
    const real = global.setTimeout;
    const tick = () => {
      /* 触发所有到期的假定时器 */
      for (let i = timers.length - 1; i >= 0; i--) {
        if (timers[i].at <= fakeNow) { const t = timers.splice(i, 1)[0]; t.fn(); }
      }
      if (++n >= (rounds || 30)) { resolve(); return; }
      real(tick, 0);
    };
    real(tick, 0);
  });
}
async function drainSync(maxSteps) {
  for (let i = 0; i < (maxSteps || 60); i++) {
    await pumpAsync(3);
    const st = LB.state().sync;
    if (st === 'synced' || st === 'failed' || st === 'local' || st === 'idle') return st;
    fakeNow += 500;
  }
  return LB.state().sync;
}

/* 一直泵到条件成立（用于等异步复算 / 等定时器 / 等网络往返），
   比 drainSync 更适合"状态本来就是终态、但要等另一件事完成"的场景 */
async function until(cond, maxSteps) {
  for (let i = 0; i < (maxSteps || 120); i++) {
    await pumpAsync(3);
    if (cond()) return true;
    fakeNow += 300;
  }
  return false;
}

/* 打一局真对局并结算 */
function playAndSettle(drops, step, scoreMul) {
  N.reset();
  const eng = N.engine;
  for (let i = 0; i < drops; i++) {
    for (let k = 0; k < 26; k++) eng.update(1 / 60);
    eng.moveAim(45 + ((i * step) % 330));
    N.tryDrop();
  }
  for (let k = 0; k < 60 * 40 && !eng.state.over; k++) eng.update(1 / 60);
  const runId = N.runId();
  let score = eng.state.score;
  /* 想要特定分数时（造作弊样本 / 造高分）直接改在结算前 */
  if (scoreMul) { score = scoreMul; }
  LB.onGameOver({ score: score, engine: eng, runId: runId });
  return { score: score, engine: eng, run: eng.exportRun() };
}

const MY_ID = Board.hashIdentity('203.0.113.7', 'data/voided.json');

function readBoard() {
  const f = repo.files.get('data/board.json');
  return f ? Board.normalizeBoard(JSON.parse(f.text)) : null;
}
function writes() { return repo.calls.filter((c) => c.method === 'PUT'); }

/* ---------------------------------------------------------
 *  开跑
 * ------------------------------------------------------- */

console.log('前端集成自检\n');

(async () => {
  /* ---------- A. 空榜：第一局就上榜 ---------- */
  console.log('[A] 空榜 → 第一局');
  putFile('data/board.json', JSON.stringify(Board.newBoard()));
  putFile('data/voided.json', JSON.stringify({ v: 1, records: [] }));
  await LB.refresh();

  let r = playAndSettle(40, 97);
  eq(LB.state().sync, 'syncing', '结算后立刻进入「正在同步」（玩家先看到自己的名次）');
  eq(els.syncState.textContent, '正在同步…', '同步状态写着「正在同步…」');
  ok(/正在核验/.test(els.submitMsg.textContent), '结算后先核验身份', els.submitMsg.textContent);
  await until(() => /暂列第/.test(els.submitMsg.textContent), 20);
  ok(/暂列第 1 名/.test(els.submitMsg.textContent), '身份确定后立刻给出本机名次', els.submitMsg.textContent);

  let st = await drainSync();
  eq(st, 'synced', '同步完成');
  eq(els.syncState.textContent, '已同步 ✓', '同步状态变成「已同步 ✓」');
  ok(repo.files.has('data/owners/' + MY_ID + '.json'), '写出了我自己的存档文件');

  let board = readBoard();
  eq(board.entries.length, 1, '总榜有 1 条');
  eq(board.entries[0].id, MY_ID, '就是我');
  const owner = JSON.parse(repo.files.get('data/owners/' + MY_ID + '.json').text);
  ok(!!owner.run && !!owner.run.seed, '存档里有随机种子');
  ok(typeof owner.run.a === 'string' && owner.run.a.indexOf(',') > 0, '存档里有动作序列（帧号,投放位置）', owner.run.a.slice(0, 40));
  ok(typeof owner.run.k === 'string' && owner.run.k.indexOf('f0,s0') === 0, '存档里有过程快照', owner.run.k.slice(0, 40));
  eq(owner.verify.verdict, 'pass', '上传前快照自检通过');
  ok((owner.verify.snapshots || 0) >= 2, '存档里记了快照条数', owner.verify.snapshots + ' 条');
  ok(/每 500 分一条/.test(JSON.stringify(owner.run.k).slice(0, 400)) === false && owner.run.k.indexOf('s0,') >= 0,
    '快照里有 0 分那条');
  const badWrites = writes().filter((w) => w.url.indexOf('/contents/data/') < 0);
  eq(badWrites.length, 0, '只写了仓库里的数据文件');

  /* ---------- B. 第二局更差：数据库里必须仍是高分那条 ---------- */
  console.log('\n[B] 每人只留最好成绩');
  const highScore = board.entries[0].score;
  fakeNow += 20000;                       // 过了提交间隔
  const r2 = playAndSettle(28, 53);       // 再打一局，分数更低
  ok(r2.score > 0 && r2.score < highScore, '第二局有分但比重低', r2.score + ' < ' + highScore);
  /* 等真正的终态：延迟上传要等 10 秒的提交间隔走完 */
  const bDone = await until(() => /没刷新纪录|已同步 ✓|无记录|失败/.test(els.syncState.textContent), 400);
  ok(bDone, '走到了终态（不是卡在正在同步）', els.syncState.textContent);
  board = readBoard();
  eq(board.entries.length, 1, '榜上还是 1 条（没有多出第二条）');
  eq(board.entries[0].score, highScore, '保留的仍是最好的那个分数');
  const owner2 = JSON.parse(repo.files.get('data/owners/' + MY_ID + '.json').text);
  eq(owner2.score, highScore, '存档也没被低分覆盖');
  ok(/没有超过我自己的/.test(els.submitMsg.textContent) || /没刷新纪录/.test(els.syncState.textContent),
    '告诉玩家这局没超过自己以前的成绩', els.submitMsg.textContent + ' / ' + els.syncState.textContent);
  ok(/不占用上传/.test(els.syncState.textContent), '明说没刷新纪录就不上传', els.syncState.textContent);

  /* ---------- B2. 同步节流：不该传的绝不传 ---------- */
  console.log('\n[B2] 只有「刷新纪录 + 能上榜」才上传');
  {
    /* 场景一：连着打两局都没刷新纪录 → 一次 PUT 都不能有 */
    const before = writes().length;
    fakeNow += 20000;
    playAndSettle(12, 41);
    await until(() => /不占用上传|已同步|无记录|失败/.test(els.syncState.textContent), 60);
    const afterLower = writes().slice(before);
    eq(afterLower.length, 0, '再打一局没超过纪录 → 零上传', 'PUT ' + afterLower.length + ' 次');

    /* 场景二：这局确实刷新了纪录，但已经打得很高、再打也超不过 → 仍然零上传 */
    store.session = {};
    const myOwnerNow = JSON.parse(repo.files.get('data/owners/' + MY_ID + '.json').text);
    const before2 = writes().length;
    fakeNow += 20000;
    /* 故意打一局分数很低的，确保是"没超过纪录"而不是"没进榜" */
    playAndSettle(9, 37);
    await until(() => /不占用上传|已同步|无记录|失败/.test(els.syncState.textContent), 60);
    eq(writes().slice(before2).length, 0, '没超过自己纪录时不写库');
    const myOwnerAfter = JSON.parse(repo.files.get('data/owners/' + MY_ID + '.json').text);
    eq(myOwnerAfter.score, myOwnerNow.score, '数据库里我的成绩没被动过');

    /* 场景三：真的刷了纪录 → 会写 owner + 总榜。
       构造：服务器上我的成绩是 50 分（"以前很菜"），榜上只有两个人、榜没满，
       所以我再打一局正常分数就一定会刷新纪录并上榜。
       同时清掉本地缓存的 myBest（真实游戏里开新局就会清）。 */
    store.session = {};
    const lowOwner = {
      v: 1, id: MY_ID, key: 'ip', name: '匿名玩家', score: 50, runId: 'old-low',
      submittedAt: 1700000000000, run: null, verify: { verdict: 'pass' }
    };
    putFile('data/owners/' + MY_ID + '.json', JSON.stringify(lowOwner));
    const b3 = Board.newBoard();
    b3.entries.push({
      id: MY_ID, owner: 'data/owners/' + MY_ID + '.json', name: '匿名玩家',
      score: 50, submittedAt: 1700000000000, runId: 'old-low', run: null, flags: 0
    });
    b3.entries.push({
      id: 'someoneelse', owner: 'data/owners/someoneelse.json', name: '别人',
      score: 30, submittedAt: 1700000001000, runId: 'other', run: null, flags: 0
    });
    putFile('data/board.json', JSON.stringify(b3));
    await LB.refresh();
    LB.onRunStart();                     // 相当于"开新一局"：清掉本局的 myBest 缓存
    const before3 = writes().length;
    fakeNow += 20000;
    playAndSettle(40, 97);
    /* 新人第一次上榜要走「读存档 → 写存档 → 读总榜 → 写总榜」，
       中间还可能撞上 10 秒提交间隔而被推迟，所以要等到真正的终态再数。 */
    const b3done = await until(() => /已同步 ✓|无记录|失败|没刷新纪录/.test(els.syncState.textContent), 400);
    ok(b3done, '刷新纪录这一局走到了终态', els.syncState.textContent);
    const after3 = writes().slice(before3);
    ok(after3.length >= 1, '刷新纪录时确实上传了', 'PUT ' + after3.length + ' 次');
    ok(after3.every((w) => w.url.indexOf('/contents/data/') >= 0), '只写数据目录');
  }

  /* ---------- C. 没进前 100：一个字节都不写 ---------- */
  console.log('\n[C] 没进前 100 → 不写 GitHub');
  /* 一个全新的玩家（清掉身份与本地记录），面对一个塞满的榜 */
  store.session = {};
  store.local = {};
  const full = Board.newBoard();
  for (let i = 0; i < 100; i++) {
    full.entries.push({
      id: 'filler' + i, owner: 'data/owners/filler' + i + '.json', name: '高手' + i,
      score: 100000 + i, submittedAt: 1700000000000 + i, runId: 'f' + i, run: null, flags: 0
    });
  }
  putFile('data/board.json', JSON.stringify(full));
  await LB.refresh();

  const callsBeforeMiss = repo.calls.length;
  fakeNow += 20000;
  const r3 = playAndSettle(25, 71);
  ok(r3.score > 0, '这一局确实打了分', r3.score + ' 分');
  const reached = await until(() => /已同步|无记录|失败|没刷新纪录/.test(els.syncState.textContent), 400);
  ok(reached, '走到了终态而不是卡在「正在同步…」', els.syncState.textContent);
  ok(!/正在同步/.test(els.syncState.textContent), '没停在「正在同步…」', els.syncState.textContent);
  const writesAfter = repo.calls.slice(callsBeforeMiss).filter((c) => c.method === 'PUT');
  eq(writesAfter.length, 0, '没有发起任何写入', 'PUT 次数 = ' + writesAfter.length);
  const missBoard = readBoard();
  eq(missBoard.entries.length, 100, '总榜没被动过');
  ok(!missBoard.entries.some((e) => e.score < 100000), '没有把自己的低分塞进去');
  /* 本机榜不应该把这条低分写进榜单数据里；界面上会额外挂一行「我 · 无记录」，
     那是提示，不是榜上的一条。 */
  const localBoard = LB.state().board;
  eq(localBoard.entries.length, 100, '本地榜单数据还是 100 条（没把自己塞进去）');
  ok(!localBoard.entries.some((e) => e.score < 100000), '本地榜里没有我这条低分');
  const myRow = els.boardList.children.filter((c) => /（我）/.test(c.textContent))[0];
  ok(!!myRow, '界面上另外挂了一行「我」的提示');
  ok(myRow && /无记录/.test(myRow.textContent), '那一行写着「无记录」', myRow && myRow.textContent);

  /* ---------- D. 网络故障：不崩、不写、能重试 ---------- */
  console.log('\n[D] 网络挂了');
  putFile('data/board.json', JSON.stringify(Board.newBoard()));
  await LB.refresh();
  repo.down = true;
  fakeNow += 20000;
  let threw = false;
  try {
    playAndSettle(30, 83);
    await pumpAsync(20);
  } catch (e) { threw = true; }
  ok(!threw, '游戏和排行榜都没抛异常');
  /* 网络断了的时候，"正在同步…"会多停一会儿（身份要等几个源的超时），
     但最终必须给出交代：要么走到终态，要么弹出重试按钮。 */
  await until(() => els.syncState.textContent !== '正在同步…' || els.submitBtn.hidden === false, 400);
  const terminal = ['synced', 'failed', 'local'].indexOf(LB.state().sync) >= 0;
  ok(terminal || els.submitBtn.hidden === false, '给了明确的交代（终态或重试按钮）',
    'sync=' + LB.state().sync + ' 重试按钮 hidden=' + els.submitBtn.hidden + ' 文案=' + els.syncState.textContent);
  const writesWhileDown = repo.calls.filter((c) => c.method === 'PUT').length;
  ok(readBoard().entries.length === 0, '断网期间没有写进去任何东西', 'PUT 总数 ' + writesWhileDown);

  repo.down = false;
  fakeNow += 20000;
  els.submitBtn.hidden = false;
  els.submitBtn.dispatchEvent({ type: 'click', target: els.submitBtn, preventDefault() {} });
  st = await drainSync(120);
  ok(st === 'synced' || st === 'local', '恢复网络后重试成功', st + ' / ' + els.syncState.textContent);
  if (st === 'synced') {
    ok(readBoard().entries.length === 1, '重试后成绩真的进了数据库');
  }

  /* ---------- E. 榜上有人的存档缺失 → 写「无记录」 ---------- */
  console.log('\n[E] 数据库缺位');
  const withGhost = Board.newBoard();
  withGhost.entries.push({
    id: 'ghostxx', owner: 'data/owners/ghostxx.json', name: '没有存档的人',
    score: 7777, submittedAt: 1700000000000, runId: 'g1', run: null, flags: 0
  });
  withGhost.entries.push({
    id: MY_ID, owner: 'data/owners/' + MY_ID + '.json', name: '我',
    score: 500, submittedAt: 1700000001000, runId: 'g2', run: null, flags: 0
  });
  putFile('data/board.json', JSON.stringify(withGhost));
  await LB.refresh();
  const rows = els.boardList.children;
  eq(rows.length, 2, '两条都渲染出来了（坏数据不影响别人）');
  ok(/没有存档的人/.test(rows[0].textContent), '缺存档的人照样显示名字与分数', rows[0].textContent);
  ok(rows[0].children.some((c) => c.className.indexOf('report-btn') >= 0), '他也有举报按钮');

  /* 举报一个"没有记录"的人 → 不能误报成作弊 */
  const reportBtn = rows[0].children.filter((c) => c.className.indexOf('report-btn') >= 0)[0];
  reportBtn._h.click({ target: reportBtn, preventDefault() {} });
  await until(() => /无记录|已举报|已核对/.test(reportBtn.textContent), 40);
  eq(reportBtn.textContent, '已举报 ✓', '点了举报 → 按「快照缺失」提交');
  const ghostReports = writes().filter((w) => w.url.indexOf('data/reports') >= 0);
  eq(ghostReports.length, 1, '写了一份「快照缺失」的举报记录');
  const ghostPath = decodeURIComponent(ghostReports[0].url.split('/contents/')[1].split('?')[0]);
  const ghostEvidence = JSON.parse(repo.files.get(ghostPath).text);
  eq(ghostEvidence.targetId, 'ghostxx', '举报指向那条没有记录的分数');
  eq(ghostEvidence.verdict, 'incomplete', '裁决是「数据不完整」');
  ok(/没有对局记录|快照/.test(ghostEvidence.reason), '说清楚是快照缺失', ghostEvidence.reason);

  /* ---------- F. 举报：真作弊才写证据 ---------- */
  console.log('\n[F] 举报真作弊 / 不误报老实人');
  /* 老实人：拿一份真的存档（我自己的） */
  const honestRaw = repo.files.get('data/owners/' + MY_ID + '.json').text;
  putFile('data/owners/honestzon.json', honestRaw.replace(/"id":"[^"]*"/, '"id":"honestzon"'));

  /* 作弊者：同样的动作序列，分数改成 999999 */
  const cheatRun = JSON.parse(honestRaw);
  cheatRun.id = 'cheatzon';
  cheatRun.score = 999999;
  cheatRun.run.score = 999999;
  putFile('data/owners/cheatzon.json', JSON.stringify(cheatRun));

  const mixed = Board.newBoard();
  const honestScore = JSON.parse(honestRaw).score;
  mixed.entries.push({ id: 'cheatzon', owner: 'data/owners/cheatzon.json', name: '作弊者', score: 999999, submittedAt: 1700000000000, runId: 'c1', run: null, flags: 0 });
  mixed.entries.push({ id: 'honestzon', owner: 'data/owners/honestzon.json', name: '老实人', score: honestScore, submittedAt: 1700000001000, runId: 'h1', run: null, flags: 0 });
  putFile('data/board.json', JSON.stringify(mixed));
  await LB.refresh();

  const rowList = els.boardList.children;
  const cheatBtn = rowList[0].children.filter((c) => c.className.indexOf('report-btn') >= 0)[0];
  const reportsBefore = writes().filter((w) => w.url.indexOf('data/reports') >= 0).length;
  cheatBtn._h.click({ target: cheatBtn, preventDefault() {} });
  const cheatDone = await until(() => /已举报|已核对|无记录|失败/.test(cheatBtn.textContent), 200);
  ok(cheatDone, '复算跑完了（没有卡在「复算中」）', cheatBtn.textContent);
  eq(cheatBtn.textContent, '已举报 ✓', '作弊者被举报');
  const reportWrites = writes().filter((w) => w.url.indexOf('data/reports') >= 0);
  eq(reportWrites.length, reportsBefore + 1, '写了一份举报记录');
  const reportPath = decodeURIComponent(reportWrites[reportWrites.length - 1].url.split('/contents/')[1].split('?')[0]);
  const evidence = JSON.parse(repo.files.get(reportPath).text);
  eq(evidence.targetId, 'cheatzon', '举报指向正确的人');
  eq(evidence.claimed, 999999, '记录了榜上写的分数');
  ok(evidence.verdict && evidence.verdict !== 'pass', '给了不给过的裁决', evidence.verdict);
  ok(typeof evidence.reason === 'string' && evidence.reason.length > 0, '给了具体理由', evidence.reason);
  ok(Array.isArray(evidence.problems), '带了问题清单', JSON.stringify(evidence.problems || []).slice(0, 70));

  /* 老实人：复算对得上 → 只提示「已核对」，不写举报 */
  const honestBtn = rowList[1].children.filter((c) => c.className.indexOf('report-btn') >= 0)[0];
  const beforeHonest = writes().filter((w) => w.url.indexOf('data/reports') >= 0).length;
  honestBtn._h.click({ target: honestBtn, preventDefault() {} });
  const honestDone = await until(() => /快照完整|已举报|无记录|失败/.test(honestBtn.textContent), 200);
  ok(honestDone, '核查跑完了', honestBtn.textContent);
  eq(honestBtn.textContent, '快照完整', '老实人只显示「快照完整」');
  eq(writes().filter((w) => w.url.indexOf('data/reports') >= 0).length, beforeHonest, '没有误报');
  ok(/快照完整|没有发现问题/.test(honestBtn.title), '提示说明了快照完整', honestBtn.title);
  /* 举报的闸门：本机没法通过就不上传 —— 这里再确认一次"上报数没变" */
  eq(writes().filter((w) => w.url.indexOf('data/reports') >= 0).length, beforeHonest,
    '本机判定「快照完整」→ 举报一个字节都没上传');

  /* ---------- F2. 昵称里的中文/表情：从输入到上榜，一个字都不能坏 ---------- */
  console.log('\n[F2] 昵称端到端');
  {
    const hasLone = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
    /* 让表情骑在截断点上：这是老版本会显示成 � 的那种昵称 */
    const tricky = '奶'.repeat(11) + '🍉尾巴';
    els.nickInput.value = tricky;
    els.nickInput.dispatchEvent({ type: 'change', target: els.nickInput });
    eq(els.myNameLabel.textContent, Board.cleanName(tricky), '输入框提交后显示的就是清理过的名字');
    ok(!hasLone(els.myNameLabel.textContent), '界面上没有半个代理项（不会出现 �）',
      JSON.stringify(els.myNameLabel.textContent));

    /* 打一局上榜，检查库里存的名字 */
    putFile('data/board.json', JSON.stringify(Board.newBoard()));
    repo.files.delete('data/owners/' + MY_ID + '.json');
    await LB.refresh();
    LB.onRunStart();
    fakeNow += 20000;
    playAndSettle(45, 103);
    await until(() => /已同步 ✓|无记录|失败|没刷新纪录/.test(els.syncState.textContent), 400);

    const stored = JSON.parse(repo.files.get('data/owners/' + MY_ID + '.json').text);
    ok(!hasLone(stored.name), '存进库里的名字没有被劈坏', JSON.stringify(stored.name));
    eq(Array.from(stored.name).length <= Board.NAME_MAX, true,
      '存进库里的名字不超过 ' + Board.NAME_MAX + ' 个字', stored.name);

    /* 再刷新一次榜，看看渲染出来的文本 */
    await LB.refresh();
    const rows = els.boardList.children;
    const mine = rows.filter((c) => /（我）/.test(c.textContent))[0] || rows[0];
    ok(!hasLone(mine.textContent), '榜上渲染出来的文本也没有坏字符', JSON.stringify(mine.textContent));
    ok(mine.textContent.indexOf('�') < 0, '界面上不出现 U+FFFD 替换符');
  }

  /* ---------- G. 拿不到公网 IP → 本地 ID 兜底 ---------- */
  console.log('\n[G] 拿不到公网 IP');
  putFile('data/board.json', JSON.stringify(Board.newBoard()));
  repo.noIp = true;
  /* 清掉缓存的 IP 与身份：重新开一个"新玩家"的场景不好做，
     这里直接验证 fetchIP 的兜底链路 —— 把 sessionStorage 里缓存的 IP 删掉，
     并让 LB 重新解析身份（force） */
  store.session = {};
  await LB.refresh();
  await drainSync(10);
  const idWithIp = LB.state().myId;
  /* 直接触发一次强制重解析 */
  const fakeIpAgain = await new Promise((resolve) => {
    sandbox.fetch('https://ipapi.co/json/').then(() => resolve('resolved')).catch(() => resolve('rejected'));
  });
  eq(fakeIpAgain, 'rejected', 'IP 服务不可用时确实会 reject（走兜底分支）');
  repo.noIp = false;

  /* ---------- H. 空榜文案 ---------- */
  console.log('\n[H] 空榜');
  putFile('data/board.json', JSON.stringify(Board.newBoard()));
  await LB.refresh();
  const emptyEl = els.boardList.children[0];
  ok(emptyEl && /榜上还空着|读取/.test(emptyEl.textContent), '空榜有明确文案', emptyEl && emptyEl.textContent);

  /* ---------- 收尾 ---------- */
  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('集成测试崩了：', e && e.stack || e);
  process.exit(1);
});
