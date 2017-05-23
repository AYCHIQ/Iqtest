/* Math utils */
const {mean, median, mad} = require('./mathutils.js');
/**
 * @class SampleStore
 * @param {number} slen - number of samples to store
 * @method init - add key to storage
 * @method add - add value to samples of specified key
 * @method delete - remove key and its' samples
 * @method {array} get - returns samples for the key
 * @method reset - resets all sample values to undefined
 * @method {boolean} has- returns presence of samples for the key
 * @property {boolean} isComplete -  whether we have completed sample length
 * @property {array} all - returns array of all defined elements
 * @property {number} mad - returns Median Absolute Deviation of samples
 * @property {number} median - returns median of samples
 * @property {number} mean - returns mean of samples
 */
class SampleStore {
  constructor(slen) {
    this.slen = slen + 1; //add 1 because last sample is discarded
    this.samples = [];
    this.indices = new Map();
    this._median = -1;
    this.ZERO = 0;
    this.isVal = this.isVal.bind(this);
  }
  /**
   * @param {number} id -- new storage key
   * @returns
   */
  init(id) {
   this.indices.set(id, -1);
  }
  /**
   * Add sample to storage
   * @param {number} id - key for samples
   * @param {number} val - value of the sample
   * @returns
   */
  add(id, val) {
    if (!this.indices.has(id)) {
      return;
    }
    const i = this.roll(this.indices.get(id) + 1);

    this.samples[this.sampleIdx(id) + i] = val;
    this.indices.set(id, i);
    this._median = -1;
  }
  delete(id) {
    if (!this.indices.has(id)) {
      return;
    }
    const startIdx = this.sampleIdx(id);

    this.samples.fill(this.ZERO, startIdx, startIdx + this.slen);
    this.indices.delete(id);
    this._median = -1;
  }
  get(id) {
    if (!this.indices.has(id)) {
      return [];
    }
    const startIdx = this.sampleIdx(id);

    return this.samples
      .slice(startIdx, startIdx + this.slen)
      .filter(this.isVal);
  }
  reset() {
    this.samples.fill(this.ZERO);
    this._median = -1;
  }
  has(id) {
    return this.get(id).length > 0;
  }
  isVal(x) {
    return x > this.ZERO;
  }
  sampleIdx(id) {
    return id * this.slen;
  }
  roll(i) {
    return i % this.slen;
  }
  get isComplete() { //TODO: Seem not to be working
    if (this.indices.size == 0) {
      return false;
    }
    /** Check that last item for all ids is present */
    const idxList = Array.from(this.indices.keys());
    let i = idxList.length;

    while(--i >= 0) {
      const id = idxList[i];
      const idx = this.sampleIdx(id + 1) - 1;
      const sample = this.samples[idx];

      if (!this.isVal(sample)) {
        return false;
      }
    }

    return true; 
  }
  get all() {
    return this.samples
      /** Skip last added sample since it increases deviation */
      .filter((_, i) => (
	this.roll(
	  this.indices.get(Math.trunc(i / this.slen)) //eq: this.indices.get(id)
	) != i
      ))
      .filter(this.isVal);
  }
  get mad() {
    return mad(this.all);
  }
  get median() {
    if (this._median === -1) {
      this._median = median(this.all);
    }
    return this._median;
  }
  get mean() {
    return mean(this.all);
  }
}

module.exports = SampleStore;
