/**
 * SpeechRecognitionService.js
 * In-browser speech-to-text wrapper optimized for Magic: The Gathering tabletop play.
 * Supports dual-language affinity: Spanish (Default) and English.
 */

export class SpeechRecognitionService {
  /**
   * @param {Object} options
   * @param {'es-ES'|'en-US'} [options.defaultLanguage='es-ES'] - Initial language ('es-ES' by default)
   * @param {boolean} [options.continuous=false] - Keep listening across pauses (false for turn command bursts)
   * @param {boolean} [options.interimResults=true] - Stream live text while speaking
   * @param {Function} [options.onInterim] - Callback for live speech: (text) => void
   * @param {Function} [options.onFinal] - Callback for completed speech: (text) => void
   * @param {Function} [options.onError] - Callback for errors: (error) => void
   * @param {Function} [options.onStateChange] - Callback when listening state changes: (isListening, lang) => void
   */
  constructor(options = {}) {
    const SpeechRecognition = typeof window !== 'undefined' 
      ? (window.SpeechRecognition || window.webkitSpeechRecognition) 
      : null;

    this.isSupported = Boolean(SpeechRecognition);
    this.recognition = this.isSupported ? new SpeechRecognition() : null;

    // Supported language affinity: Spanish (default) & English
    this.supportedLanguages = {
      es: 'es-ES',
      en: 'en-US'
    };

    this.currentLanguage = options.defaultLanguage || this.supportedLanguages.es;
    this.isListening = false;

    // Callbacks
    this.onInterim = options.onInterim || (() => {});
    this.onFinal = options.onFinal || (() => {});
    this.onError = options.onError || (() => {});
    this.onStateChange = options.onStateChange || (() => {});

    if (this.recognition) {
      this._configureRecognition(options);
    }
  }

  _configureRecognition(options) {
    this.recognition.continuous = options.continuous ?? false;
    this.recognition.interimResults = options.interimResults ?? true;
    this.recognition.maxAlternatives = 1;
    this.recognition.lang = this.currentLanguage;

    this.recognition.onstart = () => {
      this.isListening = true;
      this.onStateChange(true, this.currentLanguage);
    };

    this.recognition.onend = () => {
      this.isListening = false;
      this.onStateChange(false, this.currentLanguage);
    };

    this.recognition.onerror = (event) => {
      this.isListening = false;
      this.onStateChange(false, this.currentLanguage);
      this.onError(event.error);
    };

    this.recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const item = event.results[i];
        if (item.isFinal) {
          finalTranscript += item[0].transcript;
        } else {
          interimTranscript += item[0].transcript;
        }
      }

      if (interimTranscript) {
        this.onInterim(interimTranscript);
      }
      if (finalTranscript) {
        this.onFinal(finalTranscript.trim());
      }
    };
  }

  /**
   * Set language explicitly ('es' or 'en', or full BCP-47 tags like 'es-ES' / 'en-US')
   * @param {'es'|'en'|'es-ES'|'en-US'} langCode
   */
  setLanguage(langCode) {
    const normalized = (langCode || '').toLowerCase();
    if (normalized.startsWith('en')) {
      this.currentLanguage = this.supportedLanguages.en;
    } else {
      // Default to Spanish
      this.currentLanguage = this.supportedLanguages.es;
    }

    if (this.recognition) {
      this.recognition.lang = this.currentLanguage;
    }
    this.onStateChange(this.isListening, this.currentLanguage);
  }

  /**
   * Toggle between Spanish and English
   * @returns {'es-ES'|'en-US'} The newly active language
   */
  toggleLanguage() {
    const nextLang = this.currentLanguage === this.supportedLanguages.es 
      ? this.supportedLanguages.en 
      : this.supportedLanguages.es;
    this.setLanguage(nextLang);
    return this.currentLanguage;
  }

  /**
   * Start listening
   */
  start() {
    if (!this.isSupported) {
      this.onError('SPEECH_RECOGNITION_NOT_SUPPORTED');
      return;
    }
    if (this.isListening) return;

    try {
      this.recognition.lang = this.currentLanguage;
      this.recognition.start();
    } catch (err) {
      this.onError(err.message);
    }
  }

  /**
   * Stop listening
   */
  stop() {
    if (!this.isSupported || !this.isListening) return;
    try {
      this.recognition.stop();
    } catch (err) {
      this.onError(err.message);
    }
  }
}
