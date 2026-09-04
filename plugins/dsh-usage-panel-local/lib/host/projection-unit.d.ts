import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import { USAGE_PANEL_KEY, type UsagePanelState } from './projection.ts';
export declare const PROJECTION_STATE_VERSION = 1;
export declare const usagePanelProjectionDefinition: ProjectionDefinition<typeof USAGE_PANEL_KEY, UsagePanelState>;
