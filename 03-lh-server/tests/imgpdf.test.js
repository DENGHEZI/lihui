/**
 * imgpdf · 零依赖 JPEG→PDF 包装器单测
 * 夹具：标准 1x1 基线 JPEG（公开的最小 JPEG，base64 内联，无外部依赖）
 */
const { jpegSize, jpegToPdf } = require('../src/services/imgpdf');

const J1X1_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

let pass = 0;
let fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.error('  FAIL - ' + name); }
}

const jpeg = Buffer.from(J1X1_B64, 'base64');

// 1. 尺寸解析
const dim = jpegSize(jpeg);
t('jpegSize 解析 1x1', dim && dim.width === 1 && dim.height === 1);
t('jpegSize 拒绝非 JPEG', jpegSize(Buffer.from('not a jpeg')) === null);
t('jpegSize 拒绝空输入', jpegSize(Buffer.alloc(0)) === null);

// 2. PDF 结构
const pdf = jpegToPdf(jpeg);
const s = pdf.toString('binary');
t('PDF 头 %PDF-1.4', s.startsWith('%PDF-1.4'));
t('PDF 尾 %%EOF', s.endsWith('%%EOF\n'));
t('MediaBox 与图片比例一致', /\/MediaBox \[0 0 0\.5 0\.5\]/.test(s));
t('DCTDecode 直挂 JPEG', s.includes('/Filter /DCTDecode'));
t('宽高写入 XObject', s.includes('/Width 1 /Height 1'));

// 3. xref 偏移自检（每个偏移必须精确指向 'N 0 obj'）
const xrefAt = parseInt(s.match(/startxref\n(\d+)/)[1], 10);
t('startxref 指向 xref 表', s.slice(xrefAt, xrefAt + 4) === 'xref');
const offs = s.slice(s.indexOf('xref'), s.indexOf('trailer')).match(/\d{10}/g);
let xrefOk = true;
[1, 2, 3, 4, 5].forEach((n, i) => {
  const off = parseInt(offs[i + 1], 10);
  if (!s.slice(off).startsWith(n + ' 0 obj\n')) xrefOk = false;
});
t('xref 五个对象偏移全部精确', xrefOk);

console.log(`imgpdf.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
