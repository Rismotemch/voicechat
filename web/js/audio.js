/**
 * VoiceChat Audio Engine - web/js/audio.js
 * High-performance AudioWorklet capture pipeline with adaptive jitter buffer,
 * sample-accurate Web Audio scheduling, and Safari/iOS auto-unlock.
 */

class AudioManager {
    constructor(options = {}) {
        this.targetSampleRate = 16000;
        this.frameDurationMs = 20;
        this.samplesPerFrame = (this.targetSampleRate * this.frameDurationMs) / 1000; // 320 сэмплов
        this.jitterBufferMs = options.jitterBufferMs || 50; // 50 мс стартовый буфер
        this.maxDriftSec = options.maxDriftSec || 0.14;     // Максимальный допуск дрейфа 140 мс

        this.audioCtx = null;
        this.micStream = null;
        this.micSourceNode = null;
        this.workletNode = null;

        this.masterGainNode = null;
        this.analyserNode = null;

        this.participants = new Map(); // senderId -> { gainNode, nextPlayTime, analyser, freqData }
        this.speakingTimeouts = new Map();

        this.isMuted = false;
        this.isInitialized = false;
        this.isWorkletLoaded = false;
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

    async ensureWorkletLoaded() {
        if (this.isWorkletLoaded) return;
        try {
            await this.audioCtx.audioWorklet.addModule('js/audio-processor.js');
            this.isWorkletLoaded = true;
        } catch (err) {
            // Повторная попытка с абсолютным путем
            await this.audioCtx.audioWorklet.addModule('/js/audio-processor.js');
            this.isWorkletLoaded = true;
        }
    }

    async startMicrophone(echoCancellation = true) {
        await this.init();
        await this.unlockAudioContext();
        await this.ensureWorkletLoaded();

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

        // Инициализация легковесного потокового AudioWorkletNode
        this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-capture-processor');

        this.workletNode.port.onmessage = (event) => {
            if (this.isMuted) return;
            const pcm16Buffer = event.data;
            if (this.onAudioFrame && pcm16Buffer) {
                this.onAudioFrame(pcm16Buffer);
            }
        };

        // Связываем ноды
        this.micSourceNode.connect(this.analyserNode);
        this.micSourceNode.connect(this.workletNode);
    }

    stopMicrophone() {
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => t.stop());
            this.micStream = null;
        }
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        if (this.micSourceNode) {
            this.micSourceNode.disconnect();
            this.micSourceNode = null;
        }
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.workletNode) {
            this.workletNode.port.postMessage({ isMuted: this.isMuted });
        }
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
     * Адаптивное планирование с защитой от джиттера WAN сетей
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

        const audioBuffer = this.audioCtx.createBuffer(1, sampleCount, this.targetSampleRate);
        audioBuffer.getChannelData(0).set(float32Data);

        let participant = this.participants.get(senderId);
        if (!participant) {
            participant = this.createParticipantAudioChain(senderId);
        }

        const now = this.audioCtx.currentTime;
        const frameDuration = sampleCount / this.targetSampleRate;

        // Управление джиттер-буфером
        if (participant.nextPlayTime < now) {
            // Если сеть затормозила и очередь опустела, планируем с легким запасом вперед
            participant.nextPlayTime = now + (this.jitterBufferMs / 1000);
        } else if ((participant.nextPlayTime - now) > this.maxDriftSec) {
            // Если из-за всплеска пакетов очередь ушла вперед больше чем на maxDriftSec, мягко сгоняем лаг
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