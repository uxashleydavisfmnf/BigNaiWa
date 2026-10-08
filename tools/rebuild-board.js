/* ============================================================
 *  总榜重建 + 举报复核（node，无第三方依赖）
 *  ------------------------------------------------------------
 *  由 .github/workflows/moderate.yaml 调用，也可以本地手动跑：
 *      node tools/rebuild-board.js
 *
 *  干三件事：
 *    1. 复核 data/reports/ 下的举报：用同一份规则把被举报那局的快照重新校验一遍
 *       （不采信举报里的结论），确认不合格就删掉那个人的成绩和对局数据；
 *    2. 从 data/owners/ 重新拼出 data/board.json（前 100 名，每人只留最好成绩）；
 *    3. 把处理完的举报文件删掉、把复核结果写进 data/voided.json。
 *
 *  抗缺位：任何一条记录读不出来、字段缺失、复算失败，都只跳过它本人，
 *  不影响榜上其它人。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OWNERS = path.join(DATA, 'owners');
const REPORTS = path.join(DATA, 'reports');
const BOARD = path.join(DATA, 'board.json');
const VOIDED = path.join(DATA, 'voided.json');

const Core = require(path.join(ROOT, 'dnw-core.js'));
const Board = require(path.join(ROOT, 'dnw-board.js'));

/* 碰撞形状必须和线上一致，否则复算出来的物理不一样 */
function loadShapes() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'assets', 'fruits', 'parts.js'), 'utf8');
    const m = src.match(/SUIKA_PARTS\s*=\s*(\[[\s\S]*?\]);?\s*$/m);
    if (m) { Core.setShapes(JSON.parse(m[1])); return true; }
  } catch (e) {
    console.log('  ! 读不到 parts.js，按圆形碰撞复算：' + e.message);
  }
  return false;
}

