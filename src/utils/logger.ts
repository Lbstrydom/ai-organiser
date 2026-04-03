/**
 * Centralised logging utility for AI Organiser.
 * All logging goes through this singleton. Debug/warn output
 * is suppressed unless debugMode is enabled; errors always log.
 */

class Logger {
	private debugMode = false;

	setDebugMode(enabled: boolean): void {
		this.debugMode = enabled;
	}

	debug(tag: string, message: string, data?: unknown): void {
		if (this.debugMode) console.log(`[AI Organiser][${tag}] ${message}`, data ?? '');
	}

	warn(tag: string, message: string, data?: unknown): void {
		if (this.debugMode) console.warn(`[AI Organiser][${tag}] ${message}`, data ?? '');
	}

	error(tag: string, message: string, data?: unknown): void {
		// Errors always log (even in production) for diagnostics
		console.error(`[AI Organiser][${tag}] ${message}`, data ?? '');
	}
}

export const logger = new Logger();
