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
            // Загружаем синхронную версию RNNoise (проще в использовании)
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm@0.2.1/dist/rnnoise-sync.js';
            document.head.appendChild(script);

            await new Promise((resolve, reject) => {
                script.onload = resolve;
                script.onerror = () => reject(new Error('Failed to load RNNoise script'));
                setTimeout(() => reject(new Error('RNNoise script timeout')), 10000);
            });

            // Проверяем, что RNNoise доступен
            if (!window.RNNoise) {
                throw new Error('RNNoise not found in window');
            }

            // Создаём денойзер
            this.denoiser = new window.RNNoise();

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
            // Конвертируем Float32 в Int16
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
                        // Пробуем разные методы обработки
                        if (typeof this.denoiser.process === 'function') {
                            denoised = this.denoiser.process(chunk);
                        } else if (typeof this.denoiser.filter === 'function') {
                            denoised = this.denoiser.filter(chunk);
                        } else if (typeof this.denoiser === 'function') {
                            denoised = this.denoiser(chunk);
                        }
                    } catch (e) {
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
}

window.neuralAudioProcessor = new NeuralAudioProcessor();