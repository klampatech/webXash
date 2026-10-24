<template>
  <div class="xash-settings">
    <!-- Landing page — TS only.
         Replaces the old hero + "Advanced" options disclosure. Launch
         options are now pre-configured and the server browser carries the
         per-server targeting, so there is no options UI by design. -->
    <XashLanding v-if="!loading" />

    <!-- Loading screen -->
    <XashLoading v-if="loading" />
  </div>
</template>

<script setup lang="ts">
// This component is now a thin switch between the landing page and the
// loading screen. The launch path (zip download, startGameZip, console
// callbacks, save refresh) moved to XashLanding.vue, which also owns the
// pre-configured launch options the old "Advanced" disclosure used to
// expose.
import { storeToRefs } from 'pinia';
import { useXashStore } from '/@/stores/store';
import XashLanding from '/@/components/XashLanding.vue';
import XashLoading from '/@/components/XashLoading.vue';

const store = useXashStore();
const { loading } = storeToRefs(store);
</script>
