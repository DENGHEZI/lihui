// uni-app Promise 化适配（官方模板文件）
const promisify = (api) => {
	return (options, ...params) => {
		return new Promise((resolve, reject) => {
			api(Object.assign({}, options, { success: resolve, fail: reject }), ...params);
		});
	}
}

/* eslint-disable */
if (typeof uni !== 'undefined' && !uni.promisify) {
	uni.promisify = {
		set: (options) => {
			return new Promise((resolve, reject) => {
				uni.setStorage(Object.assign({}, options, { success: resolve, fail: reject }))
			})
		},
		get: (options) => {
			return new Promise((resolve, reject) => {
				uni.getStorage(Object.assign({}, options, { success: resolve, fail: reject }))
			})
		},
		request: promisify(uni.request),
		getLocation: promisify(uni.getLocation),
		chooseLocation: promisify(uni.chooseLocation)
	}
}
