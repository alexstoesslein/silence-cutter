# Silence Cutter – GitHub Pages (100% Client-Side)

## Architektur
Alles läuft im Browser – kein Backend. Deployment via GitHub Pages (`/docs/`).

### Tech Stack
- **FFmpeg.wasm** – Silence Detection + Audio-Extraktion im Browser (WebAssembly)
- **Transformers.js** – Whisper ONNX Modell für Transkription im Browser
- **Claude API** – Direkt aus dem Browser (User gibt API Key ein → localStorage)
- **Vanilla JS + CSS** – Kein Framework, kein Build-Tool
- **CDN Libraries** – Via esm.sh / unpkg

### Dateistruktur
```
docs/
├── index.html
├── css/
│   └── style.css
└── js/
    ├── app.js          # Main Controller + State
    ├── silence.js      # FFmpeg.wasm Silence Detection
    ├── transcribe.js   # Transformers.js Whisper
    ├── evaluate.js     # Claude API Bewertung
    ├── export.js       # FCP XML + EDL Generator
    └── ui.js           # UI Rendering + Events
```

### Pipeline
1. File laden → `URL.createObjectURL()` + File API
2. FFmpeg.wasm laden → ~30MB WASM von CDN
3. Silence Detection → `silencedetect` Filter via ffmpeg.wasm
4. Audio-Segmente extrahieren → WAV-Segmente im WASM-Filesystem
5. Whisper Transkription → Transformers.js Whisper-Modell (~40MB)
6. Claude Bewertung → fetch() an api.anthropic.com
7. Export → FCP XML + EDL als Blob-Download
