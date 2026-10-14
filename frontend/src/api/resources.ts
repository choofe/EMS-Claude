import { request } from "./http";
import type { Dashboard, Equipment, Group, Page, ReportType, Role, Setting, TokenResponse, User } from "./types";

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
  create: (body: { code: string; name_fa: string; is_failure: boolean }) =>
    request<ReportType>("/report-types", { method: "POST", body }),
  update: (id: number, body: { name_fa?: string; is_failure?: boolean }) =>
    request<ReportType>(`/report-types/${id}`, { method: "PATCH", body }),
  setActive: (id: number, active: boolean) =>
    request<ReportType>(`/report-types/${id}/${active ? "activate" : "deactivate"}`, { method: "POST" }),
};

export const settingsApi = {
  list: () => request<Setting[]>("/settings"),
  update: (key: string, value: number) => request<Setting>(`/settings/${key}`, { method: "PUT", body: { value } }),
};

export const dashboardApi = { summary: () => request<Dashboard>("/dashboard/summary") };
