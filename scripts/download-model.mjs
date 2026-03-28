import { KokoroTTS } from 'kokoro-js';
console.log('[build] Downloading Kokoro ONNX model (~82 MB)...');
await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8' });
console.log('[build] Model cached.');
process.exit(0);
