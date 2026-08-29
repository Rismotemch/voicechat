class NeuralAudioProcessor {
    constructor() {
        this.rnnoise = null;
        this.isInitialized = false;
        this.vadThreshold = 0.01;
        this.denoiser = null;
        this.initPromise = null;
    }

    async init() {
        if (this.isInitialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._loadRNNoise();
        return this.initPromise;
    }

    async _loadRNNoise() {
        try {
            // Загружаем RNNoise WASM с CDN
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm@latest/dist/rnnoise.js';
            document.head.appendChild(script);

            await new Promise((resolve, reject) => {
                script.onload = resolve;
                script.onerror = () => reject(new Error('Failed to load RNNoise script'));
                setTimeout(() => reject(new Error('RNNoise script timeout')), 10000);
            });

            if (window.RNNoise) {
                this.rnnoise = window.RNNoise;
            } else if (window.rnnoise) {
                this.rnnoise = window.rnnoise;
            } else {
                throw new Error('RNNoise not found in window');
            }

            // Создаём денойзер
            if (typeof this.rnnoise.createDenoiser === 'function') {
                this.denoiser = await this.rnnoise.createDenoiser();
            } else if (typeof this.rnnoise === 'function') {
                this.denoiser = new this.rnnoise();
            }

            this.isInitialized = true;
            console.log('RNNoise initialized successfully');
        } catch (error) {
            console.warn('RNNoise initialization failed, using browser noise suppression:', error.message);
            this.isInitialized = false;
            this.denoiser = null;
        }

        return this.isInitialized;
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
            const frameSize = 480;
            const output = new Float32Array(float32Array.length);

            for (let i = 0; i < pcm16.length; i += frameSize) {
                const chunk = pcm16.slice(i, i + frameSize);
                if (chunk.length === frameSize) {
                    let denoised = null;

                    if (typeof this.denoiser.process === 'function') {
                        denoised = this.denoiser.process(chunk);
                    } else if (typeof this.denoiser === 'function') {
                        denoised = this.denoiser(chunk);
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