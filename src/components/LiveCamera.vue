<template>
  <!--
    The live camera behind the hero.

    WHAT THIS IS
    ------------
    A canvas that paints the frames of a permanent spectator camera in the
    game — a real client on a real server, rendering the real world — so
    the landing page shows the game instead of describing it.

    WHY A CANVAS AND NOT A <video>
    ------------------------------
    The frames arrive as JPEGs over a WebSocket, one per frame. There is
    no container to hand a <video>: the frames ARE the media. A canvas
    with `object-fit: cover` is the honest shape for that.

    THE FALLBACK IS THE POINT
    -------------------------
    The dial behind the wordmark is the background when this is not
    running. This component only appears once a frame has actually
    arrived, and it removes itself if the stream stops. A landing page
    that waits for a camera is a landing page that sometimes shows
    nothing.
  -->
  <canvas
    v-show="visible"
    ref="canvas"
    class="live-camera"
    :width="frameW"
    :height="frameH"
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

/** Where the frame stream lives. Same origin by default. */
const CAMERA_URL =
  (import.meta.env.VITE_CAMERA_URL as string | undefined) ||
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/camera/view`;

/** How long to wait for the first frame before deciding there is no camera. */
const FIRST_FRAME_TIMEOUT_MS = 8000;

const canvas = ref<HTMLCanvasElement | null>(null);
const visible = ref(false);
const frameW = ref(480);
const frameH = ref(270);

let ws: WebSocket | null = null;
let retryTimer: number | undefined;
let firstFrameTimer: number | undefined;
let closed = false;

function connect() {
  if (closed) return;
  try {
    ws = new WebSocket(CAMERA_URL);
    ws.binaryType = 'arraybuffer';
  } catch (e) {
    scheduleRetry();
    return;
  }

  ws.onmessage = async (ev: MessageEvent) => {
    if (typeof ev.data === 'string') return;
    const buf = ev.data as ArrayBuffer;
    try {
      const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
      const el = canvas.value;
      if (!el) {
        bmp.close();
        return;
      }
      if (el.width !== bmp.width || el.height !== bmp.height) {
        el.width = bmp.width;
        el.height = bmp.height;
        frameW.value = bmp.width;
        frameH.value = bmp.height;
      }
      const ctx = el.getContext('2d');
      ctx?.drawImage(bmp, 0, 0);
      bmp.close();
      if (!visible.value) {
        visible.value = true;
        if (firstFrameTimer !== undefined) {
          clearTimeout(firstFrameTimer);
          firstFrameTimer = undefined;
        }
      }
    } catch (e) {
      /* a frame that will not decode is not worth breaking the page over */
    }
  };

  ws.onclose = () => {
    // The stream went away: fall back to the dial.
    visible.value = false;
    scheduleRetry();
  };
  ws.onerror = () => {
    /* onclose follows */
  };
}

function scheduleRetry() {
  if (closed) return;
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = window.setTimeout(connect, 5000);
}

onMounted(() => {
  connect();
  firstFrameTimer = window.setTimeout(() => {
    // No frame yet: stay invisible. The dial is the background.
    if (!visible.value) ws?.close();
  }, FIRST_FRAME_TIMEOUT_MS);
});

onBeforeUnmount(() => {
  closed = true;
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer);
  ws?.close();
});
</script>

<style scoped>
.live-camera {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* The game is the texture, not the subject: it sits under everything
     and it must never fight the wordmark for attention. */
  opacity: 0.38;
  filter: saturate(0.85) contrast(1.05);
  pointer-events: none;
  /* Its own compositor layer. The landing page animates (the grid, the
     emblem rays, the LIVE dot), and without this every one of those
     animations forces the video texture to be re-rasterised with it —
     which is how a 16 fps stream ends up looking like 3 fps. */
  transform: translateZ(0);
  will-change: transform;
}
</style>
