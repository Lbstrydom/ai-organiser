/**
 * Audio Player Enhancer
 *
 * Markdown post-processor that adds playback-speed controls to Obsidian's
 * native `<audio>` embeds (from wikilinks like `![[file.wav]]` or
 * `![[file.mp3]]`). Obsidian's default `<audio controls>` gives the browser
 * chrome — play / pause / seek / volume — but NO visible speed control on
 * most platforms (the browser property `playbackRate` exists but is hidden).
 *
 * We render a small button row below each audio element with 6 preset
 * speeds. The active speed is highlighted. State lives on the <audio>
 * element's `playbackRate` property so Obsidian's own render-cache doesn't
 * lose it between renders.
 */

const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const DEFAULT_SPEED = 1;
const ENHANCED_ATTR = 'data-ai-organiser-speed-controls';

/**
 * Enhance all `<audio>` elements in a container with speed-control buttons.
 * Idempotent — skips elements already enhanced. Meant to be called from
 * a Markdown post-processor.
 */
export function enhanceAudioPlayersIn(container: HTMLElement): void {
    const audios = container.querySelectorAll<HTMLAudioElement>('audio');
    audios.forEach((audio) => {
        if (audio.getAttribute(ENHANCED_ATTR) === 'true') return;
        audio.setAttribute(ENHANCED_ATTR, 'true');

        const wrapper = createSpeedControls(audio);
        // Place controls immediately after the audio element so they stay
        // visually associated with their player even when multiple are
        // present on the same page.
        audio.insertAdjacentElement('afterend', wrapper);
    });
}

function createSpeedControls(audio: HTMLAudioElement): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-organiser-audio-speed-controls';

    const label = document.createElement('span');
    label.className = 'ai-organiser-audio-speed-label';
    label.textContent = 'Speed:';
    wrapper.appendChild(label);

    const buttons: HTMLButtonElement[] = [];

    for (const speed of PLAYBACK_SPEEDS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-organiser-audio-speed-btn';
        btn.textContent = formatSpeedLabel(speed);
        btn.setAttribute('aria-label', `Set playback speed to ${speed}×`);
        btn.setAttribute('data-speed', String(speed));
        if (speed === DEFAULT_SPEED) btn.classList.add('is-active');
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            audio.playbackRate = speed;
            // Highlight the active button, clear the others
            for (const b of buttons) b.classList.remove('is-active');
            btn.classList.add('is-active');
        });
        buttons.push(btn);
        wrapper.appendChild(btn);
    }

    // If Obsidian re-renders the audio (e.g. metadata reload) and the
    // playbackRate is reset to 1, reflect that in the UI.
    audio.addEventListener('ratechange', () => {
        const rate = audio.playbackRate;
        for (const b of buttons) {
            const btnSpeed = Number.parseFloat(b.dataset.speed || '1');
            b.classList.toggle('is-active', Math.abs(btnSpeed - rate) < 0.01);
        }
    });

    return wrapper;
}

function formatSpeedLabel(speed: number): string {
    // 1 → "1×" ; 1.5 → "1.5×" (no trailing zeros)
    return `${speed}\u00d7`;
}
