/* ============================================================
 *  举报复核 / 总榜重建 端到端自检（无浏览器、不联网）
 *  运行：node moderate.test.js
 *
 *  在临时目录里造一份「数据库」，然后真的调用 tools/rebuild-board.js：
 *    · 造一个老实人（分数真实，能复算通过）
 *    · 造一个作弊者（动作序列是真的，分数是假的 99999）
 *    · 伪造一份举报记录
 *  验证：
 *    · 复核不采信举报里的结论，而是自己算一遍
 *    · 确认造假 → 删掉他的成绩和「种子 / 动作序列」（数据要真的没了）
 *    · 黑名单里只留指纹，不留对局数据
 *    · 总榜重建后只剩老实人，且分数正确
 *    · 分数其实对得上的举报 → 驳回，成绩不动
 *    · 数据缺失（无记录）的举报 → 安全跳过，不炸
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const Core = require(path.join(ROOT, 'dnw-core.js'));
const Board = require(path.join(ROOT, 'dnw-board.js'));

const partsSrc = fs.readFileSync(path.join(ROOT, 'assets', 'fruits', 'parts.js'), 'utf8');
const mm = partsSrc.match(/SUIKA_PARTS\s*=\s*(\[[\s\S]*?\]);?\s*$/m);
Core.setShapes(mm ? JSON.parse(mm[1]) : []);

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  -- ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, label) { ok(a === b, label, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

const FIXED = Core.CONST.FIXED;

/* 造一局真对局，返回 {run, score} */
function realRun(seed, drops, xFn) {
  const g = Core.createGame(seed);
  g.reset(seed);
  let at = 0;
  for (let i = 0; i < drops; i++) {
    at += 25 + ((seed * (i + 3)) % 15);
    while (g.getFrame() < at) g.update(FIXED);
    g.drop(xFn(i));
  }
  for (let i = 0; i < 60 * 25 && !g.state.over; i++) g.update(FIXED);
  return g.exportRun();
}

/* 用一份「空仓库」跑 rebuild-board.js，最后把结果读回来 */
function runTool(workdir) {
  const out = execFileSync(process.execPath, [path.join(workdir, 'tools', 'rebuild-board.js')], {
    cwd: workdir, encoding: 'utf8'
  });
  return out;
}

console.log('举报复核自检\n');

/* 把仓库骨架复制到临时目录（tools 要用到 dnw-core / dnw-board / assets） */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dnw-mod-'));
for (const rel of ['dnw-core.js', 'dnw-board.js']) {
  fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
}
fs.mkdirSync(path.join(tmp, 'tools'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'assets', 'fruits'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'tools', 'rebuild-board.js'), path.join(tmp, 'tools', 'rebuild-board.js'));
fs.copyFileSync(path.join(ROOT, 'assets', 'fruits', 'parts.js'), path.join(tmp, 'assets', 'fruits', 'parts.js'));
fs.mkdirSync(path.join(tmp, 'data', 'owners'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'data', 'reports'), { recursive: true });
/* 一份「数据库」的起点：总榜与黑名单都是空的（真仓库里也是这样） */
fs.writeFileSync(path.join(tmp, 'data', 'board.json'),
  JSON.stringify({ v: 1, updatedAt: 0, total: 0, topN: 100, entries: [] }, null, 2));
fs.writeFileSync(path.join(tmp, 'data', 'voided.json'),
  JSON.stringify({ v: 1, updatedAt: 0, records: [] }, null, 2));

const honestRun = realRun(424242, 45, (i) => 60 + ((i * 53) % 300));
const cheatRun = realRun(777001, 40, (i) => 70 + ((i * 61) % 280));

const writeOwner = (id, name, score, run, at) => {
  fs.writeFileSync(path.join(tmp, 'data', 'owners', id + '.json'), JSON.stringify({
    v: 1, id: id, key: 'ip', name: name, score: score, runId: 'run-' + id,
    submittedAt: at, run: Core.encodeRun(run), verify: { verdict: 'pass', snapshots: (run.snapshots || []).length }
  }, null, 2));
};

writeOwner('honest0000001', '老实人', honestRun.score, honestRun, 1700000001000);
/* 作弊者：动作序列是真的（复算只会得到低分），分数写 99999 */
writeOwner('cheat00000001', '作弊者', 99999, cheatRun, 1700000002000);
/* 一条「数据缺失」的记录：只有分数，没有动作数据 */
fs.writeFileSync(path.join(tmp, 'data', 'owners', 'ghost00000001.json'), JSON.stringify({
  v: 1, id: 'ghost00000001', name: '幽灵记录', score: 5000, submittedAt: 1700000003000
}, null, 2));

