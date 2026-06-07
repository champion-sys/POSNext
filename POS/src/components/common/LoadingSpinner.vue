<template>
	<div class="flex-1 flex items-center justify-center py-6 bg-transparent">
		<div class="text-center">
			<div class="lds-grid mx-auto">
				<div></div>
				<div></div>
				<div></div>
				<div></div>
				<div></div>
				<div></div>
				<div></div>
				<div></div>
				<div></div>
			</div>
			<p v-if="text" class="mt-4 text-xs font-semibold text-gray-600 uppercase tracking-wider">
				{{ text }}
			</p>
		</div>
	</div>
</template>

<script setup>
defineProps({
	text: {
		type: String,
		default: () => __("Loading..."),
	},
})
</script>

<style scoped>
.lds-grid,
.lds-grid div {
  box-sizing: border-box;
}
.lds-grid {
  display: block;
  position: relative;
  width: 50px;
  height: 50px;
}
.lds-grid div {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 0;
  animation: lds-grid 1.2s linear infinite;
}
.lds-grid div:nth-child(even) {
  background: #9ca3af; /* Gray */
}
.lds-grid div:nth-child(odd) {
  background: #000000; /* Black */
}
.lds-grid div:nth-child(1) {
  top: 6px;
  left: 6px;
  animation-delay: 0s;
}
.lds-grid div:nth-child(2) {
  top: 6px;
  left: 20px;
  animation-delay: -0.4s;
}
.lds-grid div:nth-child(3) {
  top: 6px;
  left: 34px;
  animation-delay: -0.8s;
}
.lds-grid div:nth-child(4) {
  top: 20px;
  left: 6px;
  animation-delay: -0.4s;
}
.lds-grid div:nth-child(5) {
  top: 20px;
  left: 20px;
  animation-delay: -0.8s;
}
.lds-grid div:nth-child(6) {
  top: 20px;
  left: 34px;
  animation-delay: -1.2s;
}
.lds-grid div:nth-child(7) {
  top: 34px;
  left: 6px;
  animation-delay: -0.8s;
}
.lds-grid div:nth-child(8) {
  top: 34px;
  left: 20px;
  animation-delay: -1.2s;
}
.lds-grid div:nth-child(9) {
  top: 34px;
  left: 34px;
  animation-delay: -1.6s;
}
@keyframes lds-grid {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
</style>
