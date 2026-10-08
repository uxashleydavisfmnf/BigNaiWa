/* ============================================================
 *  快照校验自检（无浏览器）
 *  运行：node audit.test.js
 *
 *  现在的防作弊只做一件事：**校验快照**。覆盖：
 *    · 正常人打出来的局，快照一定完整、分数一定有理 → pass
 *    · 每 500 分一条，中间缺一条 → incomplete
 *    · 收尾那条不等于申报分数（凭空多分）→ implausible
 *    · 快照分数倒退 / 时间戳倒退 → incomplete
 *    · 涨 500 分却没投几次（白送分）→ incomplete
 *    · 动作里记的水果等级和种子对不上 → implausible
 *    · 手改快照分数（签名对不上 / 不是整倍数）→ 被抓
 *    · 没有快照 / 没有种子 / 帧号越界 → malformed
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const root = __dirname;
const Core = require(path.join(root, 'dnw-core.js'));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  -- ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, label) { ok(a === b, label, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

const FIXED = Core.CONST.FIXED;
const STEP = Core.CONST.SNAP_STEP;

/* 打一局（可选带复活），返回真实存档 */
function play(seed, drops, opts) {
  opts = opts || {};
  const g = Core.createGame(seed);
  g.reset(seed);
  let acted = 0;
  for (let i = 0; i < drops; i++) {
    for (let k = 0; k < 26; k++) g.update(FIXED);
    if (g.state.over) {
      if (opts.revive && g.state.revives > 0) { g.revive(); }
      else break;
    }
    if (g.state.ready) { g.drop(60 + ((i * 97) % 300)); acted++; }
  }
  for (let k = 0; k < 60 * 30 && !g.state.over; k++) g.update(FIXED);
  return g;
}
const packed = (g) => Core.encodeRun(g.exportRun());
const clone = (o) => JSON.parse(JSON.stringify(o));
const decode = (o) => Core.decodeRun(o);
const audit = (o) => Core.auditRun(decode(o));

console.log('快照校验自检\n');

/* ---------- A. 正常局必须通过 ---------- */
console.log('[A] 正常人打出来的局');
let allOk = true, snapLens = [];
for (let s = 1; s <= 20; s++) {
  const p = packed(play(s * 137, 80 + (s * 31) % 350));
  const a = audit(p);
  if (!a.ok) { allOk = false; console.log('    seed ' + (s * 137) + ' 没通过：' + a.reason); }
  snapLens.push(p.k.split(';').length);
}
ok(allOk, '20 局随机对局全部 pass');
ok(snapLens.every((n) => n >= 2), '每局至少有开局 + 收尾两条快照', '条数区间 ' + Math.min(...snapLens) + '~' + Math.max(...snapLens));

const g1 = play(20261008, 200);
const base = packed(g1);
const v1 = audit(base);
eq(v1.verdict, 'pass', '示例局通过');
ok(v1.stats.snapshots >= 2, '统计里报了快照条数', v1.stats.snapshots + ' 条 / ' + v1.stats.drops + ' 次投放');

/* 快照确实每 500 分一条 */
const snaps = decode(base).snapshots;
eq(snaps[0].s, 0, '第一条是 0 分');
eq(snaps[snaps.length - 1].s, g1.state.score, '最后一条 = 最终分数');
let stepOk = true;
for (let i = 1; i < snaps.length - 1; i++) {
  if (snaps[i].s % STEP !== 0 || snaps[i].s - snaps[i - 1].s !== STEP) stepOk = false;
}
ok(stepOk, '中间的快照是一条 500 一条、不重不漏', snaps.map((x) => x.s).join('→'));
ok(snaps.every((x) => x.t > 0), '每条快照都带时间戳');
ok(snaps.every((x) => x.g && x.g.length > 0), '每条快照都带签名');
ok(snaps.every((x) => typeof x.d === 'number'), '每条快照都带「已投放次数」');

/* ---------- B. 缺快照 → incomplete ---------- */
console.log('\n[B] 快照缺失');
/* 先造一局快照比较多的（分数过 1500），才能真的删掉中间那条 */
const bigRun = packed(play(20261008, 400));
const bigSnaps = decode(bigRun).snapshots;
ok(bigSnaps.length >= 4, '造出一局有 4 条以上快照的对局', bigSnaps.map((x) => x.s).join('→'));
{
  const miss = clone(bigRun);
  const lines = miss.k.split(';');
  lines.splice(2, 1);                       // 去掉中间那条（500 或 1000）
  miss.k = lines.join(';');
  const a = audit(miss);
  ok(!a.ok, '中间缺一条 → 不通过', a.verdict + ' / ' + a.reason);
  ok(/缺少|缺了一段/.test(a.reason + (a.problems || []).join(' ')), '说清楚缺了哪一段',
    a.reason + ' / ' + (a.problems || []).join('；'));
}
if (false) {
  /* 上面已经用 bigRun 验过了 */
}

