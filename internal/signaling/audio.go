package signaling

import (
	"encoding/binary"
	"math"
	"sync"
)

const (
	// Аудио спецификация
	SampleRate      = 16000 // 16 kHz: стандарт для передачи голоса
	FrameDurationMs = 20    // 20 мс квант аудио
	SamplesPerFrame = 320   // 16000 * 0.02 = 320 сэмплов
	BytesPerFrame   = 640   // 320 сэмплов * 2 байта (Int16)
	MaxSenderIDLen  = 128   // Максимальная длина ID для заголовка пакета

	// Параметры фильтрации и гейта (откалиброваны для естественной речи)
	HighPassCutoffFreq = 85.0   // 85 Гц сохраняет плотность голоса и разборчивость
	HighPassQ          = 0.707  // Добротность фильтра Баттерворта
	NoiseGateThreshold = 0.0035 // Мягкий порог (не срезает тихие согласные и шёпот)
	SpeechThreshold    = 0.008  // Порог для работы AGC
	VADHangoverFrames  = 28     // 560 мс удержание хвоста (окончания слов не глотаются)
	TargetRMS          = 0.13   // Целевой уровень RMS для AGC
	MaxGainMultiplier  = 2.2    // Максимальное адаптивное усиление
)

// =============================================================================
// Пул буферов памяти (Zero-Allocation)
// =============================================================================

var pcmSamplePool = sync.Pool{
	New: func() any {
		s := make([]float32, SamplesPerFrame)
		return &s
	},
}

// =============================================================================
// DSP: Biquad Filter (HighPass, LowPass, BandPass)
// =============================================================================

type BiquadFilter struct {
	b0, b1, b2 float32
	a1, a2     float32
	x1, x2     float32
	y1, y2     float32
}

func newHighPassFilter(sampleRate, cutoff, q float64) *BiquadFilter {
	w0 := 2.0 * math.Pi * cutoff / sampleRate
	cosW0 := math.Cos(w0)
	sinW0 := math.Sin(w0)
	alpha := sinW0 / (2.0 * q)

	b0 := (1.0 + cosW0) / 2.0
	b1 := -(1.0 + cosW0)
	b2 := (1.0 + cosW0) / 2.0
	a0 := 1.0 + alpha
	a1 := -2.0 * cosW0
	a2 := 1.0 - alpha

	return &BiquadFilter{
		b0: float32(b0 / a0),
		b1: float32(b1 / a0),
		b2: float32(b2 / a0),
		a1: float32(a1 / a0),
		a2: float32(a2 / a0),
	}
}

func newLowPassFilter(sampleRate, cutoff, q float64) *BiquadFilter {
	w0 := 2.0 * math.Pi * cutoff / sampleRate
	cosW0 := math.Cos(w0)
	sinW0 := math.Sin(w0)
	alpha := sinW0 / (2.0 * q)

	b0 := (1.0 - cosW0) / 2.0
	b1 := 1.0 - cosW0
	b2 := (1.0 - cosW0) / 2.0
	a0 := 1.0 + alpha
	a1 := -2.0 * cosW0
	a2 := 1.0 - alpha

	return &BiquadFilter{
		b0: float32(b0 / a0),
		b1: float32(b1 / a0),
		b2: float32(b2 / a0),
		a1: float32(a1 / a0),
		a2: float32(a2 / a0),
	}
}

func newBandPassFilter(sampleRate, centerFreq, q float64) *BiquadFilter {
	w0 := 2.0 * math.Pi * centerFreq / sampleRate
	cosW0 := math.Cos(w0)
	sinW0 := math.Sin(w0)
	alpha := sinW0 / (2.0 * q)

	b0 := alpha
	b1 := 0.0
	b2 := -alpha
	a0 := 1.0 + alpha
	a1 := -2.0 * cosW0
	a2 := 1.0 - alpha

	return &BiquadFilter{
		b0: float32(b0 / a0),
		b1: float32(b1 / a0),
		b2: float32(b2 / a0),
		a1: float32(a1 / a0),
		a2: float32(a2 / a0),
	}
}

func (f *BiquadFilter) Process(in []float32, out []float32) {
	for i := 0; i < len(in); i++ {
		x0 := in[i]
		y0 := f.b0*x0 + f.b1*f.x1 + f.b2*f.x2 - f.a1*f.y1 - f.a2*f.y2

		f.x2 = f.x1
		f.x1 = x0
		f.y2 = f.y1
		f.y1 = y0

		out[i] = y0
	}
}

func (f *BiquadFilter) Reset() {
	f.x1, f.x2, f.y1, f.y2 = 0, 0, 0, 0
}

// =============================================================================
// DSP Pipeline Клиента
// =============================================================================

