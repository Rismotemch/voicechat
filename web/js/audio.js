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
        if (this.micStream) this.stopMicrophone();

        const constraints = {
            audio: {
                echoCancellation: enableEchoCancellation,
                noiseSuppression: true, // Включает нативное шумоподавление (убирает кулеры и фон)
                autoGainControl: false,  // AGC контролирует наш Go-сервер
                channelCount: 1,
                sampleRate: 48000
            },
            video: false
        };

        try {
            this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
            this.micSourceNode = this.audioCtx.createMediaStreamSource(this.micStream);

            this.selfAnalyser = this.audioCtx.createAnalyser();
            this.selfAnalyser.fftSize = 64;
            this.selfAnalyser.smoothingTimeConstant = 0.3;
            this.micSourceNode.connect(this.selfAnalyser);

            this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-capture-processor');
            this.workletNode.port.onmessage = (event) => {
                if (event.data && this.onAudioFrame && !this.isMuted) {
                    this.onAudioFrame(event.data);
                }
            };

            this.micSourceNode.connect(this.workletNode);
            this.startLocalVAD();
        } catch (err) {
            console.error('[AudioManager] getUserMedia error:', err);
            throw err;
        }
    }

    playAudioPacket(arrayBuffer) {
        if (!this.audioCtx || this.audioCtx.state === 'suspended') return;

        const dataView = new DataView(arrayBuffer);
        if (dataView.byteLength < 4) return;

        const userIdLen = dataView.getUint16(0, false);
        const userIdOffset = 2;
        if (dataView.byteLength < userIdOffset + userIdLen) return;

        const userIdBytes = new Uint8Array(arrayBuffer, userIdOffset, userIdLen);
        const userId = this.textDecoder.decode(userIdBytes);

        let pcmOffset = userIdOffset + userIdLen;
        if (userIdLen % 2 !== 0) pcmOffset += 1;

        const pcmBytesLen = dataView.byteLength - pcmOffset;
        const sampleCount = pcmBytesLen / 2;
        if (sampleCount <= 0) return;

        const floatSamples = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            const int16 = dataView.getInt16(pcmOffset + i * 2, true);
            floatSamples[i] = int16 < 0 ? int16 / 32768.0 : int16 / 32767.0;
        }

        const audioBuffer = this.audioCtx.createBuffer(1, sampleCount, this.sampleRate);
        audioBuffer.copyToChannel(floatSamples, 0);

        const pipeline = this.getParticipantPipeline(userId);
        const sourceNode = this.audioCtx.createBufferSource();
        sourceNode.buffer = audioBuffer;
        sourceNode.connect(pipeline.gainNode);

        const now = this.audioCtx.currentTime;
        const startupLead = 0.060; // 60 мс подушка безопасности при старте фразы
        const maxLead = 0.140;     // Сброс только при накоплении более 140 мс

        // Если это первый пакет после паузы или очередь отстала от реального времени
        if (pipeline.nextPlayTime < now) {
            pipeline.nextPlayTime = now + startupLead;
        } else if (pipeline.nextPlayTime > now + maxLead) {
            pipeline.nextPlayTime = now + startupLead;
        }

        sourceNode.start(pipeline.nextPlayTime);
        pipeline.nextPlayTime += audioBuffer.duration;

        this.triggerParticipantVAD(userId, pipeline);
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
     * Прямое управление передачей голоса для Push-to-Talk
     */
    setPttActive(isActive) {
        if (!this.workletNode) return;
        // Если PTT не зажат — глушим передачу в ворклете, иначе открываем
        const shouldMute = !isActive;
        this.workletNode.port.postMessage({ isMuted: shouldMute });

        if (this.onSpeakingStateChange) {
            this.onSpeakingStateChange('self', isActive);
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
        if (!this.audioCtx || this.audioCtx.state === 'suspended') return;

        const dataView = new DataView(arrayBuffer);
        if (dataView.byteLength < 4) return;

        const userIdLen = dataView.getUint16(0, false);
        const userIdOffset = 2;
        if (dataView.byteLength < userIdOffset + userIdLen) return;

        const userIdBytes = new Uint8Array(arrayBuffer, userIdOffset, userIdLen);
        const userId = this.textDecoder.decode(userIdBytes);

        let pcmOffset = userIdOffset + userIdLen;
        if (userIdLen % 2 !== 0) pcmOffset += 1;

        const pcmBytesLen = dataView.byteLength - pcmOffset;
        const sampleCount = pcmBytesLen / 2;
        if (sampleCount <= 0) return;

        const floatSamples = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            const int16 = dataView.getInt16(pcmOffset + i * 2, true);
            floatSamples[i] = int16 < 0 ? int16 / 32768.0 : int16 / 32767.0;
        }

        const audioBuffer = this.audioCtx.createBuffer(1, sampleCount, this.sampleRate);
        audioBuffer.copyToChannel(floatSamples, 0);

        const pipeline = this.getParticipantPipeline(userId);
        const sourceNode = this.audioCtx.createBufferSource();
        sourceNode.buffer = audioBuffer;
        sourceNode.connect(pipeline.gainNode);

        // Стабильный адаптивный джиттер-буфер 45-50мс (без разрывов и щелчков)
        const now = this.audioCtx.currentTime;
        const targetLead = 0.045; // 45 мс буфер безопасности
        const maxLead = 0.120;    // Лимит накопления до сброса (120 мс)

        if (pipeline.nextPlayTime < now) {
            pipeline.nextPlayTime = now + targetLead;
        } else if (pipeline.nextPlayTime > now + maxLead) {
            pipeline.nextPlayTime = now + targetLead;
        }

        sourceNode.start(pipeline.nextPlayTime);
        pipeline.nextPlayTime += audioBuffer.duration;

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