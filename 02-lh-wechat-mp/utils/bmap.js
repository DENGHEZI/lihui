/**
 * 鲤慧 LiHui · 百度地图 · 微信小程序端直连封装
 *
 * 用途：小程序端可直接调用的百度地图 Web 服务 API（轻量、低延迟），
 *      用于行政区定位、输入联想等「端上体验敏感」的场景；
 *      路线规划、POI 检索等重能力仍走服务端中转（见 utils/api.js），以统一限流与缓存。
 *
 * 前置条件：
 *   1) 小程序后台 → 开发设置 → 服务器域名 → request 合法域名加入 https://api.map.baidu.com
 *   2) 百度地图开放平台 → 该 AK 的 Referer 白名单设为「微信小程序」并绑定 AppID
 */
const config = require('./config.js')

function call(pathname, params) {
  const qs = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&')
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.BAIDU_BASE}${pathname}?${qs}&ak=${config.BAIDU_AK}&output=json`,
      method: 'GET',
      timeout: 9000,
      success: (res) => {
        const d = res.data || {}
        if (d.status !== undefined && d.status !== 0) {
          reject(new Error(d.message || d.msg || '百度接口错误'))
          return
        }
        resolve(d)
      },
      fail: reject
    })
  })
}

/** 地址 → 坐标 */
function geocode(address, city) {
  // ret_coordtype=gcj02：geocoding 默认吐 BD-09，与端上坐标系不一致会偏 500~900m
  return call('/geocoding/v3/', { address, city: city || '', ret_coordtype: 'gcj02' }).then((d) => {
    const l = (d.result && d.result.location) || {}
    return { lng: Number(l.lng), lat: Number(l.lat), level: (d.result && d.result.level) || '' }
  })
}

/** 坐标 → 地址 */
function reverseGeocode(lng, lat) {
  return call('/reverse_geocoding/v3/', { location: `${lat},${lng}`, coordtype: 'gcj02' }).then((d) => {
    const r = d.result || {}
    const ad = r.addressComponent || {}
    return {
      formatted: r.formatted_address || '',
      city: ad.city || '',
      district: ad.district || '',
      province: ad.province || ''
    }
  })
}

/** 输入联想 */
function suggest(keyword, city) {
  return call('/place/v2/suggestion', {
    query: keyword,
    region: city || '',
    city_limit: false,
    ret_coord_type: 'gcj02'
  }).then((d) =>
    (d.result || []).map((x) => ({
      name: x.name,
      district: x.district,
      lng: x.location && Number(x.location.lng),
      lat: x.location && Number(x.location.lat)
    }))
  )
}

/** 周边 POI（轻量兜底，主链路走服务端）
 *  ⚠️ coord_type=3 必须显式声明：不传时百度按 BD-09 解释 location，
 *     等于把 GCJ-02 的检索圆心当成百度坐标，整圈结果会整体偏移 500~900m。 */
function poiSearch(query, lng, lat, radius) {
  return call('/place/v2/search', {
    query,
    location: `${lat},${lng}`,
    radius: radius || 1200,
    page_size: 20,
    page_num: 0,
    scope: 2,
    coord_type: 3
  }).then((d) => ({
    total: d.total || 0,
    items: (d.results || []).map((x) => {
      const l = x.location || {}
      const info = x.detail_info || {}
      return {
        uid: x.uid,
        name: x.name,
        address: x.address,
        lng: Number(l.lng),
        lat: Number(l.lat),
        distance: info.distance !== undefined ? Number(info.distance) : null,
        tag: info.tag || '',
        rating: info.overall_rating || null
      }
    })
  }))
}

module.exports = { call, geocode, reverseGeocode, suggest, poiSearch }
