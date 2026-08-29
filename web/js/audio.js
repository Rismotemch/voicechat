/**
 * VoiceChat Audio Engine Controller
 * File: web/js/audio.js
 * 
 * Provides unified management of Web Audio API, AudioWorklets,
 * microphone lifecycle, per-speaker routing, independent jitter buffers,
 * and AnalyserNode spectrum/waveform data for voice visualization.
 */

class AudioManager {
    /**
     * @param {Object} options
     * @param {number} [options.sampleRate=16000] - Частота дискретизации (16 кГц)
     * @param {number} [options.frameDurationMs=20] - Квант аудио (20 мс)
     * @param {number} [options.jitterBufferMs=50] - Целевой джиттер-буфер
     * @param {number} [options.maxDriftSec=0.15] - Максимальное отставание до сброса (150 мс)
     */
    constructor(options = {}) {
        this.sampleRate = options.sampleRate || 16000;
        this.frameDurationMs = options.frameDurationMs || 20;
        this.jitterBufferMs = options.jitterBufferMs || 30;
        this.maxDriftSec = options.maxDriftSec || 0.08;

        /** @type {AudioContext|null} */
        this.audioContext = null;
        /** @type {MediaStream|null} */
        this.microphoneStream = null;
        /** @type {MediaStreamAudioSourceNode|null} */
        this.sourceNode = null;
        /** @type {AudioWorkletNode|null} */
        this.workletNode = null;
        /** @type {GainNode|null} */
        this.masterGain = null;

        /** @type {AnalyserNode|null} Анализатор для локального микрофона */
        this.localAnalyser = null;

        /** @type {Map<string, GainNode>} */
        this.participantGains = new Map();
        /** @type {Map<string, AnalyserNode>} Анализаторы для каждого удаленного собеседника */
        this.participantAnalysers = new Map();
        /** @type {Map<string, number>} */
        this.participantVolumes = new Map();

        /** @type {Map<string, number>} Независимые таймлайны воспроизведения */
        this.speakerPlayTimes = new Map();

        this.masterVolume = 1.0;
        this.isRecording = false;
        this.isMuted = false;
        this.workletLoaded = false;

        /** @type {((buffer: ArrayBuffer) => void)|null} */
        this.onAudioFrame = null;
        /** @type {((userId: string, isSpeaking: boolean) => void)|null} */
        this.onSpeakingStateChange = null;
    }

