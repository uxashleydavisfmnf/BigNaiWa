/* ============================================================
 *  合成大奶娃 · 排行榜（前端）
 *  ------------------------------------------------------------
 *  数据库就是 GitHub 仓库本身，浏览器直接读写（GitHub 的内容 API 允许跨域）。
 *
 *  一次上榜（结算后）：
 *    1. 结算完立刻在本机把「我这一局」插进排行榜，玩家马上看到正确名次；
 *       同时下面写「正在同步…」。
 *    2. 先复算一遍自己这一局（种子 + 动作序列）—— 复算不过就根本不上传，
 *       省得白跑一趟。（顺手也算自证清白）
 *    3. 名次 > 100 的：不写 GitHub，显示「101 · 无记录」。
 *    4. 进前 100 的：写 data/owners/<我的ID>.json（种子 + 动作序列 + 快照 + 分数），
 *       再把前 100 名写回 data/board.json；人满了就顶掉分数最低的那位。
 *    5. 写完把「正在同步…」换成「已同步 ✓」。
 *
 *  举报别人（榜上每一行都有「举报」）：
 *    · 把那个人的存档拉下来，在本地用保存的随机种子和动作序列完整复算一遍；
 *    · 分数差太多 → 写一份举报记录，并把证据（复算分数、差值）一起存进库里；
 *    · 只提交证据，不直接改别人的成绩 —— 抹除由自动化流程按证据执行，
 *      免得谁都能一键删榜。
 * ============================================================ */
