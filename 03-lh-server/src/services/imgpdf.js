/**
 * 鲤慧 LiHui · 零依赖 JPEG→PDF 包装器
 *
 * 用途：小程序端把体检长图（canvas 导出的 JPEG）上传上来，包装成单页 PDF 返回。
 * 小程序生态无法本地生成 PDF（wx.openDocument 只能打开现成文件），所以由服务端包装。
 *
 * 原理：手工构造最小 PDF 1.4 文档——单页 MediaBox 按图片比例、嵌入一个
 * DCTDecode（即原始 JPEG 字节，无需重编码）的 Image XObject。
 * 仅支持 JPEG（canvas 导出 fileType:'jpg' 天然满足），不引入任何依赖。
 */
'use strict';

/** 解析 JPEG 尺寸（扫描 SOF0/SOF1/SOF2 段；失败返回 null） */
function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    // SOF0/1/2（基线/扩展/渐进）：帧头含宽高
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}

/**
 * JPEG 字节 → 单页 PDF Buffer
 * 页面尺寸：像素按 144dpi 折算 pt（pt = px × 72 / 144），A4 纵向等价宽度感、长图可整页容纳
 */
function jpegToPdf(jpeg) {
  const dim = jpegSize(jpeg);
  if (!dim) throw new Error('not a valid jpeg');
  const SCALE = 72 / 144; // px → pt
  const W = +(dim.width * SCALE).toFixed(2);
  const H = +(dim.height * SCALE).toFixed(2);

  const chunks = [];
  let offset = 0;
  const offsets = {};
  const push = (b) => { chunks.push(b); offset += b.length; };
  const obj = (num, body) => {
    offsets[num] = offset;
    push(Buffer.from(num + ' 0 obj\n' + body + '\nendobj\n', 'binary'));
  };
  const bin = (num, head, stream) => {
    offsets[num] = offset;
    push(Buffer.from(num + ' 0 obj\n' + head + 'stream\n', 'binary'));
    push(stream);
    push(Buffer.from('\nendstream\nendobj\n', 'binary'));
  };

  push(Buffer.from('%PDF-1.4\n%\xB5\xB5\xB5\xB5\n', 'binary'));

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);

  // 图片流：原始 JPEG 直接作为 DCTDecode 流（零重编码、零膨胀）
  bin(4, `<< /Type /XObject /Subtype /Image /Width ${dim.width} /Height ${dim.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);

  const content = `q\n${W} 0 0 ${H} 0 0 cm\n/Im0 Do\nQ\n`;
  bin(5, `<< /Length ${content.length} >>`, Buffer.from(content, 'binary'));

  const xrefAt = offset;
  const xref = ['xref', '0 6', '0000000000 65535 f ']
    .concat([1, 2, 3, 4, 5].map((n) => String(offsets[n]).padStart(10, '0') + ' 00000 n '))
    .join('\n') + '\n';
  push(Buffer.from(xref + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n', 'binary'));
  return Buffer.concat(chunks);
}

module.exports = { jpegSize, jpegToPdf };
