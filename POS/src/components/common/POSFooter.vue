<template>
	<div v-if="isEnabled" ref="footerRoot" class="pos-footer-component" :style="footerStyle">
		<div class="footer-content" dir="ltr">
			<span class="footer-text">{{ footerText }}</span>
			<a :href="footerLink" target="_blank" rel="noopener noreferrer" class="footer-link">
				{{ linkText }}
			</a>
		</div>
	</div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { call } from '@/utils/apiWrapper'

// Component state
const footerText = ref('Powered by')
const linkText = ref('BrainWise')
const footerLink = ref('https://nexus.brainwise.me')
const isEnabled = ref(true)
const config = ref({})

const footerStyle = computed(() => ({
	padding: config.value._s?.p || '12px 20px',
	backgroundColor: config.value._s?.bg || '#f8f9fa',
	borderTop: config.value._s?.bt || '1px solid #e0e0e0',
	textAlign: config.value._s?.ta || 'center',
	fontSize: config.value._s?.fs || '13px',
	color: config.value._s?.c || '#6b7280',
	zIndex: config.value._s?.z || 100,
	userSelect: 'none',
	WebkitUserSelect: 'none',
	MozUserSelect: 'none',
	msUserSelect: 'none',
	position: 'fixed',
	bottom: '0',
	left: '0',
	right: '0',
	width: '100%'
}))

// Load branding configuration from backend
const loadBrandingConfig = async () => {
	try {
		const response = await call('pos_next.api.branding.get_branding_config')

		if (response) {
			config.value = response
			isEnabled.value = response._e !== 0 && response._e !== false

			// Decode base64 encoded values
			footerText.value = atob(response._t || '')
			linkText.value = atob(response._l || '')
			footerLink.value = atob(response._u || '')
		}
	} catch (error) {
		console.error('[BrainWise] Failed to load branding config:', error)
		// Use fallback values
		footerText.value = 'Powered by'
		linkText.value = 'BrainWise'
		footerLink.value = 'https://nexus.brainwise.me'
		isEnabled.value = true
	}
}

onMounted(async () => {
	await loadBrandingConfig()
})
</script>

<style scoped>
/* Minimal scoped styles - main styles are injected dynamically */
.pos-footer-component {
	flex-shrink: 0;
}
</style>
