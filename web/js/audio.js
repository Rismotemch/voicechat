/**
 * VoiceChat Core Audio Engine - web/js/audio.js
 * 
 * Responsibilities:
 * - Web Audio API pipeline & AudioContext lifecycle management
 * - Microphone capture via AudioWorklet (16kHz PCM downsampling)
 * - Binary PCM packet decoding & sample-accurate timeline playback
 * - Dynamic routing to 3D Spatial Audio Engine (Minecraft Mode) or Standard Stereo
 * - FFT Analysers for participant visualizers and VAD speaking detection
 */

class AudioManager {
    constructor() {
        this.audioCtx = null;
        this.masterGain = null;
        this.compressor = null;
        this.micStream = null;
        this.micSourceNode = null;
        this.workletNode = null;
        this.selfAnalyser = null;

        // userId -> { gainNode, analyser, nextPlayTime, speakingTimeout, isSpeaking }
        this.participants = new Map();

        this.sampleRate = 16000;
        this.isMuted = false;
        this.masterVolume = 1.0;
        this.isInitialized = false;

        // Коллбэки для интеграции с внешними скриптами
        this.onAudioFrame = null;          // fn(arrayBuffer)
        this.onSpeakingStateChange = null; // fn(userId, isSpeaking)

        this.textDecoder = new TextDecoder('utf-8');
    }

    /**
     * Инициализация AudioContext и загрузка AudioWorklet
     */
    async init() {
        if (this.isInitialized && this.audioCtx) {
            if (this.audioCtx.state === 'suspended') {
                await this.audioCtx.resume();
            }
            return;
        }

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioContextClass({ latencyHint: 'interactive' });

        // Динамический компрессор для предотвращения перегрузок и клиппинга
        this.compressor = this.audioCtx.createDynamicsCompressor();
        this.compressor.threshold.setValueAtTime(-12, this.audioCtx.currentTime);
        this.compressor.knee.setValueAtTime(30, this.audioCtx.currentTime);
        this.compressor.ratio.setValueAtTime(8, this.audioCtx.currentTime);
        this.compressor.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
        this.compressor.release.setValueAtTime(0.15, this.audioCtx.currentTime);

        // Мастер-громкость
        this.masterGain = this.audioCtx.createGain();
        this.masterGain.gain.setValueAtTime(this.masterVolume, this.audioCtx.currentTime);

        this.masterGain.connect(this.compressor);
        this.compressor.connect(this.audioCtx.destination);

        // Загрузка изолированного потока ресэмплинга AudioWorklet
        try {
            await this.audioCtx.audioWorklet.addModule('js/audio-processor.js');
        } catch (err) {
            console.error('[AudioManager] Failed to load AudioWorklet module:', err);
            throw err;
        }

        this.isInitialized = true;
    }

    /**
     * Запуск захвата микрофона
     */
    async startMicrophone(enableEchoCancellation = false) {
        await this.init();

        if (this.micStream) {
            this.stopMicrophone();
        }

        const constraints = {
            audio: {
                echoCancellation: enableEchoCancellation,
                noiseSuppression: false, // Noise-Gate и VAD работают на Go-сервере
                autoGainControl: false,  // AGC работает на сервере
                channelCount: 1,
                sampleRate: 48000
            },
            video: false
        };

        try {
            this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
            this.micSourceNode = this.audioCtx.createMediaStreamSource(this.micStream);

            // Инициализация собственного анализатора спектра для визуализатора
            this.selfAnalyser = this.audioCtx.createAnalyser();
            this.selfAnalyser.fftSize = 64;
            this.selfAnalyser.smoothingTimeConstant = 0.4;
            this.micSourceNode.connect(this.selfAnalyser);

            // Создание ноды AudioWorklet
            this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-capture-processor');
            this.workletNode.port.onmessage = (event) => {
                if (event.data && this.onAudioFrame && !this.isMuted) {
                    this.onAudioFrame(event.data);
                }
            };

            this.micSourceNode.connect(this.workletNode);

            // Запуск детекции речи локального микрофона
            this.startLocalVAD();
        } catch (err) {
            console.error('[AudioManager] getUserMedia error:', err);
            throw err;
        }
    }

