/**
 * Copy the OCR runtime out of node_modules and into `public/tesseract/`.
 *
 * Tesseract.js defaults to pulling its worker script, its WebAssembly core and
 * its language model from a public CDN at runtime. For this app that default is
 * wrong twice over: it means the first scan needs the network in an app that is
 * otherwise fully offline, and it announces to a third party that someone is
 * scanning a receipt. Serving all three from our own origin fixes both.
 *
 * The files are large and reproducible from the lockfile, so they are copied at
 * build time and git-ignored rather than committed.
 *
 * Run automatically by the `predev` and `prebuild` npm scripts.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modules = join(root, 'node_modules');
const outDir = join(root, 'public', 'tesseract');

/**
 * The LSTM-only core is the one to ship: it drops the legacy Tesseract engine,
 * which this app never asks for, and is ~600 KB smaller as a result. Both the
 * SIMD and non-SIMD builds are needed — tesseract.js picks between them at
 * runtime based on what the browser supports.
 */
const FILES = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  // The integerized "best" model: noticeably better on faded thermal receipts
  // than the fast model, at a quarter the size of full "best".
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata.gz'],
];

function formatBytes(bytes) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(0)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let total = 0;
const missing = [];

for (const [from, to] of FILES) {
  const source = join(modules, from);
  const target = join(outDir, to);

  try {
    const info = await stat(source);
    await mkdir(dirname(target), { recursive: true });
    await pipeline(createReadStream(source), createWriteStream(target));
    total += info.size;
    console.log(`  ${to.padEnd(38)} ${formatBytes(info.size)}`);
  } catch (error) {
    if (error.code === 'ENOENT') missing.push(from);
    else throw error;
  }
}

if (missing.length > 0) {
  console.error(
    `\nMissing OCR assets in node_modules:\n${missing.map((m) => `  - ${m}`).join('\n')}\n` +
      'Run `npm install` first. Receipt scanning will not work without these.',
  );
  process.exit(1);
}

console.log(`OCR assets vendored to public/tesseract (${formatBytes(total)} total).`);
