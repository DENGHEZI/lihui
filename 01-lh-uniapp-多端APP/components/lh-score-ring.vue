<template>
	<view class="ring-wrap">
		<view class="ring" :style="{ width: size + 'px', height: size + 'px' }">
			<!-- 底环 -->
			<view class="orbit" :style="orbitStyle"></view>
			<!-- 进度环（用 conic-gradient 表现，App 端回落为纯色） -->
			<view class="progress" :style="progressStyle"></view>
			<view class="inner">
				<text class="score" :style="{ color: color, fontSize: size * 0.28 + 'px' }">{{ animated }}</text>
				<text class="unit">分</text>
			</view>
		</view>
		<text class="level" :style="{ color: color }">{{ level }}</text>
	</view>
</template>

<script>
export default {
	name: 'lh-score-ring',
	props: {
		score: { type: Number, default: 0 },
		level: { type: String, default: '' },
		size: { type: Number, default: 120 }
	},
	data() {
		return { animated: 0 }
	},
	computed: {
		color() {
			const s = this.score
			if (s >= 85) return '#00B96B'
			if (s >= 60) return '#1677FF'
			if (s >= 40) return '#FF8A00'
			return '#F5222D'
		},
		orbitStyle() {
			return {
				width: this.size + 'px',
				height: this.size + 'px',
				borderRadius: '50%',
				border: '10px solid #EDEFF2',
				boxSizing: 'border-box'
			}
		},
		progressStyle() {
			const deg = Math.max(0, Math.min(100, this.score)) * 3.6
			return {
				width: this.size + 'px',
				height: this.size + 'px',
				borderRadius: '50%',
				position: 'absolute',
				left: '0',
				top: '0',
				background: `conic-gradient(${this.color} ${deg}deg, transparent ${deg}deg)`,
				WebkitMask: `radial-gradient(farthest-side, transparent calc(100% - 10px), #000 calc(100% - 10px))`,
				mask: `radial-gradient(farthest-side, transparent calc(100% - 10px), #000 calc(100% - 10px))`
			}
		}
	},
	watch: {
		score: {
			immediate: true,
			handler(v) {
				this.animate(Number(v) || 0)
			}
		}
	},
	methods: {
		animate(target) {
			const start = this.animated
			const diff = target - start
			const steps = 24
			let i = 0
			const timer = setInterval(() => {
				i++
				this.animated = Math.round(start + (diff * i) / steps)
				if (i >= steps) {
					this.animated = target
					clearInterval(timer)
				}
			}, 25)
		}
	}
}
</script>

<style scoped>
.ring-wrap {
	display: flex;
	flex-direction: column;
	align-items: center;
}
.ring {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
}
.inner {
	position: absolute;
	left: 0;
	right: 0;
	top: 0;
	bottom: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
}
.score {
	font-weight: 600;
	line-height: 1;
}
.unit {
	font-size: 12px;
	color: #8F959E;
	margin-top: 2px;
}
.level {
	margin-top: 10px;
	font-size: 15px;
	font-weight: 600;
}
</style>
