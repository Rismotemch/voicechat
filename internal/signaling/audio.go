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

	// Параметры DSP
	HighPassCutoffFreq = 80.0  // Частота среза High-Pass фильтра в Гц
	HighPassQ          = 0.707 // Добротность фильтра Баттерворта
	VADEnergyThreshold = 0.008 // Минимальный порог RMS для детекции речи
	VADHangoverFrames  = 10    // Удержание VAD (10 фреймов = 200 мс)
	TargetRMS          = 0.12  // Целевой уровень RMS для компрессора/AGC
	MaxGainMultiplier  = 3.0   // Максимальное усиление слабого сигнала
)

// =============================================================================
// Пул буферов памяти (Zero-Allocation во время непрерывного аудиопотока)
// =============================================================================

var (
	pcmSamplePool = sync.Pool{
		New: func() any {
			s := make([]float32, SamplesPerFrame)
			return &s
		},
	}
)

// =============================================================================
// DSP: Biquad High-Pass Filter (2-й порядок Баттерворта)
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
// DSP Pipeline Клиента (Фильтрация, VAD, AGC, Soft Limiting)
// =============================================================================

type AudioProcessor struct {
	hpFilter      *BiquadFilter
	hangoverCount int
	isSpeaking    bool
	currentGain   float32
}

func NewAudioProcessor() *AudioProcessor {
	return &AudioProcessor{
		hpFilter:    newHighPassFilter(SampleRate, HighPassCutoffFreq, HighPassQ),
		currentGain: 1.0,
	}
}

// ProcessFrame выполняет полную цепочку улучшения голоса на PCM-сэмплах
func (p *AudioProcessor) ProcessFrame(samples []float32) bool {
	n := len(samples)
	if n == 0 {
		return false
	}

	// 1. High-Pass фильтр (удаление низкочастотного гула микрофона)
	p.hpFilter.Process(samples, samples)

	// 2. Расчет среднеквадратичной энергии (RMS)
	var sum float32
	for i := 0; i < n; i++ {
		sum += samples[i] * samples[i]
	}
	rms := float32(math.Sqrt(float64(sum / float32(n))))

	// 3. VAD с таймером Hangover для предотвращения срезания окончаний слов
	if rms >= VADEnergyThreshold {
		p.hangoverCount = VADHangoverFrames
		p.isSpeaking = true
	} else if p.hangoverCount > 0 {
		p.hangoverCount--
		p.isSpeaking = true
	} else {
		p.isSpeaking = false
		for i := 0; i < n; i++ {
			samples[i] = 0
		}
		return false
	}

	// 4. AGC (Automatic Gain Control)
	if rms > 0.001 {
		desiredGain := TargetRMS / rms
		if desiredGain > MaxGainMultiplier {
			desiredGain = MaxGainMultiplier
		} else if desiredGain < 0.5 {
			desiredGain = 0.5
		}
		// Плавная интерполяция громкости без резких скачков
		p.currentGain = p.currentGain*0.9 + desiredGain*0.1
	}

	// 5. Применение усиления и Soft Limiting (кубическая компрессия пиков)
	for i := 0; i < n; i++ {
		val := samples[i] * p.currentGain
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

func (p *AudioProcessor) Reset() {
	p.hpFilter.Reset()
	p.hangoverCount = 0
	p.isSpeaking = false
	p.currentGain = 1.0
}

// =============================================================================
// AudioClient и AudioHub
// =============================================================================

type AudioClient struct {
	ID        string
	UserID    string
	Send      chan []byte
	IsMuted   bool
	Processor *AudioProcessor
	mu        sync.RWMutex
}

func NewAudioClient(id, userID string, sendBufSize int) *AudioClient {
	return &AudioClient{
		ID:        id,
		UserID:    userID,
		Send:      make(chan []byte, sendBufSize),
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

// ProcessAndBroadcast обрабатывает PCM-фрейм и рассылает его подписчикам
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

	// 1. Извлечение сэмплов из пула
	floatBufPtr := pcmSamplePool.Get().(*[]float32)
	floatBuf := *floatBufPtr
	defer pcmSamplePool.Put(floatBufPtr)

	// 2. Декодирование Int16 Little-Endian в Float32 [-1.0 ... 1.0]
	sampleCount := len(rawPCM) / 2
	if sampleCount > SamplesPerFrame {
		sampleCount = SamplesPerFrame
	}

	for i := 0; i < sampleCount; i++ {
		rawSample := int16(binary.LittleEndian.Uint16(rawPCM[i*2 : i*2+2]))
		floatBuf[i] = float32(rawSample) / 32768.0
	}

	// 3. Серверная обработка DSP (High-Pass, VAD, AGC, Limiter)
	hasVoice := sender.Processor.ProcessFrame(floatBuf[:sampleCount])
	if !hasVoice {
		return
	}

	// 4. Формирование пакета с 2-byte alignment заголовка для клиентского Int16Array
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

	// Заголовок пакета: [uint16 Big-Endian: UserID Len] + [UserID Bytes] + [Padding]
	binary.BigEndian.PutUint16(outPacket[0:2], uint16(userIDLen))
	copy(outPacket[2:2+userIDLen], userIDBytes)

	// Кодирование Float32 обратно в Int16 Little-Endian с четного смещения
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

	// 5. Неблокирующий Broadcast всем участникам, кроме автора фрейма
	h.mu.RLock()
	defer h.mu.RUnlock()

	for id, client := range h.clients {
		if id != senderID {
			select {
			case client.Send <- outPacket:
			default:
				// Дроп устаревшего пакета при просадке канала (защита от задержек)
			}
		}
	}
}

func (h *AudioHub) GetClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
