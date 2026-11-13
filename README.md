# NETRA - Visual Navigation Assistant

NETRA is an assistive vision and spatial guidance platform designed for blind and visually impaired users. It processes live camera frames, micro-navigation precision targeting, persistent spatial memory tagging, and voice inquiries.

## Architecture

- **Visual Reasoning & Navigation**: Powered by **Groq** (`llama-4-scout-17b-16e-instruct` or specified model)
- **Speech-to-Text (STT)**: Powered by **Gnani Vachana STT v3** (`prisma-v3.0` with 16 kHz mono 16-bit PCM WAV)
- **Text-to-Speech (TTS)**: Powered by **Gnani Vachana TTS** (`timbre-v2.5`), with zero-delay Web Speech API fallback
- **Spatial Audio Engine**: Directional binaural panning, sonar distance pulses, and geiger micro-tones

---

## Required Secrets & Environment Variables

Add these secrets in your host's **Environment Variables** (e.g., Render Dashboard or AI Studio **Settings > Secrets**) or in your local `.env` file on the server:

### Required Credentials
```env
# Groq API Key (Used for all vision, navigation, and planning model calls)
GROQ_KEY="your_groq_api_key"

# Gnani Vachana API Key (Used for STT transcription and optional TTS synthesis)
GNANI_KEY="your_gnani_api_key"
```

### Optional Settings (Defaults applied if unset)
```env
# Vision & Reasoning Model on Groq
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct

# Gnani STT Language Code (indic-auto, en-IN, hi-IN, etc.)
GNANI_STT_LANGUAGE=indic-auto

# Gnani TTS Voice Name
GNANI_TTS_VOICE=Nalini

# Gnani TTS Language Code
GNANI_TTS_LANGUAGE=en-IN

# Gnani TTS Synthesis Mode (inquiry | all | off)
# - "inquiry": Synthesizes voice inquiry responses & task guidance (default)
# - "all": Synthesizes all messages including frame navigation
# - "off": Uses browser client speech synthesis only
GNANI_TTS_MODE=inquiry

# Optional path for persistent memory JSON (useful with a mounted Render Persistent Disk)
# MEMORY_FILE_PATH=/data/long_term_memory.json

# Express Server Port (automatically assigned by Render)
PORT=3000
```

---

## URL Parameters & Overrides

- `?scan=<ms>`: Override default frame scan interval (default: `15000` ms).
- `?micro=<ms>`: Override micro-navigation loop interval (default: `2000` ms).
- First frame is sent immediately upon session start.

---

## Testing & Validation

Run unit tests verifying Groq rate limiting, session management, and Gnani STT/TTS mocks:
```bash
npm run test
```

Run TypeScript verification:
```bash
npm run lint
```

Build production client:
```bash
npm run build
```
