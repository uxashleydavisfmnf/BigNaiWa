/* 生成混淆后的 site-config.js：
     token 拆成 4 段 → 每段各自用不同的方式洗过 → 再整体叠一层带盐的字节位移。
     目标是「一眼看不出是 token、也看不出怎么拼」，不是密码学意义上的加密
     （密钥就在客户端，任何混淆都只能提高成本）。
   用法：node tools/make-credentials.js <token> [输出路径]     默认写到 ../site-config.js
*/
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const token = process.argv[2];
if (!token) { console.error('用法: node tools/make-credentials.js <token> [输出路径]'); process.exit(1); }
if (!/^[A-Za-z0-9_]{20,80}$/.test(token)) { console.error('token 形状不对'); process.exit(1); }
const OUT = process.argv[3] || path.join(__dirname, '..', 'site-config.js');

/* ---------- 第一层：把 token 切成 4 段，每段用不同花样洗 ---------- */

/* 花样 A：和固定字节流异或 */
function washA(s) {
  const k = [0x5b, 0x2e, 0x91, 0x07, 0xd4];
  const out = Buffer.alloc(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) ^ k[i % k.length];
  return out.toString('base64');
}

/* 花样 B：字符码整体 +17，再倒序 */
function washB(s) {
  const codes = [];
  for (let i = s.length - 1; i >= 0; i--) codes.push(s.charCodeAt(i) + 17);
  return codes.map((c) => c.toString(36)).join('-');
}

/* 花样 C：拆成奇数位/偶数位两半，各自 + 3 */
function washC(s) {
  const a = [], b = [];
  for (let i = 0; i < s.length; i++) (i % 2 ? b : a).push(s.charCodeAt(i) + 3);
  return a.map((c) => c.toString(36)).join('.') + '~' + b.map((c) => c.toString(36)).join('.');
}

/* 花样 D：逐字符和序号混合后转 36 进制 */
function washD(s) {
  const arr = [];
  let seed = 0x2f;
  for (let i = 0; i < s.length; i++) {
    seed = (seed * 31 + i * 7) & 0xff;
    arr.push(((s.charCodeAt(i) << 1) ^ seed) & 0xffff);
  }
  return arr.map((c) => c.toString(36)).join(':');
}

const pieces = [
  washA(token.slice(0, 8)),
  washB(token.slice(8, 20)),
  washC(token.slice(20, 32)),
  washD(token.slice(32))
];

/* ---------- 第二层：整体再加一层"逐字节位移"，盐藏在文件里 ---------- */
function maskAll(list, salt) {
  const bytes = Buffer.from(list.join('\u0001'), 'utf8');
  const out = Buffer.alloc(bytes.length);
  let acc = salt & 0xff;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc * 1103515245 + 12345) & 0xff;
    out[i] = (bytes[i] + acc) & 0xff;
  }
  return out.toString('base64');
}

const SALT = 0x9d;
const blob = maskAll(pieces, SALT);

/* ---------- 打散成多段，中间穿插无关的数字，便于隐藏 ---------- */
const chunkSize = 40;
const chunks = [];
for (let i = 0; i < blob.length; i += chunkSize) chunks.push(blob.slice(i, i + chunkSize));
const table = chunks.flatMap((chunk, i) => [
  (0x30 + i * 7) % 256,       // 干扰项
  chunk
]);

