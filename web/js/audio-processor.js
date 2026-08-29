class NeuralAudioProcessor {
    constructor() {
        this.rnnoise = null;
        this.isInitialized = false;
        this.vadThreshold = 0.01;
        this.denoiser = null;
    }

    async init() {
        if (this.isInitialized) return;

        try {
            // Пробуем загрузить локально
            const module = await import('/js/rnnoise/index.js');

            if (module.default) {
                this.rnnoise = module.default;
            } else {
                this.rnnoise = module;
            }

            if (this.rnnoise && typeof this.rnnoise.createDenoiser === 'function') {
                this.denoiser = await this.rnnoise.createDenoiser();
            }

            this.isInitialized = true;
            console.log('RNNoise initialized successfully');
        } catch (error) {
            console.warn('RNNoise initialization failed, using browser noise suppression:', error);
            this.isInitialized = false;
            this.denoiser = null;
        }
    }

    processAudio(float32Array) {
        if (!this.denoiser || !this.isInitialized) {
            return float32Array;
        }

        try {
            // Конвертируем Float32 в Int16
            const pcm16 = new Int16Array(float32Array.length);
            for (let i = 0; i < float32Array.length; i++) {
                const s = Math.max(-1, Math.min(1, float32Array[i]));
                pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            // Обрабатываем через RNNoise
            const frameSize = 480; // 10ms при 48kHz
            const output = new Float32Array(float32Array.length);

            for (let i = 0; i < pcm16.length; i += frameSize) {
                const chunk = pcm16.slice(i, i + frameSize);
                if (chunk.length === frameSize) {
                    let denoised;

                    if (typeof this.denoiser.process === 'function') {
                        denoised = this.denoiser.process(chunk);
                    } else if (typeof this.denoiser === 'function') {
                        denoised = this.denoiser(chunk);
                    } else {
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

    setSpeakingCallback(callback) {
        this.speakingCallback = callback;
    }
}

window.neuralAudioProcessor = new NeuralAudioProcessor();