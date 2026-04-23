/**
 * StatusBarBroker
 * ---------------
 * Singleton that owns the shared status-bar element and arbitrates concurrent
 * reporters via a ticket stack. Fixes H2: before this, two overlapping
 * reporters would race to mutate the same global DOM text.
 *
 * Semantics:
 *   - Each reporter acquires one ticket on construction.
 *   - The top-of-stack ticket owns the visible text.
 *   - Releasing the top ticket reveals the prior one's text.
 *   - Watchdog: a ticket pinged via heartbeat() stays alive forever; a ticket
 *     that goes 3 min with no heartbeat + no release is assumed leaked and
 *     force-released.
 */

import type AIOrganiserPlugin from '../../main';
import { logger } from '../../utils/logger';

const ACTIVE_CLASS = 'ai-organiser-busy-active';
const WATCHDOG_MS = 3 * 60 * 1000;
const MIN_DISPLAY_MS = 400;

export interface StatusBarTicket {
    update(text: string): void;
    heartbeat(): void;
    release(): void;
}

interface Ticket extends StatusBarTicket {
    readonly id: number;
    text: string;
    lastBeatAt: number;
    watchdogTimer: ReturnType<typeof setTimeout> | null;
    released: boolean;
}

class Broker {
    private stack: Ticket[] = [];
    private nextId = 1;
    private el: HTMLElement | null = null;
    private fallbackLabel = 'AI processing…';
    private firstShownAt = 0;
    private hideTimer: ReturnType<typeof setTimeout> | null = null;

    acquire(plugin: AIOrganiserPlugin, initialText: string): StatusBarTicket {
        this.el = plugin.busyStatusBarEl ?? null;
        this.fallbackLabel = plugin.t?.messages?.aiProcessing ?? this.fallbackLabel;

        const ticket: Ticket = {
            id: this.nextId++,
            text: initialText || this.fallbackLabel,
            lastBeatAt: Date.now(),
            watchdogTimer: null,
            released: false,
            update: (text: string) => this.updateTicket(ticket, text),
            heartbeat: () => this.heartbeatTicket(ticket),
            release: () => this.releaseTicket(ticket),
        };
        this.armWatchdog(ticket);
        this.stack.push(ticket);
        if (this.stack.length === 1) this.firstShownAt = Date.now();
        this.renderTop();
        return ticket;
    }

    private updateTicket(ticket: Ticket, text: string): void {
        if (ticket.released) return;
        ticket.text = text;
        ticket.lastBeatAt = Date.now();
        this.armWatchdog(ticket);
        if (this.top() === ticket) this.renderTop();
    }

    private heartbeatTicket(ticket: Ticket): void {
        if (ticket.released) return;
        ticket.lastBeatAt = Date.now();
        this.armWatchdog(ticket);
    }

    private releaseTicket(ticket: Ticket): void {
        if (ticket.released) return;
        ticket.released = true;
        if (ticket.watchdogTimer) {
            clearTimeout(ticket.watchdogTimer);
            ticket.watchdogTimer = null;
        }
        this.stack = this.stack.filter(t => t.id !== ticket.id);
        this.renderTop();
    }

    private armWatchdog(ticket: Ticket): void {
        if (ticket.watchdogTimer) clearTimeout(ticket.watchdogTimer);
        ticket.watchdogTimer = setTimeout(() => {
            if (ticket.released) return;
            logger.warn('StatusBarBroker', `watchdog force-released ticket ${ticket.id} after ${WATCHDOG_MS / 1000}s of silence — likely leaked`);
            this.releaseTicket(ticket);
        }, WATCHDOG_MS);
    }

    private top(): Ticket | null {
        return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
    }

    private renderTop(): void {
        if (!this.el) return;
        const top = this.top();
        if (top) {
            if (this.hideTimer) {
                clearTimeout(this.hideTimer);
                this.hideTimer = null;
            }
            this.el.setText(top.text);
            this.el.addClass(ACTIVE_CLASS);
        } else {
            const elapsed = Date.now() - this.firstShownAt;
            const remaining = MIN_DISPLAY_MS - elapsed;
            if (remaining > 0) {
                this.hideTimer = setTimeout(() => {
                    this.hideTimer = null;
                    if (this.stack.length === 0 && this.el) this.el.removeClass(ACTIVE_CLASS);
                }, remaining);
            } else {
                this.el.removeClass(ACTIVE_CLASS);
            }
        }
    }

    /** Test-only: wipe state. */
    _reset(): void {
        for (const t of this.stack) {
            if (t.watchdogTimer) clearTimeout(t.watchdogTimer);
        }
        this.stack = [];
        if (this.hideTimer) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
        if (this.el) this.el.removeClass(ACTIVE_CLASS);
    }
}

export const statusBarBroker = new Broker();

/** Test-only export for resetting singleton state between tests. */
export function __resetStatusBarBroker(): void {
    statusBarBroker._reset();
}
