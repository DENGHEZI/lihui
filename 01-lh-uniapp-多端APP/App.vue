<script>
	import { ensureDeviceId } from './utils/token.js'
	import { getCareMode } from './utils/care.js'

	export default {
		onLaunch: function() {
			// 设备指纹（用于 Token 计量与服务端识别）
			ensureDeviceId()
			// 关怀模式（老年人）
			const care = getCareMode()
			console.log('[鲤慧] 启动完成，关怀模式 =', care)
		},
		onShow: function() {
			console.log('[鲤慧] App Show')
		},
		onHide: function() {
			console.log('[鲤慧] App Hide')
		}
	}
</script>

<style>
	/* 全局样式：与 00-设计文档/设计令牌/tokens.css 保持一致 */
	page {
		--lh-primary: #1677FF;
		--lh-primary-dark: #0E5FD8;
		--lh-primary-soft: #EAF2FF;
		--lh-success: #00B96B;
		--lh-warning: #FF8A00;
		--lh-danger: #F5222D;
		--lh-text: #1A1A1A;
		--lh-text-sub: #646A73;
		--lh-text-weak: #8F959E;
		--lh-line: #EDEFF2;
		--lh-bg: #F4F5F7;
		--lh-card: #FFFFFF;

		background-color: #F4F5F7;
		color: #1A1A1A;
		font-size: 15px;
		line-height: 1.5;
		font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif;
	}

	/* 关怀模式：大字、高对比 */
	.care-mode {
		--lh-text: #000000;
		--lh-text-sub: #333333;
		--lh-text-weak: #5A5A5A;
		--lh-line: #D8DCE2;
	}

	.care-mode .lh-body {
		font-size: 19px;
		line-height: 1.6;
	}

	.care-mode .lh-h2 {
		font-size: 22px;
	}

	/* 公共原子类 */
	.lh-page {
		min-height: 100vh;
		background: #F4F5F7;
	}

	.lh-card {
		background: #FFFFFF;
		border-radius: 16px;
		box-shadow: 0 2px 12px rgba(0, 0, 0, .06);
		padding: 16px;
		box-sizing: border-box;
	}

	.lh-h1 {
		font-size: 22px;
		line-height: 1.36;
		font-weight: 600;
		color: var(--lh-text);
	}

	.lh-h2 {
		font-size: 18px;
		line-height: 1.44;
		font-weight: 600;
		color: var(--lh-text);
	}

	.lh-body {
		font-size: 15px;
		line-height: 1.5;
		color: var(--lh-text);
	}

	.lh-cap {
		font-size: 13px;
		line-height: 1.4;
		color: var(--lh-text-sub);
	}

	.lh-mini {
		font-size: 11px;
		color: var(--lh-text-weak);
	}

	.lh-divider {
		height: 1px;
		background: var(--lh-line);
	}

	.lh-pill {
		display: inline-flex;
		align-items: center;
		height: 28px;
		padding: 0 12px;
		border-radius: 999px;
		border: 1px solid var(--lh-line);
		color: var(--lh-text-sub);
		font-size: 13px;
		background: #FFF;
	}

	.lh-pill--on {
		background: var(--lh-primary-soft);
		border-color: var(--lh-primary);
		color: var(--lh-primary);
		font-weight: 600;
	}

	.lh-btn {
		height: 48px;
		border-radius: 999px;
		background: var(--lh-primary);
		color: #FFFFFF;
		font-size: 16px;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
	}

	.lh-btn--ghost {
		background: #FFFFFF;
		color: var(--lh-primary);
		border: 1px solid var(--lh-primary);
	}

	.lh-btn--dis {
		background: #C8CDD4;
	}

	.lh-fab {
		width: 56px;
		height: 56px;
		border-radius: 50%;
		background: #FFFFFF;
		box-shadow: 0 4px 16px rgba(22, 119, 255, .25);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.lh-handle {
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: #DDE0E4;
		margin: 8px auto;
	}
</style>
