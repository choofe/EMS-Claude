const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export interface LivenessResponse {
  status: string;
  app: string;
  environment: string;
}

export interface ReadinessResponse {
  status: string;
  database: string;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`);
  if (!response.ok) {
    throw new Error(`درخواست ${path} با خطا مواجه شد (کد ${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function getLiveness(): Promise<LivenessResponse> {
  return getJson<LivenessResponse>("/health/live");
}

export function getReadiness(): Promise<ReadinessResponse> {
  return getJson<ReadinessResponse>("/health/ready");
}
