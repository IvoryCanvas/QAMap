<script setup>
import { onMounted, ref } from "vue";
import DetailPanel from "../components/DetailPanel.vue";

const ready = ref(false);
onMounted(() => setTimeout(() => {
  ready.value = true;
}, 50));
</script>

<template>
  <main v-if="ready">
    <img class="hero" src="/assets/hero.svg" loading="lazy" decoding="async" alt="Workspace overview" />
    <DetailPanel />
  </main>
</template>

<style scoped>
.hero {
  animation: shimmer 1s linear infinite;
  background-position: 100% 0;
}
</style>
