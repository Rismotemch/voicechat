/**
 * VoiceChat 3D Spatial & Environment Engine - web/js/spatial.js
 * Features:
 * - 3D HRTF Panning & Head Orientation (Yaw/Pitch)
 * - Procedural Cave Impulse Response Generator (Convolver Reverb)
 * - Proximity Falloff & Automatic Walkie-Talkie Radio Fallback
 */

class SpatialAudioEngine {
    constructor(audioManager) {
        this.am = audioManager;
        this.maxProximityDistance = 28.0; // Дистанция слышимости прямого голоса (блоков)
        this.radioDistance = 35.0;        // Дистанция перехода в режим рации

        this.listenerPos = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, inCave: false };
        this.chains = new Map(); // userId -> SpatialChain

        this.caveConvolver = null;
        this.isInitialized = false;
    }

    init() {
        if (!this.am.audioCtx || this.isInitialized) return;

        // Создаем процедурную реверберацию пещеры (2.2 секунды затухания)
        this.caveConvolver = this.am.audioCtx.createConvolver();
        this.caveConvolver.buffer = this.generateCaveImpulseResponse(2.2, 2.0);

        this.isInitialized = true;
    }

    /**
     * Процедурная генерация импульса эха пещеры (decay time, diffusion)
     */
    generateCaveImpulseResponse(duration, decay) {
        const sampleRate = this.am.audioCtx.sampleRate;
        const length = sampleRate * duration;
        const impulse = this.am.audioCtx.createBuffer(2, length, sampleRate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);

        for (let i = 0; i < length; i++) {
            const n = i / length;
            // Экспоненциальный спад с рандомным шумом
            const env = Math.pow(1 - n, decay);
            left[i] = (Math.random() * 2 - 1) * env;
            right[i] = (Math.random() * 2 - 1) * env;
        }
        return impulse;
    }

    /**
     * Создает пространственную цепочку для участника:
     * Source -> Panner -> [Direct Gain + Reverb Send] -> Master
     *                  -> [Radio Filter + Distortion] -> Master
     */
    createSpatialChain(userId, sourceNode, destinationNode) {
        if (!this.isInitialized) this.init();
        const ctx = this.am.audioCtx;

        // 3D Panner
        const panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 2.0;
        panner.maxDistance = this.maxProximityDistance;
        panner.rolloffFactor = 1.2;
        panner.coneInnerAngle = 360;

        // Direct & Cave Send Gains
        const directGain = ctx.createGain();
        const reverbGain = ctx.createGain();
        reverbGain.gain.value = 0.0;

        // Radio Chain (Полосовой фильтр 400Гц - 2.5кГц + сатурация)
        const radioHP = ctx.createBiquadFilter();
        radioHP.type = 'highpass';
        radioHP.frequency.value = 450;

        const radioLP = ctx.createBiquadFilter();
        radioLP.type = 'lowpass';
        radioLP.frequency.value = 2400;

        const radioGain = ctx.createGain();
        radioGain.gain.value = 0.0;

        // Соединения
        sourceNode.connect(panner);
        panner.connect(directGain);
        directGain.connect(destinationNode);

        // Пещерный посыл
        if (this.caveConvolver) {
            panner.connect(reverbGain);
            reverbGain.connect(this.caveConvolver);
            this.caveConvolver.connect(destinationNode);
        }

        // Обходной радио-канал (играет по центру, минуя 3D-панорамирование)
        sourceNode.connect(radioHP);
        radioHP.connect(radioLP);
        radioLP.connect(radioGain);
        radioGain.connect(destinationNode);

        const chain = {
            panner,
            directGain,
            reverbGain,
            radioGain,
            lastPos: { x: 0, y: 0, z: 0, dimension: 0, inCave: false }
        };

        this.chains.set(userId, chain);
        return chain;
    }

    /**
     * Обновление позиции и направления взгляда слушателя (Minecraft Yaw/Pitch)
     */
    updateListener(x, y, z, yaw, pitch, inCave) {
        if (!this.am.audioCtx) return;
        const ctx = this.am.audioCtx;
        const now = ctx.currentTime;

        this.listenerPos = { x, y, z, yaw, pitch, inCave };

        // 1. Позиция слушателя
        if (ctx.listener.positionX) {
            ctx.listener.positionX.setTargetAtTime(x, now, 0.05);
            ctx.listener.positionY.setTargetAtTime(y, now, 0.05);
            ctx.listener.positionZ.setTargetAtTime(z, now, 0.05);
        } else {
            ctx.listener.setPosition(x, y, z);
        }

        // 2. Вектор направления взгляда в координатах Minecraft:
        // yaw 0 = +Z (Юг), yaw 90 = -X (Запад), yaw 180 = -Z (Север), yaw 270 = +X (Восток)
        const yawRad = yaw * (Math.PI / 180.0);
        const pitchRad = pitch * (Math.PI / 180.0);

        const cosPitch = Math.cos(pitchRad);
        const fwdX = -Math.sin(yawRad) * cosPitch;
        const fwdY = -Math.sin(pitchRad);
        const fwdZ = Math.cos(yawRad) * cosPitch;

        // Вектор "Верх" (перпендикулярен направлению взгляда)
        const upX = -Math.sin(yawRad) * -Math.sin(pitchRad);
        const upY = Math.cos(pitchRad);
        const upZ = Math.cos(yawRad) * -Math.sin(pitchRad);

        if (ctx.listener.forwardX) {
            ctx.listener.forwardX.setTargetAtTime(fwdX, now, 0.05);
            ctx.listener.forwardY.setTargetAtTime(fwdY, now, 0.05);
            ctx.listener.forwardZ.setTargetAtTime(fwdZ, now, 0.05);
            ctx.listener.upX.setTargetAtTime(upX, now, 0.05);
            ctx.listener.upY.setTargetAtTime(upY, now, 0.05);
            ctx.listener.upZ.setTargetAtTime(upZ, now, 0.05);
        } else {
            ctx.listener.setOrientation(fwdX, fwdY, fwdZ, upX, upY, upZ);
        }
    }

    /**
     * Обновление позиции удаленного игрока и расчет акустики
     */
    updateRemotePlayer(userId, x, y, z, dimension, inCave) {
        const chain = this.chains.get(userId);
        if (!chain || !this.am.audioCtx) return;

        const ctx = this.am.audioCtx;
        const now = ctx.currentTime;

        chain.lastPos = { x, y, z, dimension, inCave };

        // Разные измерения (например Оверворлд и Незер) -> только рация
        const isDifferentDim = dimension !== this.listenerPos.dimension;

        // Расчет 3D-дистанции
        const dx = x - this.listenerPos.x;
        const dy = y - this.listenerPos.y;
        const dz = z - this.listenerPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (isDifferentDim || dist > this.maxProximityDistance) {
            // Вне зоны видимости -> включаем рацию (Walkie-Talkie), отключаем 3D-звук
            chain.directGain.gain.setValueAtTime(0.0, now);
            chain.reverbGain.gain.setValueAtTime(0.0, now);
            chain.radioGain.gain.setTargetAtTime(0.85, now, 0.05);
        } else {
            // В зоне слышимости -> позиционный 3D звук
            chain.radioGain.gain.setValueAtTime(0.0, now);
            chain.directGain.gain.setTargetAtTime(1.0, now, 0.05);

            // Позиционирование источника
            if (chain.panner.positionX) {
                chain.panner.positionX.setTargetAtTime(x, now, 0.04);
                chain.panner.positionY.setTargetAtTime(y, now, 0.04);
                chain.panner.positionZ.setTargetAtTime(z, now, 0.04);
            } else {
                chain.panner.setPosition(x, y, z);
            }

            // Эхо пещеры: если оба или говорящий находятся в пещере
            const reverbAmount = (inCave || this.listenerPos.inCave) ? 0.45 : 0.0;
            chain.reverbGain.gain.setTargetAtTime(reverbAmount, now, 0.1);
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