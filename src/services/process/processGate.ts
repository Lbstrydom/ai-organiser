/** Which features make the Process view worth having. Any one is enough; with none, the view and its command do not exist. */
import { isFeatureEnabled } from '../featureService';

export const processViewActive = (settings: Parameters<typeof isFeatureEnabled>[0]): boolean =>
    isFeatureEnabled(settings, 'capture-inbox') || isFeatureEnabled(settings, 'inbox-sweep') || isFeatureEnabled(settings, 'ai-workspaces');
