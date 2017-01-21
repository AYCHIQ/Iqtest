'use strict';
const SECONDS = 1000;
const MINUTES = 60 * SECONDS;
const HOURS = 60 * MINUTES;

class Timing {
  constructor() {
    this.time = new Map();
  }
  init(key, hires) {
    const time = hires ? process.hrtime() : Date.now();

    this.time.set(key, time);
  }
  remove(key) {
    this.time.delete(key);
  }
  elapsed(key) {
    const stime = this.time.get(key);
    
    if (Array.isArray(stime)) {
      return this.toMs(process.hrtime(stime));
    } else {
      return Date.now() - stime;
    }
  }
  elapsedString(key) {
    return this.getTimeString(this.elapsed(key));
  }
  toMs(hrtime) {
    return hrtime[0] * 1e3 + hrtime[1] * 1e-6;
  }
  getTimeString(n) {
    const t = isFinite(n) ? n : 0;
    const hrs = Math.trunc(t / HOURS);
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