    /**
     * Остановка микрофона
     */
    stopMicrophone() {
        if (this.micStream) {
            this.micStream.getTracks().forEach(track => track.stop());
            this.micStream = null;
        }
        if (this.micSourceNode) {
            try { this.micSourceNode.disconnect(); } catch (e) { }
            this.micSourceNode = null;
        }
        if (this.workletNode) {
            try { this.workletNode.disconnect(); } catch (e) { }
            this.workletNode = null;
        }
        if (this.selfAnalyser) {
            try { this.selfAnalyser.disconnect(); } catch (e) { }
            this.selfAnalyser = null;
        }
        if (this.onSpeakingStateChange) {
            this.onSpeakingStateChange('self', false);
        }
    }

    /**
     * Переключение режима Mute
     */
    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.workletNode) {
            this.workletNode.port.postMessage({ isMuted: this.isMuted });
        }
        if (this.onSpeakingStateChange && this.isMuted) {
            this.onSpeakingStateChange('self', false);
        }
        return this.isMuted;
    }

    /**
     * Получение или создание аудио-пайплайна для конкретного участника
     */
    getParticipantPipeline(userId) {
        let p = this.participants.get(userId);
        if (!p) {
            const gainNode = this.audioCtx.createGain();
            gainNode.gain.setValueAtTime(1.0, this.audioCtx.currentTime);

            const analyser = this.audioCtx.createAnalyser();
            analyser.fftSize = 64;
            gainNode.connect(analyser);

            p = {
                gainNode,
                analyser,
                nextPlayTime: 0,
                speakingTimeout: null,
                isSpeaking: false
            };
            this.participants.set(userId, p);

            // Если комната в режиме Minecraft — сразу строим 3D-цепь
            if (window.appState && window.appState.minecraftMode && window.appState.spatialEngine) {
                window.appState.spatialEngine.createSpatialChain(userId, gainNode, this.masterGain);
            } else {
                gainNode.connect(this.masterGain);
            }
        }
        return p;
    }

    /**
     * Декодирование бинарного пакета и бесшовное планирование воспроизведения
     * Формат пакета: [uint16 userIdLen][userId bytes][padding?][int16 PCM...]
     */
    playAudioPacket(arrayBuffer) {
        if (!this.audioCtx || this.audioCtx.state === 'suspended') {
            return;
        }

        const dataView = new DataView(arrayBuffer);
        if (dataView.byteLength < 4) return;

        // 1. Чтение UserID
        const userIdLen = dataView.getUint16(0, false); // BigEndian
        const userIdOffset = 2;
        if (dataView.byteLength < userIdOffset + userIdLen) return;

        const userIdBytes = new Uint8Array(arrayBuffer, userIdOffset, userIdLen);
        const userId = this.textDecoder.decode(userIdBytes);

        // Выравнивание PCM сэмплов
        let pcmOffset = userIdOffset + userIdLen;
        if (userIdLen % 2 !== 0) {
            pcmOffset += 1;
        }

        const pcmBytesLen = dataView.byteLength - pcmOffset;
        const sampleCount = pcmBytesLen / 2;
        if (sampleCount <= 0) return;

        // 2. Преобразование LittleEndian Int16 в Float32 (-1.0 ... 1.0)
        const floatSamples = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            const int16 = dataView.getInt16(pcmOffset + i * 2, true);
            floatSamples[i] = int16 < 0 ? int16 / 32768.0 : int16 / 32767.0;
        }

        // 3. Создание AudioBuffer с исходным квантом 16 кГц
        const audioBuffer = this.audioCtx.createBuffer(1, sampleCount, this.sampleRate);
        audioBuffer.copyToChannel(floatSamples, 0);

        const pipeline = this.getParticipantPipeline(userId);
        const sourceNode = this.audioCtx.createBufferSource();
        sourceNode.buffer = audioBuffer;
        sourceNode.connect(pipeline.gainNode);

        // 4. Sample-Accurate Timeline Scheduling (Борьба с джиттером и накоплением задержки)
        const now = this.audioCtx.currentTime;
        const safetyLeadTime = 0.025; // 25 мс буфер безопасности

        if (pipeline.nextPlayTime < now) {
            pipeline.nextPlayTime = now + safetyLeadTime;
        } else if (pipeline.nextPlayTime > now + 0.150) {
            // Если очередь превысила 150 мс из-за лага сети, сбрасываем timeline
            pipeline.nextPlayTime = now + safetyLeadTime;
        }

        sourceNode.start(pipeline.nextPlayTime);
        pipeline.nextPlayTime += audioBuffer.duration;

        // 5. Детекция активности голоса для анимации карточки в UI
        this.triggerParticipantVAD(userId, pipeline);
    }

    /**
     * VAD для удаленного участника
     */
    triggerParticipantVAD(userId, pipeline) {
        if (!pipeline.isSpeaking) {
            pipeline.isSpeaking = true;
            if (this.onSpeakingStateChange) {
                this.onSpeakingStateChange(userId, true);
            }
        }

        if (pipeline.speakingTimeout) {
            clearTimeout(pipeline.speakingTimeout);
        }

        // 250 мс удержание статуса речи
        pipeline.speakingTimeout = setTimeout(() => {
            pipeline.isSpeaking = false;
            if (this.onSpeakingStateChange) {
                this.onSpeakingStateChange(userId, false);
            }
        }, 250);
    }

    /**
     * VAD локального микрофона
     */
    startLocalVAD() {
        const checkVAD = () => {
            if (!this.micStream || !this.selfAnalyser) return;

            const freqData = new Uint8Array(this.selfAnalyser.frequencyBinCount);
            this.selfAnalyser.getByteFrequencyData(freqData);

            let sum = 0;
            for (let i = 0; i < freqData.length; i++) {
                sum += freqData[i];
            }
            const avg = sum / freqData.length;
            const isSpeaking = !this.isMuted && avg > 14;

            if (this.onSpeakingStateChange) {
                this.onSpeakingStateChange('self', isSpeaking);
            }

            setTimeout(checkVAD, 80);
        };
        checkVAD();
    }

    /**
     * Получение частотных данных для 60 FPS Canvas-визуализатора
     */
    getFrequencyData(userId) {
        if (userId === 'self') {
            if (!this.selfAnalyser) return null;
            const data = new Uint8Array(this.selfAnalyser.frequencyBinCount);
            this.selfAnalyser.getByteFrequencyData(data);
            return data;
        }

        const p = this.participants.get(userId);
        if (!p || !p.analyser) return null;

        const data = new Uint8Array(p.analyser.frequencyBinCount);
        p.analyser.getByteFrequencyData(data);
        return data;
    }

    /**
     * Установка индивидуальной громкости участника
     */
    setParticipantVolume(userId, volume) {
        const p = this.participants.get(userId);
        if (p && p.gainNode) {
            p.gainNode.gain.setValueAtTime(volume, this.audioCtx.currentTime);
        }
    }

    /**
     * Установка общей громкости
     */
    setMasterVolume(volume) {
        this.masterVolume = volume;
        if (this.masterGain && this.audioCtx) {
            this.masterGain.gain.setValueAtTime(volume, this.audioCtx.currentTime);
        }
    }

    /**
     * Удаление участника при выходе из комнаты
     */
    removeParticipant(userId) {
        const p = this.participants.get(userId);
        if (p) {
            if (p.speakingTimeout) clearTimeout(p.speakingTimeout);
            try { p.gainNode.disconnect(); } catch (e) { }
            try { p.analyser.disconnect(); } catch (e) { }
            this.participants.delete(userId);
        }
    }
}

// Экспортируем единственный экземпляр аудио-менеджера в глобальную область
window.audioManager = new AudioManager();