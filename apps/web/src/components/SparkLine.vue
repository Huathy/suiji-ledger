<script setup lang="ts">
import { computed } from 'vue'

/**
 * 迷你折线：viewBox 自适应容器宽度（不再写死 width，避免小屏横向溢出 / PC 下过窄）
 */
const props = defineProps<{ points: number[]; width?: number; height?: number; color?: string }>()

const W = computed(() => props.width ?? 300)
const H = computed(() => props.height ?? 36)

const path = computed(() => {
  const pts = props.points
  if (pts.length < 2) return { line: '', dots: null as null | [number, number] }
  const w = W.value
  const h = H.value
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = max - min || 1
  const step = w / (pts.length - 1)
  const coords = pts.map((v, i) => [i * step, h - 4 - ((v - min) / span) * (h - 8)] as [number, number])
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  return { line, dots: coords[coords.length - 1] }
})
</script>

<template>
  <svg class="spark" :viewBox="`0 0 ${W} ${H}`" :style="{ height: H + 'px' }" preserveAspectRatio="none" role="img" aria-label="净资产走势">
    <path :d="path.line" fill="none" :stroke="color || 'rgba(255,255,255,.9)'" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    <circle v-if="path.dots" :cx="path.dots[0]" :cy="path.dots[1]" r="3" :fill="color || '#fff'" />
  </svg>
</template>

<style>
.spark { display: block; width: 100%; max-width: 100%; overflow: visible; }
</style>
