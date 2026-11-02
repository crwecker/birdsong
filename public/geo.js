/**
 * Location filter rules, shared by the inference worker (importScripts), the page
 * (classic <script>) and the Node tests (evaluated with vm), so all three agree.
 */
(function (root) {
  /** Area-model score below which a species is ruled out. */
  const GEO_MIN = 0.03;

  /** BirdNET's week of the year: 48 weeks, 4 per month, 1-based. */
  function birdnetWeek(date) {
    return Math.min(48, date.getMonth() * 4 + Math.ceil(date.getDate() / 7.75));
  }

  root.BirdsongGeo = { GEO_MIN, birdnetWeek };
})(typeof self !== 'undefined' ? self : globalThis);
