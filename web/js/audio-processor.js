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
            const module = await import('https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm@0.2.1/dist/rnnoise-sync.js');

            let RNNoiseClass = module.default || module.RNNoise;

            if (!RNNoiseClass) {
                throw new Error('RNNoise class not found');
            }

            this.denoiser = new RNNoiseClass();

            // Ждём готовности WASM
            if (this.denoiser.ready) {
                await this.denoiser.ready;
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
            const frameSize = 480;
            const output = new Float32Array(float32Array.length);

            for (let i = 0; i < float32Array.length; i += frameSize) {
                const chunk = float32Array.slice(i, i + frameSize);

                if (chunk.length === frameSize) {
                    let denoised = null;

                    try {
                        // Пробуем разные методы
                        if (typeof this.denoiser.process === 'function') {
                            denoised = this.denoiser.process(chunk);
                        } else if (typeof this.denoiser._rnnoise_process_frame === 'function') {
                            // Используем WASM функцию напрямую
                            denoised = this._processWithWASM(chunk);
                        } else if (typeof this.denoiser.filter === 'function') {
                            denoised = this.denoiser.filter(chunk);
                        }
                    } catch (e) {
                        denoised = chunk;
                    }

                    if (denoised) {
                        for (let j = 0; j < chunk.length; j++) {
                            output[i + j] = denoised[j];
                        }
                    } else {
                        for (let j = 0; j < chunk.length; j++) {
                            output[i + j] = chunk[j];
                        }
                    }
                } else {
                    // Неполный кадр — копируем как есть
                    for (let j = 0; j < chunk.length; j++) {
                        output[i + j] = chunk[j];
                    }
                }
            }

            return output;
        } catch (e) {
            console.warn('RNNoise processing failed:', e);
            return float32Array;
        }
    }

    _processWithWASM(float32Chunk) {
        // Конвертируем Float32 в Int16
        const pcm16 = new Int16Array(480);
        for (let i = 0; i < 480; i++) {
            const s = Math.max(-1, Math.min(1, float32Chunk[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Выделяем память в WASM
        const ptr = this.denoiser._malloc(480 * 2);
        this.denoiser.HEAP16.set(pcm16, ptr / 2);

        // Обрабатываем
        this.denoiser._rnnoise_process_frame(ptr, ptr);

        // Получаем результат
        const result = new Float32Array(480);
        for (let i = 0; i < 480; i++) {
            result[i] = this.denoiser.HEAP16[ptr / 2 + i] / 32768.0;
        }

        // Освобождаем память
        this.denoiser._free(ptr);

        return result;
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