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
            const module = await import('https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm@0.2.1/dist/rnnoise-sync.js');
            
            let RNNoiseClass;
            
            // Проверяем разные варианты экспорта
            if (module.default) {
                RNNoiseClass = module.default;
            } else if (module.RNNoise) {
                RNNoiseClass = module.RNNoise;
            } else {
                // Ищем в самом модуле
                for (const key in module) {
                    if (typeof module[key] === 'function' || typeof module[key] === 'object') {
                        RNNoiseClass = module[key];
                        break;
                    }
                }
            }
            
            if (!RNNoiseClass) {
                throw new Error('RNNoise class not found in module');
            }
            
            // Создаём экземпляр
            if (typeof RNNoiseClass === 'function') {
                this.denoiser = new RNNoiseClass();
            } else if (typeof RNNoiseClass === 'object') {
                this.denoiser = RNNoiseClass;
            } else {
                throw new Error('Cannot instantiate RNNoise');
            }
            
            // Проверяем, что денойзер имеет метод process или filter
            if (typeof this.denoiser.process !== 'function' && 
                typeof this.denoiser.filter !== 'function' &&
                typeof this.denoiser !== 'function') {
                console.warn('RNNoise denoiser methods:', Object.keys(this.denoiser));
            }
            
            this.isInitialized = true;
            console.log('✅ RNNoise initialized successfully');
            console.log('Denoiser methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(this.denoiser)));
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
            
            const frameSize = 480;
            const output = new Float32Array(float32Array.length);
            
            for (let i = 0; i < pcm16.length; i += frameSize) {
                const chunk = pcm16.slice(i, i + frameSize);
                
                if (chunk.length === frameSize) {
                    let denoised = null;
                    
                    try {
                        if (typeof this.denoiser.process === 'function') {
                            denoised = this.denoiser.process(chunk);
                        } else if (typeof this.denoiser.filter === 'function') {
                            denoised = this.denoiser.filter(chunk);
                        } else if (typeof this.denoiser === 'function') {
                            denoised = this.denoiser(chunk);
                        }
                    } catch (e) {
                        console.warn('RNNoise frame processing error:', e);
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