const lines = [];
lines.push('\'use strict\';');
lines.push('');
lines.push('/* 站点同步与凭据。表里混了干扰项，索引按顺序取。 */');
lines.push('(function () {');
lines.push('  var T = {');
lines.push('    ep: ' + JSON.stringify('api.github.com') + ',');
lines.push('    sch: ' + JSON.stringify('token') + ',');
lines.push('    ver: ' + JSON.stringify('2022-11-28') + ',');
lines.push('    /* 数据表（分段存放） */');
table.forEach((item, i) => {
  lines.push('    t' + i + ': ' + JSON.stringify(String(item)) + ',');
});
lines.push('    n: ' + chunks.length + ',');
lines.push('    salt: ' + SALT + ',');
lines.push('    step: ' + chunkSize);
lines.push('  };');
lines.push('');
lines.push('  /* 还原表 → 取出盐 → 逐字节还原 → 再按四种花样拆回四段 → 拼起来 */');
lines.push('  function rebuild() {');
lines.push('    var parts = [], i;');
lines.push('    for (i = 0; i < T.n; i++) parts.push(T["t" + (i * 2 + 1)]);');
lines.push('    var raw = parts.join("");');
lines.push('    if (typeof atob === "function") {');
lines.push('      var bin = atob(raw);');
lines.push('      var out = new Uint8Array(bin.length);');
lines.push('      for (i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);');
lines.push('      raw = out;');
lines.push('    } else {');
lines.push('      raw = Uint8Array.from(Buffer.from(raw, "base64"));');
lines.push('    }');
lines.push('    var acc = T.salt & 0xff;');
lines.push('    for (i = 0; i < raw.length; i++) {');
lines.push('      acc = (acc * 1103515245 + 12345) & 0xff;');
lines.push('      raw[i] = (raw[i] - acc) & 0xff;');
lines.push('    }');
lines.push('    var text = "";');
lines.push('    for (i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i]);');
lines.push('    return text.split("\\u0001");');
lines.push('  }');
lines.push('');
lines.push('  function unA(s) {');
lines.push('    var k = [0x5b, 0x2e, 0x91, 0x07, 0xd4];');
lines.push('    var bin = (typeof atob === "function") ? atob(s) : Buffer.from(s, "base64").toString("binary");');
lines.push('    var out = "";');
lines.push('    for (var i = 0; i < bin.length; i++) out += String.fromCharCode(bin.charCodeAt(i) ^ k[i % k.length]);');
lines.push('    return out;');
lines.push('  }');
lines.push('  function unB(s) {');
lines.push('    var codes = s.split("-").reverse();');
lines.push('    var out = "";');
lines.push('    for (var i = 0; i < codes.length; i++) out += String.fromCharCode(parseInt(codes[i], 36) - 17);');
lines.push('    return out;');
lines.push('  }');
lines.push('  function unC(s) {');
lines.push('    var half = s.split("~");');
lines.push('    var a = half[0] ? half[0].split(".") : [];');
lines.push('    var b = half[1] ? half[1].split(".") : [];');
lines.push('    var out = "";');
lines.push('    var n = Math.max(a.length + b.length, 0);');
lines.push('    for (var i = 0; i < n; i++) {');
lines.push('      if (i % 2 === 0 && a[i / 2] !== undefined) out += String.fromCharCode(parseInt(a[i / 2], 36) - 3);');
lines.push('      else if (b[(i - 1) / 2] !== undefined) out += String.fromCharCode(parseInt(b[(i - 1) / 2], 36) - 3);');
lines.push('    }');
lines.push('    return out;');
lines.push('  }');
lines.push('  function unD(s) {');
lines.push('    var codes = s.split(":");');
lines.push('    var out = "";');
lines.push('    var seed = 0x2f;');
lines.push('    for (var i = 0; i < codes.length; i++) {');
lines.push('      seed = (seed * 31 + i * 7) & 0xff;');
lines.push('      out += String.fromCharCode((parseInt(codes[i], 36) ^ seed) >> 1);');
lines.push('    }');
lines.push('    return out;');
lines.push('  }');
lines.push('');
lines.push('  var cache = null;');
lines.push('  window.DNWCredentials = {');
lines.push('    endpoint: T.ep,');
lines.push('    scheme: T.sch,');
lines.push('    apiVersion: T.ver,');
lines.push('    get: function () {');
lines.push('      if (cache) return cache;');
lines.push('      var p = rebuild();');
lines.push('      cache = unA(p[0]) + unB(p[1]) + unC(p[2]) + unD(p[3]);');
lines.push('      return cache;');
lines.push('    }');
lines.push('  };');
lines.push('})();');
lines.push('');

const code = lines.join('\n') + '\n';

/* ---------- 自检：在沙箱里跑一遍，确认能还原出原来的 token ---------- */
const sandbox = {
  window: {}, console,
  atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
  Uint8Array, Buffer
};
vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: 'site-config.js' });
  const got = sandbox.window.DNWCredentials.get();
  if (got !== token) {
    console.error('自检失败：还原出来的东西和 token 不一致');
    console.error('  got     ', got);
    console.error('  expected', token);
    process.exit(1);
  }
  console.log('自检通过：能还原出 token（长度 ' + got.length + '，前缀 ' + got.slice(0, 4) + '）');
} catch (e) {
  console.error('自检失败：' + e.message);
  process.exit(1);
}
if (code.indexOf(token) >= 0) { console.error('自检失败：文件里出现了 token 明文'); process.exit(1); }

fs.writeFileSync(OUT, code, 'utf8');
console.log('已写入 ' + OUT + '（' + code.length + ' 字节）');
