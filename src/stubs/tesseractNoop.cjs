/**
 * Tesseract.js no-op stub.
 *
 * officeparser eagerly requires `tesseract.js` at module load (ocrUtils.js →
 * tesseract.js → createWorker → ./worker/node → worker_threads), even though
 * OCR is opt-in via `ocr: true`. In the Obsidian Electron renderer, that
 * eager chain throws mid-bundle-init. Because esbuild's `__commonJS` caches
 * a half-initialised exports object after the first throw, subsequent
 * `await import('officeparser')` calls return a defined module where
 * `parseOffice` is `undefined` — surfacing as the user-visible bug
 * "n.parseOffice is not a function".
 *
 * We never enable OCR (officeparser default is `ocr: false` and we never
 * override). Replacing `tesseract.js` with this stub via esbuild's `alias`
 * lets officeparser load cleanly; the stub functions only run if OCR is
 * ever turned on by accident, in which case they return empty results
 * rather than throwing — failure mode is "no OCR text" not "minutes crash".
 *
 * Mirror tesseract.js's public surface (createWorker / createScheduler /
 * setLogging / languages / OEM / PSM / recognize / detect) so any other
 * consumer that ever lands in this codebase doesn't blow up at import.
 */

const noopWorker = {
    recognize: async () => ({ data: { text: '', lines: [], words: [], symbols: [], confidence: 0 } }),
    terminate: async () => {},
    reinitialize: async () => {},
    loadLanguage: async () => {},
    initialize: async () => {},
    setParameters: async () => {},
    getPDF: async () => ({ data: new Uint8Array(0) }),
    detect: async () => ({ data: { script: 'Latin', script_confidence: 0 } }),
};

const noopScheduler = {
    addWorker: () => 'stub-worker-id',
    addJob: async () => ({ data: { text: '' } }),
    terminate: async () => {},
    getQueueLen: () => 0,
    getNumWorkers: () => 0,
};

module.exports.createWorker = async () => noopWorker;
module.exports.createScheduler = () => noopScheduler;
module.exports.setLogging = () => {};
module.exports.recognize = async () => ({ data: { text: '' } });
module.exports.detect = async () => ({ data: { script: 'Latin' } });
module.exports.languages = {};
module.exports.OEM = { TESSERACT_ONLY: 0, LSTM_ONLY: 1, TESSERACT_LSTM_COMBINED: 2, DEFAULT: 3 };
module.exports.PSM = {
    OSD_ONLY: '0', AUTO_OSD: '1', AUTO_ONLY: '2', AUTO: '3',
    SINGLE_COLUMN: '4', SINGLE_BLOCK_VERT_TEXT: '5', SINGLE_BLOCK: '6',
    SINGLE_LINE: '7', SINGLE_WORD: '8', CIRCLE_WORD: '9',
    SINGLE_CHAR: '10', SPARSE_TEXT: '11', SPARSE_TEXT_OSD: '12', RAW_LINE: '13',
};
