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
  labor_mode: LaborMode;
  equipment_required: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type LaborMode = "REQUIRED" | "OPTIONAL" | "ON_REQUEST" | "NONE";

/** Report entry (docs/report-creation.md). */
export interface EntryConfig {
  default_labor_minutes: number;
  max_participant_minutes: number;
  max_participants: number;
  max_description_length: number;
  future_tolerance_minutes: number;
  groups: { id: number; code: string; name: string }[];
}
export interface Candidate { id: number; full_name: string }
export interface QuickEquipment { id: number; equipment_code: string; group_id: number; group_code: string; description: string | null }
export interface QuickPick { recent: QuickEquipment[]; frequent: QuickEquipment[] }
export interface DraftPayload {
  equipment_id?: number | null;
  group_id?: number | null;
  report_type_id?: number | null;
  event_datetime?: string | null;
  description?: string | null;
  participants?: { user_id: number | null; name?: string | null; minutes: number }[];
}
export interface Draft { id: number; payload: DraftPayload; version: number; created_at: string; updated_at: string }
export interface ReportCreateBody {
  equipment_id?: number;
  group_id?: number;
  report_type_id: number;
  event_datetime: string;
  description: string;
  participants: { user_id: number; minutes: number }[];
  draft_id?: number;
}
export interface ReportCreated {
  id: number;
  report_number: string;
  equipment_id: number | null;
  equipment_code: string | null;
  group_id: number;
  group_code: string;
  report_type_id: number;
  is_general: boolean;
  event_datetime: string;
  created_at: string;
  description: string;
  participants: { user_id: number; full_name: string; minutes: number }[];
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

/** Equipment import (docs/equipment-import.md). Reason-specific fields are omitted by the server when not relevant. */
export interface ImportRowError {
  row: number;
  equipment_code: string;
  code: string;
  found?: string;
  expected?: string;
  first_row?: number;
  existing_group_code?: string;
  existing_is_active?: boolean;
  bad_chars?: string[];
  column?: string;
}

export interface ImportPreview {
  group: { id: number; code: string; name: string };
  file_name: string;
  file_sha256: string;
  rows_total: number;
  valid_count: number;
  error_count: number;
  ignored_columns: string[];
  errors: ImportRowError[];
  sample: { row: number; equipment_code: string; description?: string }[];
}

export interface ImportCommit extends ImportPreview {
  batch_id: number;
  created_count: number;
}

export interface ImportBatch {
  id: number;
  group_id: number;
  group_code: string;
  group_name: string;
  file_name: string;
  created_by_name: string;
  created_at: string;
  created_count: number;
  rejected_count: number;
  remaining_count: number;
  report_count: number;
  undone_at: string | null;
  can_undo: boolean;
}
