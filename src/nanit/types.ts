export interface NanitTokens {
  access_token: string;
  token: string;
  refresh_token: string;
}

export interface NanitMfaChallenge {
  mfa_token: string;
  phone_suffix: string;
  channel: string;
  message: string;
}

export interface NanitLoginResponse {
  access_token?: string;
  token?: string;
  refresh_token?: string;
  mfa_token?: string;
  phone_suffix?: string;
  channel?: string;
  message?: string;
}

export interface NanitBaby {
  uid: string;
  id: number;
  name: string;
  birthdate: string;
  due_date?: string;
  camera_uid?: string;
  public_address?: string;
  private_address?: string;
}

export interface NanitBabiesResponse {
  babies: NanitBaby[];
}

// The calendar endpoint returns ALL event types in a single array
export interface NanitCalendarEntry {
  uid: string;
  baby_uid: string;
  begin_ts: number;
  end_ts: number;
  duration: number;
  type: string; // 'auto_sleep' | 'bottle_feed' | 'diaper_change' | etc.
  time: number;
  status?: string;
  // Care-specific fields
  change_type?: 'pee' | 'mixed' | 'poo';
  feed_amount?: number;
}

export interface NanitCalendarResponse {
  calendar: NanitCalendarEntry[];
}

export interface NanitMessage {
  id: number;
  baby_uid: string;
  user_id: number;
  type: 'SOUND' | 'MOTION' | 'TEMPERATURE';
  time: number;
  read_at?: number;
  seen_at?: number;
  dismissed_at?: number;
  updated_at: string;
  created_at: string;
  data?: Record<string, unknown>;
}

export interface NanitMessagesResponse {
  messages: NanitMessage[];
}
