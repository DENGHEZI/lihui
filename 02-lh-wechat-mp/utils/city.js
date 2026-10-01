/**
 * 鲤慧 LiHui · 城市名解析
 * 把「湖南省郴州市北湖区」「郴州市」「北湖区」等行政区划文本解析成短城市名
 */
function parseCity(text) {
  if (!text) return ''
  const segs = String(text)
    .replace(/(维吾尔|壮族|回族)?自治区/g, '|')
    .replace(/特别行政区/g, '|')
    .replace(/省/g, '|')
    .replace(/市/g, '|')
    .replace(/区|县|旗|盟/g, '|')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
  // 「湖南省郴州市北湖区」→ ['湖南','郴州','北湖'] → 取第二段「郴州」
  return segs[1] || segs[0] || ''
}

function parseDistrict(text) {
  if (!text) return ''
  const segs = String(text)
    .replace(/(维吾尔|壮族|回族)?自治区/g, '|')
    .replace(/特别行政区/g, '|')
    .replace(/省/g, '|')
    .replace(/市/g, '|')
    .replace(/区|县|旗|盟/g, '|')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
  return segs.length >= 3 ? segs[2] : ''
}

module.exports = { parseCity, parseDistrict }
