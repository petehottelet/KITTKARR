/* Revision 2. Advance the Mac playback position with a monotonic browser clock. */
(function (root) {
  'use strict';

  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

  function rms(samples) {
    if (!samples.length) return 0;
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }

  function amplitudeToLevel(amplitude, sensitivity = 1) {
    if (!Number.isFinite(amplitude) || amplitude <= 0.003) return 0;
    const db = 20 * Math.log10(amplitude);
    return clamp(((db + 48) / 40) * sensitivity);
  }

  function smoothLevel(previous, target, deltaSeconds) {
    const timeConstant = target > previous ? 0.025 : 0.115;
    const result = previous + (target - previous) * (1 - Math.exp(-Math.max(0, deltaSeconds) / timeConstant));
    return result < 0.005 ? 0 : clamp(result);
  }

  function segmentIntensity(level, index, count = 20) {
    if (level <= 0) return 0;
    const distance = Math.abs(index + 0.5 - count / 2) / (count / 2);
    return clamp((level - distance) * 9);
  }

  function speechAmplitude(speech, elapsed) {
    if (!speech || elapsed < 0 || elapsed >= speech.durationMs || !(speech.stepMs > 0)) return 0;
    const position = Math.max(0, elapsed / speech.stepMs - .5), index = Math.floor(position);
    const a = speech.levels[index] || 0, b = speech.levels[index + 1] || 0;
    return a + (b - a) * (position - index);
  }

  function speechPosition(speech, serverTime, receivedAt, now) {
    if (!speech) return -1;
    const sinceReceipt = Math.max(0, now - receivedAt);
    if (Number.isFinite(speech.positionMs) && Number.isFinite(speech.updatedAt)) {
      return speech.positionMs + Math.max(0, serverTime - speech.updatedAt) + sinceReceipt;
    }
    return serverTime - speech.startedAt + sinceReceipt;
  }

  function smoothSpeechLevel(previous, target, deltaSeconds) {
    const seconds = target > previous ? .018 : .065;
    const result = previous + (target - previous) * (1 - Math.exp(-Math.max(0, deltaSeconds) / seconds));
    return result < .005 ? 0 : clamp(result);
  }

  function segmentColor(level, index, count = 20) {
    const distance = Math.abs(index + 0.5 - count / 2) / (count / 2);
    const heat = clamp((level - distance) / Math.max(.12, level * .62));
    const stops = [[255, 48, 35], [255, 132, 45], [255, 224, 105], [255, 255, 233]];
    const position = heat * (stops.length - 1);
    const start = Math.min(Math.floor(position), stops.length - 2);
    const mix = position - start;
    const channels = stops[start].map((value, channel) => Math.round(value + (stops[start + 1][channel] - value) * mix));
    return `rgb(${channels.join(',')})`;
  }

  function formatTime(seconds) {
    const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function createDemoWav() {
    const sampleRate = 22050;
    const seconds = 10;
    const frames = sampleRate * seconds;
    const buffer = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buffer);
    const text = (offset, value) => {
      for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + frames * 2, true);
    text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, frames * 2, true);
    let phase = 0;
    for (let index = 0; index < frames; index++) {
      const time = index / sampleRate;
      const phrase = time % 2.5;
      const syllable = (phrase * 3.4) % 1;
      const gate = phrase > 0.2 && phrase < 1.98;
      const envelope = gate ? Math.sin(Math.PI * syllable) ** 2 : 0;
      const frequency = 118 + 22 * Math.sin(time * 2.9) + 12 * Math.sin(time * 8);
      phase += 2 * Math.PI * frequency / sampleRate;
      const voice = Math.sin(phase) * .52 + Math.sin(phase * 2) * .24 + Math.sin(phase * 4) * .14 + Math.sin(phase * 7) * .06;
      const fade = Math.min(1, time * 10, (seconds - time) * 10);
      const sample = voice * envelope * (.27 + .14 * Math.sin(time * 1.5) ** 2) * fade;
      view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
    }
    return buffer;
  }

  const api = { clamp, rms, amplitudeToLevel, smoothLevel, speechAmplitude, speechPosition, smoothSpeechLevel, segmentIntensity, segmentColor, formatTime, createDemoWav };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KittSignal = api;
})(globalThis);
