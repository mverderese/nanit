export interface Milestone {
  id: string;
  icon: string; // emoji
  title: string;
  description: string;
  date: string; // YYYY-MM-DD when achieved
  kind: 'record' | 'streak' | 'first' | 'improvement';
}

interface HistoryNight {
  date: string;
  score: number;
  total_sleep_minutes: number;
  wake_count: number;
  longest_stretch_minutes: number;
  bedtime: string; // ISO
}

function minutesBetween(bedtimeIso: string, comparedToHour: number, tzOffset: number): number {
  // Returns minutes between bedtime and `comparedToHour` local time (on the same day)
  const ms = new Date(bedtimeIso).getTime();
  const localMs = ms - tzOffset * 60 * 1000;
  const d = new Date(localMs);
  const bedMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const compareMinutes = comparedToHour * 60;
  return bedMinutes - compareMinutes;
}

/**
 * Given nights sorted oldest to newest, return any milestones achieved.
 * "Focus night" is the most recent night — we highlight badges earned on that night,
 * but we compute context (records, streaks) using the full history.
 */
export function detectMilestones(nights: HistoryNight[], tzOffset: number = 0): Milestone[] {
  if (nights.length === 0) return [];

  // Sort oldest to newest
  const sorted = [...nights].sort((a, b) => a.date.localeCompare(b.date));
  const milestones: Milestone[] = [];
  const focus = sorted[sorted.length - 1];

  // 1. Longest stretch record (on focus night, is it the longest ever seen?)
  const longestEverMinutes = Math.max(...sorted.map(n => n.longest_stretch_minutes));
  if (focus.longest_stretch_minutes >= longestEverMinutes && focus.longest_stretch_minutes >= 120) {
    const hours = Math.floor(focus.longest_stretch_minutes / 60);
    const mins = focus.longest_stretch_minutes % 60;
    milestones.push({
      id: 'longest_stretch_record',
      icon: '🏆',
      title: 'Longest Stretch Record',
      description: `${hours}h${mins ? ` ${mins}m` : ''} continuous sleep — the longest in the past ${sorted.length} nights!`,
      date: focus.date,
      kind: 'record',
    });
  }

  // 2. Highest score ever
  const bestScoreEver = Math.max(...sorted.map(n => n.score));
  if (focus.score >= bestScoreEver && focus.score >= 70 && sorted.length >= 3) {
    milestones.push({
      id: 'best_score',
      icon: '⭐',
      title: 'Best Sleep Score Yet',
      description: `Scored ${focus.score} — the highest in the past ${sorted.length} nights!`,
      date: focus.date,
      kind: 'record',
    });
  }

  // 3. First X-hour stretch (first time crossing round-number thresholds)
  const stretchThresholds = [240, 300, 360, 420, 480, 540, 600]; // 4h–10h
  for (const threshold of stretchThresholds) {
    // Is focus the FIRST night to hit this threshold?
    const hitAt = sorted.find(n => n.longest_stretch_minutes >= threshold);
    if (hitAt && hitAt.date === focus.date) {
      const h = threshold / 60;
      milestones.push({
        id: `first_${threshold}m_stretch`,
        icon: '🌙',
        title: `First ${h}-Hour Stretch!`,
        description: `${focus.longest_stretch_minutes} min continuous — crossed the ${h}h milestone for the first time.`,
        date: focus.date,
        kind: 'first',
      });
      break; // only report the highest threshold hit for the first time
    }
  }

  // 4. Good night streak (3+ consecutive nights ≥70)
  let streak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].score >= 70) streak++;
    else break;
  }
  if (streak >= 3) {
    milestones.push({
      id: 'good_streak',
      icon: '🔥',
      title: `${streak}-Night Good Streak`,
      description: `${streak} nights in a row with a score ≥ 70. Keep it up!`,
      date: focus.date,
      kind: 'streak',
    });
  }

  // 5. Consistent bedtime streak (bedtime within 30 min of average for 5+ nights)
  if (sorted.length >= 5) {
    const bedtimeMinutes = sorted.slice(-5).map(n => {
      const d = new Date(new Date(n.bedtime).getTime() - tzOffset * 60 * 1000);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    });
    const avg = bedtimeMinutes.reduce((a, b) => a + b, 0) / bedtimeMinutes.length;
    const allWithin30 = bedtimeMinutes.every(m => Math.abs(m - avg) <= 30);
    if (allWithin30) {
      milestones.push({
        id: 'consistent_bedtime',
        icon: '⏰',
        title: 'Consistent Bedtime',
        description: 'Bedtime has stayed within 30 minutes of average for 5 nights running.',
        date: focus.date,
        kind: 'streak',
      });
    }
  }

  // 6. Fewer wakes than usual (focus night has fewer wakes than the running average)
  if (sorted.length >= 4) {
    const prior = sorted.slice(0, -1);
    const avgWakes = prior.reduce((s, n) => s + n.wake_count, 0) / prior.length;
    if (focus.wake_count < avgWakes - 1 && focus.wake_count <= 2) {
      milestones.push({
        id: 'fewer_wakes',
        icon: '💤',
        title: 'Fewer Wake-ups',
        description: `Only ${focus.wake_count} wake${focus.wake_count === 1 ? '' : 's'} — well below the ${avgWakes.toFixed(1)} average.`,
        date: focus.date,
        kind: 'improvement',
      });
    }
  }

  // 7. Big sleep improvement (score jumped ≥15 vs prior night)
  if (sorted.length >= 2) {
    const prev = sorted[sorted.length - 2];
    if (focus.score - prev.score >= 15) {
      milestones.push({
        id: 'big_improvement',
        icon: '📈',
        title: 'Big Improvement',
        description: `Score jumped from ${prev.score} to ${focus.score} — a ${focus.score - prev.score} point gain!`,
        date: focus.date,
        kind: 'improvement',
      });
    }
  }

  return milestones;
}

/**
 * Convert history points to HistoryNight[] shape for milestone detection.
 */
export function toHistoryNights(nights: any[]): HistoryNight[] {
  return nights
    .filter(n => n.score != null && n.total_sleep_minutes != null)
    .map(n => ({
      date: n.date,
      score: n.score,
      total_sleep_minutes: n.total_sleep_minutes,
      wake_count: n.wake_count ?? 0,
      longest_stretch_minutes: n.longest_stretch_minutes ?? 0,
      bedtime: n.bedtime ?? new Date().toISOString(),
    }));
}
