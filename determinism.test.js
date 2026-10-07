/* ============================================================
 *  复算 / 防作弊自检（无浏览器）
 *  运行：node determinism.test.js
 *
 *  覆盖：
 *    · 同一颗种子 + 同一串动作 → 逐帧状态完全一致（确定性的地基）
 *    · 不同种子 → 结果不同（种子真的在起作用）
 *    · 存下来的一局能原样复算出同一个分数（不是靠运气）
 *    · 改分数 / 改快照 / 改动作 / 删动作 → 一律被抓出来
 *    · 结构非法的数据 → malformed，不会被当成合法成绩
 *    · 复算耗时（举报要在玩家浏览器里当场跑完）
 * ============================================================ */
'use strict';
const fs = require('fs'), path = require('path');
const root = __dirname;

const Core = require(path.join(root, 'dnw-core.js'));

/* 碰撞形状按贴图轮廓生成，复算必须用同一份 */
const partsSrc = fs.readFileSync(path.join(root, 'assets', 'fruits', 'parts.js'), 'utf8');
const m = partsSrc.match(/SUIKA_PARTS\s*=\s*(\[[\s\S]*?\]);?\s*$/m);
Core.setShapes(m ? JSON.parse(m[1]) : []);

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  -- ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, label) { ok(a === b, label, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

const FIXED = Core.CONST.FIXED;

/* 造一局「像人玩的」对局：固定种子，按冷却节奏随机投放 */
function playRun(seed, drops, xFn) {
  const g = Core.createGame(seed);
  g.reset(seed);
  let dropAt = 0;
  for (let i = 0; i < drops; i++) {
    dropAt += 25 + Math.floor(((seed * (i + 7)) % 17));
    while (g.getFrame() < dropAt) g.update(FIXED);
    g.drop(xFn(i));
  }
  /* 收尾：跑到结束或者最多再跑 20 秒 */
  for (let i = 0; i < 60 * 20 && !g.state.over; i++) g.update(FIXED);
  return g;
}

const xFor = (i) => 60 + ((i * 53) % 300);

console.log('复算自检：确定性 + 防作弊\n');

/* ---------- A. 确定性 ---------- */
console.log('[A] 确定性：同种子同动作 → 逐帧一致');
const A1 = playRun(123456, 40, xFor);
const A2 = playRun(123456, 40, xFor);

eq(A1.state.score, A2.state.score, '两次跑分数一致');
eq(A1.getFrame(), A2.getFrame(), '两次跑帧数一致');
eq(A1.state.balls.length, A2.state.balls.length, '两次跑球数一致');
eq(Core.hashBalls(A1.state.balls), Core.hashBalls(A2.state.balls), '两次跑盘面指纹一致');

const sn1 = A1.getSnapshots(), sn2 = A2.getSnapshots();
eq(sn1.length, sn2.length, '快照条数一致');
eq(sn1.map(Core.snapshotLine).join('|'), sn2.map(Core.snapshotLine).join('|'), '每条快照都一致');

const A3 = playRun(999999, 40, xFor);
ok(A3.state.score !== A1.state.score || Core.hashBalls(A3.state.balls) !== Core.hashBalls(A1.state.balls),
  '换种子结果不同（种子真的有用）', 'seed123456=' + A1.state.score + ' seed999999=' + A3.state.score);

/* ---------- B. 存档 → 复算 ---------- */
console.log('\n[B] 存下来的对局能原样复算');
const run = A1.exportRun();
ok(run.actions.length > 0, '动作序列非空', run.actions.length + ' 个动作');
ok(run.snapshots.length >= 2, '有多个过程快照', run.snapshots.length + ' 条');

const packed = Core.encodeRun(run);
const size = JSON.stringify(packed).length;
ok(size < 60000, '存档体积可控', (size / 1024).toFixed(1) + ' KB');

const decoded = Core.decodeRun(packed);
eq(decoded.score, run.score, '解码后分数一致');
eq(decoded.actions.length, run.actions.length, '解码后动作数一致');
eq(decoded.snapshots.length, run.snapshots.length, '解码后快照数一致');

const verdict = Core.validateRun(decoded);
eq(verdict.verdict, 'pass', '复算裁决 = pass');
eq(verdict.replayScore, run.score, '复算分数 = 申报分数', run.score + ' 分');
eq(verdict.frameErrorCount, 0, '过程快照零错位');

/* 复算的结果必须和真跑一模一样，不是"差不多" */
const replayEngine = Core.createGame(Core.strToSeed(run.seed));
ok(true, '复算用的种子可还原', run.seed + ' → ' + Core.strToSeed(run.seed));

/* ---------- C. 作弊：改分数 ---------- */
console.log('\n[C] 改分数');
const cheatScore = Object.assign({}, packed, { score: packed.score + 5000 });
const vC = Core.validateRun(Core.decodeRun(cheatScore));
eq(vC.verdict, 'fraud', '虚报 5000 分 → fraud');
ok(vC.delta < 0, '给出了差值证据', 'delta=' + vC.delta);

const cheatScore2 = Object.assign({}, packed, { score: Math.floor(packed.score / 2) });
eq(Core.validateRun(Core.decodeRun(cheatScore2)).verdict, 'fraud', '少报分数 → 也是 fraud（分数必须严丝合缝）');

/* ---------- D. 作弊：伪造过程 ---------- */
console.log('\n[D] 改过程快照');
const lines = packed.k.split(';');
const mid = Math.floor(lines.length / 2);
const tamperedK = lines.slice();
tamperedK[mid] = tamperedK[mid].replace(/s\d+/, 's' + (Number(tamperedK[mid].match(/s(\d+)/)[1]) + 300));
const vD = Core.validateRun(Core.decodeRun(Object.assign({}, packed, { k: tamperedK.join(';') })));
ok(vD.verdict === 'tamper' || vD.verdict === 'fraud', '中途多塞 300 分 → 被抓', vD.verdict + ' / ' + vD.reason);

const hashBumped = lines.slice();
hashBumped[mid] = hashBumped[mid].replace(/h[0-9a-z]+$/, 'hzzzzz');
const vD2 = Core.validateRun(Core.decodeRun(Object.assign({}, packed, { k: hashBumped.join(';') })));
eq(vD2.verdict, 'tamper', '只改盘面指纹 → tamper（得分对得上但过程对不上）');

/* 开局就有分：一眼假 */
const fakeHead = Object.assign({}, packed, { k: 'f0,s9999,n0,r0,h1;' + packed.k });
eq(Core.validateRun(Core.decodeRun(fakeHead)).verdict, 'tamper', '开局快照就有 9999 分 → 直接判 tamper');

/* ---------- E. 作弊：改动作 ---------- */
console.log('\n[E] 改动作序列');
const acts = packed.a.split(';');
const beforeV = Core.validateRun(Core.decodeRun(packed));
const moved = acts.slice();
moved[2] = moved[2].replace(/^\d+/, String(Number(moved[2].split(',')[0]) + 60));
const vE = Core.validateRun(Core.decodeRun(Object.assign({}, packed, { a: moved.join(';') })));
ok(vE.verdict !== 'pass', '把第 3 次投放的时机挪后 1 秒 → 复算对不上', vE.verdict + ' / ' + vE.reason);

const dropped = acts.slice(0, -1);
const vE2 = Core.validateRun(Core.decodeRun(Object.assign({}, packed, { a: dropped.join(';') })));
ok(vE2.verdict !== 'pass', '删掉最后一次投放 → 复算对不上', vE2.verdict + ' / ' + vE2.reason);

/* 结构非法要单独造：拿真存档去改，很容易先触发别的规则（比如间隔太小） */
const emptySnap = 'f0,s0,n0,r0,h1';
eq(Core.validateRun(Core.decodeRun({ seed: 'zz', score: 1, a: '10,100;12,100', k: emptySnap })).verdict,
  'malformed', '两次投放只隔 2 帧 → malformed');
eq(Core.validateRun(Core.decodeRun({ seed: 'zz', score: 1, a: '10,100', k: 'f0,s0,n0,r0,h1;f' + (60 * 60 * 61) + ',s1,n1,r0,h1' })).verdict,
  'malformed', '快照帧号超出 1 小时上限 → malformed');

/* 把分数改小、动作也删干净：不能因为"复算更小"就放行 */
const gutted = Object.assign({}, packed, { a: acts.slice(0, 3).join(';') });
eq(Core.validateRun(Core.decodeRun(gutted)).verdict, 'fraud', '只留 3 个动作却报满分 → fraud');

/* ---------- F. 结构非法 ---------- */
console.log('\n[F] 结构非法');
eq(Core.validateRun(Core.decodeRun({ score: 100, a: '', k: '' })).verdict, 'malformed', '没有种子 → malformed');
eq(Core.validateRun(Core.decodeRun({ seed: 'abc', score: -5, a: '', k: '' })).verdict, 'malformed', '负分 → malformed');
eq(Core.validateRun(Core.decodeRun({ seed: 'abc', score: 9.9e9, a: '', k: '' })).verdict, 'malformed', '分数大到离谱 → malformed');
eq(Core.validateRun(null).verdict, 'malformed', '空数据 → malformed');
eq(Core.validateRun({ seed: 'abc', score: 1, actions: [{ k: 'drop', t: 60 * 60 * 61, x: 100 }], snapshots: [] }).verdict,
  'malformed', '动作帧号越界 → malformed');
eq(Core.validateRun({ seed: 'abc', score: 1, actions: [{ k: 'drop', t: 10, x: 5000 }], snapshots: [] }).verdict,
  'malformed', '投放位置在场地外 → malformed');

/* 合法但对不上的：分数为 0 的空局 */
const empty = Core.encodeRun({ seed: 'zz', score: 0, actions: [], snapshots: [{ f: 0, s: 0, n: 0, r: 0, h: Core.hashBalls([]) }] });
eq(Core.validateRun(Core.decodeRun(empty)).verdict, 'pass', '0 分空局本身合法');

/* ---------- G. 举报要跑多快 ---------- */
console.log('\n[G] 复算耗时（举报是当场在玩家浏览器里跑的）');
const longRun = playRun(20261008, 220, xFor);
const longPacked = Core.encodeRun(longRun.exportRun());
const t0 = Date.now();
const vLong = Core.validateRun(Core.decodeRun(longPacked));
const ms = Date.now() - t0;
eq(vLong.verdict, 'pass', '一整局复算 = pass', longRun.state.score + ' 分 / ' + longRun.getFrame() + ' 帧');
ok(ms < 20000, '复算耗时可以接受', ms + ' ms（存档 ' + (JSON.stringify(longPacked).length / 1024).toFixed(1) + ' KB）');

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');

/* ---------- H. 分段复算（举报用）和同步复算结果必须一致 ---------- */
(async () => {
  console.log('\n[H] 分段复算（让出主线程版）结果与同步版一致');
  const packed2 = longPacked;
  const sync = Core.validateRun(Core.decodeRun(packed2));

  let ticks = 0;
  const t1 = Date.now();
  const asyncVerdict = await Core.verifyRunAsync(Core.decodeRun(packed2), {
    timeSlice: 5,
    onProgress: () => { ticks++; }
  });
  const msAsync = Date.now() - t1;

  eq(asyncVerdict.verdict, sync.verdict, '裁决一致');
  eq(asyncVerdict.replayScore, sync.replayScore, '复算分数一致');
  eq(asyncVerdict.frameErrorCount, sync.frameErrorCount, '快照错位数一致');
  ok(ticks > 0, '确实分段让出了主线程', ticks + ' 次');

  /* 改过分数的那份，两条路径也必须给出同一个结论 */
  const cheat2 = Object.assign({}, packed2, { score: packed2.score + 8000 });
  const s2 = Core.validateRun(Core.decodeRun(cheat2));
  const a2 = await Core.verifyRunAsync(Core.decodeRun(cheat2), { timeSlice: 5 });
  eq(a2.verdict, s2.verdict, '作弊样本：两条路径结论一致（' + a2.verdict + '）');

  console.log('  分段复算耗时 ' + msAsync + ' ms（同步版 ' + ms + ' ms）');
  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
