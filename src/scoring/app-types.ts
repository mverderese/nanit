import type { CheckIn, WakeDetail, WakeResponse } from './night-activity.js';

export interface SleepScoreBreakdown {
  total_score: number;
  duration_score: number;
  continuity_score: number;
  onset_score: number; // longest-stretch score (historical name)
  timing_score: number;
  details: {
    total_sleep_minutes: number;
    target_sleep_minutes: number;
    wake_count: number;
    longest_stretch_minutes: number;
    bedtime: string;
    wake_time: string;
    custom_bedtime?: string;
    custom_wake_time?: string;
    /** true when a manual annotation changed the night window */
    adjusted: boolean;
    /** Each wake with whether a parent responded (from Nanit VISIT/REMOVED events or the parent's override). */
    wakes: WakeDetail[];
    /** Parent visits while the baby was asleep. */
    check_ins: CheckIn[];
  };
  expectations: {
    adjusted_age_months: number;
    ideal_sleep_hours: number;
    expected_wakes: number;
    normal_wake_minutes: number;
    expected_stretch_hours: number;
    ideal_bedtime_range: [number, number];
    excess_wake_penalty: number;
    long_wake_penalty: number;
    /** Self-settled wakes this short don't break the longest stretch. */
    brief_wake_minutes: number;
    self_settled_wakes: number;
    parent_visit_wakes: number;
    unknown_wakes: number;
  };
}

export interface SleepAnnotation {
  session_id: string;
  baby_uid: string;
  custom_start_time?: number;
  custom_end_time?: number;
  notes?: string;
  /** Parent corrections to wake labels, keyed by the wake's start (unix seconds). */
  wake_overrides?: Record<string, WakeResponse>;
  updated_at: number;
}

export interface ApiError {
  error: string;
  message: string;
  status: number;
}