type AudioProcessor struct {
	hpFilter      *BiquadFilter
	hangoverCount int
	isSpeaking    bool
	currentGain   float32
	gateEnvelope  float32
	activeFilter  string

	radioHPFilter *BiquadFilter
	radioLPFilter *BiquadFilter
	megaphoneBP   *BiquadFilter
	demonLPFilter *BiquadFilter
	modPhase      float64
}

func NewAudioProcessor() *AudioProcessor {
	return &AudioProcessor{
		hpFilter:      newHighPassFilter(SampleRate, HighPassCutoffFreq, HighPassQ),
		currentGain:   1.0,
		gateEnvelope:  0.0,
		activeFilter:  "none",
		radioHPFilter: newHighPassFilter(SampleRate, 400.0, 0.707),
		radioLPFilter: newLowPassFilter(SampleRate, 2600.0, 0.707),
		megaphoneBP:   newBandPassFilter(SampleRate, 1200.0, 1.8),
		demonLPFilter: newLowPassFilter(SampleRate, 600.0, 0.8),
	}
}

func (p *AudioProcessor) SetVoiceFilter(filterName string) {
	p.activeFilter = filterName
}

func (p *AudioProcessor) ProcessFrame(samples []float32) bool {
	n := len(samples)
	if n == 0 {
		return false
	}

	// 1. Мягкая High-Pass фильтрация инфранизкого гула
	p.hpFilter.Process(samples, samples)

	// 2. Расчет энергии RMS
	var sum float32
	for i := 0; i < n; i++ {
		sum += samples[i] * samples[i]
	}
	rms := float32(math.Sqrt(float64(sum / float32(n))))

	// 3. VAD с продленным удержанием
	var targetGate float32
	if rms >= NoiseGateThreshold {
		p.hangoverCount = VADHangoverFrames
		p.isSpeaking = true
		targetGate = 1.0
	} else if p.hangoverCount > 0 {
		p.hangoverCount--
		p.isSpeaking = true
		targetGate = 1.0
	} else {
		p.isSpeaking = false
		targetGate = 0.0
	}

	// Сброс тишины при полном закрытии
	if !p.isSpeaking && p.gateEnvelope < 0.005 {
		p.gateEnvelope = 0.0
		for i := 0; i < n; i++ {
			samples[i] = 0
		}
		return false
	}

	// 4. AGC: адаптивное выравнивание громкости
	if rms >= SpeechThreshold {
		desiredGain := TargetRMS / rms
		if desiredGain > MaxGainMultiplier {
			desiredGain = MaxGainMultiplier
		} else if desiredGain < 0.6 {
			desiredGain = 0.6
		}
		p.currentGain = p.currentGain*0.96 + desiredGain*0.04
	}

	// 5. Применение голосовых фильтров
	p.applyVoiceEffects(samples)

	// 6. Быстрая атака (0 задержки на первые буквы) и плавный релиз
	var envStep float32
	if targetGate > p.gateEnvelope {
		envStep = 0.35 // Мгновенное открытие на первый согласный
	} else {
		envStep = 0.015 // Очень плавное угасание хвоста
	}

	for i := 0; i < n; i++ {
		p.gateEnvelope += (targetGate - p.gateEnvelope) * envStep
		val := samples[i] * p.currentGain * p.gateEnvelope

		// Soft Limiter
		if val > 1.0 {
			val = 1.0
		} else if val < -1.0 {
			val = -1.0
		} else {
			val = val - (val * val * val / 6.0)
		}
		samples[i] = val
	}

	return true
}

func (p *AudioProcessor) applyVoiceEffects(samples []float32) {
	n := len(samples)
	twoPi := 2.0 * math.Pi

	switch p.activeFilter {
	case "radio":
		p.radioHPFilter.Process(samples, samples)
		p.radioLPFilter.Process(samples, samples)
		for i := 0; i < n; i++ {
			s := samples[i] * 2.2
			if s > 0.8 {
				s = 0.8
			} else if s < -0.8 {
				s = -0.8
			}
			samples[i] = s
		}

	case "robot":
		freq := 50.0
		phaseStep := (twoPi * freq) / SampleRate
		for i := 0; i < n; i++ {
			carrier := float32(math.Sin(p.modPhase))
			samples[i] = samples[i] * carrier * 1.4
			p.modPhase += phaseStep
			if p.modPhase > twoPi {
				p.modPhase -= twoPi
			}
		}

	case "megaphone":
		p.megaphoneBP.Process(samples, samples)
		for i := 0; i < n; i++ {
			s := samples[i] * 3.0
			if s > 0.6 {
				s = 0.6
			} else if s < -0.6 {
				s = -0.6
			}
			samples[i] = s * 1.5
		}

	case "demon":
		p.demonLPFilter.Process(samples, samples)
		freq := 28.0
		phaseStep := (twoPi * freq) / SampleRate
		for i := 0; i < n; i++ {
			carrier := 0.7 + 0.3*float32(math.Sin(p.modPhase))
			samples[i] = samples[i] * carrier * 1.8
			p.modPhase += phaseStep
			if p.modPhase > twoPi {
				p.modPhase -= twoPi
			}
		}
	}
}

