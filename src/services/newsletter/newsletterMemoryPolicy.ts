/**
 * Newsletter Story Memory — the single gating rule.
 *
 * Consulted by the service, the command and the host signal, so the rule cannot
 * be re-derived differently at three call sites.
 *
 * When memory is off there is NO recall read, NO ledger write, NO consumption
 * write and NO audio callback. The setting means "collect and use no memory",
 * not "hide it from the prompt" — a user who turns it off should not still be
 * accumulating story text in their plugin data.
 */

import type { AIOrganiserSettings } from '../../core/settings';
import { isFeatureEnabled } from '../featureService';

export function isStoryMemoryEnabled(settings: AIOrganiserSettings): boolean {
    return isFeatureEnabled(settings, 'newsletter') && settings.newsletterStoryMemory === true;
}
