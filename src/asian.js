// Is a title plausibly on AvistaZ at all? AvistaZ is an Asian-content tracker — East, Southeast
// and South Asian movies and TV (plus anime). A Hollywood blockbuster is simply not there, so
// escalating one automatically spends a metered tracker search (and possibly a download slot)
// on a search that can't succeed.
//
// Pure and offline: callers hand in the TMDB-shaped metadata Overseerr already serves
// (src/seerr.js fetchSeerrMediaOrigin) and get back a three-valued verdict. 'unknown' is a real
// answer — when Seerr is unreachable or the record is bare, nothing is claimed either way and
// the caller falls back to asking a human.

// Languages whose content AvistaZ carries. Codes are TMDB's ISO 639-1 (plus 'cn', which TMDB
// uses for Cantonese-language titles).
const ASIAN_LANGUAGES = new Set([
  // East Asia
  'ja', 'ko', 'zh', 'cn', 'yue',
  // Southeast Asia
  'th', 'vi', 'id', 'ms', 'tl', 'fil', 'km', 'lo', 'my',
  // South Asia
  'hi', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'gu', 'pa', 'ur', 'si', 'ne', 'as', 'or', 'sd', 'ks',
  // Inner Asia
  'mn', 'bo', 'dz',
]);

// Countries whose productions AvistaZ carries, ISO 3166-1 alpha-2. Deliberately scoped to East,
// Southeast and South Asia — the tracker's actual remit. Central and West Asia (TR, IL, the
// -stans, the Gulf) are left out on purpose: a title from there gets 'unknown'/'non_asian' and
// therefore a human decision rather than a wasted automatic grab.
const ASIAN_COUNTRIES = new Set([
  'JP', 'KR', 'KP', 'CN', 'TW', 'HK', 'MO',
  'TH', 'VN', 'ID', 'MY', 'SG', 'PH', 'KH', 'LA', 'MM', 'BN', 'TL',
  'IN', 'PK', 'BD', 'LK', 'NP', 'BT', 'MV',
  'MN',
]);

// Writing systems used across AvistaZ's regions. An original title written in one of these is
// strong evidence on its own — it survives a record with no language or country at all.
// Urdu's Arabic script is deliberately absent — it can't be told apart from Arabic or Persian,
// which AvistaZ doesn't carry; the 'ur' language code covers those titles instead.
const ASIAN_SCRIPT = new RegExp('['
  + '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff'  // kana, CJK ideographs
  + '\\u1100-\\u11ff\\uac00-\\ud7af'                                // hangul
  + '\\u0900-\\u097f\\u0980-\\u09ff\\u0a00-\\u0a7f\\u0a80-\\u0aff'  // devanagari, bengali, gurmukhi, gujarati
  + '\\u0b00-\\u0b7f\\u0b80-\\u0bff\\u0c00-\\u0c7f\\u0c80-\\u0cff'  // oriya, tamil, telugu, kannada
  + '\\u0d00-\\u0d7f\\u0d80-\\u0dff'                                // malayalam, sinhala
  + '\\u0e00-\\u0e7f\\u0e80-\\u0eff\\u0f00-\\u0fff'                  // thai, lao, tibetan
  + '\\u1000-\\u109f\\u1780-\\u17ff'                                // myanmar, khmer
  + ']');

const lang = v => String(v || '').trim().toLowerCase();
const country = v => String(v || '').trim().toUpperCase();

// Every country code in a TMDB-shaped record: originCountry (TV, plain codes) and
// productionCountries (movies and TV, { iso_3166_1, name } objects).
function countryCodes(meta) {
  const from = [];
  for (const c of meta.originCountry || []) from.push(country(c));
  for (const c of meta.productionCountries || []) from.push(country(typeof c === 'string' ? c : c?.iso_3166_1));
  return from.filter(Boolean);
}

// { verdict, confidence, reasons } for one title.
//   'asian'     — an Asian language, an Asian production country, or an Asian-script original
//                 title. AvistaZ plausibly has it; safe to act on without asking.
//   'non_asian' — the record is populated and every signal points elsewhere (English-language,
//                 US/UK production). AvistaZ almost certainly doesn't have it.
//   'unknown'   — nothing usable came back (Seerr down, sparse TMDB record). Claims nothing.
// meta = { originalLanguage, originCountry[], productionCountries[], originalTitle, title }
function assessAsianOrigin(meta = {}) {
  const reasons = [];
  const language = lang(meta.originalLanguage);
  const countries = countryCodes(meta);
  const asianCountries = countries.filter(c => ASIAN_COUNTRIES.has(c));

  if (language && ASIAN_LANGUAGES.has(language)) reasons.push(`original language ${language}`);
  if (asianCountries.length) reasons.push(`produced in ${[...new Set(asianCountries)].join(', ')}`);
  // The original title, not the localized one: "Kingdom" tells us nothing, "킹덤" tells us
  // everything. Checked last so it reads as the supporting reason it usually is.
  const original = String(meta.originalTitle || meta.originalName || '');
  if (ASIAN_SCRIPT.test(original)) reasons.push('original title is in an Asian script');

  if (reasons.length) {
    // One signal is enough to act on; two or more make it unmistakable.
    return { verdict: 'asian', confidence: reasons.length >= 2 ? 'high' : 'medium', reasons };
  }
  // No positive signal. Only call it non-Asian when the record actually said something —
  // an empty record is 'unknown', which asks a human instead of assuming either way.
  if (language || countries.length) {
    const said = [language ? `original language ${language}` : null, countries.length ? `produced in ${[...new Set(countries)].join(', ')}` : null].filter(Boolean);
    return { verdict: 'non_asian', confidence: language && countries.length ? 'high' : 'medium', reasons: said };
  }
  return { verdict: 'unknown', confidence: 'none', reasons: [] };
}

// One line for a Discord embed, explaining the verdict in the terms an admin cares about:
// will AvistaZ plausibly have this?
function describeAvistazFit(verdict, reasons = []) {
  const detail = reasons.length ? ` (${reasons.join('; ')})` : '';
  if (verdict === 'asian') return `🀄 Looks like Asian content${detail} — AvistaZ plausibly has it.`;
  if (verdict === 'non_asian') return `🌍 Doesn't look like Asian content${detail} — AvistaZ only carries Asian movies and TV, so it probably isn't there.`;
  return '❔ Couldn\'t tell where this is from — AvistaZ only carries Asian movies and TV.';
}

module.exports = { assessAsianOrigin, describeAvistazFit, ASIAN_LANGUAGES, ASIAN_COUNTRIES };
