export function traceDashboardResponse(request: Request, options?: {
  resolveApiKey?: (request: Request) => Promise<string | null | undefined>;
}): Promise<Response>;
