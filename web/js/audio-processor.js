/**
 * VoiceChat High-Performance Audio Worklet Processors
 * File: web/js/audio-processor.js
 * 
 * Runs in a dedicated audio rendering thread (AudioWorkletGlobalScope).
 * Zero garbage collection overhead, real-time PCM16 quantization and streaming.
 */

// =============================================================================
// 1. Capture Processor (Mic Float32 -> Int16 PCM 20ms Frames)
// =============================================================================
class VoiceCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.frameSize = 320; // 20ms при 16000 Hz (16000 * 0.02)
        this.accumulator = new Float32Array(this.frameSize);
        this.accumulatedSamples = 0;
        this.isMuted = false;

        this.port.onmessage = (event) => {
            if (event.data && typeof event.data.isMuted === 'boolean') {
                this.isMuted = event.data.isMuted;
            }
        };
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || input.length === 0) {
            return true;
        }

        const channelData = input[0];
        const inputLen = channelData.length;

        if (this.isMuted) {
            this.accumulatedSamples = 0;
            return true;
        }

        let readOffset = 0;

        while (readOffset < inputLen) {
            const needed = this.frameSize - this.accumulatedSamples;
            const available = inputLen - readOffset;
            const toCopy = Math.min(needed, available);

            this.accumulator.set(
                channelData.subarray(readOffset, readOffset + toCopy),
                this.accumulatedSamples
            );

            this.accumulatedSamples += toCopy;
            readOffset += toCopy;

            if (this.accumulatedSamples >= this.frameSize) {
                this.flushFrame();
                this.accumulatedSamples = 0;
            }
        }

        return true;
    }

    flushFrame() {
        const pcm16 = new Int16Array(this.frameSize);
        for (let i = 0; i < this.frameSize; i++) {
            // Hard clamp [-1.0, 1.0] для предотвращения переполнения разрядности Int16
            const sample = Math.max(-1.0, Math.min(1.0, this.accumulator[i]));
            pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        }

        // Передаем ArrayBuffer с передачей владения (Transferable Objects) без копирования памяти
        this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
}

registerProcessor('voice-capture-processor', VoiceCaptureProcessor);