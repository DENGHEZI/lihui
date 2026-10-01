<template>
	<view class="search-wrap">
		<view class="search-bar" @click="$emit('focus')">
			<text class="ico">🔍</text>
			<input
				class="inp"
				:value="value"
				:placeholder="placeholder"
				placeholder-class="ph"
				confirm-type="search"
				@input="onInput"
				@confirm="$emit('confirm', value)"
			/>
			<view class="mic" @click.stop="$emit('voice')">
				<text>🎙</text>
			</view>
		</view>
		<view v-if="showSuggest && suggests.length" class="suggest">
			<view v-for="(s, i) in suggests" :key="i" class="sug-item" @click="pick(s)">
				<text class="sug-name">{{ s.name }}</text>
				<text class="sug-dist">{{ s.district || '' }}</text>
			</view>
		</view>
	</view>
</template>

<script>
export default {
	name: 'lh-search-bar',
	props: {
		value: { type: String, default: '' },
		placeholder: { type: String, default: '搜索目的地、公交、地铁…' },
		suggests: { type: Array, default: () => [] },
		showSuggest: { type: Boolean, default: false }
	},
	methods: {
		onInput(e) {
			this.$emit('input', e.detail.value)
			this.$emit('change', e.detail.value)
		},
		pick(s) {
			this.$emit('pick', s)
		}
	}
}
</script>

<style scoped>
.search-wrap {
	position: relative;
}
.search-bar {
	height: 48px;
	background: #FFFFFF;
	border-radius: 24px;
	display: flex;
	align-items: center;
	padding: 0 8px 0 14px;
	box-shadow: 0 2px 12px rgba(0, 0, 0, .08);
}
.ico {
	font-size: 16px;
	margin-right: 6px;
}
.inp {
	flex: 1;
	height: 48px;
	font-size: 15px;
	color: #1A1A1A;
}
.ph {
	color: #8F959E;
	font-size: 15px;
}
.mic {
	width: 36px;
	height: 36px;
	border-radius: 50%;
	background: #EAF2FF;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 16px;
}
.suggest {
	position: absolute;
	left: 0;
	right: 0;
	top: 54px;
	background: #FFFFFF;
	border-radius: 16px;
	box-shadow: 0 8px 24px rgba(0, 0, 0, .12);
	overflow: hidden;
	z-index: 30;
}
.sug-item {
	padding: 12px 16px;
	display: flex;
	justify-content: space-between;
	align-items: center;
	border-bottom: 1px solid #EDEFF2;
}
.sug-item:last-child {
	border-bottom: none;
}
.sug-name {
	font-size: 15px;
	color: #1A1A1A;
}
.sug-dist {
	font-size: 13px;
	color: #8F959E;
}
</style>
