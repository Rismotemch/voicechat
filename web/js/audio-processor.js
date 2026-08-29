class NeuralAudioProcessor {
    constructor() {
        this.isInitialized = false;
        this.vadThreshold = 0.01;
        this.denoiser = null;
        this.initPromise = null;
    }

    async init() {
        if (this.isInitialized) return true;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._loadRNNoise();
        return this.initPromise;
    }

    async _loadRNNoise() {
        try {
            // Загружаем RNNoise как ES модуль через import()
            const module = await import('https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm@0.2.1/dist/rnnoise-wasm.js');

            let rnnoiseModule = module.default || module;

            // Создаём экземпляр RNNoise
            let rnnoise;
            if (typeof rnnoiseModule === 'function') {
                rnnoise = await rnnoiseModule();
            } else if (rnnoiseModule.create) {
                rnnoise = await rnnoiseModule.create();
            } else {
                rnnoise = rnnoiseModule;
            }

            // Создаём денойзер
            if (rnnoise && typeof rnnoise.createDenoiser === 'function') {
                this.denoiser = await rnnoise.createDenoiser();
            } else if (rnnoise && rnnoise.Denoiser) {
                this.denoiser = new rnnoise.Denoiser();
            } else {
                throw new Error('Denoiser not found');
            }

            this.isInitialized = true;
            console.log('✅ RNNoise initialized successfully');
            return true;
        } catch (error) {
            console.warn('⚠️ RNNoise initialization failed:', error.message);
            this.isInitialized = false;
            this.denoiser = null;
            return false;
        }
    }

    processAudio(float32Array) {
        if (!this.denoiser || !this.isInitialized) {
            return float32Array;
        }

        try {
            // Конвертируем Float32 в Int16 (RNNoise работает с PCM 16-bit)
            const pcm16 = new Int16Array(float32Array.length);
            for (let i = 0; i < float32Array.length; i++) {
                const s = Math.max(-1, Math.min(1, float32Array[i]));
                pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            // RNNoise обрабатывает кадры по 480 сэмплов
            const frameSize = 480;
            const output = new Float32Array(float32Array.length);

            for (let i = 0; i < pcm16.length; i += frameSize) {
                const chunk = pcm16.slice(i, i + frameSize);

                if (chunk.length === frameSize) {
                    let denoised = null;

                    try {
                        if (typeof this.denoiser.process === 'function') {
                            denoised = this.denoiser.process(chunk);
                        } else if (typeof this.denoiser === 'function') {
                            denoised = this.denoiser(chunk);
                        }
                    } catch (e) {
                        // Ошибка обработки — используем оригинал
                        denoised = chunk;
                    }

                    if (denoised) {
                        for (let j = 0; j < chunk.length; j++) {
                            output[i + j] = denoised[j] / 32768.0;
                        }
                    } else {
                        for (let j = 0; j < chunk.length; j++) {
                            output[i + j] = chunk[j] / 32768.0;
                        }
                    }
                } else {
                    // Неполный кадр — копируем как есть
                    for (let j = 0; j < chunk.length; j++) {
                        output[i + j] = chunk[j] / 32768.0;
                    }
                }
            }

            return output;
        } catch (e) {
            console.warn('RNNoise processing failed:', e);
            return float32Array;
        }
    }

    detectVoice(float32Array) {
        let sum = 0;
        for (let i = 0; i < float32Array.length; i++) {
            sum += float32Array[i] * float32Array[i];
        }
        const rms = Math.sqrt(sum / float32Array.length);
        return rms > this.vadThreshold;
    }
}

window.neuralAudioProcessor = new NeuralAudioProcessor();