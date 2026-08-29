<script setup>
import { defineAsyncComponent } from "vue";

const DetailPanel = defineAsyncComponent(() => import("../components/DetailPanel.vue"));
</script>

<template>
  <main>
    <img class="hero" src="/assets/hero.svg" loading="eager" fetchpriority="high" decoding="async" alt="Workspace overview" />
    <img src="/assets/history.svg" loading="lazy" decoding="async" alt="Recent activity" />
    <DetailPanel />
  </main>
</template>

<style scoped>
.hero {
  animation: settle 240ms ease-out 1;
  transform: translateX(0);
}
</style>
