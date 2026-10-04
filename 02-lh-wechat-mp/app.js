/**
 * 鲤慧 LiHui · 微信小程序入口
 */
const { ensureDeviceId } = require('./utils/token.js')
const { getCareMode } = require('./utils/care.js')
const { safeGcj02 } = require('./utils/coord.js')

/** 定位结果复用时长：3 分钟内直接复用，避免反复弹权限；过期后静默刷新 */
const LOC_TTL = 3 * 60 * 1000
/** 精度阈值（米）：超过即判为粗定位（基站 / WiFi 近似），需补行政区文案 */
const ACC_FINE = 120

App({
  globalData: {
    deviceId: '',
    careMode: false,
    location: null,   // { lng, lat, city, district, source }
    plan: 'pro'
  },

  /* —— 极简事件总线：定位变化时通知各页面刷新 ——
   * 客户反馈「首页定位位置和地点没有变化」，根因是 globalData.location 变更后
   * 没有任何页面能感知（tab 页 onLoad 只走一次、onShow 里也只读了缓存）。
   * 现在定位 settle 时 emit('locationChange')，首页等页面订阅后自行刷新。 */
  _listeners: {},
  on(evt, fn) {
    if (!this._listeners[evt]) this._listeners[evt] = []
    if (this._listeners[evt].indexOf(fn) === -1) this._listeners[evt].push(fn)
  },
  off(evt, fn) {
    const a = this._listeners[evt]
    if (a) this._listeners[evt] = a.filter((f) => f !== fn)
  },
  emit(evt, data) {
    ;(this._listeners[evt] || []).slice().forEach((f) => {
      try { f(data) } catch (e) { console.warn('[鲤慧-事件] 处理器异常', evt, e) }
    })
  },

  onLaunch() {
    this.globalData.deviceId = ensureDeviceId()
    this.globalData.careMode = getCareMode()
    console.log('[鲤慧] 小程序启动，deviceId =', this.globalData.deviceId)
  },

  onShow() {
    console.log('[鲤慧] onShow')
  },

  onHide() {
    console.log('[鲤慧] onHide')
  },

  onError(err) {
    console.error('[鲤慧] 运行错误', err)
  },

  /**
   * 全局定位：优先高精度 GPS，失败回落服务端 IP 锚定（城市级）
   *
   * @param {{force?:boolean}} opts force=true 时忽略缓存强制重新定位（「回到我的位置」用）
   * @returns {Promise<{lng:number,lat:number,city:string,district:string,accuracy:number,source:string}|null>}
   */
  getLocation(opts) {
    opts = opts || {}
    const self = this
    const now = Date.now()
    const cached = this.globalData.location
    if (!opts.force && cached && cached.ts && now - cached.ts < LOC_TTL) {
      console.log('[鲤慧-定位] 复用缓存', cached.source, '±' + cached.accuracy + 'm')
      return Promise.resolve(cached)
    }

    return new Promise((resolve) => {
      const settle = (loc) => {
        if (loc) {
          loc.ts = loc.ts || Date.now()
          // 全链路统一 GCJ-02：来自百度的 BD-09 结果在这里换算一次，其余一律按 GCJ-02 处理
          if (Number(loc.lng) && Number(loc.lat)) {
            if (loc.coord === 'bd09') {
              const g = safeGcj02(loc.lng, loc.lat)
              if (g) {
                loc.lng = g.lng
                loc.lat = g.lat
              }
            } else {
              loc.lng = Number(loc.lng)
              loc.lat = Number(loc.lat)
            }
            loc.coord = 'gcj02'
          }
          self.globalData.location = loc
          // 广播定位变化：首页 / 生活圈等订阅页据此刷新地图中心与周边数据
          self.emit('locationChange', loc)
          // GPS 结果回写服务端，让「无坐标 / IP 兜底」的请求也能精确定位
          if (loc.source === 'gps' || loc.source === 'gps-coarse') {
            try {
              const api = require('./utils/api.js')
              api.reportLocation(loc.lng, loc.lat, loc.accuracy)
            } catch (e) {
              console.warn('[鲤慧-定位] GPS 回写失败（不影响使用）', e)
            }
          }
        }
        resolve(loc || null)
      }

      /** 粗定位时补一次逆地理，拿到城市 / 区县文案 */
      const fillPlace = (loc) => {
        const done = () => settle(loc)
        try {
          const api = require('./utils/api.js')
          api
            .reverseGeocode(loc.lng, loc.lat)
            .then((r) => {
              loc.city = (r && r.city) || loc.city || ''
              loc.district = (r && r.district) || loc.district || ''
              loc.formatted = (r && r.formatted) || loc.formatted || ''
              done()
            })
            .catch(done)
        } catch (e) {
          done()
        }
      }

      wx.getLocation({
        type: 'gcj02',
        // ⚠️ 关键：不开高精度，系统可能直接返回「上次缓存位置 / 基站」，
        // 误差能到几百米甚至几公里，却依然被当成 GPS 用
        isHighAccuracy: true,
        highAccuracyExpireTime: 5000,
        success: (res) => {
          const acc = Number(res.accuracy == null ? 50 : res.accuracy)
          const loc = {
            lng: Number(res.longitude),
            lat: Number(res.latitude),
            city: '',
            district: '',
            formatted: '',
            accuracy: acc,
            // ≤120m 才算真 GPS；否则退化为「近似定位」，UI 要如实标注
            source: acc <= ACC_FINE ? 'gps' : 'gps-coarse'
          }
          if (loc.source === 'gps-coarse') {
            fillPlace(loc)
          } else {
            settle(loc)
          }
        },
        fail: (err) => {
          console.warn('[鲤慧-定位] getLocation fail', err)
          // 定位被拒：只引导一次去开权限
          wx.getSetting({
            success: (s) => {
              if (s.authSetting && s.authSetting['scope.userLocation'] === false && !self._locTipShown) {
                self._locTipShown = true
                wx.showModal({
                  title: '开启定位',
                  content: '开启定位后，鲤慧可以准确找到你身边的便民服务与出行方案。',
                  confirmText: '去开启',
                  success: (r) => {
                    if (r.confirm) wx.openSetting({})
                  }
                })
              }
            }
          })
          // 回落服务端 IP 锚定（城市级，误差数公里，但至少不会再乱跳到别的城市）
          const { get } = require('./utils/request.js')
          get('/ip/locate')
            .then((d) => {
              const p = (d && d.point) || {}
              settle({
                lng: Number(p.lng),
                lat: Number(p.lat),
                city: (d && d.city) || '',
                district: (d && d.district) || '',
                formatted: (d && d.districtName) || '',
                accuracy: 3000,
                source: 'ip'
              })
            })
            .catch(() => {
              // 不再硬编码「长沙市」兜底：宁可拿不到位置，也不要把用户扔到 200km 外
              console.error('[鲤慧-定位] IP 锚定也失败，放弃本次定位')
              resolve(null)
            })
        }
      })
    })
  }
})
