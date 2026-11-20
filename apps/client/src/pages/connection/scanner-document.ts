export function scannerDocument(source: string): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:">
<title>Scan an Eta code</title>
<style>
* { box-sizing: border-box }
body { margin: 0; color: white; background: #0a0b0c; font: 14px/18px "Inter Variable", Inter, system-ui, sans-serif }
video { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: cover }
.dim { position: fixed; inset: 0; background: #0000008c; pointer-events: none }
.frame { position: fixed; width: min(240px, 76vw); aspect-ratio: 1; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  background: linear-gradient(white, white) top left / 28px 2px,
    linear-gradient(white, white) top left / 2px 28px,
    linear-gradient(white, white) top right / 28px 2px,
    linear-gradient(white, white) top right / 2px 28px,
    linear-gradient(white, white) bottom left / 28px 2px,
    linear-gradient(white, white) bottom left / 2px 28px,
    linear-gradient(white, white) bottom right / 28px 2px,
    linear-gradient(white, white) bottom right / 2px 28px;
  background-repeat: no-repeat }
.instructions { position: fixed; top: calc(50% + min(120px, 38vw) + 24px); width: 100%;
  text-align: center; padding: 0 16px; display: grid; gap: 6px }
strong { font-size: 14px; line-height: 18px; font-weight: 400 }
small { color: #ffffffb3; font-size: 12px; line-height: 16px }
button { position: fixed; top: max(12px, env(safe-area-inset-top)); left: 6px;
  border: 0; background: transparent; color: white;
  font: inherit; min-height: 44px; padding: 0 10px; cursor: pointer }
</style>
<video autoplay muted playsinline aria-hidden="true"></video><div class="dim"></div><div class="frame"></div>
<div class="instructions"><strong>Scan the code on your computer</strong>
<small>Settings → Machines → Connect phone</small></div>
<button type="button">Close</button>
<script>${source.replace(/<\/script/gi, "<\\/script")}</script>
<script>
const video = document.querySelector('video');
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let stream, timer, finished = false, starting = false;
function pause() {
  clearInterval(timer);
  stream?.getTracks().forEach(track => track.stop());
  stream = undefined;
  video.srcObject = null;
}
function finish(message) {
  if (finished) return;
  finished = true;
  pause();
  window.nsh.postMessage(JSON.stringify(message));
}
function scan() {
  if (!ctx || !video.videoWidth) return;
  const side = Math.min(video.videoWidth, video.videoHeight);
  canvas.width = canvas.height = Math.min(640, side);
  ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2,
    side, side, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
  if (code) finish({ code: code.data });
}
async function start() {
  if (starting || stream || document.hidden || finished) return;
  if (!ctx || !navigator.mediaDevices?.getUserMedia) return finish({ unavailable: true });
  starting = true;
  try {
    const camera = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false,
    });
    if (document.hidden || finished) {
      camera.getTracks().forEach(track => track.stop());
      return;
    }
    stream = camera;
    video.srcObject = stream;
    await video.play();
    if (stream === camera) timer = setInterval(scan, 160);
  } catch {
    finish({ unavailable: true });
  } finally {
    starting = false;
  }
}
document.querySelector('button').addEventListener('click', () => finish({ close: true }));
document.addEventListener('visibilitychange', () => document.hidden ? pause() : start());
window.addEventListener('pagehide', pause);
start();
</script></html>`;
}
