<script setup lang="ts">
import { computed, ref } from "vue";

const subscriptionPlan = "archived";
const isImportReady = ref(false);
const isImportComplete = ref(false);
const actionLabel = computed(() => isImportReady.value ? "Import document" : "Request access");

function startImport() {
  if (!isImportReady.value) return;
  const params = new URLSearchParams({ source: "documents" });
  isImportComplete.value = true;
  window.location.href = `/documents/imported?${params.toString()}`;
}
</script>

<template>
  <main>
    <h1>Documents</h1>
    <button type="button" @click="startImport">{{ actionLabel }}</button>
    <p v-if="isImportComplete">Document imported</p>
  </main>
</template>
