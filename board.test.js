/* ============================================================
 *  排行榜账本自检（无浏览器）
 *  运行：node board.test.js
 *
 *  覆盖：
 *    · 只记前 100 名
 *    · 每人（按 IP 哈希）只留最好成绩
 *    · 榜满了顶掉分数最低的那位
 *    · 没进前 100 就不写（名次 = 101 → 显示「无记录」）
 *    · 数据库抗缺位：缺 id / 缺 owner / 缺字段 / 存档读不到，都不炸
 *    · 抹除成绩时连数据一起丢，只留证据摘要
 *    · 写进 GitHub 的 board.json 必须是精简的（不带对局数据）
 * ============================================================ */
'use strict';
const fs = require('fs'), path = require('path');
const root = __dirname;

const Core = require(path.join(root, 'dnw-core.js'));
const Board = require(path.join(root, 'dnw-board.js'));

const partsSrc = fs.readFileSync(path.join(root, 'assets', 'fruits', 'parts.js'), 'utf8');
const mm = partsSrc.match(/SUIKA_PARTS\s*=\s*(\[[\s\S]*?\]);?\s*$/m);
Core.setShapes(mm ? JSON.parse(mm[1]) : []);

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  -- ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, label) { ok(a === b, label, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

const FIXED = Core.CONST.FIXED;
function entry(id, score, name, t) {
  return { id: id, owner: 'data/owners/' + id + '.json', name: name || id, score: score, submittedAt: t || 1700000000000, runId: 'r' + id };
}

console.log('排行榜账本自检\n');

/* ---------- A. 名次与门槛 ---------- */
console.log('[A] 名次 / 上榜门槛');
let board = Board.newBoard();
eq(board.entries.length, 0, '新榜是空的');
eq(Board.qualifies(board, 1), true, '榜首：榜没满，1 分也能上');
eq(Board.rankOf(board, 'nobody', 500), 1, '空榜上任何分数都是第 1');

let r = Board.applyEntry(board, entry('a', 100));
board = r.board;
eq(r.rank, 1, '第一条就是第 1 名');
eq(r.made, true, '进榜了');

r = Board.applyEntry(board, entry('b', 200));
board = r.board;
eq(r.rank, 1, '200 分插到最前面');
eq(board.entries.length, 2, '榜上两条');
eq(board.entries[1].id, 'a', '旧的退到第 2');

/* ---------- B. 每人只留最好成绩 ---------- */
console.log('\n[B] 每人（按 IP）只留最好成绩');
r = Board.applyEntry(board, entry('a', 150));
board = r.board;
eq(board.entries.length, 2, '同一个人再交一次不会多出一条');
eq(r.rank, 2, '150 分排第 2');

r = Board.applyEntry(board, entry('a', 50));
board = r.board;
eq(r.made, false, '比自己以前的差 → 榜上不会写这条');
eq(r.keptPrev, true, '明确告诉我们"保留的是以前那条"');
eq(r.qualifiesStandalone, true, '不过按分数算它本来就够格（两件事分开）');
eq(board.entries.length, 2, '也不会顶掉谁');
eq(board.entries.filter((e) => e.id === 'a').length, 1, '榜上这个人还是只有一条');
eq(board.entries[1].score, 150, '保留的仍然是最好那次的分数');

/* ---------- C. 只记前 100 ---------- */
console.log('\n[C] 只记前 100 名');
board = Board.newBoard();
/* 先把榜填满：1000~1099 分，榜尾正好 1000 分 */
for (let i = 1; i <= 100; i++) {
  board = Board.applyEntry(board, entry('p' + i, 999 + i, '玩家' + i)).board;
}
eq(board.entries.length, 100, '刚好 100 条');
eq(board.entries[99].score, 1000, '榜尾（第 100 名）是 1000 分');
eq(Board.qualifies(board, 5000), true, '5000 分当然进');
eq(Board.qualifies(board, 1001), true, '1001 > 榜尾 1000 → 进');
eq(Board.qualifies(board, 1000), false, '刚好并列榜尾 1000 → 不进（先到先得）');
eq(Board.qualifies(board, 1000, 1700000000001), false, '同分且提交更晚 → 依然不进');
eq(Board.qualifies(board, 1000, 1), true, '同分但提交时间比榜尾早 → 进（同分先到先得）');
eq(Board.qualifies(board, 999), false, '999 分进不去');
eq(Board.qualifies(board, 0), false, '0 分不上榜');
eq(Board.rankOf(board, 'newbie', 999), 101, '999 分在榜外 → 名次 101');
/* 名次 = 严格高于我的条数 + 1：1005 分上面有 94 条（1006~1099），所以是第 95 */
eq(Board.rankOf(board, 'newbie', 1005), 95, '1005 分能挤进去的话排第 95');
eq(Board.rankOf(board, 'p50', 999 + 50), 51, '榜上的人直接给榜上名次');

/* 门槛和名次必须一致：说进不去就得是 101，说进得去就不能是 101 */
let consistent = true;
for (let s = 990; s <= 1110; s++) {
  const q = Board.qualifies(board, s);
  const rk = Board.rankOf(board, 'probe' + s, s);
  if (q !== (rk <= 100)) { consistent = false; console.log('    不一致: score=' + s + ' qualifies=' + q + ' rank=' + rk); }
}
ok(consistent, 'qualifies() 和 rankOf() 在 990~1110 分区间完全一致');

r = Board.applyEntry(board, entry('n1', 5000));
board = r.board;
eq(r.rank, 1, '5000 分空降第 1');
eq(board.entries.length, 100, '榜还是 100 条');
ok(r.replaced !== null, '顶掉了一位');
eq(r.replaced.id, 'p1', '被顶掉的正是分数最低的那位（1000 分）');
ok(!board.entries.some((e) => e.id === 'p1'), '被顶掉的人从榜上消失了');
eq(Board.rankOf(board, 'p1', 1000), 101, '被顶掉的人名次变 101');
eq(board.entries[99].score, 1001, '新的榜尾是 1001 分');

/* 同分：刚投出来的成绩挤不掉榜尾（先到先得），所以 1001 分进不去；
   真正顶掉最低那位的是 1002 分。 */
r = Board.applyEntry(board, entry('n2', 1001, 'n2', 9999999999999));
board = r.board;
eq(r.made, false, '和榜尾同分、还提交得更晚 → 不进榜（先到先得）');

r = Board.applyEntry(board, entry('n3', 1002));
board = r.board;
eq(r.rank, 99, '1002 分插进去排第 99');
eq(board.entries.length, 100, '榜还是 100 条');
eq(r.replaced.score, 1001, '被顶掉的是垫底那位（1001 分）');
eq(board.entries[board.entries.length - 1].score, 1002, '新的榜尾是 1002 分');

/* ---------- D. 抗缺位 ---------- */
console.log('\n[D] 数据库缺位也不炸');
const broken = {
  updatedAt: 'not-a-number',
  entries: [
    null,
    { score: 300, name: '缺 id' },                       // 没 id → 丢掉
    { id: 'x1', score: 'abc' },                          // 分数不是数 → 丢掉
    { id: 'x2', name: '正常', score: 120, submittedAt: 5 },
    { id: 'x2', name: '重复 id', score: 900 },            // 重复 → 只留第一条
    'garbage',
    { id: 'x3' },                                        // 缺分数 → 丢掉
    { id: 'x4', score: 80, name: null, owner: undefined } // 缺名字/owner → 补默认值
  ]
};
const nb = Board.normalizeBoard(broken);
eq(nb.entries.length, 2, '能用的只剩 2 条，其余安全丢弃');
eq(nb.entries[0].id, 'x2', '分数高的在前');
eq(nb.entries[1].name, '匿名玩家', '缺名字 → 匿名玩家');
eq(nb.entries[1].owner, '', '缺 owner → 空串（渲染时按「无记录」处理）');
eq(Board.normalizeBoard(null).entries.length, 0, '读不到文件 → 空榜');
eq(Board.normalizeBoard({ entries: 'nope' }).entries.length, 0, 'entries 类型不对 → 空榜');

/* board.json 里混进旧的/超量的数据也要收敛到 100 */
const over = { entries: [] };
for (let i = 0; i < 140; i++) over.entries.push(entry('q' + i, i));
eq(Board.normalizeBoard(over).entries.length, 100, '超过 100 条 → 截到 100');

/* ---------- E. 抹除 ---------- */
console.log('\n[E] 抹除成绩（连数据一起丢）');
board = Board.newBoard();
board = Board.applyEntry(board, entry('cheat', 99999, '作弊者')).board;
board = Board.applyEntry(board, entry('good', 50, '老实人')).board;
const v = Board.voidEntry(board, 'cheat', { at: 1700000001000, reason: '复算 320 分，与榜上 99999 不符', verifier: 'localhost' });
eq(v.board.entries.length, 1, '榜上只剩老实人');
eq(v.removed.id, 'cheat', '被抹掉的是作弊者');
eq(v.record.score, 99999, '黑名单里留下「当时报了多少」');
ok(v.record.reason.indexOf('复算') >= 0, '留下抹除原因');
ok(!('run' in v.record) && !('seed' in v.record), '黑名单不保留种子/动作序列（数据已丢）');

/* ---------- F. 写进 GitHub 的 board.json 必须精简 ---------- */
console.log('\n[F] board.json 体积');
board = Board.newBoard();
for (let i = 0; i < 100; i++) board = Board.applyEntry(board, entry('e' + i, 1000 + i, '玩家' + i)).board;
const json = JSON.stringify(board);
ok(json.length < 30000, '前 100 名的总榜很小', (json.length / 1024).toFixed(1) + ' KB');
ok(json.indexOf('"snapshots"') < 0 && json.indexOf('"seed"') < 0, '总榜里不含种子 / 快照（那些在 owner 文件里）');
const round = JSON.parse(json);
eq(Board.normalizeBoard(round).entries.length, 100, '写出去再读回来还是 100 条');

/* ---------- G. 玩家标识 ---------- */
console.log('\n[G] 玩家标识（只存哈希）');
const h1 = Board.hashIdentity('1.2.3.4', 'salt');
const h2 = Board.hashIdentity('1.2.3.4', 'salt');
const h3 = Board.hashIdentity('1.2.3.5', 'salt');
eq(h1, h2, '同一个 IP → 同一个 ID');
ok(h1 !== h3, '不同 IP → 不同 ID');
ok(h1.indexOf('1.2.3.4') < 0 && h1.indexOf('2') >= 0 === false || h1.indexOf('1.2.3.4') < 0, 'ID 里不出现 IP 明文');
ok(/^[0-9a-z]+$/.test(h1), 'ID 是紧凑的字母数字', h1);

/* ---------- H. 显示文案 ---------- */
console.log('\n[H] 显示文案');
ok(Board.NO_RECORD.indexOf('101') === 0 && Board.NO_RECORD.indexOf('无记录') > 0,
  '没进前 100 的文案：' + Board.NO_RECORD);
eq(Board.cleanName('  很长的名字超过十二个字啦啦啦  ').length, 12, '昵称截到 12 个字');
eq(Board.cleanName('\u0007坏\u0000名字'), '坏名字', '去掉控制字符');
eq(Board.cleanName(''), '匿名玩家', '空昵称 → 匿名玩家');
eq(Board.formatScore(1234.6), '1235', '分数取整显示');
eq(Board.rankLabel(0) + Board.rankLabel(1) + Board.rankLabel(2), '🥇🥈🥉', '前三名是奖牌');
eq(Board.rankLabel(3), '4', '第四名是数字（索引 3 → 名次 4）');

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
