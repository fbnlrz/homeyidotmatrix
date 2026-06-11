'use strict';

/**
 * Natural-language time for English, German, Dutch — 5-minute resolution.
 *   en: "It is twenty past seven"
 *   de: "Es ist zwanzig nach sieben"
 *   nl: "Het is tien voor half acht"
 */

const HOURS_EN = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];
const HOURS_DE = ['zwölf', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf'];
const HOURS_NL = ['twaalf', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen', 'tien', 'elf'];

function _hour12(d) { return d.getHours() % 12; }
function _bucket(m) { return Math.round(m / 5) * 5; }

function en(date) {
  const m = _bucket(date.getMinutes());
  const h = _hour12(date);
  if (m === 0)  return `It is ${HOURS_EN[h]}`;
  if (m === 60) return `It is ${HOURS_EN[(h + 1) % 12]}`;
  if (m === 30) return `It is half past ${HOURS_EN[h]}`;
  if (m === 15) return `It is quarter past ${HOURS_EN[h]}`;
  if (m === 45) return `It is quarter to ${HOURS_EN[(h + 1) % 12]}`;
  if (m < 30)   return `It is ${_minsEn(m)} past ${HOURS_EN[h]}`;
  return `It is ${_minsEn(60 - m)} to ${HOURS_EN[(h + 1) % 12]}`;
}

function _minsEn(n) {
  return ({ 5: 'five', 10: 'ten', 20: 'twenty', 25: 'twenty-five' })[n] || String(n);
}

function de(date) {
  const m = _bucket(date.getMinutes());
  const h = _hour12(date);
  const cur = HOURS_DE[h];
  const next = HOURS_DE[(h + 1) % 12];
  const curU = cur === 'eins' ? 'ein' : cur;
  const nextU = next === 'eins' ? 'ein' : next;
  if (m === 0)  return `Es ist ${curU} Uhr`;
  if (m === 60) return `Es ist ${nextU} Uhr`;
  if (m === 30) return `Es ist halb ${next}`;
  if (m === 15) return `Es ist viertel nach ${cur}`;
  if (m === 45) return `Es ist viertel vor ${next}`;
  if (m === 5)  return `Es ist fünf nach ${cur}`;
  if (m === 10) return `Es ist zehn nach ${cur}`;
  if (m === 20) return `Es ist zwanzig nach ${cur}`;
  if (m === 25) return `Es ist fünf vor halb ${next}`;
  if (m === 35) return `Es ist fünf nach halb ${next}`;
  if (m === 40) return `Es ist zwanzig vor ${next}`;
  if (m === 50) return `Es ist zehn vor ${next}`;
  if (m === 55) return `Es ist fünf vor ${next}`;
  return `${cur} Uhr ${m}`;
}

function nl(date) {
  const m = _bucket(date.getMinutes());
  const h = _hour12(date);
  const cur = HOURS_NL[h];
  const next = HOURS_NL[(h + 1) % 12];
  if (m === 0)  return `Het is ${cur} uur`;
  if (m === 60) return `Het is ${next} uur`;
  if (m === 30) return `Het is half ${next}`;
  if (m === 15) return `Het is kwart over ${cur}`;
  if (m === 45) return `Het is kwart voor ${next}`;
  if (m === 5)  return `Het is vijf over ${cur}`;
  if (m === 10) return `Het is tien over ${cur}`;
  if (m === 20) return `Het is tien voor half ${next}`;
  if (m === 25) return `Het is vijf voor half ${next}`;
  if (m === 35) return `Het is vijf over half ${next}`;
  if (m === 40) return `Het is tien over half ${next}`;
  if (m === 50) return `Het is tien voor ${next}`;
  if (m === 55) return `Het is vijf voor ${next}`;
  return `${cur} uur ${m}`;
}

function format(locale, date = new Date()) {
  switch ((locale || 'en').toLowerCase()) {
    case 'de': return de(date);
    case 'nl': return nl(date);
    default:   return en(date);
  }
}

module.exports = { format, en, de, nl };
