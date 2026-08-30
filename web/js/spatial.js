/**
 * VoiceChat 3D Spatial Engine - web/js/spatial.js
 * Relative Local-Space HRTF Panning (100% compatible with Safari WebKit & Chrome)
 */

class SpatialAudioEngine {
    constructor(audioManager) {
        this.am = audioManager;
        this.maxDistance = 32.0; // Максимальная дистанция слышимости (блоков)
        this.listenerPos = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, inCave: false };
        this.chains = new Map(); // userId -> chain
        this.caveConvolver = null;
        this.isInitialized = false;
    }

    init() {
        if (!this.am.audioCtx || this.isInitialized) return;

        // Фиксируем слушателя строго в центре (0, 0, 0) лицом вперед (-Z)
        const listener = this.am.audioCtx.listener;
        if (listener.positionX) {
            listener.positionX.value = 0;
            listener.positionY.value = 0;
            listener.positionZ.value = 0;
            listener.forwardX.value = 0;
            listener.forwardY.value = 0;
            listener.forwardZ.value = -1;
            listener.upX.value = 0;
            listener.upY.value = 1;
            listener.upZ.value = 0;
        } else if (listener.setPosition) {
            listener.setPosition(0, 0, 0);
            listener.setOrientation(0, 0, -1, 0, 1, 0);
        }

        // Процедурный реверб пещеры
        this.caveConvolver = this.am.audioCtx.createConvolver();
        this.caveConvolver.buffer = this.generateCaveIR(1.5, 2.0);

        this.isInitialized = true;
    }

    generateCaveIR(duration, decay) {
        const rate = this.am.audioCtx.sampleRate;
        const len = rate * duration;
        const buf = this.am.audioCtx.createBuffer(2, len, rate);
        const l = buf.getChannelData(0);
        const r = buf.getChannelData(1);
        for (let i = 0; i < len; i++) {
            const env = Math.pow(1 - i / len, decay);
            l[i] = (Math.random() * 2 - 1) * env;
            r[i] = (Math.random() * 2 - 1) * env;
        }
        return buf;
    }

    createSpatialChain(userId, sourceGainNode, destinationNode) {
        if (!this.isInitialized) this.init();
        const ctx = this.am.audioCtx;

        const panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1.5;
        panner.maxDistance = this.maxDistance;
        panner.rolloffFactor = 1.2;

        const directGain = ctx.createGain();
        directGain.gain.value = 1.0;

        const reverbGain = ctx.createGain();
        reverbGain.gain.value = 0.0;

        const radioFilter = ctx.createBiquadFilter();
        radioFilter.type = 'bandpass';
        radioFilter.frequency.value = 1400;
        radioFilter.Q.value = 1.5;

        const radioGain = ctx.createGain();
        radioGain.gain.value = 0.0;

        // Коммутация графа
        sourceGainNode.connect(panner);
        panner.connect(directGain);
        directGain.connect(destinationNode);

        if (this.caveConvolver) {
            panner.connect(reverbGain);
            reverbGain.connect(this.caveConvolver);
            this.caveConvolver.connect(destinationNode);
        }

        // Обходной радио-канал для больших расстояний
        sourceGainNode.connect(radioFilter);
        radioFilter.connect(radioGain);
        radioGain.connect(destinationNode);

        const chain = { panner, directGain, reverbGain, radioGain };
        this.chains.set(userId, chain);
        return chain;
    }

    updateListener(x, y, z, yaw, pitch, inCave) {
        this.listenerPos = { x, y, z, yaw, pitch, inCave };
    }

    /**
     * Преобразование глобальных координат Minecraft в локальные координаты ушей игрока
     */
    updateRemotePlayer(userId, targetX, targetY, targetZ, dimension, inCave) {
        let chain = this.chains.get(userId);
        if (!chain && this.am) {
            this.am.getParticipantPipeline(userId);
            chain = this.chains.get(userId);
        }
        if (!chain || !this.am.audioCtx) return;

        const now = this.am.audioCtx.currentTime;

        // Вектор смещения в мире
        const dx = targetX - this.listenerPos.x;
        const dy = targetY - this.listenerPos.y;
        const dz = targetZ - this.listenerPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (dist > this.maxDistance) {
            // Переход на рацию при удалении
            chain.directGain.gain.setValueAtTime(0.0, now);
            chain.reverbGain.gain.setValueAtTime(0.0, now);
            chain.radioGain.gain.setTargetAtTime(0.9, now, 0.05);
            return;
        }

        chain.radioGain.gain.setValueAtTime(0.0, now);
        chain.directGain.gain.setTargetAtTime(1.0, now, 0.05);

        // Проекция в систему координат головы (Minecraft Yaw: 0 = +Z, 90 = -X)
        const yawRad = this.listenerPos.yaw * (Math.PI / 180.0);
        const cosY = Math.cos(yawRad);
        const sinY = Math.sin(yawRad);

        // relX: <0 (слева), >0 (справа)
        // relZ: <0 (спереди), >0 (сзади)
        const relX = -(dx * cosY + dz * sinY);
        const relY = dy;
        const relZ = -(-dx * sinY + dz * cosY);

        // Применяем относительные координаты к PannerNode
        if (chain.panner.positionX) {
            chain.panner.positionX.setTargetAtTime(relX, now, 0.04);
            chain.panner.positionY.setTargetAtTime(relY, now, 0.04);
            chain.panner.positionZ.setTargetAtTime(relZ, now, 0.04);
        } else if (chain.panner.setPosition) {
            chain.panner.setPosition(relX, relY, relZ);
        }

        // Эхо пещеры
        const reverbVal = (inCave || this.listenerPos.inCave) ? 0.45 : 0.0;
        chain.reverbGain.gain.setTargetAtTime(reverbVal, now, 0.1);
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