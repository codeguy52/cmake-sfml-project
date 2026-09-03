import { createWorker, type Worker } from 'tesseract.js';
import type { ParsedReceipt } from '../types';
import { parseReceiptText } from './receiptParser';

/**
 * On-device OCR.
 *
 * Tesseract runs in a web worker in the browser — the photo never leaves the
 * device, which is the whole reason for choosing it over a cloud vision API for
 * something as personal as a shopping history. The trade is accuracy, so
 * `recognizeReceipt` preprocesses aggressively (grayscale, contrast stretch,
 * downscale) because Tesseract's weakness is low-contrast photographs, not
 * unusual layouts.
 *
 * Every piece of the OCR runtime is served from our own origin, vendored into
 * `public/tesseract/` by `scripts/vendor-ocr-assets.mjs`. Tesseract.js would
 * otherwise fetch its worker, its WebAssembly core and the language model from
 * a public CDN on first use, which would both break offline scanning and tell a
 * third party that someone is photographing a receipt. Overriding these three
 * paths is what makes "on-device" actually true.
 *
 * The worker and its ~3 MB model load lazily on the first scan and are then
 * reused, so the app's initial load isn't paying for a feature that may never
 * be used.
 */

let workerPromise: Promise<Worker> | null = null;

export type OcrProgress = { status: string; progress: number };

/** Same base the app is served from, so a subdirectory deploy still resolves. */
const OCR_BASE = `${import.meta.env.BASE_URL}tesseract`;

async function getWorker(onProgress?: (p: OcrProgress) => void): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker(
      'eng',
      1,
      {
        workerPath: `${OCR_BASE}/worker.min.js`,
        corePath: `${OCR_BASE}/`,
        langPath: `${OCR_BASE}/lang`,
        // The vendored model is gzipped, matching Tesseract's own convention.
        gzip: true,
        logger: (m) => {
          if (onProgress && typeof m.progress === 'number') {
            onProgress({ status: m.status, progress: m.progress });
          }
        },
      },
    ).then(async (worker) => {
      await worker.setParameters({
        // Receipts are a single block of text in reading order; the default
        // page-segmentation mode wastes effort hunting for columns.
        tessedit_pageseg_mode: '6' as never,
        preserve_interword_spaces: '1',
      });
      return worker;
    });

    // A failed load must not poison every later attempt.
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

/** Release the worker and its model. Called when the receipt view unmounts. */
export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // Nothing to release.
  }
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not decode the image.'));
      img.src = url;
    });
    return img;
  } finally {
    // Safe once decoding has finished either way.
    URL.revokeObjectURL(url);
  }
}

/**
 * Grayscale, stretch contrast, and cap the long edge.
 *
 * The contrast stretch is a percentile-clipped linear remap rather than a fixed
 * threshold: a phone photo of a receipt usually occupies a narrow band in the
 * middle of the histogram (grey paper, grey-black ink), and pulling that band
 * out to the full range is what turns unreadable output into readable output.
 */
export async function preprocessForOcr(blob: Blob, maxEdge = 1800): Promise<Blob> {
  const img = await loadImage(blob);

  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return blob;

  ctx.drawImage(img, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;

  // Pass 1: grayscale in place, building a histogram as we go.
  const histogram = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const gray = (px[i]! * 0.299 + px[i + 1]! * 0.587 + px[i + 2]! * 0.114) | 0;
    px[i] = gray;
    px[i + 1] = gray;
    px[i + 2] = gray;
    histogram[gray]! += 1;
  }

  // Clip the darkest and lightest 1% before stretching, so a single specular
  // highlight or shadow can't define the range.
  const pixelCount = width * height;
  const clip = Math.floor(pixelCount * 0.01);
  let low = 0;
  let high = 255;
  for (let seen = 0, v = 0; v < 256; v++) {
    seen += histogram[v]!;
    if (seen > clip) { low = v; break; }
  }
  for (let seen = 0, v = 255; v >= 0; v--) {
    seen += histogram[v]!;
    if (seen > clip) { high = v; break; }
  }

  // Pass 2: remap, but only when there's a usable range to remap into.
  if (high - low > 10) {
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      lut[v] = Math.max(0, Math.min(255, Math.round(((v - low) / (high - low)) * 255)));
    }
    for (let i = 0; i < px.length; i += 4) {
      const mapped = lut[px[i]!]!;
      px[i] = mapped;
      px[i + 1] = mapped;
      px[i + 2] = mapped;
    }
  }

  ctx.putImageData(image, 0, 0);

  return new Promise<Blob>((resolve) => {
    canvas.toBlob((out) => resolve(out ?? blob), 'image/png');
  });
}

/**
 * Re-encode a captured photo for storage.
 *
 * Phone cameras produce 3-6 MB JPEGs; at ~1600px and quality 0.75 a receipt
 * stays perfectly legible at a fraction of the size, which matters because the
 * browser's storage quota is finite and shared.
 */
export async function compressForStorage(
  blob: Blob,
  maxEdge = 1600,
  quality = 0.75,
): Promise<{ blob: Blob; mimeType: string }> {
  try {
    const img = await loadImage(blob);
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && blob.size < 500_000) {
      return { blob, mimeType: blob.type || 'image/jpeg' };
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return { blob, mimeType: blob.type || 'image/jpeg' };

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', quality);
    });
    return out ? { blob: out, mimeType: 'image/jpeg' } : { blob, mimeType: blob.type || 'image/jpeg' };
  } catch {
    // If anything about decoding fails, keep the original rather than losing it.
    return { blob, mimeType: blob.type || 'image/jpeg' };
  }
}

export interface OcrResult {
  text: string;
  confidence: number;
  parsed: ParsedReceipt;
}

export async function recognizeReceipt(
  blob: Blob,
  onProgress?: (p: OcrProgress) => void,
): Promise<OcrResult> {
  const worker = await getWorker(onProgress);
  const prepared = await preprocessForOcr(blob);
  const { data } = await worker.recognize(prepared);

  return {
    text: data.text,
    confidence: data.confidence,
    parsed: parseReceiptText(data.text),
  };
}
