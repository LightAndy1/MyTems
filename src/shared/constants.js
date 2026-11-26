export const STORAGE_KEYS = {
  SETTINGS: 'mytems_settings',
  LECTURES: 'mytems_lectures',
  ACTIVE_SESSION: 'mytems_active_session',
};

export const OPENROUTER_URLS = {
  TRANSCRIPTIONS: 'https://openrouter.ai/api/v1/audio/transcriptions',
  CHAT: 'https://openrouter.ai/api/v1/chat/completions',
  MODELS: 'https://openrouter.ai/api/v1/models',
};

export const AI_VENDORS = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPlaceholder: 'sk-or-v1-...',
    requiresKey: true,
    defaultSttModel: 'openai/whisper-large-v3',
    defaultLlmModel: 'google/gemini-2.5-flash',
    defaultJevModel: 'typesafe/jev-latest',
  },
  google: {
    id: 'google',
    label: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyPlaceholder: 'AIza...',
    requiresKey: true,
    defaultSttModel: 'gemini-3.5-flash',
    defaultLlmModel: 'gemini-3.5-flash',
    defaultJevModel: 'gemini-3.5-flash-lite',
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyPlaceholder: 'nvapi-...',
    requiresKey: true,
    defaultSttModel: 'nvidia/nemotron-transcribe',
    defaultLlmModel: 'meta/llama-3.2-90b-vision-instruct',
    defaultJevModel: 'meta/llama-3.1-8b-instruct',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyPlaceholder: 'gsk_...',
    requiresKey: true,
    defaultSttModel: 'whisper-large-v3-turbo',
    defaultLlmModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    defaultJevModel: 'llama-3.1-8b-instant',
  },
  custom: {
    id: 'custom',
    label: 'Basement Node (Local / Custom)',
    baseUrl: 'http://localhost:11434/v1',
    keyPlaceholder: 'Optional bearer token',
    requiresKey: false,
    defaultSttModel: 'whisper-1',
    defaultLlmModel: 'qwen2.5vl:7b',
    defaultJevModel: 'qwen2.5vl:7b',
  },
};

export const AI_VENDOR_IDS = Object.keys(AI_VENDORS);

export const DEFAULT_VENDOR_KEYS = {
  openrouter: '',
  google: '',
  nvidia: '',
  groq: '',
  custom: '',
};

export const DEFAULT_SETTINGS = {
  aiEnabled: true,
  expertMode: false,
  providerMode: 'cloud',
  openrouterApiKey: '',
  vendorKeys: { ...DEFAULT_VENDOR_KEYS },
  sttVendor: 'openrouter',
  sttModel: 'openai/whisper-large-v3',
  llmVendor: 'openrouter',
  llmModel: 'google/gemini-2.5-flash',
  jevEnabled: false,
  jevVendor: 'openrouter',
  jevModel: 'typesafe/jev-latest',
  providerRouting: 'auto',
  preferredProviders: '',
  localSttUrl: 'http://localhost:8080/v1/audio/transcriptions',
  localSttModel: 'whisper-1',
  localLlmUrl: 'http://localhost:11434/v1/chat/completions',
  localLlmModel: 'qwen2.5vl:7b',
  defaultCourseHint: '',
  recordScreen: true,
  whiteboardMode: 'off',
  whiteboardMeetings: '',
  dropRelayUrl: 'https://ntfy.sh',
};

export const DROP_LAYERS = [
  { id: 'video', label: 'Video (video.webm)' },
  { id: 'audio', label: 'Audio Segments (audio/)' },
  { id: 'slides', label: 'Slides & Whiteboard (slides/)' },
  { id: 'transcript', label: 'Transcript (transcript.json)' },
  { id: 'notes', label: 'Notes & Exam Radar (notes.json)' },
];

export const HINT_PRESETS = [
  {
    id: 'ro-math-induction',
    label: 'RO Math (Inducție / Serii)',
    hint: 'Curs universitar de matematică în limba română: inducție matematică, verificare, presupunem P(k) adevărată, demonstrăm P(k+1), radical, factorial, divizibilitate, inegalitate.',
  },
];

export const NOTE_MODES = [
  { id: 'math', label: 'Math / Theory' },
  { id: 'code', label: 'Coding / CS' },
  { id: 'architecture', label: 'Architecture / Diagrams' },
  { id: 'meeting', label: 'Meeting / Sync' },
];

export function resolveNoteMode(mode) {
  return NOTE_MODES.some((m) => m.id === mode) ? mode : 'math';
}

export const WHITEBOARD_ORIGINS = [
  'https://teams.microsoft.com/*',
  'https://teams.cloud.microsoft/*',
  'https://whiteboard.office.com/*',
  'https://*.whiteboard.microsoft.com/*',
];

export const WHITEBOARD_CONFIG = {
  INTERVAL_MS: 5_000,
  SETTLE_IDLE_MS: 5_000,
  MAX_DIRTY_MS: 60_000,
  MIN_COOLDOWN_SEC: 10,
  MAX_CAPTURES: 240,
  MAX_LLM_SLIDES: 60,
  LLM_MAX_WIDTH: 1440,
  LLM_JPEG_QUALITY: 0.85,
  EXPORT_WIDTH: 1920,
  EXPORT_HEIGHT: 1080,
};

export const RECORDING_CONFIG = {
  VIDEO_BPS: 180_000,
  AUDIO_BPS: 16_000,
  MAX_WIDTH: 1920,
  MAX_HEIGHT: 1080,
  MAX_FPS: 8,
  TIMESLICE_MS: 5000,
  AUDIO_SEGMENT_MS: 600_000,
  AUDIO_OVERLAP_MS: 300,
};

export const SLIDE_CONFIG = {
  STEP_SEC: 4,
  DIFF_THRESHOLD: 0.04,
  MIN_COOLDOWN_SEC: 8,
  MAX_SLIDES: 50,
  JPEG_QUALITY: 0.85,
  COMPARE_WIDTH: 160,
  COMPARE_HEIGHT: 90,
};
