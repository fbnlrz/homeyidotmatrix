'use strict';

/**
 * Sunrise / sunset for a given date and lat/lon. Returns the times in
 * minutes since local midnight, suitable for direct comparison with
 * `now.getHours() * 60 + now.getMinutes()`.
 *
 * Algorithm: NOAA solar position approximation. Accurate to about a
 * minute at temperate latitudes, which is more than enough for picking
 * a brightness curve.
 *
 * Returns null for either field if the sun never rises or sets at the
 * given location on the given day (polar regions in summer/winter).
 */
function sunTimes(date, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { sunriseMinutes: null, sunsetMinutes: null };
  const startOfDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const n = Math.floor((startOfDay - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  // Fractional year (radians)
  const gamma = (2 * Math.PI / 365) * (n - 1);
  // Equation of time (minutes)
  const eqtime = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  );
  // Solar declination (radians)
  const decl = 0.006918
    - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma)
    + 0.00148 * Math.sin(3 * gamma);
  // Hour angle for sunrise/sunset
  const latRad = lat * Math.PI / 180;
  const cosH = (Math.sin(-0.01454) - Math.sin(latRad) * Math.sin(decl)) / (Math.cos(latRad) * Math.cos(decl));
  if (cosH > 1) return { sunriseMinutes: null, sunsetMinutes: null };  // sun never rises
  if (cosH < -1) return { sunriseMinutes: null, sunsetMinutes: null }; // sun never sets
  const ha = Math.acos(cosH) * 180 / Math.PI; // degrees
  // Sunrise/sunset in UTC minutes from midnight
  const sunriseUtcMin = 720 - 4 * (lon + ha) - eqtime;
  const sunsetUtcMin  = 720 - 4 * (lon - ha) - eqtime;
  // Convert UTC minutes → local minutes using the timezone offset of the date
  // (Date.getTimezoneOffset is positive west of UTC).
  const tzOffsetMin = -date.getTimezoneOffset();
  const wrap = m => ((m % 1440) + 1440) % 1440;
  return {
    sunriseMinutes: wrap(Math.round(sunriseUtcMin + tzOffsetMin)),
    sunsetMinutes: wrap(Math.round(sunsetUtcMin + tzOffsetMin)),
  };
}

module.exports = { sunTimes };
