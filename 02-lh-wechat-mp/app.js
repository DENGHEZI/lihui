/**
 * 鲤慧 LiHui · 微信小程序入口
 */
const { ensureDeviceId } = require('./utils/token.js')
const { getCareMode } = require('./utils/care.js')

App({
  globalData: {
    deviceId: '',
    careMode: false,
    location: null,   // { lng, lat, city, district, source }
    plan: 'pro'
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

  /** 全局定位：优先 GPS，失败回落服务端 IP 锚定 */
  getLocation() {
    return new Promise((resolve) => {
      if (this.globalData.location) {
        resolve(this.globalData.location)
        return
      }
      const finish = (loc) => {
        this.globalData.location = loc
        resolve(loc)
      }
      wx.getLocation({
        type: 'gcj02',
        success: (res) => {
          finish({
            lng: res.longitude,
            lat: res.latitude,
            city: '',
            district: '',
            accuracy: res.accuracy || 50,
            source: 'gps'
          })
        },
        fail: () => {
          // 定位失败/被拒：先引导开启权限（只弹一次），再走服务端 IP 锚定兜底
          wx.getSetting({
            success: (s) => {
              if (s.authSetting && s.authSetting['scope.userLocation'] === false && !this._locTipShown) {
                this._locTipShown = true
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
          const { get } = require('./utils/request.js')
          get('/ip/locate')
            .then((d) => {
              finish({
                lng: (d.point && d.point.lng) || 112.938814,
                lat: (d.point && d.point.lat) || 28.228209,
                city: d.city || '',
                district: d.district || '',
                accuracy: 2000,
                source: 'ip'
              })
            })
            .catch(() => {
              finish({ lng: 112.938814, lat: 28.228209, city: '长沙市', district: '', accuracy: 5000, source: 'fallback' })
            })
        }
      })
    })
  }
})
