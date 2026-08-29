/**
 * VoiceChat Audio Engine - web/js/audio.js
 * Cross-browser Web Audio API pipeline with Safari/iOS unlock,
 * Jitter-buffer scheduling, PCM-16 decoding & Micro-Fading.
 */

class AudioManager {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate || 16000;
        this.frameDurationMs = options.frameDurationMs || 20;
        this.samplesPerFrame = (this.sampleRate * this.frameDurationMs) / 1000; // 320 сэмплов
        this.jitterBufferMs = options.jitterBufferMs || 60; // 60 мс джиттер-буфер
        this.maxDriftSec = options.maxDriftSec || 0.15;

        this.audioCtx = null;
        this.micStream = null;
        this.micSourceNode = null;
        this.micGainNode = null;
        this.micProcessorNode = null;

        this.masterGainNode = null;
        this.analyserNode = null;

        this.participants = new Map(); // senderId -> { gainNode, pannerNode, nextPlayTime, analyser, freqData }
        this.speakingTimeouts = new Map();

        this.isMuted = false;
        this.isInitialized = false;
        this.textDecoder = new TextDecoder('utf-8');

        // Callbacks
        this.onAudioFrame = null;
        this.onSpeakingStateChange = null;
    }

    async init() {
        if (this.isInitialized && this.audioCtx) {
            if (this.audioCtx.state === 'suspended') {
                await this.audioCtx.resume();
            }
            return;
        }

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioContextClass({ latencyHint: 'interactive' });

        // Мастер-громкость
        this.masterGainNode = this.audioCtx.createGain();
        this.masterGainNode.gain.value = 1.0;
        this.masterGainNode.connect(this.audioCtx.destination);

        // Анализатор локального микрофона для визуализатора
        this.analyserNode = this.audioCtx.createAnalyser();
        this.analyserNode.fftSize = 64;
        this.analyserNode.smoothingTimeConstant = 0.5;

        // Разблокировка Web Audio в Safari / iOS
        await this.unlockAudioContext();

        this.isInitialized = true;
    }

    async unlockAudioContext() {
        if (!this.audioCtx) return;

        if (this.audioCtx.state === 'suspended') {
            await this.audioCtx.resume();
        }

        // Проигрываем бесшумный буфер для снятия ограничений WebKit
        try {
            const silentBuffer = this.audioCtx.createBuffer(1, 1, 22050);
            const source = this.audioCtx.createBufferSource();
            source.buffer = silentBuffer;
            source.connect(this.audioCtx.destination);
            source.start(0);
        } catch (e) { }
    }

    async startMicrophone(echoCancellation = true) {
        await this.init();
        await this.unlockAudioContext();

        if (this.micStream) {
            this.stopMicrophone();
        }

        const constraints = {
            audio: {
                echoCancellation: echoCancellation,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: this.sampleRate
            },
            video: false
        };

        this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
        this.micSourceNode = this.audioCtx.createMediaStreamSource(this.micStream);

        this.micGainNode = this.audioCtx.createGain();
        this.micGainNode.gain.value = 1.0;

        // Захват PCM через ScriptProcessor (гарантирует синхронные 320 сэмплов)
        this.micProcessorNode = this.audioCtx.createScriptProcessor(512, 1, 1);

        let sampleAccumulator = [];

        this.micProcessorNode.onaudioprocess = (e) => {
            if (this.isMuted) return;

            const inputData = e.inputBuffer.getChannelData(0);
            for (let i = 0; i < inputData.length; i++) {
                sampleAccumulator.push(inputData[i]);
            }

            while (sampleAccumulator.length >= this.samplesPerFrame) {
                const chunk = sampleAccumulator.splice(0, this.samplesPerFrame);
                const pcm16Buffer = new ArrayBuffer(this.samplesPerFrame * 2);
                const view = new DataView(pcm16Buffer);

                for (let j = 0; j < this.samplesPerFrame; j++) {
                    let s = chunk[j];
                    if (s > 1.0) s = 1.0;
                    if (s < -1.0) s = -1.0;
                    const int16 = s < 0 ? s * 32768 : s * 32767;
                    view.setInt16(j * 2, int16, true);
                }

                if (this.onAudioFrame) {
                    this.onAudioFrame(pcm16Buffer);
                }
            }
        };

        this.micSourceNode.connect(this.micGainNode);
        this.micGainNode.connect(this.analyserNode);
        this.micGainNode.connect(this.micProcessorNode);

        // Dummy connection для старта онаудиопроцесс в WebKit
        const dummyGain = this.audioCtx.createGain();
        dummyGain.gain.value = 0;
        this.micProcessorNode.connect(dummyGain);
        dummyGain.connect(this.audioCtx.destination);
    }

    stopMicrophone() {
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => t.stop());
            this.micStream = null;
        }
        if (this.micProcessorNode) {
            this.micProcessorNode.disconnect();
            this.micProcessorNode = null;
        }
        if (this.micGainNode) {
            this.micGainNode.disconnect();
            this.micGainNode = null;
        }
        if (this.micSourceNode) {
            this.micSourceNode.disconnect();
            this.micSourceNode = null;
        }
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.isMuted && this.onSpeakingStateChange) {
            this.onSpeakingStateChange('self', false);
        }
        return this.isMuted;
    }

    setMasterVolume(val) {
        if (this.masterGainNode && this.audioCtx) {
            this.masterGainNode.gain.setValueAtTime(val, this.audioCtx.currentTime);
        }
    }

    setParticipantVolume(senderId, val) {
        const participant = this.participants.get(senderId);
        if (participant && participant.gainNode && this.audioCtx) {
            participant.gainNode.gain.setValueAtTime(val, this.audioCtx.currentTime);
        }
    }

    createParticipantAudioChain(senderId) {
        const gainNode = this.audioCtx.createGain();
        gainNode.gain.value = 1.0;

        const analyser = this.audioCtx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.5;

        gainNode.connect(analyser);
        analyser.connect(this.masterGainNode);

        const participant = {
            gainNode,
            analyser,
            freqData: new Uint8Array(analyser.frequencyBinCount),
            nextPlayTime: 0
        };

        this.participants.set(senderId, participant);
        return participant;
    }

    removeParticipant(senderId) {
        const participant = this.participants.get(senderId);
        if (participant) {
            try {
                participant.gainNode.disconnect();
                participant.analyser.disconnect();
            } catch (e) { }
            this.participants.delete(senderId);
        }
    }

    /**
     * Воспроизведение бинарного PCM-пакета с автопробуждением контекста
     */
    async playAudioPacket(arrayBuffer) {
        if (!this.audioCtx) return;

        // Если Safari заблокировал контекст — будим его
        if (this.audioCtx.state === 'suspended') {
            try {
                await this.audioCtx.resume();
            } catch (e) {
                return;
            }
        }

        const dataView = new DataView(arrayBuffer);
        if (dataView.byteLength < 4) return;

        const idLen = dataView.getUint16(0, false);
        const padding = (idLen % 2 !== 0) ? 1 : 0;
        const pcmOffset = 2 + idLen + padding;

        if (dataView.byteLength <= pcmOffset) return;

        const idBytes = new Uint8Array(arrayBuffer, 2, idLen);
        const senderId = this.textDecoder.decode(idBytes);

        const pcmByteLength = dataView.byteLength - pcmOffset;
        const sampleCount = Math.floor(pcmByteLength / 2);
        if (sampleCount === 0) return;

        // PCM Int16 -> Float32
        const float32Data = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            const int16 = dataView.getInt16(pcmOffset + i * 2, true);
            float32Data[i] = int16 < 0 ? int16 / 32768.0 : int16 / 32767.0;
        }

        // Микро-сглаживание (16 сэмплов = 1 мс) для удаления клиппинга
        const fadeSamples = Math.min(16, Math.floor(sampleCount / 4));
        for (let i = 0; i < fadeSamples; i++) {
            const ramp = i / fadeSamples;
            float32Data[i] *= ramp;
            float32Data[sampleCount - 1 - i] *= ramp;
        }

        const audioBuffer = this.audioCtx.createBuffer(1, sampleCount, this.sampleRate);
        audioBuffer.getChannelData(0).set(float32Data);

        let participant = this.participants.get(senderId);
        if (!participant) {
            participant = this.createParticipantAudioChain(senderId);
        }

        const now = this.audioCtx.currentTime;
        const frameDuration = sampleCount / this.sampleRate;

        // Коррекция таймлайна при дрейфе
        if (participant.nextPlayTime < now || (participant.nextPlayTime - now) > this.maxDriftSec) {
            participant.nextPlayTime = now + (this.jitterBufferMs / 1000);
        }

        const source = this.audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(participant.gainNode);

        source.start(participant.nextPlayTime);
        participant.nextPlayTime += frameDuration;

        this.triggerSpeaking(senderId);
    }

    triggerSpeaking(userId) {
        if (this.onSpeakingStateChange) {
            this.onSpeakingStateChange(userId, true);

            if (this.speakingTimeouts.has(userId)) {
                clearTimeout(this.speakingTimeouts.get(userId));
            }

            const tid = setTimeout(() => {
                this.onSpeakingStateChange(userId, false);
                this.speakingTimeouts.delete(userId);
            }, 300);

            this.speakingTimeouts.set(userId, tid);
        }
    }

    getFrequencyData(userId) {
        if (!this.audioCtx) return null;

        if (userId === 'self') {
            if (!this.analyserNode || this.isMuted) return null;
            const data = new Uint8Array(this.analyserNode.frequencyBinCount);
            this.analyserNode.getByteFrequencyData(data);
            return data;
        }

        const participant = this.participants.get(userId);
        if (!participant || !participant.analyser) return null;

        participant.analyser.getByteFrequencyData(participant.freqData);
        return participant.freqData;
    }
}

// Глобальный экземпляр аудио-менеджера
window.audioManager = new AudioManager();
