// Frame Comparison for Skipping Near-Identical Frames (Requirement 3)

export function computeGrayscaleThumbnail(
  video: HTMLVideoElement,
  width: number = 16,
  height: number = 16
): Uint8Array | null {
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(video, 0, 0, width, height);
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    const totalPixels = width * height;
    const gray = new Uint8Array(totalPixels);

    for (let i = 0; i < totalPixels; i++) {
      const idx = i * 4;
      gray[i] = Math.round(
        0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]
      );
    }
    return gray;
  } catch {
    return null;
  }
}

export function computeMeanPixelDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 1.0;
  let sumDiff = 0;
  for (let i = 0; i < a.length; i++) {
    sumDiff += Math.abs(a[i] - b[i]);
  }
  return sumDiff / (a.length * 255);
}

export function shouldSkipFrame(
  currentThumb: Uint8Array | null,
  lastSentThumb: Uint8Array | null,
  lastSentTime: number,
  now: number = Date.now(),
  threshold: number = 0.06,
  maxSilenceMs: number = 30000
): boolean {
  if (!currentThumb || !lastSentThumb) return false;
  // Unless 30 seconds have passed since the last sent frame
  if (now - lastSentTime >= maxSilenceMs) return false;

  const diff = computeMeanPixelDiff(currentThumb, lastSentThumb);
  return diff < threshold;
}
