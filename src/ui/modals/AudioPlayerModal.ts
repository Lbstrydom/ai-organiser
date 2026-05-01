/**
 * AudioPlayerModal — focused player for narrated mp3 files with the controls
 * Obsidian's native HTML5 audio renderer doesn't expose:
 *   - Playback speed pills (0.75× / 1× / 1.25× / 1.5× / 2×)
 *   - Skip-back 15s + skip-forward 30s buttons
 *
 * Why this exists: persona walk (Pat — director, drives while listening to
 * narrated travel notes) found that the inline `![[narration.mp3]]` embed
 * gives play/pause/scrub/volume but NO speed and NO skip. Recommending a
 * community plugin ("Audio Player Plus") solves the problem for power users
 * but Pat won't install plugins. This modal is a one-click escape hatch
 * surfaced from the success Notice.
 *
 * Loads the mp3 by resourcePath (works for vault files; safe for Electron
 * + mobile WebView). No re-encoding, no streaming server — just a richer
 * `<audio>` wrapper.
 */

import { App, Modal, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';

const PLAYBACK_RATES = [0.75, 1.0, 1.25, 1.5, 2.0] as const;
const SKIP_BACK_SEC = 15;
const SKIP_FORWARD_SEC = 30;

export class AudioPlayerModal extends Modal {
    private audioEl!: HTMLAudioElement;
    private rateButtons: HTMLButtonElement[] = [];

    constructor(
        app: App,
        private readonly plugin: AIOrganiserPlugin,
        private readonly file: TFile,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        const t = this.plugin.t.modals.audioPlayer;

        contentEl.empty();
        contentEl.addClass('ai-organiser-modal-content');
        contentEl.addClass('ai-organiser-audio-player-modal');

        contentEl.createEl('h2', { text: t.title });
        contentEl.createDiv({
            cls: 'ai-organiser-audio-player-filename',
            text: this.file.basename,
        });

        // Native audio element — supplies play/pause/scrub/volume/time
        this.audioEl = contentEl.createEl('audio', { cls: 'ai-organiser-audio-player-audio' });
        this.audioEl.controls = true;
        this.audioEl.preload = 'metadata';
        this.audioEl.src = this.app.vault.getResourcePath(this.file);
        this.audioEl.playbackRate = 1.0;

        // ── Skip controls ────────────────────────────────────────────────
        const skipRow = contentEl.createDiv({ cls: 'ai-organiser-audio-player-row' });
        const backBtn = skipRow.createEl('button', {
            cls: 'ai-organiser-audio-player-skip',
            text: t.skipBack.replace('{sec}', String(SKIP_BACK_SEC)),
        });
        backBtn.addEventListener('click', () => {
            this.audioEl.currentTime = Math.max(0, this.audioEl.currentTime - SKIP_BACK_SEC);
        });

        const forwardBtn = skipRow.createEl('button', {
            cls: 'ai-organiser-audio-player-skip',
            text: t.skipForward.replace('{sec}', String(SKIP_FORWARD_SEC)),
        });
        forwardBtn.addEventListener('click', () => {
            const dur = this.audioEl.duration;
            const target = this.audioEl.currentTime + SKIP_FORWARD_SEC;
            this.audioEl.currentTime = isNaN(dur) ? target : Math.min(dur, target);
        });

        // ── Speed pills ──────────────────────────────────────────────────
        const speedRow = contentEl.createDiv({ cls: 'ai-organiser-audio-player-row' });
        speedRow.createSpan({
            cls: 'ai-organiser-audio-player-speed-label',
            text: t.speedLabel,
        });
        for (const rate of PLAYBACK_RATES) {
            const btn = speedRow.createEl('button', {
                cls: 'ai-organiser-audio-player-rate',
                text: `${rate}×`,
            });
            if (rate === 1.0) btn.addClass('is-active');
            btn.addEventListener('click', () => {
                this.audioEl.playbackRate = rate;
                for (const b of this.rateButtons) b.removeClass('is-active');
                btn.addClass('is-active');
            });
            this.rateButtons.push(btn);
        }

        // ── Open externally fallback (mobile system player has lock-screen widget) ──
        const externalRow = contentEl.createDiv({ cls: 'ai-organiser-audio-player-row' });
        const externalBtn = externalRow.createEl('button', {
            cls: 'ai-organiser-audio-player-external',
            text: t.openExternal,
        });
        externalBtn.addEventListener('click', () => {
            this.audioEl.pause();
            this.close();
            void this.app.workspace.openLinkText(this.file.path, '', false);
        });
    }

    onClose(): void {
        try { this.audioEl?.pause(); } catch { /* noop */ }
        this.contentEl.empty();
    }
}
