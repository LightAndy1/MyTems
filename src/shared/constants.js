export const STORAGE_KEYS = {
  SETTINGS: 'mytems_settings',
  LECTURES: 'mytems_lectures',
  ACTIVE_SESSION: 'mytems_active_session',
};

export const OPENROUTER_URLS = {
  TRANSCRIPTIONS: 'https://openrouter.ai/api/v1/audio/transcriptions',
  CHAT: 'https://openrouter.ai/api/v1/chat/completions',
};

export const DEFAULT_SETTINGS = {
  providerMode: 'cloud',
  openrouterApiKey: '',
  sttModel: 'openai/whisper-large-v3',
  llmModel: 'google/gemini-2.5-flash',
  providerRouting: 'auto',
  preferredProviders: '',
  localSttUrl: 'http://localhost:8080/v1/audio/transcriptions',
  localSttModel: 'whisper-1',
  localLlmUrl: 'http://localhost:11434/v1/chat/completions',
  localLlmModel: 'qwen2.5vl:7b',
  defaultCourseHint: '',
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
