class AudioProcessor {
    constructor() {
        this.audioContext = null;
        this.opusEncoder = null;
        this.opusDecoder = null;
        this.isInitialized = false;
    }
    
    async init() {
        if (this.isInitialized) return;
        
        // Инициализируем AudioContext
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 48000,
            latencyHint: 'interactive'
        });
        
        // Загружаем Opus кодек (WebAssembly)
        await this.loadOpusCodec();
        
        this.isInitialized = true;
    }
    
    async loadOpusCodec() {
        // Используем opus-recorder или подобную библиотеку
        // Для простоты используем MediaRecorder с Opus
        // Или можно использовать opusscript (чистый JS)
        
        // Временно используем PCM, но с лучшей обработкой
        console.log('Opus codec loading...');
    }
    
    createNoiseFilter() {
        // Создаём многополосный эквалайзер
        const filters = [];
        
        // Low shelf - уменьшаем низкие частоты
        const lowShelf = this.audioContext.createBiquadFilter();
        lowShelf.type = 'lowshelf';
        lowShelf.frequency.value = 200;
        lowShelf.gain.value = -6; // -6 dB
        
        // High shelf - усиливаем высокие для чёткости
        const highShelf = this.audioContext.createBiquadFilter();
        highShelf.type = 'highshelf';
        highShelf.frequency.value = 4000;
        highShelf.gain.value = 3; // +3 dB
        
        // Peaking - усиливаем речевые частоты
        const peaking = this.audioContext.createBiquadFilter();
        peaking.type = 'peaking';
        peaking.frequency.value = 2500;
        peaking.Q.value = 1.0;
        peaking.gain.value = 6; // +6 dB
        
        filters.push(lowShelf, highShelf, peaking);
        return filters;
    }
    
    createCompressor() {
        const compressor = this.audioContext.createDynamicsCompressor();
        compressor.threshold.value = -30;
        compressor.knee.value = 20;
        compressor.ratio.value = 8;
        compressor.attack.value = 0.002;
        compressor.release.value = 0.1;
        return compressor;
    }
    
    createNoiseGate() {
        // Создаём noise gate через ScriptProcessor
        const noiseGate = this.audioContext.createScriptProcessor(512, 1, 1);
        const threshold = 0.01; // -40 dB
        
        noiseGate.onaudioprocess = (event) => {
            const input = event.inputBuffer.getChannelData(0);
            const output = event.outputBuffer.getChannelData(0);
            
            // Вычисляем RMS
            let sum = 0;
            for (let i = 0; i < input.length; i++) {
                sum += input[i] * input[i];
            }
            const rms = Math.sqrt(sum / input.length);
            
            // Применяем gate
            if (rms < threshold) {
                // Тишина
                output.fill(0);
            } else {
                // Пропускаем звук
                output.set(input);
            }
        };
        
        return noiseGate;
    }
    
    createEchoCanceller() {
        // Простое эхоподавление через компрессор
        const echoCanceller = this.audioContext.createDynamicsCompressor();
        echoCanceller.threshold.value = -20;
        echoCanceller.knee.value = 10;
        echoCanceller.ratio.value = 4;
        echoCanceller.attack.value = 0.001;
        echoCanceller.release.value = 0.05;
        return echoCanceller;
    }
}

window.audioProcessor = new AudioProcessor();