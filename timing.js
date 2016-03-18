'use strict';
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
}
module.exports = new Timing();
