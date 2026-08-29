/**
 * VoiceChat Audio Engine - web/js/audio.js
 * Optimized Web Audio API pipeline:
 * - Real-time downsampling (48kHz/44.1kHz -> 16kHz)
 * - Seamless sample-accurate scheduling (no 50Hz modulation buzz)
 * - Safari/iOS auto-unlocking & zero-latency playback
 */

class AudioManager {
    constructor(options = {}) {
        this.targetSampleRate = 16000; // Целевая частота DSP-сервера
        this.frameDurationMs = 20;     // 20 мс
        this.samplesPerFrame = (this.targetSampleRate * this.frameDurationMs) / 1000; // 320 сэмплов
        this.jitterBufferMs = options.jitterBufferMs || 40; // 40 мс стартовый буфер
        this.maxDriftSec = options.maxDriftSec || 0.12;

        this.audioCtx = null;
        this.micStream = null;
        this.micSourceNode = null;
        this.micProcessorNode = null;

        this.masterGainNode = null;
        this.analyserNode = null;

        this.participants = new Map(); // senderId -> { gainNode, nextPlayTime, analyser, freqData }
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

        this.masterGainNode = this.audioCtx.createGain();
        this.masterGainNode.gain.value = 1.0;
        this.masterGainNode.connect(this.audioCtx.destination);

        this.analyserNode = this.audioCtx.createAnalyser();
        this.analyserNode.fftSize = 64;
        this.analyserNode.smoothingTimeConstant = 0.5;

        await this.unlockAudioContext();
        this.isInitialized = true;
    }

    async unlockAudioContext() {
        if (!this.audioCtx) return;

        if (this.audioCtx.state === 'suspended') {
            await this.audioCtx.resume();
        }

        try {
            const buffer = this.audioCtx.createBuffer(1, 1, 22050);
            const source = this.audioCtx.createBufferSource();
            source.buffer = buffer;
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
                channelCount: 1
            },
            video: false
        };

        this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
        this.micSourceNode = this.audioCtx.createMediaStreamSource(this.micStream);

        // Буфер захвата 2048 сэмплов для стабильной работы в WebKit
        this.micProcessorNode = this.audioCtx.createScriptProcessor(2048, 1, 1);

        const inputSampleRate = this.audioCtx.sampleRate;
        const resampleRatio = inputSampleRate / this.targetSampleRate;
        let resampleBuffer = [];

        this.micProcessorNode.onaudioprocess = (e) => {
            if (this.isMuted) return;

            const inputData = e.inputBuffer.getChannelData(0);

            // Линейный ресэмплинг из нативной частоты браузера (48к/44.1к) в 16кГц
            let sourceIndex = 0;
            while (sourceIndex < inputData.length) {
                const i0 = Math.floor(sourceIndex);
                const i1 = Math.min(i0 + 1, inputData.length - 1);
                const frac = sourceIndex - i0;

                const sample = inputData[i0] * (1 - frac) + inputData[i1] * frac;
                resampleBuffer.push(sample);

                sourceIndex += resampleRatio;
            }

            // Нарезка строго по 320 сэмплов (20 мс)
            while (resampleBuffer.length >= this.samplesPerFrame) {
                const frame = resampleBuffer.splice(0, this.samplesPerFrame);
                const pcm16Buffer = new ArrayBuffer(this.samplesPerFrame * 2);
                const view = new DataView(pcm16Buffer);

                for (let j = 0; j < this.samplesPerFrame; j++) {
                    let s = frame[j];
                    if (s > 1.0) s = 1.0;
                    if (s < -1.0) s = -1.0;
                    const int16 = s < 0 ? s * 32768 : s * 32767;
                    view.setInt16(j * 2, int16, true); // Little-Endian
                }

                if (this.onAudioFrame) {
                    this.onAudioFrame(pcm16Buffer);
                }
            }
        };

        this.micSourceNode.connect(this.analyserNode);
        this.micSourceNode.connect(this.micProcessorNode);

        // Необходимая заглушка для работы ScriptProcessor в Safari
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
     * Бесшовное воспроизведение входящих фреймов (без 50 Гц вибрации)
     */
    async playAudioPacket(arrayBuffer) {
        if (!this.audioCtx) return;

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

        // Распаковка PCM Int16 -> Float32
        const float32Data = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            const int16 = dataView.getInt16(pcmOffset + i * 2, true);
            float32Data[i] = int16 < 0 ? int16 / 32768.0 : int16 / 32767.0;
        }

        // Web Audio API автоматически апсэмплит 16кГц в 48кГц звуковой карты
        const audioBuffer = this.audioCtx.createBuffer(1, sampleCount, this.targetSampleRate);
        audioBuffer.getChannelData(0).set(float32Data);

        let participant = this.participants.get(senderId);
        if (!participant) {
            participant = this.createParticipantAudioChain(senderId);
        }

        const now = this.audioCtx.currentTime;
        const frameDuration = sampleCount / this.targetSampleRate;

        // Бесшовная склейка без сброса таймлайна на каждом фрейме
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
            }, 250);

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

window.audioManager = new AudioManager();
