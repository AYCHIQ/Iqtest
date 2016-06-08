'use strict';
const SECONDS = 1000;
const MINUTES = 60 * SECONDS;
const HOURS = 60 * MINUTES;

class Timing {
  constructor() {
    this.time = new Map();
  }
  init(key) {
    this.time.set(key, Date.now());
  }
  elapsed(key) {
    return Date.now() - this.time.get(key);
  }
  elapsedString(key) {
    return this.getTimeString(this.elapsed(key));
  }
  getTimeString(t) {
    const hrs = this.toDoubleDigit(t / HOURS);
    const m = t % HOURS;
    const min = this.toDoubleDigit(m / MINUTES);
    const s = m % MINUTES;
    const sec = this.toDoubleDigit(s / SECONDS);

    return `${hrs}:${min}:${sec}`;
  }
  toDoubleDigit(x) {
    return `00${Math.trunc(x)}`.slice(-2);
  }
}
module.exports = new Timing();
