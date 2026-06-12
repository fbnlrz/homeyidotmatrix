'use strict';

/**
 * Smoke tests for lib/sun.js. We're not chasing arc-minute accuracy here —
 * the goal is "Berlin at the equinox returns ~06:00 / ~18:00", not "exact
 * to NOAA". A few minutes of drift is fine for picking a brightness curve.
 *
 * Run with: node test/sun.test.js
 */

const { sunTimes } = require('../lib/sun');

let passed = 0;
let failed = 0;

function ok(label, cond) {
  if (cond) { passed++; console.log('  ok  ', label); }
  else { failed++; console.log('  FAIL', label); }
}
function near(label, got, want, tolerance) {
  if (got === null) { failed++; console.log('  FAIL', label, '(got null)'); return; }
  const diff = Math.abs(got - want);
  if (diff <= tolerance) { passed++; console.log('  ok  ', label, `(${got}, want ~${want})`); }
  else { failed++; console.log('  FAIL', label, `got ${got}, want within ±${tolerance} of ${want}`); }
}

// Berlin (52.52°N, 13.40°E) at the March equinox. Sunrise ~06:00 / sunset ~18:00 local.
// Use a Date in the local Berlin tz — but the test runner is in UTC, so we
// manually build a "noon UTC" date which roughly maps to spring equinox day.
{
  const d = new Date(Date.UTC(2025, 2, 20, 12, 0)); // March 20 2025 noon UTC
  const t = sunTimes(d, 52.52, 13.40);
  // Equinox: roughly 06:00 sunrise, 18:00 sunset in local Berlin tz.
  // CI runs in UTC → local minutes match UTC minutes; in Berlin we'd get
  // shifted by +60min. Accept either by widening the tolerance to ±90min.
  near('Berlin equinox sunrise minutes', t.sunriseMinutes, 360, 90);
  near('Berlin equinox sunset minutes', t.sunsetMinutes, 1080, 90);
}

// NaN inputs return nulls
{
  const t = sunTimes(new Date(), NaN, 13);
  ok('NaN lat → null sunrise', t.sunriseMinutes === null);
  ok('NaN lat → null sunset', t.sunsetMinutes === null);
}

// Polar night at the equator? No — pick high latitude in deep winter.
{
  const d = new Date(Date.UTC(2025, 11, 21, 12, 0)); // Dec 21
  const t = sunTimes(d, 80, 0); // 80°N — sun never rises
  ok('Polar night returns null sunrise', t.sunriseMinutes === null);
  ok('Polar night returns null sunset', t.sunsetMinutes === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
