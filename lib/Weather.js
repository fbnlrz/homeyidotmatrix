'use strict';

/**
 * Open-Meteo (https://open-meteo.com) — free, no key, JSON.
 * Returns current temperature + label/icon for given lat/lon.
 */

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

async function fetchCurrent({ latitude, longitude, units = 'celsius' } = {}) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    throw new Error('latitude/longitude are required');
  }
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,weather_code,wind_speed_10m',
    temperature_unit: units === 'fahrenheit' ? 'fahrenheit' : 'celsius',
    timezone: 'auto',
  });
  const res = await fetch(`${ENDPOINT}?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const cur = json && json.current;
  if (!cur) throw new Error('open-meteo: empty current');
  return {
    temperature: cur.temperature_2m,
    temperatureUnit: units === 'fahrenheit' ? '°F' : '°C',
    weatherCode: cur.weather_code,
    windSpeed: cur.wind_speed_10m,
    label: codeLabel(cur.weather_code),
    icon: codeIcon(cur.weather_code),
  };
}

/** WMO weather code → short ASCII glyph (renderable by the device's font). */
function codeIcon(code) {
  if (code === 0) return '*';
  if (code <= 2) return '*';
  if (code <= 3) return '#';
  if (code >= 45 && code <= 48) return '~';
  if (code >= 51 && code <= 67) return '.';
  if (code >= 71 && code <= 77) return '+';
  if (code >= 80 && code <= 82) return '!';
  if (code >= 95) return '!';
  return '?';
}

function codeLabel(code) {
  if (code === 0) return 'clear';
  if (code <= 2) return 'mostly clear';
  if (code === 3) return 'overcast';
  if (code >= 45 && code <= 48) return 'fog';
  if (code >= 51 && code <= 55) return 'drizzle';
  if (code >= 56 && code <= 57) return 'freezing drizzle';
  if (code >= 61 && code <= 65) return 'rain';
  if (code >= 66 && code <= 67) return 'freezing rain';
  if (code >= 71 && code <= 75) return 'snow';
  if (code === 77) return 'snow grains';
  if (code >= 80 && code <= 82) return 'rain showers';
  if (code >= 85 && code <= 86) return 'snow showers';
  if (code === 95) return 'thunderstorm';
  if (code >= 96) return 'thunderstorm w/ hail';
  return 'unknown';
}

module.exports = { fetchCurrent, codeIcon, codeLabel };
