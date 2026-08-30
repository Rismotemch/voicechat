/**
 * VoiceChat 3D Spatial & Environment Engine - web/js/spatial.js
 * Optimized for Safari/WebKit & Chrome: HRTF Panning, Yaw/Pitch Orientation, Cave Reverb & Radio Fallback.
 */

class SpatialAudioEngine {
    constructor(audioManager) {
        this.am = audioManager;
        this.maxProximityDistance = 32.0; // Максимальная дистанция 3D звука (блоков)
        this.listenerPos = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, inCave: false, matched: false };
        this.chains = new Map(); // userId -> SpatialChain
        this.caveConvolver = null;
        this.isInitialized = false;
    }

    init() {
        if (!this.am.audioCtx || this.isInitialized) return;

        // Создаем процедурный импульс эха пещеры (2.0 сек)
        this.caveConvolver = this.am.audioCtx.createConvolver();
        this.caveConvolver.buffer = this.generateCaveImpulseResponse(1.8, 2.2);

        this.isInitialized = true;
        console.log('[SpatialAudio] Engine initialized successfully.');
    }

    generateCaveImpulseResponse(duration, decay) {
        const sampleRate = this.am.audioCtx.sampleRate;
        const length = sampleRate * duration;
        const impulse = this.am.audioCtx.createBuffer(2, length, sampleRate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);

        for (let i = 0; i < length; i++) {
            const n = i / length;
            const env = Math.pow(1 - n, decay);
            left[i] = (Math.random() * 2 - 1) * env;
            right[i] = (Math.random() * 2 - 1) * env;
        }
        return impulse;
    }

    createSpatialChain(userId, sourceGainNode, destinationNode) {
        if (!this.isInitialized) this.init();
        const ctx = this.am.audioCtx;

        // 3D Panner с агрессивной кривой для четкого разделения лево/право
        const panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1.5;
        panner.maxDistance = this.maxProximityDistance;
        panner.rolloffFactor = 1.0;
        panner.coneInnerAngle = 360;

        const directGain = ctx.createGain();
        directGain.gain.setValueAtTime(1.0, ctx.currentTime);

        const reverbGain = ctx.createGain();
        reverbGain.gain.setValueAtTime(0.0, ctx.currentTime);

        // Радио-фильтр для дальней дистанции
        const radioHP = ctx.createBiquadFilter();
        radioHP.type = 'highpass';
        radioHP.frequency.value = 450;

        const radioLP = ctx.createBiquadFilter();
        radioLP.type = 'lowpass';
        radioLP.frequency.value = 2500;

        const radioGain = ctx.createGain();
        radioGain.gain.setValueAtTime(0.0, ctx.currentTime);

        // Коммутация графа
        sourceGainNode.connect(panner);
        panner.connect(directGain);
        directGain.connect(destinationNode);

        if (this.caveConvolver) {
            panner.connect(reverbGain);
            reverbGain.connect(this.caveConvolver);
            this.caveConvolver.connect(destinationNode);
        }

        sourceGainNode.connect(radioHP);
        radioHP.connect(radioLP);
        radioLP.connect(radioGain);
        radioGain.connect(destinationNode);

        const chain = {
            panner,
            directGain,
            reverbGain,
            radioGain,
            lastPos: { x: 0, y: 0, z: 0, dimension: 0, inCave: false, dist: 0 }
        };

        this.chains.set(userId, chain);
        console.log(`[SpatialAudio] Created 3D chain for user: ${userId}`);
        return chain;
    }

    /**
     * Позиционирование слушателя (с поддержкой Safari WebKit)
     */
    updateListener(x, y, z, yaw, pitch, inCave) {
        if (!this.am.audioCtx) return;
        const ctx = this.am.audioCtx;
        const listener = ctx.listener;

        this.listenerPos = { x, y, z, yaw, pitch, inCave, matched: true };

        // 1. Позиция слушателя (совместимо со всеми браузерами)
        if (listener.positionX) {
            listener.positionX.value = x;
            listener.positionY.value = y;
            listener.positionZ.value = z;
        }
        if (listener.setPosition) {
            listener.setPosition(x, y, z);
        }

        // 2. Вектор направления взгляда в Minecraft (Yaw 0 = +Z South, 90 = -X West)
        const yawRad = yaw * (Math.PI / 180.0);
        const pitchRad = pitch * (Math.PI / 180.0);

        const cosPitch = Math.cos(pitchRad);
        const fwdX = -Math.sin(yawRad) * cosPitch;
        const fwdY = -Math.sin(pitchRad);
        const fwdZ = Math.cos(yawRad) * cosPitch;

        const upX = 0;
        const upY = 1;
        const upZ = 0;

        if (listener.forwardX) {
            listener.forwardX.value = fwdX;
            listener.forwardY.value = fwdY;
            listener.forwardZ.value = fwdZ;
            listener.upX.value = upX;
            listener.upY.value = upY;
            listener.upZ.value = upZ;
        }
        if (listener.setOrientation) {
            listener.setOrientation(fwdX, fwdY, fwdZ, upX, upY, upZ);
        }
    }

    /**
     * Позиционирование источника звука собеседника
     */
    updateRemotePlayer(userId, x, y, z, dimension, inCave) {
        let chain = this.chains.get(userId);

        // Если цепочка еще не была создана, запрашиваем ноду у аудио-менеджера
        if (!chain && this.am) {
            const pipeline = this.am.getParticipantPipeline(userId);
            chain = this.chains.get(userId);
        }

        if (!chain || !this.am.audioCtx) return;

        const ctx = this.am.audioCtx;
        const now = ctx.currentTime;

        const dx = x - this.listenerPos.x;
        const dy = y - this.listenerPos.y;
        const dz = z - this.listenerPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        chain.lastPos = { x, y, z, dimension, inCave, dist };

        const isDifferentDim = this.listenerPos.matched && (dimension !== this.listenerPos.dimension);

        if (isDifferentDim || dist > this.maxProximityDistance) {
            // Режим рации при удалении или в другом измерении
            chain.directGain.gain.setValueAtTime(0.0, now);
            chain.reverbGain.gain.setValueAtTime(0.0, now);
            chain.radioGain.gain.setTargetAtTime(0.9, now, 0.05);
        } else {
            // 3D звук
            chain.radioGain.gain.setValueAtTime(0.0, now);
            chain.directGain.gain.setTargetAtTime(1.0, now, 0.05);

            if (chain.panner.positionX) {
                chain.panner.positionX.value = x;
                chain.panner.positionY.value = y;
                chain.panner.positionZ.value = z;
            }
            if (chain.panner.setPosition) {
                chain.panner.setPosition(x, y, z);
            }

            // Эхо пещеры
            const reverbLevel = (inCave || this.listenerPos.inCave) ? 0.5 : 0.0;
            chain.reverbGain.gain.setTargetAtTime(reverbLevel, now, 0.1);
        }
    }

    removeChain(userId) {
        const chain = this.chains.get(userId);
        if (chain) {
            try {
                chain.panner.disconnect();
                chain.directGain.disconnect();
                chain.reverbGain.disconnect();
                chain.radioGain.disconnect();
            } catch (e) { }
            this.chains.delete(userId);
        }
    }
}

window.SpatialAudioEngine = SpatialAudioEngine;