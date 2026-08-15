// Phase 11.4: pure tests for the recruitment journey state model --
// no DOM, no network. See src/lib/recruitment-journey.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecruitmentJourney, CANONICAL_RECRUITMENT_STAGES } from '../src/lib/recruitment-journey';

function statusesOf(journey: ReturnType<typeof buildRecruitmentJourney>) {
  return journey.steps.map((s) => s.status);
}

test('accepted: only the first step is current, nothing complete', () => {
  const journey = buildRecruitmentJourney({
    stage: 'accepted',
    previous_stage: null,
    stage_entered_at: '2026-01-01T00:00:00Z',
    history: [{ from_stage: null, to_stage: 'accepted', created_at: '2026-01-01T00:00:00Z' }],
  });
  assert.deepEqual(statusesOf(journey), ['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
  assert.equal(journey.effectiveStage, 'accepted');
  assert.equal(journey.holdActive, false);
  assert.equal(journey.notPursuing, false);
  assert.equal(journey.steps[0]!.enteredAt, '2026-01-01T00:00:00Z');
});

test('contacting: accepted complete, contacting current', () => {
  const journey = buildRecruitmentJourney({
    stage: 'contacting',
    previous_stage: null,
    stage_entered_at: '2026-01-05T00:00:00Z',
    history: [
      { from_stage: null, to_stage: 'accepted', created_at: '2026-01-01T00:00:00Z' },
      { from_stage: 'accepted', to_stage: 'contacting', created_at: '2026-01-05T00:00:00Z' },
    ],
  });
  assert.deepEqual(statusesOf(journey), ['complete', 'current', 'upcoming', 'upcoming', 'upcoming']);
  assert.equal(journey.steps[0]!.enteredAt, '2026-01-01T00:00:00Z');
  assert.equal(journey.steps[1]!.enteredAt, '2026-01-05T00:00:00Z');
});

test('engaged: two complete steps before it', () => {
  const journey = buildRecruitmentJourney({
    stage: 'engaged',
    previous_stage: null,
    stage_entered_at: '2026-01-10T00:00:00Z',
    history: [
      { from_stage: null, to_stage: 'accepted', created_at: '2026-01-01T00:00:00Z' },
      { from_stage: 'accepted', to_stage: 'contacting', created_at: '2026-01-05T00:00:00Z' },
      { from_stage: 'contacting', to_stage: 'engaged', created_at: '2026-01-10T00:00:00Z' },
    ],
  });
  assert.deepEqual(statusesOf(journey), ['complete', 'complete', 'current', 'upcoming', 'upcoming']);
});

test('agreement: three complete steps before it', () => {
  const journey = buildRecruitmentJourney({
    stage: 'agreement',
    previous_stage: null,
    stage_entered_at: '2026-01-15T00:00:00Z',
    history: [
      { from_stage: null, to_stage: 'accepted', created_at: '2026-01-01T00:00:00Z' },
      { from_stage: 'accepted', to_stage: 'contacting', created_at: '2026-01-05T00:00:00Z' },
      { from_stage: 'contacting', to_stage: 'engaged', created_at: '2026-01-10T00:00:00Z' },
      { from_stage: 'engaged', to_stage: 'agreement', created_at: '2026-01-15T00:00:00Z' },
    ],
  });
  assert.deepEqual(statusesOf(journey), ['complete', 'complete', 'complete', 'current', 'upcoming']);
});

test('signed: every step complete or current, terminal success', () => {
  const journey = buildRecruitmentJourney({
    stage: 'signed',
    previous_stage: null,
    stage_entered_at: '2026-01-20T00:00:00Z',
    history: [
      { from_stage: null, to_stage: 'accepted', created_at: '2026-01-01T00:00:00Z' },
      { from_stage: 'accepted', to_stage: 'contacting', created_at: '2026-01-05T00:00:00Z' },
      { from_stage: 'contacting', to_stage: 'engaged', created_at: '2026-01-10T00:00:00Z' },
      { from_stage: 'engaged', to_stage: 'agreement', created_at: '2026-01-15T00:00:00Z' },
      { from_stage: 'agreement', to_stage: 'signed', created_at: '2026-01-20T00:00:00Z' },
    ],
  });
  assert.deepEqual(statusesOf(journey), ['complete', 'complete', 'complete', 'complete', 'current']);
  assert.equal(journey.effectiveStage, 'signed');
});

test('on_hold after an intermediate stage: uses previous_stage, not another linear step', () => {
  const journey = buildRecruitmentJourney({
    stage: 'on_hold',
    previous_stage: 'engaged',
    stage_entered_at: '2026-01-12T00:00:00Z',
    history: [
      { from_stage: null, to_stage: 'accepted', created_at: '2026-01-01T00:00:00Z' },
      { from_stage: 'accepted', to_stage: 'contacting', created_at: '2026-01-05T00:00:00Z' },
      { from_stage: 'contacting', to_stage: 'engaged', created_at: '2026-01-10T00:00:00Z' },
      { from_stage: 'engaged', to_stage: 'on_hold', created_at: '2026-01-12T00:00:00Z' },
    ],
  });
  assert.equal(journey.holdActive, true);
  assert.equal(journey.notPursuing, false);
  assert.equal(journey.effectiveStage, 'engaged');
  assert.deepEqual(statusesOf(journey), ['complete', 'complete', 'current', 'upcoming', 'upcoming']);
  assert.equal(journey.currentStatusSince, '2026-01-12T00:00:00Z');
  // on_hold is not one of the 5 canonical steps -- confirm it never appears.
  assert.ok(journey.steps.every((s) => (CANONICAL_RECRUITMENT_STAGES as readonly string[]).includes(s.stage)));
});

test('not_pursuing after an intermediate stage: derives how far it got from history, not previous_stage', () => {
  const journey = buildRecruitmentJourney({
    stage: 'not_pursuing',
    previous_stage: null, // never set on_hold, so this stays null -- must not be used
    stage_entered_at: '2026-01-08T00:00:00Z',
    history: [
      { from_stage: null, to_stage: 'accepted', created_at: '2026-01-01T00:00:00Z' },
      { from_stage: 'accepted', to_stage: 'contacting', created_at: '2026-01-05T00:00:00Z' },
      { from_stage: 'contacting', to_stage: 'not_pursuing', created_at: '2026-01-08T00:00:00Z' },
    ],
  });
  assert.equal(journey.notPursuing, true);
  assert.equal(journey.holdActive, false);
  assert.equal(journey.effectiveStage, 'contacting');
  assert.deepEqual(statusesOf(journey), ['complete', 'current', 'upcoming', 'upcoming', 'upcoming']);
});

test('not_pursuing directly from an on_hold that itself started from an intermediate stage: still resolves via history', () => {
  const journey = buildRecruitmentJourney({
    stage: 'not_pursuing',
    previous_stage: null, // cleared when leaving on_hold-adjacent state; irrelevant here
    stage_entered_at: '2026-01-14T00:00:00Z',
    history: [
      { from_stage: null, to_stage: 'accepted', created_at: '2026-01-01T00:00:00Z' },
      { from_stage: 'accepted', to_stage: 'contacting', created_at: '2026-01-05T00:00:00Z' },
      { from_stage: 'contacting', to_stage: 'engaged', created_at: '2026-01-10T00:00:00Z' },
      { from_stage: 'engaged', to_stage: 'on_hold', created_at: '2026-01-12T00:00:00Z' },
      { from_stage: 'on_hold', to_stage: 'not_pursuing', created_at: '2026-01-14T00:00:00Z' },
    ],
  });
  assert.equal(journey.effectiveStage, 'engaged');
  assert.deepEqual(statusesOf(journey), ['complete', 'complete', 'current', 'upcoming', 'upcoming']);
});

test('incomplete/missing history: no fabricated completed stages', () => {
  const journeyNoHistory = buildRecruitmentJourney({
    stage: 'not_pursuing',
    previous_stage: null,
    stage_entered_at: '2026-01-08T00:00:00Z',
    history: [],
  });
  assert.equal(journeyNoHistory.effectiveStage, null);
  assert.deepEqual(statusesOf(journeyNoHistory), ['upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
  assert.ok(journeyNoHistory.steps.every((s) => s.status !== 'complete'), 'must never guess completed stages with no history');

  const journeyUndefinedHistory = buildRecruitmentJourney({
    stage: 'on_hold',
    previous_stage: null, // also missing/unusable
    stage_entered_at: '2026-01-08T00:00:00Z',
  });
  assert.equal(journeyUndefinedHistory.effectiveStage, null);
  assert.ok(journeyUndefinedHistory.steps.every((s) => s.status !== 'complete'));
});
