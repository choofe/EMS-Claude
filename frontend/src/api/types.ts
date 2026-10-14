/** Mirrors the backend response models (docs/management-api.md). */
export interface AuthUser {
  id: number;
  username: string;
  full_name: string;
  role_code: string;
  role_label_fa: string;
  group_ids: number[];
  must_change_password: boolean;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  must_change_password: boolean;
  user: AuthUser;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface User {
  id: number;
  username: string;
  full_name: string;
  role_code: string;
  role_label_fa: string;
  is_active: boolean;
  must_change_password: boolean;
  group_ids: number[];
  created_at: string;
  updated_at: string;
}

export interface Group {
  id: number;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  equipment_count: number;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface Equipment {
  id: number;
  equipment_code: string;
  group_id: number;
  group_code: string;
  group_name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ReportType {
  id: number;
  code: string;
  name_fa: string;
  is_failure: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Setting {
  key: string;
  label_fa: string;
  description: string;
  value: number;
  default: number;
  minimum: number;
  maximum: number;
  special_values: number[];
  is_default: boolean;
  updated_at: string | null;
  updated_by: number | null;
}

export interface Role {
  code: string;
  label_fa: string;
}

export interface Dashboard {
  active_users: number;
  inactive_users: number;
  active_equipment: number;
  inactive_equipment: number;
  active_groups: number;
  groups: { id: number; code: string; name: string; active_equipment: number; active_members: number }[];
}