const writeReport = (target, extra) => {
  const body = Object.assign({
    v: 1, at: 1700000004000, targetId: target, targetName: '作弊者',
    claimed: 99999, verdict: 'implausible',
    reason: '（这份结论是举报者写的，复核不该采信）', frameErrors: 0, by: 'reporter', runId: 'run-x'
  }, extra || {});
  fs.writeFileSync(path.join(tmp, 'data', 'reports', target.slice(0, 6) + '-x.json'), JSON.stringify(body, null, 2));
};

/* 报告目录里还剩几个举报文件 */
function reportsLeft() {
  try { return fs.readdirSync(path.join(tmp, 'data', 'reports')); } catch (e) { return []; }
}

console.log('[1] 复核作弊举报');
writeReport('cheat00000001');
let out = runTool(tmp);
if (process.env.VERBOSE) console.log(out);
ok(/确认造假 1/.test(out), '一份举报被确认造假');
console.log('  · ' + out.split('\n').filter((l) => l.indexOf('举报 ') >= 0).join('\n  · '));
ok(!fs.existsSync(path.join(tmp, 'data', 'owners', 'cheat00000001.json')),
  '作弊者的对局数据（种子 / 动作序列）已删除');
eq(reportsLeft().length, 0, '举报记录处理完就删掉');

const voided = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'voided.json'), 'utf8'));
eq(voided.records.length, 1, '黑名单里有一条');
eq(voided.records[0].id, 'cheat00000001', '记的是作弊者');
eq(voided.records[0].score, 99999, '记下「当时报了多少分」');
ok(Array.isArray(voided.records[0].problems) || typeof voided.records[0].reason === 'string',
  '记下具体问题', JSON.stringify(voided.records[0].problems || voided.records[0].reason).slice(0, 90));
ok(JSON.stringify(voided.records[0]).indexOf('"a"') < 0,
  '黑名单不含对局数据（动作序列）');

console.log('\n[2] 重建总榜');
const board = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'board.json'), 'utf8'));
eq(board.entries.length, 2, '榜上剩 2 条（老实人 + 幽灵记录）');
ok(!board.entries.some((e) => e.id === 'cheat00000001'), '作弊者不在榜上');
const honest = board.entries.find((e) => e.id === 'honest0000001');
eq(honest.score, honestRun.score, '老实人的分数原样保留');
eq(board.entries[0].id, 'ghost00000001', '榜首是「幽灵记录」（它有分数，但没有对局数据）');
eq(board.entries[board.entries.length - 1].id, 'honest0000001', '老实人按分数排在它后面');
ok(board.entries.every((e) => e.run === null || e.run === undefined), '总榜里不带对局数据');

console.log('\n[3] 复核「其实没问题」的举报 → 驳回');
/* 这次举报老实人，说他造假；复核会算出分数其实对得上 */
writeReport('honest0000001', { claimed: honestRun.score, targetName: '老实人' });
out = runTool(tmp);
ok(out.indexOf('驳回 1') >= 0, '举报被驳回', out.split('\n').filter((l) => l.indexOf('举报') >= 0)[0] || '');
ok(fs.existsSync(path.join(tmp, 'data', 'owners', 'honest0000001.json')), '老实人的数据没被动');
const voided2 = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'voided.json'), 'utf8'));
eq(voided2.records.length, 1, '黑名单没有新增');

console.log('\n[4] 举报一条「无记录」的成绩 → 安全跳过');
writeReport('nothere000001');
out = runTool(tmp);
ok(out.indexOf('数据缺失') >= 0, '按「无记录」处理', out.split('\n').filter((l) => l.indexOf('举报') >= 0)[0] || '');
ok(!fs.existsSync(path.join(tmp, 'data', 'reports', 'nothere-x.json')), '不会卡住，举报文件被清掉');

console.log('\n[5] 有人手改了 owner 里的分数 → 重建时拒收');
fs.writeFileSync(path.join(tmp, 'data', 'owners', 'tamper0000001.json'), JSON.stringify({
  v: 1, id: 'tamper0000001', name: '改分的人', score: honestRun.score + 50000,
  submittedAt: 1700000005000, run: Core.encodeRun(honestRun)   // 数据是真的，分数是假的
}, null, 2));
out = runTool(tmp);
ok(out.indexOf('tamper0000001') >= 0 && /没通过|复核不通过/.test(out), '被拒收', '');
const board2 = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'board.json'), 'utf8'));
ok(!board2.entries.some((e) => e.id === 'tamper0000001'), '改了分数的记录进不了总榜');
ok(board2.entries.some((e) => e.id === 'honest0000001'), '没影响别人');

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
