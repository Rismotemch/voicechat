/**
 * VoiceChat AudioWorklet Processor - web/js/audio-processor.js
 * Runs in dedicated AudioWorklet thread:
 * - Real-time downsampling to 16kHz
 * - Zero-copy 20ms frame slicing (320 samples)
 * - Immune to UI thread lag & garbage collector spikes
 */

class PCMCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.targetSampleRate = 16000;
        this.samplesPerFrame = 320; // 20 мс при 16 кГц

        this.resampleBuffer = [];
        this.sourceIndex = 0;
        this.isMuted = false;

        this.port.onmessage = (event) => {
            if (event.data && typeof event.data.isMuted === 'boolean') {
                this.isMuted = event.data.isMuted;
                if (this.isMuted) {
                    this.resampleBuffer = [];
                    this.sourceIndex = 0;
                }
            }
        };
    }

    process(inputs, outputs, parameters) {
        if (this.isMuted) {
            return true;
        }

        const input = inputs[0];
        if (!input || !input[0] || input[0].length === 0) {
            return true;
        }

        const inputChannel = input[0]; // Моно-канал (128 сэмплов)
        const inputLen = inputChannel.length;
        const resampleRatio = sampleRate / this.targetSampleRate;

        // Потоковый линейный ресэмплинг
        while (this.sourceIndex < inputLen) {
            const i0 = Math.floor(this.sourceIndex);
            const i1 = Math.min(i0 + 1, inputLen - 1);
            const frac = this.sourceIndex - i0;

            const sample = inputChannel[i0] * (1 - frac) + inputChannel[i1] * frac;
            this.resampleBuffer.push(sample);

            this.sourceIndex += resampleRatio;
        }
        this.sourceIndex -= inputLen;

        // Нарезка строго по 320 сэмплов (20 мс)
        while (this.resampleBuffer.length >= this.samplesPerFrame) {
            const frame = this.resampleBuffer.splice(0, this.samplesPerFrame);
            const pcm16Buffer = new ArrayBuffer(this.samplesPerFrame * 2);
            const view = new DataView(pcm16Buffer);

            for (let j = 0; j < this.samplesPerFrame; j++) {
                let s = frame[j];
                if (s > 1.0) s = 1.0;
                if (s < -1.0) s = -1.0;
                const int16 = s < 0 ? s * 32768 : s * 32767;
                view.setInt16(j * 2, int16, true); // Little-Endian
            }

            // Zero-copy transfer буфера в основной поток
            this.port.postMessage(pcm16Buffer, [pcm16Buffer]);
        }

        return true;
    }
}

registerProcessor('pcm-capture-processor', PCMCaptureProcessor);