    /**
     * Инициализация AudioContext и загрузка Worklet
     * @returns {Promise<void>}
     */
    async init() {
        if (!this.audioContext) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioCtx({
                sampleRate: this.sampleRate,
                latencyHint: 'interactive'
            });

            this.masterGain = this.audioContext.createGain();
            this.masterGain.gain.setValueAtTime(this.masterVolume, this.audioContext.currentTime);
            this.masterGain.connect(this.audioContext.destination);
        }

        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        if (!this.workletLoaded) {
            await this.audioContext.audioWorklet.addModule('/js/audio-processor.js');
            this.workletLoaded = true;
        }
    }

    /**
     * Захват аудио с микрофона и подключение AnalyserNode
     * @param {boolean} echoCancellation
     * @returns {Promise<void>}
     */
    async startMicrophone(echoCancellation = true) {
        await this.init();
        this.stopMicrophone();

        try {
            this.microphoneStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: this.sampleRate,
                    echoCancellation: echoCancellation,
                    noiseSuppression: false,
                    autoGainControl: false
                },
                video: false
            });

            this.sourceNode = this.audioContext.createMediaStreamSource(this.microphoneStream);
            this.workletNode = new AudioWorkletNode(this.audioContext, 'voice-capture-processor');

            // Создаем анализатор для визуализации собственного голоса
            this.localAnalyser = this.audioContext.createAnalyser();
            this.localAnalyser.fftSize = 64;
            this.localAnalyser.smoothingTimeConstant = 0.8;

            this.workletNode.port.onmessage = (event) => {
                if (!this.isRecording || this.isMuted) return;

                const pcmBuffer = event.data;
                if (typeof this.onAudioFrame === 'function') {
                    this.onAudioFrame(pcmBuffer);
                }

                this._calculateVAD(pcmBuffer, 'self');
            };

            this.sourceNode.connect(this.localAnalyser);
            this.sourceNode.connect(this.workletNode);

            this.isRecording = true;
            this.setMute(this.isMuted);
        } catch (err) {
            console.error('[AudioManager] Failed to start microphone capture:', err);
            this.stopMicrophone();
            throw err;
        }
    }

    /**
     * Остановка захвата микрофона
     */
    stopMicrophone() {
        if (this.workletNode) {
            try {
                this.workletNode.port.onmessage = null;
                this.workletNode.disconnect();
            } catch (e) { }
            this.workletNode = null;
        }

        if (this.localAnalyser) {
            try {
                this.localAnalyser.disconnect();
            } catch (e) { }
            this.localAnalyser = null;
        }

        if (this.sourceNode) {
            try {
                this.sourceNode.disconnect();
            } catch (e) { }
            this.sourceNode = null;
        }

        if (this.microphoneStream) {
            this.microphoneStream.getTracks().forEach((track) => {
                track.stop();
                track.enabled = false;
            });
            this.microphoneStream = null;
        }

        this.isRecording = false;
        if (typeof this.onSpeakingStateChange === 'function') {
            this.onSpeakingStateChange('self', false);
        }
    }

    /**
     * Mute микрофона
     * @param {boolean} isMuted
     */
    setMute(isMuted) {
        this.isMuted = Boolean(isMuted);
        if (this.workletNode) {
            this.workletNode.port.postMessage({ isMuted: this.isMuted });
        }
        if (this.isMuted && typeof this.onSpeakingStateChange === 'function') {
            this.onSpeakingStateChange('self', false);
        }
    }

    /**
     * Переключение Mute
     * @returns {boolean}
     */
    toggleMute() {
        this.setMute(!this.isMuted);
        return this.isMuted;
    }

    /**
     * Воспроизведение входящего бинарного пакета от сервера.
     * @param {ArrayBuffer} arrayBuffer
     */
    playAudioPacket(arrayBuffer) {
        if (!this.audioContext || arrayBuffer.byteLength < 4) return;

        const view = new DataView(arrayBuffer);
        const idLen = view.getUint16(0, false);
        let pcmOffset = 0;
        let speakerId = 'default_stream';

        if (idLen > 0 && arrayBuffer.byteLength >= 2 + idLen + 2) {
            const idBytes = new Uint8Array(arrayBuffer, 2, idLen);
            speakerId = new TextDecoder().decode(idBytes);
            pcmOffset = 2 + idLen + (idLen % 2 !== 0 ? 1 : 0);
        } else {
            pcmOffset = 0;
        }

        const rawByteLength = arrayBuffer.byteLength - pcmOffset;
        if (rawByteLength % 2 !== 0 || rawByteLength < 2) return;

        const sampleCount = rawByteLength / 2;
        const int16Array = new Int16Array(arrayBuffer, pcmOffset, sampleCount);
        const float32Buffer = new Float32Array(sampleCount);
        let energySum = 0;

        for (let i = 0; i < sampleCount; i++) {
            const s = int16Array[i] / 32768.0;
            float32Buffer[i] = s;
            energySum += s * s;
        }

        if (speakerId !== 'default_stream' && typeof this.onSpeakingStateChange === 'function') {
            const rms = Math.sqrt(energySum / sampleCount);
            this.onSpeakingStateChange(speakerId, rms > 0.012);
        }

        const audioBuffer = this.audioContext.createBuffer(1, sampleCount, this.sampleRate);
        audioBuffer.getChannelData(0).set(float32Buffer);

        const sourceNode = this.audioContext.createBufferSource();
        sourceNode.buffer = audioBuffer;

        // Маршрутизация через персональный AnalyserNode и GainNode
        const targetGain = this._getParticipantGainNode(speakerId);
        sourceNode.connect(targetGain);

        // Индивидуальный джиттер-буфер для собеседника
        const currentTime = this.audioContext.currentTime;
        const jitterOffset = this.jitterBufferMs / 1000.0;
        let nextPlayTime = this.speakerPlayTimes.get(speakerId) || 0;

        if (nextPlayTime < currentTime) {
            nextPlayTime = currentTime + jitterOffset;
        } else if (nextPlayTime > currentTime + this.maxDriftSec) {
            nextPlayTime = currentTime + jitterOffset;
        }

        sourceNode.start(nextPlayTime);
        this.speakerPlayTimes.set(speakerId, nextPlayTime + audioBuffer.duration);
    }

    /**
     * Получение или создание GainNode и AnalyserNode для участника
     * @private
     * @param {string} speakerId
     * @returns {GainNode}
     */
    _getParticipantGainNode(speakerId) {
        if (!speakerId || speakerId === 'default_stream') {
            return this.masterGain;
        }

        let gainNode = this.participantGains.get(speakerId);
        if (!gainNode) {
            gainNode = this.audioContext.createGain();
            const volume = this.participantVolumes.get(speakerId) ?? 1.0;
            gainNode.gain.setValueAtTime(volume, this.audioContext.currentTime);

            // Создаем анализатор для спектральной визуализации собеседника
            const analyser = this.audioContext.createAnalyser();
            analyser.fftSize = 64;
            analyser.smoothingTimeConstant = 0.8;

            gainNode.connect(analyser);
            analyser.connect(this.masterGain);

            this.participantGains.set(speakerId, gainNode);
            this.participantAnalysers.set(speakerId, analyser);
        }
        return gainNode;
    }

    /**
     * Получение частотных данных (FFT) для отрисовки анимации волны / спектра
     * @param {string} userId ID пользователя или 'self' для микрофона
     * @returns {Uint8Array|null} Массив амплитуд частот [0..255]
     */
    getFrequencyData(userId) {
        let analyser = null;
        if (userId === 'self') {
            analyser = this.localAnalyser;
            if (this.isMuted) return null;
        } else {
            analyser = this.participantAnalysers.get(userId);
        }

        if (!analyser) return null;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);
        return dataArray;
    }

    /**
     * Установка громкости отдельного участника
     * @param {string} userId
     * @param {number} volume [0.0 ... 2.0]
     */
    setParticipantVolume(userId, volume) {
        const clamped = Math.max(0, Math.min(2, volume));
        this.participantVolumes.set(userId, clamped);

        const gainNode = this.participantGains.get(userId);
        if (gainNode && this.audioContext) {
            gainNode.gain.setValueAtTime(clamped, this.audioContext.currentTime);
        }
    }

    /**
     * Установка мастер-громкости
     * @param {number} volume [0.0 ... 2.0]
     */
    setMasterVolume(volume) {
        this.masterVolume = Math.max(0, Math.min(2, volume));
        if (this.masterGain && this.audioContext) {
            this.masterGain.gain.setValueAtTime(this.masterVolume, this.audioContext.currentTime);
        }
    }

    /**
     * Очистка ресурсов участника при выходе
     * @param {string} userId
     */
    removeParticipant(userId) {
        const analyser = this.participantAnalysers.get(userId);
        if (analyser) {
            try {
                analyser.disconnect();
            } catch (e) { }
            this.participantAnalysers.delete(userId);
        }

        const gainNode = this.participantGains.get(userId);
        if (gainNode) {
            try {
                gainNode.disconnect();
            } catch (e) { }
            this.participantGains.delete(userId);
        }

        this.participantVolumes.delete(userId);
        this.speakerPlayTimes.delete(userId);
    }

    /**
     * Полное уничтожение аудиоконтекста
     */
    async destroy() {
        this.stopMicrophone();

        this.participantAnalysers.forEach((analyser) => {
            try {
                analyser.disconnect();
            } catch (e) { }
        });
        this.participantAnalysers.clear();

        this.participantGains.forEach((gain) => {
            try {
                gain.disconnect();
            } catch (e) { }
        });
        this.participantGains.clear();
        this.participantVolumes.clear();
        this.speakerPlayTimes.clear();

        if (this.masterGain) {
            try {
                this.masterGain.disconnect();
            } catch (e) { }
            this.masterGain = null;
        }

        if (this.audioContext) {
            await this.audioContext.close().catch(() => { });
            this.audioContext = null;
        }

        this.workletLoaded = false;
    }

    /**
     * Локальный расчет VAD
     * @private
     */
    _calculateVAD(pcmBuffer, userId) {
        if (typeof this.onSpeakingStateChange !== 'function') return;
        const int16 = new Int16Array(pcmBuffer);
        let sum = 0;
        for (let i = 0; i < int16.length; i++) {
            const s = int16[i] / 32768.0;
            sum += s * s;
        }
        const rms = Math.sqrt(sum / int16.length);
        this.onSpeakingStateChange(userId, rms > 0.012);
    }
}

// Глобальный инстанс
window.audioManager = new AudioManager();