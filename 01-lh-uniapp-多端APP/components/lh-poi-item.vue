<template>
	<view class="poi" @click="$emit('tap', item)">
		<view class="ico" :style="{ background: bg }">{{ icon }}</view>
		<view class="mid">
			<view class="name-row">
				<text class="name">{{ item.name }}</text>
				<text v-if="item.rating && item.rating !== '0'" class="rate">★{{ item.rating }}</text>
			</view>
			<text class="addr">{{ item.address || '地址未知' }}</text>
			<view v-if="tags.length" class="tags">
				<text v-for="(t, i) in tags" :key="i" class="tag">{{ t }}</text>
			</view>
		</view>
		<view class="right">
			<text class="dist">{{ distText }}</text>
			<text class="go">导航 ›</text>
		</view>
	</view>
</template>

<script>
export default {
	name: 'lh-poi-item',
	props: {
		item: { type: Object, required: true },
		icon: { type: String, default: '📍' },
		bg: { type: String, default: '#EAF2FF' }
	},
	computed: {
		distText() {
			const d = this.item.distance
			if (d === null || d === undefined || d === '') return ''
			return Number(d) >= 1000 ? (Number(d) / 1000).toFixed(1) + 'km' : Math.round(Number(d)) + 'm'
		},
		tags() {
			const arr = []
			if (this.item.tag) arr.push(this.item.tag)
			if (this.item.type && this.item.type !== this.item.tag) {
				const parts = String(this.item.type).split(';')
				if (parts[0] && parts[0] !== this.item.tag) arr.push(parts[0])
			}
			if (this.distText && Number(this.item.distance) <= 500) arr.push('步行 ' + Math.max(1, Math.round(this.item.distance / 75)) + ' 分钟')
			return arr.slice(0, 3)
		}
	}
}
</script>

<style scoped>
.poi {
	display: flex;
	align-items: flex-start;
	padding: 14px 0;
	border-bottom: 1px solid #EDEFF2;
}
.poi:last-child {
	border-bottom: none;
}
.ico {
	width: 40px;
	height: 40px;
	border-radius: 12px;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 19px;
	margin-right: 12px;
	flex-shrink: 0;
}
.mid {
	flex: 1;
	min-width: 0;
}
.name-row {
	display: flex;
	align-items: center;
}
.name {
	font-size: 15px;
	font-weight: 600;
	color: #1A1A1A;
	margin-right: 6px;
}
.rate {
	font-size: 12px;
	color: #FF8A00;
}
.addr {
	font-size: 13px;
	color: #646A73;
	margin-top: 3px;
	display: block;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.tags {
	display: flex;
	flex-wrap: wrap;
	margin-top: 6px;
}
.tag {
	font-size: 11px;
	color: #646A73;
	background: #F4F5F7;
	border-radius: 6px;
	padding: 2px 6px;
	margin-right: 6px;
}
.right {
	text-align: right;
	flex-shrink: 0;
	margin-left: 8px;
}
.dist {
	font-size: 13px;
	color: #1677FF;
	font-weight: 600;
	display: block;
}
.go {
	font-size: 12px;
	color: #8F959E;
	margin-top: 4px;
	display: block;
}
</style>