const noSnap = clone(base);
noSnap.k = '';
eq(audit(noSnap).verdict, 'incomplete', '一条快照都没有 → incomplete');

/* ---------- C. 分数没道理 ---------- */
console.log('\n[C] 分数没道理');
const more = clone(base);
more.score = base.score + 10000;            // 只改申报分数，快照没跟着改
eq(audit(more).verdict, 'implausible', '申报分数比最后一条快照高 → implausible');

const less = clone(base);
less.score = Math.max(0, base.score - 300);
eq(audit(less).verdict, 'implausible', '申报分数和最后一条快照对不上 → implausible');

/* 快照分数倒退 */
const back = clone(base);
const dl = decode(base);
if (dl.snapshots.length >= 3) {
  const lines = back.k.split(';');
  lines[1] = lines[1].replace(/s(\d+)/, 's' + (STEP * 5));    // 中间那条改成更高，后面就倒退了
  back.k = lines.join(';');
  const a = audit(back);
  ok(a.verdict !== 'pass', '中间快照分数跳高导致倒退 → 不通过', a.verdict + ' / ' + a.reason);
} else {
  const fake = clone(base);
  fake.k = 'f0,s0,n0,r0,d0,t1700000000000,gx;f100,s1000,n1,r0,d5,t1700000001000,gx;f200,s500,n1,r0,d9,t1700000002000,gx';
  const a = audit(fake);
  ok(a.verdict !== 'pass', '快照分数倒退 → 不通过', a.verdict);
}

/* 时间戳倒退 */
const timeBack = clone(base);
const tl = decode(base);
if (decode(bigRun).snapshots.length >= 4) {
  /* 把中间那条的时间戳改成一个荒唐的小值（1970 年）*/
  const tb = clone(bigRun);
  const lines = tb.k.split(';');
  lines[2] = lines[2].replace(/,t\d+/, ',t1');
  tb.k = lines.join(';');
  const a = audit(tb);
  ok(!a.ok, '时间戳不合理 → 不通过', a.verdict + ' / ' + a.reason);
  ok(/时间戳/.test(a.reason + (a.problems || []).join(' ')), '说清楚是时间戳的问题',
    a.reason + ' / ' + (a.problems || []).join('；'));
} else {
  const fake = clone(base);
  fake.k = 'f0,s0,n0,r0,d0,t1700000002000,gx;f100,s500,n1,r0,d5,t1700000001000,gx';
  fake.score = 500;
  const a = audit(fake);
  ok(a.verdict !== 'pass', '时间戳倒退 → 不通过', a.verdict);
}

/* 涨 500 分却没投几次（白送分）。
   注意：动作序列要和种子对得上，才能把问题定位到"投放次数不够"上，
   所以这里拿一局真对局的前 3 次投放来拼。 */
{
  const real = decode(packed(play(4242, 60)));
  const threeDrops = real.actions.filter((x) => x.k === 'drop').slice(0, 3);
  const freeScore = {
    seed: real.seed,
    score: 500,
    spawn: real.spawn.slice(0, 3),
    actions: threeDrops,
    snapshots: [
      { f: 0, s: 0, n: 0, r: 0, d: 0, t: 1700000000000, g: '' },
      { f: threeDrops[2].t, s: 500, n: 5, r: 0, d: 3, t: 1700000001000, g: '' }
    ]
  };
  const aFree = Core.auditRun(freeScore);
  ok(!aFree.ok, '只投 3 次就报 500 分 → 不通过', aFree.verdict + ' / ' + aFree.reason);
  ok(aFree.verdict === 'incomplete' || aFree.verdict === 'implausible', '给出了不通过的裁决', aFree.verdict);
}

/* ---------- D. 掉落流水对不上 ---------- */
console.log('\n[D] 掉落流水');
const ledgerMismatch = clone(base);
const dm = decode(base);
ledgerMismatch.a = dm.actions.map((x, i) => {
  if (x.k !== 'drop') return x;
  const t = x.tier === undefined ? 0 : x.tier;
  return { k: 'drop', t: x.t, x: x.x, tier: (t + 1) % 5 };   // 把等级改错
}).map(Core.actionLine).join(';');
const aLed = audit(ledgerMismatch);
eq(aLed.verdict, 'implausible', '动作里的水果等级和种子对不上 → implausible');
ok(/等级/.test(aLed.reason), '说清楚是等级对不上', aLed.reason);