function listJson(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (e) {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log('  ! 读不了 ' + path.basename(file) + '：' + e.message);
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/* ---------------------------------------------------------
 *  1. 复核举报
 * ------------------------------------------------------- */

function loadVoided() {
  const v = readJson(VOIDED);
  if (!v || typeof v !== 'object') return { v: 1, updatedAt: 0, records: [] };
  if (!Array.isArray(v.records)) v.records = [];
  return v;
}

function moderate() {
  const voided = loadVoided();
  const alreadyVoided = {};
  voided.records.forEach((r) => { if (r && r.id) alreadyVoided[r.id] = r; });

  const files = listJson(REPORTS);
  let confirmed = 0, dismissed = 0, broken = 0;

  for (const f of files) {
    const file = path.join(REPORTS, f);
    const rep = readJson(file);
    if (!rep || !rep.targetId) {
      console.log('  ! 举报 ' + f + ' 结构不对，删除');
      fs.unlinkSync(file);
      broken++;
      continue;
    }

    const targetId = String(rep.targetId);
    const ownerFile = path.join(OWNERS, targetId + '.json');
    const owner = fs.existsSync(ownerFile) ? readJson(ownerFile) : null;

    /* 数据已经不在了：要么早就被处理过，要么记录缺失 —— 按「无记录」收场 */
    if (!owner || !owner.run) {
      console.log('  - 举报 ' + targetId + '：数据缺失（无记录），驳回并关闭');
      dismissed++;
      fs.unlinkSync(file);
      continue;
    }

    /* 独立复核：不采信举报里的结论，自己按快照重新校验一遍 */
    let verdict;
    try {
      const rec = Core.decodeRun(owner.run);
      rec.score = Number(owner.score) || 0;
      verdict = Core.auditReport(rec);
    } catch (e) {
      verdict = { verdict: 'malformed', ok: false, reason: '校验异常：' + e.message };
    }

    const claimed = Number(owner.score) || 0;
    console.log('  · 举报 ' + targetId + '（榜上 ' + claimed + ' 分）→ 快照校验 ' +
                verdict.verdict +
                (verdict.stats ? '，' + verdict.stats.snapshots + ' 条快照 / ' + verdict.stats.drops + ' 次投放' : '') +
                (verdict.reason ? '：' + verdict.reason : ''));

    if (verdict.ok) {
      console.log('    复核通过 → 成绩没问题，驳回举报');
      dismissed++;
      fs.unlinkSync(file);
      continue;
    }

    /* 确认造假：删数据 + 删榜 + 留指纹 */
    fs.unlinkSync(ownerFile);
    if (!alreadyVoided[targetId]) {
      const record = {
        id: targetId,
        name: String(owner.name || ''),
        score: claimed,
        at: Date.now(),
        reason: verdict.reason || verdict.verdict,
        verdict: verdict.verdict,
        problems: (verdict.problems || []).slice(0, 6),
        snapshots: (verdict.stats && verdict.stats.snapshots) || 0,
        reports: 1,
        verifier: 'github-actions/rebuild-board'
      };
      voided.records.push(record);
      alreadyVoided[targetId] = record;
    } else {
      alreadyVoided[targetId].reports = (Number(alreadyVoided[targetId].reports) || 1) + 1;
    }
    console.log('    复核不通过 → 已抹除成绩与对局数据，记入 data/voided.json');
    confirmed++;
    fs.unlinkSync(file);
  }

  voided.updatedAt = Date.now();
  writeJson(VOIDED, voided);
  return { confirmed: confirmed, dismissed: dismissed, broken: broken, total: files.length };
}

/* ---------------------------------------------------------
 *  2. 重建总榜
 * ------------------------------------------------------- */

function rebuild() {
  const voided = loadVoided();
  const banned = {};
  voided.records.forEach((r) => { if (r && r.id) banned[r.id] = r; });

  let board = Board.newBoard();
  board.updatedAt = Date.now();

  const files = listJson(OWNERS);
  let used = 0, skipped = 0;

  for (const f of files) {
    const owner = readJson(path.join(OWNERS, f));
    const id = String((owner && owner.id) || f.replace(/\.json$/, ''));

    /* 被抹除过的人，成绩不再进榜 */
    if (banned[id]) { skipped++; continue; }

    if (!owner || !owner.score) { skipped++; continue; }

    const score = Number(owner.score);
    if (!isFinite(score) || score <= 0) { skipped++; continue; }

    /* 有对局数据就顺手校验一遍快照：数据明显不完整/不合理的就不让它进榜 */
    if (owner.run) {
      let v;
      try {
        const rec = Core.decodeRun(owner.run);
        rec.score = score;
        v = Core.auditReport(rec);
      } catch (e) {
        v = { ok: false, verdict: 'malformed', reason: '校验异常：' + e.message };
      }
      if (!v.ok) {
        console.log('  ! ' + id + ' 的快照没通过（' + v.verdict + '），不进榜：' + (v.reason || ''));
        skipped++;
        continue;
      }
    }

    board = Board.applyEntry(board, {
      id: id,
      owner: 'data/owners/' + id + '.json',
      name: owner.name,
      score: score,
      submittedAt: owner.submittedAt,
      runId: owner.runId,
      run: null,
      flags: 0
    }).board;

    /* 榜只留前 100：多出来的就是被顶掉的那位，owner 文件保留（下次还能再冲） */
    used++;
  }

  board.total = used;
  writeJson(BOARD, board);
  return { owners: files.length, used: used, skipped: skipped, top: board.entries.length };
}

/* ---------------------------------------------------------
 *  主流程
 * ------------------------------------------------------- */

console.log('== 合成大奶娃 · 总榜重建与举报复核 ==');
loadShapes();

console.log('\n[1/2] 复核举报');
const mod = moderate();
console.log('  举报 ' + mod.total + ' 份：确认造假 ' + mod.confirmed +
            '，驳回 ' + mod.dismissed + '，结构异常 ' + mod.broken);

console.log('\n[2/2] 重建总榜');
const rb = rebuild();
console.log('  owner 文件 ' + rb.owners + ' 个：进榜 ' + rb.used +
            '，跳过 ' + rb.skipped + '，总榜 ' + rb.top + ' 条');

console.log('\n完成。');
