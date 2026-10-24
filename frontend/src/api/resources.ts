import { request } from "./http";
import type { Candidate, Dashboard, Draft, DraftPayload, EntryConfig, Equipment, Mode, QuickPick, ReportCreateBody, ReportCreated, Group, ImportBatch, ImportCommit, ImportPreview, Page, ReportType, Role, Setting, TokenResponse, User } from "./types";

export const authApi = {
  login: (username: string, password: string) =>
    request<TokenResponse>("/auth/login", { method: "POST", body: { username, password }, auth: false }),
  logout: () => request<void>("/auth/logout", { method: "POST", csrf: true, auth: false }),
  changePassword: (current_password: string, new_password: string) =>
    request<TokenResponse>("/auth/change-password", { method: "POST", body: { current_password, new_password } }),
};

export type Paging = { limit: number; offset: number };

export const usersApi = {
  list: (q: Paging & { q?: string; role_code?: string; is_active?: boolean; group_id?: number }) =>
    request<Page<User>>("/users", { query: q }),
  create: (body: { username: string; full_name: string; role_code: string; password: string; group_ids: number[]; must_change_password: boolean }) =>
    request<User>("/users", { method: "POST", body }),
  update: (id: number, body: { full_name?: string; role_code?: string }) =>
    request<User>(`/users/${id}`, { method: "PATCH", body }),
  setActive: (id: number, active: boolean) =>
    request<User>(`/users/${id}/${active ? "activate" : "deactivate"}`, { method: "POST" }),
  setGroups: (id: number, group_ids: number[]) =>
    request<User>(`/users/${id}/groups`, { method: "PUT", body: { group_ids } }),
  resetPassword: (id: number, password: string, must_change_password: boolean) =>
    request<User>(`/users/${id}/reset-password`, { method: "POST", body: { password, must_change_password } }),
  forceChange: (id: number) => request<User>(`/users/${id}/force-password-change`, { method: "POST" }),
  forceChangeAll: () => request<{ users_affected: number }>("/users/force-password-change-all", { method: "POST" }),
  roles: () => request<Role[]>("/roles"),
};

export const groupsApi = {
  list: (q: Paging & { include_inactive?: boolean }) => request<Page<Group>>("/groups", { query: q }),
  create: (body: { code: string; name: string; description: string | null }) =>
    request<Group>("/groups", { method: "POST", body }),
  update: (id: number, body: { name?: string; description?: string | null }) =>
    request<Group>(`/groups/${id}`, { method: "PATCH", body }),
  setActive: (id: number, active: boolean) =>
    request<Group>(`/groups/${id}/${active ? "activate" : "deactivate"}`, { method: "POST" }),
};

export const equipmentApi = {
  list: (q: Paging & { q?: string; group_id?: number; is_active?: boolean }) =>
    request<Page<Equipment>>("/equipment", { query: q }),
  get: (id: number) => request<Equipment>(`/equipment/${id}`),
  create: (body: { equipment_code: string; group_id: number; description: string | null }) =>
    request<Equipment>("/equipment", { method: "POST", body }),
  update: (id: number, body: { description: string | null }) =>
    request<Equipment>(`/equipment/${id}`, { method: "PATCH", body }),
  move: (id: number, group_id: number) =>
    request<Equipment>(`/equipment/${id}/move`, { method: "POST", body: { group_id } }),
  setActive: (id: number, active: boolean) =>
    request<Equipment>(`/equipment/${id}/${active ? "activate" : "deactivate"}`, { method: "POST" }),
};

export const reportTypesApi = {
  list: (include_inactive: boolean) => request<ReportType[]>("/report-types", { query: { include_inactive } }),
  create: (body: { code: string; name_fa: string; is_failure: boolean; labor_mode: Mode; equipment_mode: Mode; help_fa: string | null }) =>
    request<ReportType>("/report-types", { method: "POST", body }),
  update: (id: number, body: { name_fa?: string; is_failure?: boolean; labor_mode?: Mode; equipment_mode?: Mode; help_fa?: string | null }) =>
    request<ReportType>(`/report-types/${id}`, { method: "PATCH", body }),
  setActive: (id: number, active: boolean) =>
    request<ReportType>(`/report-types/${id}/${active ? "activate" : "deactivate"}`, { method: "POST" }),
};

export const settingsApi = {
  list: () => request<Setting[]>("/settings"),
  update: (key: string, value: number) => request<Setting>(`/settings/${key}`, { method: "PUT", body: { value } }),
};

export const dashboardApi = { summary: () => request<Dashboard>("/dashboard/summary") };

const uploadForm = (groupId: number, file: File, extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.append("group_id", String(groupId));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append("file", file);
  return form;
};

export const importApi = {
  preview: (groupId: number, file: File) =>
    request<ImportPreview>("/equipment/import/preview", { method: "POST", form: uploadForm(groupId, file) }),
  commit: (groupId: number, file: File, previewSha256: string) =>
    request<ImportCommit>("/equipment/import/commit", { method: "POST", form: uploadForm(groupId, file, { preview_sha256: previewSha256 }) }),
  template: (format: "xlsx" | "csv") => request<Blob>("/equipment/import/template", { query: { format }, blob: true }),
  batches: (q: Paging) => request<Page<ImportBatch>>("/equipment/import/batches", { query: q }),
  undo: (id: number) => request<{ batch_id: number; deleted_count: number }>(`/equipment/import/batches/${id}/undo`, { method: "POST" }),
};

export const reportsApi = {
  entryConfig: () => request<EntryConfig>("/reports/entry-config"),
  candidates: (q: { equipment_id?: number; group_id?: number; q?: string; limit?: number }) =>
    request<Candidate[]>("/reports/participant-candidates", { query: q }),
  quickPick: () => request<QuickPick>("/reports/equipment-quick-pick"),
  heartbeat: () => request<{ ok: boolean; server_time: string }>("/reports/heartbeat", { method: "POST" }),
  create: (body: ReportCreateBody) => request<ReportCreated>("/reports", { method: "POST", body }),
  drafts: () => request<Draft[]>("/reports/drafts"),
  createDraft: (payload: DraftPayload) => request<Draft>("/reports/drafts", { method: "POST", body: { payload } }),
  updateDraft: (id: number, payload: DraftPayload, version: number) =>
    request<Draft>(`/reports/drafts/${id}`, { method: "PUT", body: { payload, version } }),
  deleteDraft: (id: number) => request<void>(`/reports/drafts/${id}`, { method: "DELETE" }),
};
