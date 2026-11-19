import { copyFile, mkdir } from 'node:fs/promises'

const target = 'public/ocr'
await mkdir(target, { recursive: true })
const files = {
  'worker.min.js': 'tesseract.js/dist/worker.min.js',
  'tesseract-core-lstm.wasm.js': 'tesseract.js-core/tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'eng.traineddata.gz': '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
  'LICENSE-tesseract.txt': 'tesseract.js/LICENSE.md',
  'LICENSE-tesseract-core.txt': 'tesseract.js-core/LICENSE',
  'libheif.mjs': 'libheif-js/libheif-wasm/libheif-bundle.mjs',
  'LICENSE-libheif.txt': 'libheif-js/libheif-wasm/LICENSE',
}
await Promise.all(Object.entries(files).map(([name, source]) => copyFile(`node_modules/${source}`, `${target}/${name}`)))