/* 引擎自己记的流水和独立算出来的流水必须一致（防"两套算法"） */
const dLed = decode(base);
const ledger = Core.spawnLedger(Core.strToSeed(dLed.seed), dLed.actions.filter((x) => x.k === 'drop').length);
const recorded = (dLed.spawn || '').split('').map((c) => parseInt(c, 36));
eq(recorded.length, ledger.length, '引擎记的流水条数 = 独立算出来的条数');
eq(recorded.join(','), ledger.join(','), '引擎记的流水 = 用种子独立算出来的流水');

/* ---------- E. 手改快照 ---------- */
console.log('\n[E] 手改快照');
const de = decode(bigRun);
{
  const edited = clone(bigRun);
  const lines = edited.k.split(';');
  const i = lines.length - 1;
  lines[i] = lines[i].replace(/s(\d+)/, 's' + (Number(de.snapshots[de.snapshots.length - 1].s) + 700));
  edited.k = lines.join(';');
  edited.score = Number(de.snapshots[de.snapshots.length - 1].s) + 700;
  const a = audit(edited);
  ok(!a.ok, '把收尾快照的分数改高 → 不通过', a.verdict + ' / ' + a.reason);
  ok(/签名/.test((a.problems || []).join(' ')) || /整倍数|缺少/.test(a.reason), '签名/整倍数/缺档 检查发现了改动',
    (a.problems || []).join('；'));

  const bumpTime = clone(bigRun);
  const lines2 = bumpTime.k.split(';');
  lines2[lines2.length - 1] = lines2[lines2.length - 1].replace(/,t\d+/, ',t' + (Date.now() + 999999));
  bumpTime.k = lines2.join(';');
  const a2 = audit(bumpTime);
  ok((a2.problems || []).join(' ').indexOf('签名') >= 0, '只改时间戳也会被签名抓到', (a2.problems || []).join('；'));
}

/* ---------- E2. 分数超过"这些水果最多能合出多少分" ---------- */
console.log('\n[E2] 分数上界');
{
  const real = decode(bigRun);
  const drops = real.actions.filter((x) => x.k === 'drop').length;
  const inflated = clone(bigRun);
  const lines = inflated.k.split(';');
  const claimed = Number(real.snapshots[real.snapshots.length - 1].s);
  const huge = claimed + 50000;
  /* 把收尾快照也一起改成巨大的分数，绕开"分数对不上"这条，专门考验上界 */
  lines[lines.length - 1] = lines[lines.length - 1].replace(/s(\d+)/, 's' + huge);
  inflated.k = lines.join(';');
  inflated.score = huge;
  const a = audit(inflated);
  ok(!a.ok, '把分数吹到远超上限 → 不通过', a.verdict + ' / ' + a.reason);
  ok(/最多只能合出|签名|缺少/.test(a.reason + (a.problems || []).join(' ')), '给了具体理由',
    a.reason + ' / ' + (a.problems || []).join('；'));
}

/* ---------- F. 结构非法 ---------- */
console.log('\n[F] 结构非法');
eq(Core.auditRun(null).verdict, 'malformed', '空数据 → malformed');
eq(Core.auditRun({ score: 100, actions: [], snapshots: [] }).verdict, 'malformed', '没有种子 → malformed');
eq(Core.auditRun({ seed: 'zz', score: -5, actions: [], snapshots: [] }).verdict, 'malformed', '负分 → malformed');
eq(Core.auditRun({ seed: 'zz', score: 9.9e9, actions: [], snapshots: [] }).verdict, 'malformed', '分数离谱 → malformed');
eq(Core.auditRun({ seed: 'zz', score: 1, actions: [{ k: 'drop', t: 1e9, x: 100 }], snapshots: [] }).verdict,
  'malformed', '动作帧号越界 → malformed');
eq(Core.auditRun({ seed: 'zz', score: 1, actions: [{ k: 'drop', t: 10, x: 9999 }], snapshots: [] }).verdict,
  'malformed', '投放位置越界 → malformed');
eq(Core.auditRun({ seed: 'zz', score: 1, actions: [{ k: 'drop', t: 10, x: 100 }, { k: 'drop', t: 12, x: 100 }], snapshots: [] }).verdict,
  'malformed', '两次投放挨太近 → malformed');

/* 0 分空局：只有开局那条，也应当合理 */
const emptyRun = Core.encodeRun({
  seed: 'zz', score: 0, spawn: '', actions: [],
  snapshots: [{ f: 0, s: 0, n: 0, r: 0, d: 0, t: 1700000000000, g: '' }]
});
const aEmpty = Core.auditRun(Core.decodeRun(emptyRun));
eq(aEmpty.verdict, 'pass', '0 分空局也是合理的');

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