(function () {
  'use strict';

  const Core = window.DNWCore;
  const Board = window.DNWBoard;
  const Cred = window.DNWCredentials;
  if (!Core || !Board || !Cred) {
    if (window.console) console.error('[danaiwa] 排行榜依赖缺失（dnw-core / dnw-board / site-config）');
    return;
  }

  /* ---------------------------------------------------------
   *  仓库地址与数据路径
   * ------------------------------------------------------- */

  const REPO_OWNER = 'uxashleydavisfmnf';
  const REPO_NAME  = 'BigNaiWa';
  const BRANCH     = 'main';
  const P_BOARD    = 'data/board.json';
  const P_VOIDED   = 'data/voided.json';
  const ownerPath  = (id) => 'data/owners/' + id + '.json';
  const reportPath = (name) => 'data/reports/' + name + '.json';

  const API = 'https://' + Cred.endpoint + '/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/';
  const NAME_KEY = 'danaiwa.nick.v2';
  const LOCAL_ID_KEY = 'danaiwa.localid.v1';
  const LAST_SUBMIT_KEY = 'danaiwa.lastsubmit.v2';
  const MIN_SUBMIT_GAP = 10000;      // 两次提交至少隔 10 秒，别把仓库当靶子打

  const $ = (id) => document.getElementById(id);

  const listEl = $('boardList');
  const modal = $('boardModal');
  const msgEl = $('submitMsg');
  const nickInput = $('nickInput');
  const nameLabel = $('myNameLabel');
  const submitBtn = $('submitBtn');
  const submitBox = $('submitBox');
  const syncEl = $('syncState');

  /* ---------------------------------------------------------
   *  状态
   * ------------------------------------------------------- */

  let board = Board.newBoard();
  let boardLoaded = false;
  let boardAt = 0;
  let myId = '';
  let myKey = '';
  let lastSubmitAt = Number(localStorage.getItem(LAST_SUBMIT_KEY) || 0);
  let submitting = false;
  let pendingRun = null;          // 结算后待提交的这一局
  let myEntry = null;             // 本机乐观插入的那一条（用于「我」的高亮）
  let syncState = 'idle';         // idle | syncing | synced | local | failed

  /* ---------------------------------------------------------
   *  GitHub 读写（浏览器直连，内容 API 允许跨域）
   * ------------------------------------------------------- */

  function apiFetch(path, opts) {
    opts = opts || {};
    const url = API + path + (opts.query || '');
    const headers = {
      'Authorization': Cred.scheme + ' ' + Cred.get(),
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': Cred.apiVersion
    };
    const init = { method: opts.method || 'GET', headers: headers, cache: 'no-store' };
    if (opts.body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctl) init.signal = ctl.signal;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 20000);
    return fetch(url, init).then(
      (res) => {
        clearTimeout(timer);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      },
      (err) => {
        clearTimeout(timer);
        throw new Error(err && err.name === 'AbortError' ? '请求超时' : '网络不可用');
      }
    );
  }

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64 || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* 读一个文件：返回 { sha, data } 或 null */
  function readJson(path) {
    return apiFetch(path, { query: '?ref=' + BRANCH + '&t=' + Date.now() }).then((res) => {
      if (!res || !res.content) return null;
      let data;
      try { data = JSON.parse(b64decode(res.content)); } catch (e) { return null; }
      return { sha: res.sha, data: data };
    });
  }

  /* 写一个文件：没有 sha 就是新建，有 sha 就是更新 */
  function writeJson(path, data, sha, message) {
    const body = { message: message, content: b64encode(JSON.stringify(data)), branch: BRANCH };
    if (sha) body.sha = sha;
    return apiFetch(path, { method: 'PUT', body: body });
  }

  /* ---------------------------------------------------------
   *  我是谁：公网 IP → 哈希（同一 IP 只留最好成绩）
   * ------------------------------------------------------- */

  function localId() {
    let v = '';
    try { v = localStorage.getItem(LOCAL_ID_KEY) || ''; } catch (e) { /* 隐私模式 */ }
    if (!v) {
      v = '';
      const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
      const rnd = (window.crypto && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(10)) : null;
      for (let i = 0; i < 10; i++) v += abc[(rnd ? rnd[i] : Math.floor(Math.random() * 256)) % abc.length];
      try { localStorage.setItem(LOCAL_ID_KEY, v); } catch (e) { /* 忽略 */ }
    }
    return v;
  }

  function resolveIdentity() {
    if (myId) return Promise.resolve(myId);
    const salt = P_VOIDED;          // 盐只用来区分用途，不参与保密
    return fetch('https://api.ipify.org?format=json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const ip = j && j.ip ? String(j.ip) : '';
        myId = Board.hashIdentity(ip || ('local:' + localId()), salt);
        myKey = ip ? 'ip' : 'local';
        return myId;
      })
      .catch(() => {
        myId = Board.hashIdentity('local:' + localId(), salt);
        myKey = 'local';
        return myId;
      });
  }

  /* ---------------------------------------------------------
   *  昵称
   * ------------------------------------------------------- */

  function loadName() {
    try { return Board.cleanName(localStorage.getItem(NAME_KEY) || ''); } catch (e) { return ''; }
  }
  function saveName(n) {
    try { localStorage.setItem(NAME_KEY, n); } catch (e) { /* 忽略 */ }
  }
  function myName() { return loadName() || '默认用户'; }

  function paintName() {
    const n = myName();
    if (nameLabel) nameLabel.textContent = n;
    if (nickInput && document.activeElement !== nickInput) nickInput.value = loadName();
  }

  /* ---------------------------------------------------------
   *  同步状态文案
   * ------------------------------------------------------- */

  function setSync(state, text) {
    syncState = state;
    if (!syncEl) return;
    syncEl.hidden = !text;
    syncEl.textContent = text || '';
    syncEl.className = 'sync-state is-' + state;
  }

  function setMsg(text, kind) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.className = 'submit-msg' + (kind ? ' is-' + kind : '');
  }

  function showRetry(show) {
    if (submitBtn) submitBtn.hidden = !show;
  }

  /* ---------------------------------------------------------
   *  排行榜渲染
   * ------------------------------------------------------- */

  function boardMessage(text, cls) {
    if (!listEl) return;
    listEl.textContent = '';
    const p = document.createElement('p');
    p.className = 'board-empty' + (cls ? ' ' + cls : '');
    p.textContent = text;
    listEl.appendChild(p);
  }

  function makeRow(entry, rank, opts) {
    opts = opts || {};
    const line = document.createElement('div');
    line.className = 'board-row' + (rank <= 3 ? ' r' + rank : '') + (opts.mine ? ' is-mine' : '') +
                   (opts.pending ? ' is-pending' : '');

    const rk = document.createElement('span');
    rk.className = 'board-rank';
    rk.textContent = opts.mine && !opts.ranked ? '我' : Board.rankLabel(rank - 1);

    const nm = document.createElement('span');
    nm.className = 'board-name';
    nm.textContent = entry.name + (opts.mine ? '（我）' : '');

    const sc = document.createElement('span');
    sc.className = 'board-score';
    sc.textContent = Board.formatScore(entry.score);

    const meta = document.createElement('span');
    meta.className = 'board-meta';
    const bits = [];
    if (entry.submittedAt) bits.push(Board.timeAgo(entry.submittedAt));
    if (opts.pending) bits.push('同步中…');
    if (!opts.ranked) bits.push('无记录');
    meta.textContent = bits.join(' · ');

    line.appendChild(rk);
    line.appendChild(nm);
    line.appendChild(sc);
    line.appendChild(meta);

    if (opts.ranked && !opts.mine && entry.id) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'report-btn';
      btn.textContent = '举报';
      btn.title = '在本地用这位玩家的随机种子和动作序列复算一遍，对不上就提交证据';
      btn.addEventListener('click', () => reportEntry(entry, btn));
      line.appendChild(btn);
    }
    return line;
  }

  function render() {
    if (!listEl) return;
    listEl.textContent = '';

    const rows = board.entries.slice();
    const myRanked = rows.some((e) => e.id === myId && (!myEntry || e.runId === myEntry.runId || e.score >= myEntry.score));

    if (!rows.length) {
      boardMessage(boardLoaded ? '榜上还空着，快去玩一局！' : '正在读取排行榜…');
    }

    rows.forEach((e, i) => {
      listEl.appendChild(makeRow(e, i + 1, { ranked: true, mine: e.id === myId && myRanked }));
    });

    /* 本机成绩但还没进榜（或者刚提交还在同步）：单独挂在最后，写清楚「无记录」 */
    if (myEntry && !myRanked) {
      const rank = myEntry.rank || Board.TOP_N + 1;
      listEl.appendChild(makeRow(myEntry, rank, {
        mine: true,
        ranked: false,
        pending: syncState === 'syncing'
      }));
    }
  }

  function refresh(myScore) {
    return readJson(P_BOARD).then((res) => {
      boardLoaded = true;
      if (res && res.data) {
        board = Board.normalizeBoard(res.data);
        boardAt = Date.now();
      }
      render();
      return board;
    }).catch((err) => {
      boardLoaded = true;
      boardMessage('排行榜读取失败：' + err.message + '（检查一下网络？）');
      throw err;
    });
  }

  /* ---------------------------------------------------------
   *  开局 / 结算
   * ------------------------------------------------------- */

  function onRunStart() {
    myEntry = null;
    pendingRun = null;
    setSync('idle', '');
    showRetry(false);
    if (msgEl) setMsg('', '');
  }

  /* 结算：先本机上榜（玩家立刻看到正确名次），再后台同步 */
  function onGameOver(payload) {
    const score = Number(payload && payload.score) || 0;
    const engine = payload && payload.engine;
    const runId = (payload && payload.runId) || '';

    if (submitBox) submitBox.style.display = score > 0 ? '' : 'none';
    paintName();
    showRetry(false);
    if (!(score > 0) || !engine) return;

    const run = engine.exportRun();
    const at = Date.now();
    pendingRun = { score: score, runId: runId, run: run, name: myName(), at: at };

    /* —— 本机乐观上榜：名次当场就算出来 —— */
    const provisional = {
      id: myId || ('local-' + localId()),
      owner: ownerPath(myId || ''),
      name: myName(),
      score: score,
      submittedAt: at,
      runId: runId,
      run: null
    };
    const applied = Board.applyEntry(board, provisional);
    myEntry = {
      id: provisional.id,
      name: provisional.name,
      score: provisional.score,
      submittedAt: provisional.submittedAt,
      rank: applied.rank
    };
    const madeLocal = applied.rank <= Board.TOP_N;

    setMsg(madeLocal
      ? ('本局 ' + Board.formatScore(score) + ' 分，暂列第 ' + applied.rank + ' 名')
      : ('本局 ' + Board.formatScore(score) + ' 分，没进前 100'), madeLocal ? 'good' : '');
    setSync('syncing', '正在同步…');
    render();
    submit(madeLocal);
  }

  function submit(madeLocal) {
    if (submitting || !pendingRun) return;
    const since = Date.now() - lastSubmitAt;
    if (since < MIN_SUBMIT_GAP) {
      /* 连着打两局时别硬撞：等一下自己再传，不用玩家点重试 */
      const wait = MIN_SUBMIT_GAP - since;
      setSync('syncing', '正在同步…');
      showRetry(false);
      setTimeout(() => { submit(madeLocal); }, wait + 300);
      return;
    }
    submitting = true;
    showRetry(false);

    /* 1) 先自证：复算不过就根本不上传 */
    let selfCheck;
    try {
      selfCheck = Core.validateRun(pendingRun.run);
    } catch (e) {
      selfCheck = { verdict: 'malformed', ok: false, reason: '本局数据异常' };
    }

    if (!selfCheck.ok) {
      submitting = false;
      setMsg('本局未能通过复算校验，成绩留在本机：' + (selfCheck.reason || selfCheck.verdict), 'bad');
      setSync('local', '未上传（复算未通过）');
      render();
      return;
    }

    if (!madeLocal) {
      submitting = false;
      lastSubmitAt = Date.now();
      try { localStorage.setItem(LAST_SUBMIT_KEY, String(lastSubmitAt)); } catch (e) { /* 忽略 */ }
      setSync('local', '101 · 无记录（未进总榜，不写入 GitHub）');
      render();
      return;
    }

    /* 2) 上传：owner 文件 + 总榜 */
    const owner = {
      v: 1,
      id: myId,
      key: myKey,
      name: pendingRun.name,
      score: pendingRun.score,
      runId: pendingRun.runId,
      submittedAt: Date.now(),
      run: Core.encodeRun(pendingRun.run),
      verify: { verdict: selfCheck.verdict, replay: selfCheck.replayScore }
    };

    let ownerSha = null;
    readJson(ownerPath(myId))
      .then((prev) => {
        if (prev && prev.data && Number(prev.data.score) >= owner.score) {
          /* 自己以前那次更好：对局数据不覆盖（榜上已经有那条了），
             但总榜仍然要确认一下我的那一条在不在 —— 早退会让总榜漏写。 */
          return null;
        }
        ownerSha = prev && prev.sha;
        return writeJson(ownerPath(myId), owner, ownerSha, '成绩：' + owner.name + ' ' + owner.score + ' 分');
      })
      .then(() => pushBoardEntry(owner))
      .then(() => {
        submitting = false;
        lastSubmitAt = Date.now();
        try { localStorage.setItem(LAST_SUBMIT_KEY, String(lastSubmitAt)); } catch (e) { /* 忽略 */ }
        setSync('synced', '已同步 ✓');
        setMsg('已上榜 ✓　' + owner.name + ' · ' + Board.formatScore(owner.score) + ' 分', 'good');
        return refresh();
      })
      .catch((err) => {
        submitting = false;
        setSync('failed', '同步失败：' + err.message);
        showRetry(true);
      });
  }

  /* 把成绩写进总榜：读最新 → 合并 → 写回；撞车了就重读重试 */
  function pushBoardEntry(owner, attempt) {
    attempt = attempt || 0;
    return readJson(P_BOARD).then((res) => {
      const cur = Board.normalizeBoard(res && res.data);
      const entry = {
        id: owner.id,
        owner: ownerPath(owner.id),
        name: owner.name,
        score: owner.score,
        submittedAt: owner.submittedAt,
        runId: owner.runId,
        run: null
      };
      const applied = Board.applyEntry(cur, entry);
      const next = applied.board;
      next.updatedAt = Date.now();
      next.total = Math.max(Number(cur.total) || 0, next.entries.length);

      return writeJson(P_BOARD, next, res && res.sha,
        '总榜更新：' + entry.name + ' ' + entry.score + ' 分'
      ).then((out) => {
        board = next;
        boardLoaded = true;
        myEntry = Object.assign({}, myEntry, { rank: applied.rank });
        render();
        return out;
      }, (err) => {
        if (attempt < 2) return pushBoardEntry(owner, attempt + 1);   // 别人同时写了，重读重试
        throw err;
      });
    });
  }

  /* ---------------------------------------------------------
   *  举报：本地复算别人的存档
   * ------------------------------------------------------- */

  function reportEntry(entry, btn) {
    if (!entry || !entry.id) return;
    const old = btn.textContent;
    btn.disabled = true;

    let step = 0;
    const dots = setInterval(() => {
      step = (step + 1) % 3;
      btn.textContent = '复算中' + '.'.repeat(step + 1);
    }, 400);

    const stop = (text) => {
      clearInterval(dots);
      btn.disabled = false;
      btn.textContent = text || old;
    };

    readJson(ownerPath(entry.id)).then((res) => {
      if (!res || !res.data || !res.data.run) {
        stop('无记录');
        btn.title = '这条成绩在数据库里没有对应的对局记录（种子 / 动作序列已缺失），无法复算';
        return;
      }
      const rec = Core.decodeRun(res.data.run);
      const claimed = Number(res.data.score) || Number(entry.score) || 0;
      rec.score = claimed;

      const verdict = Core.validateRun(rec);

      if (verdict.verdict === 'pass') {
        stop('已核对');
        btn.title = '本地复算结果与榜上分数一致（' + verdict.replayScore + ' 分），没有发现问题';
        return;
      }

      /* 对不上：把举报连同证据写进库里 */
      const evidence = {
        v: 1,
        at: Date.now(),
        targetId: entry.id,
        targetName: entry.name,
        claimed: claimed,
        replay: verdict.replayScore,
        delta: verdict.delta,
        verdict: verdict.verdict,
        reason: verdict.reason || '',
        frameErrors: verdict.frameErrorCount || 0,
        by: myId || ('local-' + localId()),
        runId: entry.runId || ''
      };
      const name = String(entry.id).slice(0, 6) + '-' + Date.now().toString(36);
      return writeJson(reportPath(name), evidence, null,
        '举报：' + entry.name + ' ' + claimed + ' 分（复算 ' + verdict.replayScore + '）'
      ).then(() => {
        stop('已举报 ✓');
        btn.title = '已提交举报：本地复算 ' + verdict.replayScore + ' 分，榜上写的 ' + claimed + ' 分';
        if (listEl) {
          const row = btn.parentNode;
          if (row && row.classList) row.classList.add('is-reported');
        }
        return true;
      });
    }).catch((err) => {
      stop('举报失败');
      btn.title = '举报失败：' + err.message;
    });
  }

  /* ---------------------------------------------------------
   *  打开 / 关闭
   * ------------------------------------------------------- */

  function openBoard() {
    if (!modal) return;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    if (!boardLoaded) boardMessage('正在读取排行榜…');
    else render();
    refresh().catch(() => {});
    resolveIdentity().then(() => refresh().catch(() => {}));
    /* 打开期间轮询几次，别人新上传的成绩能自己冒出来 */
    let n = 0;
    const timer = setInterval(() => {
      if (!modal.classList.contains('show') || n++ > 5) { clearInterval(timer); return; }
      refresh().catch(() => {});
    }, 5000);
  }

  function closeBoard() {
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }

  /* ---------------------------------------------------------
   *  绑定
   * ------------------------------------------------------- */

  function retry() {
    if (!pendingRun) return;
    submit(myEntry && myEntry.rank <= Board.TOP_N);
  }

  function bind() {
    const b1 = $('boardBtn');
    if (b1) b1.addEventListener('click', openBoard);
    const b2 = $('boardBtn2');
    if (b2) b2.addEventListener('click', openBoard);
    const bc = $('boardClose');
    if (bc) bc.addEventListener('click', closeBoard);
    const br = $('boardRefresh');
    if (br) br.addEventListener('click', () => { refresh().catch(() => {}); });
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeBoard(); });
    if (submitBtn) submitBtn.addEventListener('click', retry);

    if (nickInput) {
      nickInput.value = loadName();
      const commit = () => {
        saveName(Board.cleanName(nickInput.value));
        nickInput.value = loadName();
        paintName();
      };
      nickInput.addEventListener('change', commit);
      nickInput.addEventListener('blur', commit);
      nickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); nickInput.blur(); }
      });
    }
    const edit = $('editNameBtn');
    if (edit) {
      edit.addEventListener('click', () => {
        openBoard();
        if (nickInput) setTimeout(() => { nickInput.focus(); nickInput.select(); }, 260);
      });
    }
    paintName();
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBoard(); });

    /* 启动就把榜读回来，这样一结算就能当场算出名次 */
    resolveIdentity().then(() => refresh().catch(() => {}));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.DanaiwaBoard = {
    open: openBoard,
    close: closeBoard,
    refresh: refresh,
    onGameOver: onGameOver,
    onRunStart: onRunStart,
    myName: myName,
    setName(n) { saveName(Board.cleanName(n)); paintName(); },
    hasName() { return !!loadName(); },
    state() { return { board: board, myId: myId, myEntry: myEntry, sync: syncState }; },
    /* 自检用：不写网络，只算名次 */
    preview(score) {
      return Board.applyEntry(board, {
        id: myId || 'me', name: myName(), score: score, submittedAt: Date.now()
      });
    }
  };
})();
