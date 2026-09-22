'use client';

import { useState, useEffect } from 'react';

interface SubscriptionCalendarData {
  subscriptionId: string;
  startDate: string;
  endDate: string;
  pauseAllowanceDays: number;
  pauseUsedDays: number;
  pauseRemainingDays: number;
  earliestPausableDate: string;
  pausedDates: string[];
}

interface PauseCalendarProps {
  subscriptionId: string;
  onUpdate?: () => void;
}

/**
 * Calendar component for pausing delivery dates.
 *
 * Features:
 * - Monthly calendar view
 * - Click dates to toggle pause
 * - Shows pause balance
 * - Enforces 4 PM cutoff
 * - Disables dates outside subscription range
 */
export function PauseCalendar({ subscriptionId, onUpdate }: PauseCalendarProps) {
  const [calendar, setCalendar] = useState<SubscriptionCalendarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [currentMonth, setCurrentMonth] = useState<Date>(new Date());

  useEffect(() => {
    loadCalendar();
  }, [subscriptionId]);

  const loadCalendar = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/subscriptions/${subscriptionId}/calendar`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to load calendar');
      }
      const data = await res.json();
      setCalendar(data);
      setSelectedDates(new Set(data.pausedDates));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleDate = async (date: string) => {
    if (!calendar) return;

    const isPaused = selectedDates.has(date);
    const newSelected = new Set(selectedDates);

    if (isPaused) {
      newSelected.delete(date);
    } else {
      // Check if we have pause days remaining
      if (calendar.pauseRemainingDays <= 0) {
        setError('You have used all your available pause days for this subscription.');
        return;
      }
      newSelected.add(date);
    }

    // Calculate which dates changed
    const changedDates = [date];

    try {
      setSaving(true);
      setError(null);

      const endpoint = isPaused ? 'unpause' : 'pause';
      const res = await fetch(`/api/subscriptions/${subscriptionId}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dates: changedDates }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `Failed to ${endpoint} date`);
      }

      setSelectedDates(newSelected);
      await loadCalendar(); // Refresh to get updated balance
      onUpdate?.();
    } catch (err: any) {
      setError(err.message);
      // Revert optimistic update
      await loadCalendar();
    } finally {
      setSaving(false);
    }
  };

  const isDatePausable = (date: string): boolean => {
    if (!calendar) return false;
    return (
      date >= calendar.earliestPausableDate &&
      date >= calendar.startDate &&
      date <= calendar.endDate
    );
  };

  const isDateInRange = (date: string): boolean => {
    if (!calendar) return false;
    return date >= calendar.startDate && date <= calendar.endDate;
  };

  const renderCalendar = () => {
    if (!calendar) return null;

    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();

    // Get first day of month and number of days
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay(); // 0 = Sunday

    const monthName = currentMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    const days: React.ReactNode[] = [];

    // Empty cells for days before month starts
    for (let i = 0; i < startingDayOfWeek; i++) {
      days.push(<div key={`empty-${i}`} className="calendar-day empty" />);
    }

    // Days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isPaused = selectedDates.has(date);
      const pausable = isDatePausable(date);
      const inRange = isDateInRange(date);

      const classes = [
        'calendar-day',
        isPaused && 'paused',
        !pausable && inRange && 'too-soon',
        !inRange && 'out-of-range',
        pausable && 'pausable',
      ]
        .filter(Boolean)
        .join(' ');

      days.push(
        <button
          key={date}
          className={classes}
          onClick={() => pausable && toggleDate(date)}
          disabled={!pausable || saving}
          title={
            isPaused
              ? 'Click to unpause'
              : !pausable && inRange
              ? 'Cannot pause (4 PM cutoff)'
              : !inRange
              ? 'Outside subscription range'
              : 'Click to pause delivery'
          }
        >
          <span className="day-number">{day}</span>
          {isPaused && <span className="pause-indicator">⏸</span>}
        </button>
      );
    }

    return (
      <div className="pause-calendar">
        <div className="calendar-header">
          <button
            onClick={() => setCurrentMonth(new Date(year, month - 1))}
            className="nav-btn"
            disabled={saving}
          >
            ‹
          </button>
          <h3>{monthName}</h3>
          <button
            onClick={() => setCurrentMonth(new Date(year, month + 1))}
            className="nav-btn"
            disabled={saving}
          >
            ›
          </button>
        </div>

        <div className="calendar-weekdays">
          <div className="weekday">Sun</div>
          <div className="weekday">Mon</div>
          <div className="weekday">Tue</div>
          <div className="weekday">Wed</div>
          <div className="weekday">Thu</div>
          <div className="weekday">Fri</div>
          <div className="weekday">Sat</div>
        </div>

        <div className="calendar-grid">{days}</div>
      </div>
    );
  };

  if (loading) {
    return <div className="pause-calendar-loading">Loading calendar...</div>;
  }

  if (!calendar) {
    return <div className="pause-calendar-error">Could not load calendar</div>;
  }

  return (
    <div className="pause-calendar-container">
      <div className="pause-balance">
        <h3>Pause Days</h3>
        <div className="balance-display">
          <span className="remaining">{calendar.pauseRemainingDays}</span>
          <span className="separator">/</span>
          <span className="total">{calendar.pauseAllowanceDays}</span>
        </div>
        <p className="balance-label">
          {calendar.pauseRemainingDays === 0
            ? 'You have used all your available pause days'
            : `${calendar.pauseRemainingDays} day${calendar.pauseRemainingDays === 1 ? '' : 's'} remaining`}
        </p>
      </div>

      {error && <div className="pause-error">{error}</div>}

      {renderCalendar()}

      <div className="pause-info">
        <p className="cutoff-notice">
          ⏰ You must select dates before <strong>4:00 PM</strong> to pause the next day's delivery.
        </p>
        <p className="usage-note">
          Each paused date extends your subscription by 1 day. No delivery or charge on paused dates.
        </p>
      </div>

      <style jsx>{`
        .pause-calendar-container {
          max-width: 600px;
          margin: 0 auto;
        }

        .pause-balance {
          background: linear-gradient(135deg, var(--red-lift, #a81d12) 0%, var(--red-deep, #650f08) 100%);
          color: white;
          padding: 1.5rem;
          border-radius: 12px;
          text-align: center;
          margin-bottom: 1.5rem;
        }

        .pause-balance h3 {
          margin: 0 0 0.5rem 0;
          font-size: 1rem;
          opacity: 0.9;
        }

        .balance-display {
          font-size: 3rem;
          font-weight: bold;
          line-height: 1;
          margin: 0.5rem 0;
        }

        .balance-display .separator {
          opacity: 0.5;
          margin: 0 0.25rem;
        }

        .balance-label {
          margin: 0.5rem 0 0 0;
          opacity: 0.9;
        }

        .pause-error {
          background: #fee;
          color: #c33;
          padding: 0.75rem 1rem;
          border-radius: 8px;
          margin-bottom: 1rem;
          font-size: 0.9rem;
        }

        .pause-calendar {
          background: white;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          padding: 1rem;
          margin-bottom: 1rem;
        }

        .calendar-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 1rem;
        }

        .calendar-header h3 {
          margin: 0;
          font-size: 1.125rem;
        }

        .nav-btn {
          background: none;
          border: 1px solid #e5e7eb;
          width: 32px;
          height: 32px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1.25rem;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #6b7280;
          transition: all 0.2s;
        }

        .nav-btn:hover:not(:disabled) {
          background: #f3f4f6;
          border-color: #d1d5db;
        }

        .nav-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .calendar-weekdays {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 0.25rem;
          margin-bottom: 0.5rem;
        }

        .weekday {
          text-align: center;
          font-size: 0.75rem;
          font-weight: 600;
          color: #6b7280;
          padding: 0.5rem 0;
        }

        .calendar-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 0.25rem;
        }

        .calendar-day {
          aspect-ratio: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          background: white;
          cursor: pointer;
          position: relative;
          transition: all 0.2s;
          font-size: 0.9rem;
        }

        .calendar-day.empty {
          border: none;
          cursor: default;
        }

        .calendar-day.out-of-range {
          background: #f9fafb;
          color: #d1d5db;
          cursor: not-allowed;
          border-color: #f3f4f6;
        }

        .calendar-day.too-soon {
          background: #fef3c7;
          border-color: #fbbf24;
          cursor: not-allowed;
        }

        .calendar-day.pausable:hover:not(:disabled) {
          background: rgba(140, 23, 14, 0.06);
          border-color: var(--red, #8c170e);
          transform: scale(1.05);
        }

        .calendar-day.paused {
          background: var(--red, #8c170e);
          color: white;
          border-color: var(--red-deep, #650f08);
          font-weight: 600;
        }

        .calendar-day.paused:hover:not(:disabled) {
          background: var(--red-lift, #a81d12);
        }

        .calendar-day:disabled {
          cursor: not-allowed;
          opacity: 0.6;
        }

        .day-number {
          display: block;
        }

        .pause-indicator {
          position: absolute;
          top: 2px;
          right: 2px;
          font-size: 0.6rem;
        }

        .pause-info {
          background: #f9fafb;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 1rem;
        }

        .pause-info p {
          margin: 0.5rem 0;
          font-size: 0.875rem;
          color: #4b5563;
        }

        .pause-info p:first-child {
          margin-top: 0;
        }

        .pause-info p:last-child {
          margin-bottom: 0;
        }

        .cutoff-notice {
          color: #b45309 !important;
        }

        .pause-calendar-loading,
        .pause-calendar-error {
          text-align: center;
          padding: 2rem;
          color: #6b7280;
        }

        @media (max-width: 640px) {
          .pause-calendar {
            padding: 0.75rem;
          }

          .calendar-day {
            font-size: 0.8rem;
          }

          .balance-display {
            font-size: 2.5rem;
          }
        }
      `}</style>
    </div>
  );
}
