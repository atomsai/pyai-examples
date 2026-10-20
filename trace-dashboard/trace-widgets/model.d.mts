export type WidgetId = 'scanned' | 'pass_rate' | 'gaps' | 'verdicts' | 'rules';
export interface DashboardConfig {
  schema_version: 'trace-dashboard-v1'; title: string; theme: 'light' | 'dark';
  accent: string; density: 'compact' | 'comfortable'; window_days: 7 | 30 | 90;
  max_rules: number; widgets: WidgetId[]; labels: Partial<Record<WidgetId, string>>;
}
export interface ExposureData {
  object: 'trace.exposure'; window_days: number; interactions_scanned: number;
  with_a_gap: number; gap_rate: number; by_verdict: Record<'PASS' | 'WARN' | 'FAIL', number>;
  by_rule: {rule_id: string; pack_id: string | null; count: number; rate: number}[];
  top_exposure: string | null;
}
export const WIDGETS: readonly {id: WidgetId; label: string; description: string}[];
export const DEFAULT_CONFIG: Readonly<DashboardConfig>;
export const PRESETS: readonly {id: string; label: string; description: string; widgets: WidgetId[]}[];
export const SAMPLE_EXPOSURE: Readonly<ExposureData>;
export function readDashboardConfig(input: unknown): DashboardConfig;
export function projectExposure(input: unknown): ExposureData;
export function formatPercent(value: number | null): string;
export function embedSnippet(config: DashboardConfig): string;
export function exposureCsv(input: unknown): string;
