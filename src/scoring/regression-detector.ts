export interface RegressionAlert {
  id: string;
  severity: 'info' | 'warning' | 'concern';
  title: string;
  description: string;
  metric: 'score' | 'duration' | 'wakes' | 'stretch' | 'bedtime';
  trend: 'declining' | 'worsening' | 'inconsistent';
  affected_nights: number;
  recent_values: Array<{ date: string; value: number }>;
}

interface NightPoint {
  date: string;
  score: number;
  total_sleep_minutes: number;
  wake_count: number;
  longest_stretch_minutes: number;
  bedtime: string; // ISO
}

function bedtimeMinutesLocal(bedtimeIso: string, tzOffset: number): number {
  const ms = new Date(bedtimeIso).getTime() - tzOffset * 60 * 1000;
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function detectRegressions(nights: NightPoint[], tzOffset: number = 0): RegressionAlert[] {
  if (nights.length < 3) return [];
  const sorted = [...nights].sort((a, b) => a.date.localeCompare(b.date));
  const alerts: RegressionAlert[] = [];

  // 1. Score declining 3+ consecutive nights
  let declineRun = 1;
  for (let i = sorted.length - 1; i > 0 && declineRun < sorted.length; i--) {
    if (sorted[i].score < sorted[i - 1].score) declineRun++;
    else break;
  }
  if (declineRun >= 3) {
    const run = sorted.slice(-declineRun);
    const delta = run[0].score - run[run.length - 1].score;
    alerts.push({
      id: 'score_declining',
      severity: delta >= 20 ? 'concern' : 'warning',
      title: `Sleep score declining for ${declineRun} nights`,
      description: `Dropped ${delta} points from ${run[0].score} to ${run[run.length - 1].score}.`,
      metric: 'score',
      trend: 'declining',
      affected_nights: declineRun,
      recent_values: run.map(n => ({ date: n.date, value: n.score })),
    });
  }

  // 2. Total sleep ≥1h below 7-day average in last 3 nights
  if (sorted.length >= 7) {
    const baseline = sorted.slice(-10, -3);
    const recent = sorted.slice(-3);
    if (baseline.length > 0) {
      const baseAvg = baseline.reduce((s, n) => s + n.total_sleep_minutes, 0) / baseline.length;
      const recentAvg = recent.reduce((s, n) => s + n.total_sleep_minutes, 0) / recent.length;
      if (baseAvg - recentAvg >= 60) {
        alerts.push({
          id: 'duration_dropping',
          severity: baseAvg - recentAvg >= 120 ? 'concern' : 'warning',
          title: 'Total sleep has dropped',
          description: `Last 3 nights averaged ${Math.round(recentAvg)}m of sleep, down from a ${Math.round(baseAvg)}m baseline (${Math.round(baseAvg - recentAvg)}m drop).`,
          metric: 'duration',
          trend: 'declining',
          affected_nights: 3,
          recent_values: recent.map(n => ({ date: n.date, value: n.total_sleep_minutes })),
        });
      }
    }
  }

  // 3. Wake count climbing 3+ nights
  let wakeClimb = 1;
  for (let i = sorted.length - 1; i > 0 && wakeClimb < sorted.length; i--) {
    if (sorted[i].wake_count > sorted[i - 1].wake_count) wakeClimb++;
    else break;
  }
  if (wakeClimb >= 3) {
    const run = sorted.slice(-wakeClimb);
    alerts.push({
      id: 'wakes_climbing',
      severity: 'warning',
      title: `Wake-ups climbing for ${wakeClimb} nights`,
      description: `Went from ${run[0].wake_count} to ${run[run.length - 1].wake_count} wakes over ${wakeClimb} nights.`,
      metric: 'wakes',
      trend: 'worsening',
      affected_nights: wakeClimb,
      recent_values: run.map(n => ({ date: n.date, value: n.wake_count })),
    });
  }

  // 4. Longest stretch declining 3+ nights
  let stretchDecline = 1;
  for (let i = sorted.length - 1; i > 0 && stretchDecline < sorted.length; i--) {
    if (sorted[i].longest_stretch_minutes < sorted[i - 1].longest_stretch_minutes) stretchDecline++;
    else break;
  }
  if (stretchDecline >= 3) {
    const run = sorted.slice(-stretchDecline);
    const deltaMin = run[0].longest_stretch_minutes - run[run.length - 1].longest_stretch_minutes;
    if (deltaMin >= 30) {
      alerts.push({
        id: 'stretch_declining',
        severity: deltaMin >= 90 ? 'concern' : 'warning',
        title: 'Longest stretch getting shorter',
        description: `Longest continuous stretch dropped ${deltaMin} min over ${stretchDecline} nights.`,
        metric: 'stretch',
        trend: 'declining',
        affected_nights: stretchDecline,
        recent_values: run.map(n => ({ date: n.date, value: n.longest_stretch_minutes })),
      });
    }
  }

  // 5. Bedtime becoming inconsistent (stdev over last 5 nights > 45 min)
  if (sorted.length >= 5) {
    const last5 = sorted.slice(-5);
    const bedMins = last5.map(n => bedtimeMinutesLocal(n.bedtime, tzOffset));
    const avg = bedMins.reduce((a, b) => a + b, 0) / bedMins.length;
    const variance = bedMins.reduce((s, m) => s + (m - avg) ** 2, 0) / bedMins.length;
    const stdev = Math.sqrt(variance);
    if (stdev > 45) {
      alerts.push({
        id: 'bedtime_inconsistent',
        severity: 'info',
        title: 'Bedtime becoming inconsistent',
        description: `Bedtime has varied by ${Math.round(stdev)} min across the last 5 nights — consistency tends to help sleep quality.`,
        metric: 'bedtime',
        trend: 'inconsistent',
        affected_nights: 5,
        recent_values: last5.map((n, i) => ({ date: n.date, value: bedMins[i] })),
      });
    }
  }

  return alerts;
}
