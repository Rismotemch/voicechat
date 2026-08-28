class AudioManager {
    constructor() {
        this.audioContext = null;
        this.microphoneStream = null;
        this.audioProcessor = null;
        this.isRecording = false;
        this.isMuted = false;
        this.remoteAudioPlayers = new Map();
    }

    async init() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 48000,
                latencyHint: 'interactive'
            });
        }

        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
    }

    async startMicrophone() {
        await this.init();

        // Захватываем микрофон
        this.microphoneStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 48000
            }
        });

        // Создаём обработчик аудио
        const source = this.audioContext.createMediaStreamSource(this.microphoneStream);
        this.audioProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);

        this.audioProcessor.onaudioprocess = (event) => {
            if (this.isRecording && !this.isMuted) {
                const audioData = event.inputBuffer.getChannelData(0);
                const pcmData = this.floatToPCM16(audioData);

                // Отправляем через WebSocket
                if (window.voiceChat && window.voiceChat.sendAudio) {
                    window.voiceChat.sendAudio(pcmData);
                }
            }
        };

        source.connect(this.audioProcessor);
        this.audioProcessor.connect(this.audioContext.destination);

        this.isRecording = true;
    }

    floatToPCM16(float32Array) {
        const pcm16 = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16.buffer;
    }

    playRemoteAudio(userId, pcmData) {
        if (!this.audioContext) return;

        const int16Array = new Int16Array(pcmData);
        const float32Array = new Float32Array(int16Array.length);

        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        const audioBuffer = this.audioContext.createBuffer(1, float32Array.length, 48000);
        audioBuffer.getChannelData(0).set(float32Array);

        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioContext.destination);
        source.start();
    }

    stopMicrophone() {
        if (this.audioProcessor) {
            this.audioProcessor.disconnect();
            this.audioProcessor = null;
        }

        if (this.microphoneStream) {
            this.microphoneStream.getTracks().forEach(track => track.stop());
            this.microphoneStream = null;
        }

        this.isRecording = false;
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        return this.isMuted;
    }
}

// Глобальный экземпляр
window.audioManager = new AudioManager();