func (p *AudioProcessor) Reset() {
	p.hpFilter.Reset()
	p.radioHPFilter.Reset()
	p.radioLPFilter.Reset()
	p.megaphoneBP.Reset()
	p.demonLPFilter.Reset()
	p.hangoverCount = 0
	p.isSpeaking = false
	p.currentGain = 1.0
	p.gateEnvelope = 0.0
	p.modPhase = 0
}

// =============================================================================
// AudioClient и AudioHub
// =============================================================================

type AudioClient struct {
	ID        string
	UserID    string
	SendFn    func([]byte)
	IsMuted   bool
	Processor *AudioProcessor
	mu        sync.RWMutex
}

func NewAudioClient(id, userID string, sendFn func([]byte)) *AudioClient {
	return &AudioClient{
		ID:        id,
		UserID:    userID,
		SendFn:    sendFn,
		IsMuted:   false,
		Processor: NewAudioProcessor(),
	}
}

func (c *AudioClient) SetMute(muted bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.IsMuted = muted
	if muted {
		c.Processor.Reset()
	}
}

func (c *AudioClient) GetMute() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.IsMuted
}

func (c *AudioClient) SetVoiceFilter(filterName string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Processor.SetVoiceFilter(filterName)
}

type AudioHub struct {
	mu      sync.RWMutex
	clients map[string]*AudioClient
}

func NewAudioHub() *AudioHub {
	return &AudioHub{
		clients: make(map[string]*AudioClient),
	}
}

func (h *AudioHub) AddClient(client *AudioClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[client.ID] = client
}

func (h *AudioHub) RemoveClient(clientID string) {
	h.mu.Lock()
	delete(h.clients, clientID)
	h.mu.Unlock()
}

func (h *AudioHub) GetClient(clientID string) *AudioClient {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.clients[clientID]
}

func (h *AudioHub) ProcessAndBroadcast(senderID string, rawPCM []byte) {
	if len(rawPCM) < BytesPerFrame {
		return
	}

	h.mu.RLock()
	sender, senderExists := h.clients[senderID]
	h.mu.RUnlock()

	if !senderExists || sender.GetMute() {
		return
	}

	floatBufPtr := pcmSamplePool.Get().(*[]float32)
	floatBuf := *floatBufPtr
	defer pcmSamplePool.Put(floatBufPtr)

	sampleCount := len(rawPCM) / 2
	if sampleCount > SamplesPerFrame {
		sampleCount = SamplesPerFrame
	}

	for i := 0; i < sampleCount; i++ {
		rawSample := int16(binary.LittleEndian.Uint16(rawPCM[i*2 : i*2+2]))
		floatBuf[i] = float32(rawSample) / 32768.0
	}

	hasVoice := sender.Processor.ProcessFrame(floatBuf[:sampleCount])
	if !hasVoice {
		return
	}

	userIDBytes := []byte(sender.UserID)
	userIDLen := len(userIDBytes)
	if userIDLen > MaxSenderIDLen {
		userIDLen = MaxSenderIDLen
		userIDBytes = userIDBytes[:MaxSenderIDLen]
	}

	var padding int
	if userIDLen%2 != 0 {
		padding = 1
	}

	pcmOffset := 2 + userIDLen + padding
	totalPacketSize := pcmOffset + (sampleCount * 2)
	outPacket := make([]byte, totalPacketSize)

	binary.BigEndian.PutUint16(outPacket[0:2], uint16(userIDLen))
	copy(outPacket[2:2+userIDLen], userIDBytes)

	for i := 0; i < sampleCount; i++ {
		s := floatBuf[i]
		if s > 1.0 {
			s = 1.0
		} else if s < -1.0 {
			s = -1.0
		}

		var val int16
		if s < 0 {
			val = int16(s * 32768.0)
		} else {
			val = int16(s * 32767.0)
		}
		binary.LittleEndian.PutUint16(outPacket[pcmOffset+i*2:pcmOffset+i*2+2], uint16(val))
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for id, client := range h.clients {
		if id != senderID && client.SendFn != nil {
			client.SendFn(outPacket)
		}
	}
}

func (h *AudioHub) GetClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
