import type { DashboardConfig } from './model.mjs';
export interface TraceDashboardElement extends HTMLElement {
  config: DashboardConfig;
  setData(data: unknown, options?: {sample?: boolean; updatedAt?: string | null}): void;
  refresh(): Promise<void>;
}
export function registerTraceDashboard(): void;
