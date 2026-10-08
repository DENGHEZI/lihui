/**
 * 鲤慧 LiHui · 通用 RRF（Reciprocal Rank Fusion，倒数排名融合）
 *
 * 为什么需要：单一路径的检索排名总有一类盲区——
 *  · 关键词 BM25 能命中字面，但理解不了「步行圈」≈「生活圈」≈「walkability」
 *  · 标签/类目通道能按主题召回，但对冷门措辞不敏感
 *  · 类目先验通道懂「问的是哪类事」，但不会看字面
 * RRF（Cormack et al. 2009）是国际通用的多路融合标准做法：
 *   score(d) = Σ_i 1 / (k + rank_i(d))   （k=60 为论文验证值，抑制单通道权重独大）
 * 同款参数已在 baiduMap.poiSearch 的复合关键词融合里实测过（k=60）。
 *
 * 零依赖；输入若干「已按相关性排好序」的数组，输出融合后的新数组。
 */

/**
 * @param {Array<Array<{item:any, id:string}>>} rankedLists 多个排名列表；
 *        也可以直接传元素数组（用 keyOf 提取 id）
 * @param {object} opts { k=60, keyOf=(x)=>x.id }
 * @returns {Array<{item:any, score:number}>} 按 RRF 分数降序
 */
function rrfFuse(rankedLists, opts = {}) {
  const k = Number(opts.k) > 0 ? Number(opts.k) : 60;
  const keyOf = opts.keyOf || ((x) => x.id);
  const scores = new Map(); // id -> { item, score }
  for (const list of rankedLists) {
    if (!Array.isArray(list)) continue;
    list.forEach((entry, idx) => {
      if (entry === null || entry === undefined) return;
      const item = entry && Object.prototype.hasOwnProperty.call(entry, 'item') ? entry.item : entry;
      const id = String(keyOf(item, entry));
      if (!id) return;
      const inc = 1 / (k + idx + 1); // rank 从 1 计
      const cur = scores.get(id);
      if (cur) cur.score += inc;
      else scores.set(id, { item, score: inc });
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score);
}

module.exports = { rrfFuse };
