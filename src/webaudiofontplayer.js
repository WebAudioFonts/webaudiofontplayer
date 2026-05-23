export default class WebAudioFontPlayer {

    #audioCtx = null;
    #compressor = null;
    #preset = null;

    #envelopes = [];
    #afterTime = 0.05;
    #nearZero = 0.000001;

    #bendRange = 2;

    #mainGain = null;
    #volumeValue = 0.7;
    #expressionValue = 1.0;
    #expressionGain = null;
    #sustain = false;
    #pitchBendValue = 8192;
    #notesWaitingForSustain = new Set();


    constructor(preset, audioCtx, compressor = null) {
        this.#audioCtx = audioCtx;
        this.#compressor = compressor;
        this.#preset = preset;
        this.#mainGain = this.#audioCtx.createGain();
        this.#mainGain.gain.setValueAtTime(this.#volumeValue, this.#audioCtx.currentTime);
        this.#expressionGain = this.#audioCtx.createGain();
        this.#expressionGain.gain.setValueAtTime(this.#expressionValue, this.#audioCtx.currentTime);
        this.#mainGain.connect(this.#expressionGain);
        this.#expressionGain.connect(this.#compressor ? this.#compressor.input : this.#audioCtx.destination);
        this.#preset.zones.map(zone => this.#adjustZone(zone));
    }

    get preset() { return this.#preset; }
    set preset(preset) {
        this.#preset = preset;
        this.#preset.zones.map(zone => this.#adjustZone(zone));
    }


    close() {
        const now = this.#audioCtx.currentTime;
        this.#envelopes.forEach(envelope => {
            try {
                envelope.gain.cancelScheduledValues(0);
                if (envelope.audioBufferSourceNode) {
                    envelope.audioBufferSourceNode.stop(now);
                    envelope.audioBufferSourceNode.disconnect();
                    envelope.audioBufferSourceNode = null;
                }
            } catch (e) {}
            try { envelope.disconnect(); } catch (e) { }
        });
        this.#envelopes = [];
        this.#notesWaitingForSustain.clear();
        try { this.#mainGain.disconnect(); } catch (e) { }
        try { this.#expressionGain.disconnect(); } catch (e) { }
        this.#mainGain = null;
        this.#expressionGain = null;
        this.#preset = null;
        this.#compressor = null;
        this.#audioCtx = null;
    }


    queueWaveTable(when, pitch, duration, volume, slides) {
        if (this.#audioCtx.state === 'suspended') this.#audioCtx.resume().catch(() => { });
        const vol = this.#limitVolume(volume);
        const zone = this.#findZone(Math.round(pitch));
        if (!zone?.buffer) return null;

        const baseDetuneCents = zone.originalPitch - 100.0 * zone.coarseTune - zone.fineTune;
        const originalPitchCents = pitch * 100;
        const currentBendCents = ((this.#pitchBendValue - 8192) / 8192) * this.#bendRange * 100;
        const totalCents = (originalPitchCents - baseDetuneCents) + currentBendCents;
        const playbackRate = Math.pow(2, totalCents / 1200.0);
        const startWhen = Math.max(when, this.#audioCtx.currentTime);
        let waveDuration = duration + this.#afterTime;

        const loop = zone.loopStart >= 1 && zone.loopStart < zone.loopEnd;
        if (!loop) waveDuration = Math.min(waveDuration, zone.buffer.duration / playbackRate);

        const envelope = this.#findEnvelope();
        this.#setupEnvelope(envelope, zone, vol, startWhen, waveDuration, duration);

        const source = this.#audioCtx.createBufferSource();
        source.buffer = zone.buffer;
        source.playbackRate.setValueAtTime(playbackRate, 0);

        if (slides?.length > 0) {
            source.playbackRate.setValueAtTime(playbackRate, startWhen);
            slides.forEach(s => {
                const slidePitchCents = (pitch + s.delta) * 100;
                const totalSlideCents = (slidePitchCents - baseDetuneCents) + currentBendCents;
                const newRate = Math.pow(2, totalSlideCents / 1200.0);
                source.playbackRate.linearRampToValueAtTime(newRate, startWhen + s.when);
            });
        }

        source.loop = loop;
        if (loop) {
            const d = zone.delay ?? 0;
            source.loopStart = zone.loopStart / zone.sampleRate + d;
            source.loopEnd = zone.loopEnd / zone.sampleRate + d;
        }

        source.connect(envelope);
        source.start(startWhen, zone.delay ?? 0);
        source.stop(startWhen + waveDuration);

        envelope.audioBufferSourceNode = source;
        envelope.when = startWhen;
        envelope.duration = waveDuration;
        envelope.pitch = pitch;
        envelope.baseDetune = baseDetuneCents;

        return envelope;
    }


    async cancelQueue() {
        this.#envelopes.forEach(e => {
            e.gain.cancelScheduledValues(0);
            e.gain.setValueAtTime(this.#nearZero, this.#audioCtx.currentTime);
            e.when = -1;
            try { e.audioBufferSourceNode?.disconnect(); } catch (e) { }
        });
    }


    isSustainActive() {
        return this.#sustain;
    }


    registerSustainNote(cancelFn) {
        this.#notesWaitingForSustain.add(cancelFn);
    }


    setPitchBend(value) {
        this.#pitchBendValue = value;
        const normalized = value - 8192;
        const semitones = normalized >= 0
            ? (normalized / 8191) * this.#bendRange
            : (normalized / 8192) * this.#bendRange;
        const now = this.#audioCtx.currentTime;
        this.#envelopes.forEach(e => {
            if (e.audioBufferSourceNode && e.when + e.duration > now) {
                const originalPitchCents = e.pitch * 100;
                const baseDetuneCents = e.baseDetune;
                const bendCents = semitones * 100;
                const totalCents = (originalPitchCents - baseDetuneCents) + bendCents;
                const newRate = Math.pow(2, totalCents / 1200.0);
                e.audioBufferSourceNode.playbackRate.cancelScheduledValues(now);
                e.audioBufferSourceNode.playbackRate.setTargetAtTime(newRate, now, 0.015);
            }
        });
    }


    setController(number, value) {
        const now = this.#audioCtx.currentTime;
        const normalizedValue = Math.max(0, Math.min(127, value)) / 127;
        switch (number) {
            case 7:
                this.#volumeValue = normalizedValue;
                this.#mainGain.gain.setTargetAtTime(this.#volumeValue, now, 0.05);
                break;
            case 11:
                this.#expressionValue = normalizedValue;
                this.#expressionGain.gain.setTargetAtTime(this.#expressionValue, now, 0.03);
                break;
            case 64:
                this.#sustain = value >= 64;
                if (!this.#sustain) {
                    this.#notesWaitingForSustain.forEach(cancelFn => cancelFn());
                    this.#notesWaitingForSustain.clear();
                }
                break;
        }
    }


    #adjustZone(zone) {
        if (zone.buffer) return Promise.resolve(zone);
        zone.delay = 0;

        if (zone.file) {
            const decoded = atob(zone.file);
            const uint8Array = new Uint8Array(decoded.length);
            for (let i = 0; i < decoded.length; i++) uint8Array[i] = decoded.charCodeAt(i);
            this.#audioCtx.decodeAudioData(
                uint8Array.buffer,
                audioBuffer => {
                    zone.buffer = audioBuffer;
                    this.#applyZoneParameters(zone);
                    return zone;
                },
                error => {
                    console.error("Audio decoding error:", error);
                    console.warn(this.#preset);
                    return false;
                }
            );
        } else {
            this.#applyZoneParameters(zone);
            return zone;
        }
    };


    #applyZoneParameters(zone) {
        zone.loopStart = this.#numValue(zone.loopStart, 0);
        zone.loopEnd = this.#numValue(zone.loopEnd, 0);
        zone.coarseTune = this.#numValue(zone.coarseTune, 0);
        zone.fineTune = this.#numValue(zone.fineTune, 0);
        zone.originalPitch = this.#numValue(zone.originalPitch, 6000);
    };


    #setupEnvelope(envelope, zone, volume, when, sampleDuration, noteDuration) {
        envelope.gain.setValueAtTime(this.#nearZero, this.#audioCtx.currentTime);
        const duration = Math.min(noteDuration, sampleDuration - this.#afterTime);
        const ahdsr = (zone.ahdsr && zone.ahdsr.length > 0) ? zone.ahdsr : [
            { duration: 0, volume: 1 },
            { duration: duration, volume: 1 }
        ];

        envelope.gain.cancelScheduledValues(when);
        const initialVol = (ahdsr[0]?.volume ?? 1) * volume;
        envelope.gain.linearRampToValueAtTime(this.#noZeroVolume(initialVol), when + 0.002);

        let lastTime = 0;
        let lastVolume = ahdsr[0]?.volume ?? 1;

        for (const stage of ahdsr) {
            const { duration: stageDuration, volume: stageVolume } = stage;
            if (stageDuration <= 0) continue;
            const remainingTime = duration - lastTime;
            if (stageDuration > remainingTime) {
                const ratio = remainingTime / stageDuration;
                const interpolatedVolume = lastVolume + ratio * (stageVolume - lastVolume);
                envelope.gain.exponentialRampToValueAtTime(
                    this.#noZeroVolume(volume * interpolatedVolume),
                    when + duration
                );
                break;
            }
            lastTime += stageDuration;
            lastVolume = stageVolume;
            envelope.gain.exponentialRampToValueAtTime(
                this.#noZeroVolume(volume * lastVolume),
                when + lastTime
            );
        }
        envelope.gain.exponentialRampToValueAtTime(this.#nearZero, when + duration + this.#afterTime);
    }


    #findEnvelope(destinationNode) {
        const target = destinationNode || this.#mainGain;
        const now = this.#audioCtx.currentTime;
        let envelope = this.#envelopes.find(e => e.target === target && now > e.when + e.duration + 0.05);
        if (!envelope && this.#envelopes.length >= 64) {
            const activeEnvelopes = this.#envelopes.filter(e => e.target === target);
            if (activeEnvelopes.length > 0) {
                activeEnvelopes.sort((a, b) => a.when - b.when);
                envelope = activeEnvelopes[0];
            }
        }
        if (envelope) {
            if (envelope.audioBufferSourceNode) {
                try {
                    envelope.audioBufferSourceNode.stop(0);
                    envelope.audioBufferSourceNode.disconnect();
                } catch (e) { }
                envelope.audioBufferSourceNode = null;
            }
            envelope.gain.cancelScheduledValues(0);
            envelope.gain.setValueAtTime(this.#nearZero, now);
        } else {
            envelope = this.#audioCtx.createGain();
            envelope.gain.value = 0;
            envelope.target = target;
            envelope.connect(target);
            this.#envelopes.push(envelope);
        }
        envelope.cancel = (force = false) => {
            const currentTime = this.#audioCtx.currentTime;
            if (force && envelope.audioBufferSourceNode) {
                try {
                    envelope.audioBufferSourceNode.stop(0);
                    envelope.audioBufferSourceNode.disconnect();
                } catch (e) { }
                envelope.audioBufferSourceNode = null;
            }
            if (envelope.when + envelope.duration > currentTime) {
                envelope.gain.cancelScheduledValues(0);
                envelope.gain.setTargetAtTime(this.#nearZero, currentTime, force ? 0.005 : 0.02);
                envelope.when = currentTime + 0.00001;
                envelope.duration = 0;
            }
        };
        return envelope;
    }


    #findZone(pitch) {
        const zone = this.#preset.zones.findLast(z => pitch >= z.keyRangeLow && pitch <= z.keyRangeHigh + 1);
        if (zone) this.#adjustZone(zone);
        return zone;
    };


    #limitVolume(v) {
        const requestedVolume = v ? 1.0 * v : 0.5;
        return Math.min(requestedVolume, 0.8);
    };


    #noZeroVolume(n) {
        return n > this.#nearZero ? n : this.#nearZero;
    }


    #numValue(a, b) {
        return typeof a === "number" ? a : b;
    }

}
