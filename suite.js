const SampleStore = require('./samples');
const {log} = require('./dashboard');
const {parseUri} = require('./utils');
const {pollStats} = require('./wsutils');
const timing = require('./timing');
/* Math utils */
const {
  min, max,
  mean, median, stdDev, mad
} = require('./mathutils.js');
const GOLDEN_RATIO = 0.618;
const GOLDEN_RATIO_ = 1.618;

/**
 * @class Attempts
 * @param {object} options -- attempt options
 * @param {object} handlers -- add/remove function holder
 * @property {map} monitorFps -- FPS displayed in monitor
 * @property {array} cpuSamples -- last CPU usage samples
 * @property {number} calmFails -- number of time samples were not calm
 * @property {number} count -- number of added cameras
 * @property {object} cpu -- returns min, mean, max CPU usage
 * @property {number} estimate -- number of cameras we can safely add
 * @property {number} camId -- recent camera Id
 * @property {array} camHistory -- history of camera numbers since begining 
 * @property {array} ffHistory -- history of fullFps calculation (reversed)
 * @property {number} lastDev -- recent deviation value 
 * @property {boolean} ignoreCPU -- whether we exceeded CPU limit
 *                                  and should ignore CPU usage
 * @property {boolean} hasEnoughCpu -- whether we have enough CPU usage samples
 * @property {boolean} hasEnoughSamples -- whether we have enough FPS samples
 * @property {boolean} isCalm -- whether system metrics have stabilised
 * @property {boolean} hasFullFps -- calculate whether system renders all frames it receives
 * @property {boolean} hasSaneFps -- do we have sane sample values (s/ref > GOLDEN_RATIO) 
 * @property {array} streamFps -- FPS series of input video stream
 * @property {number} fpsIn -- input FPS calculated value
 * @property {number} fpsOut -- output FPS median value
 * @property {boolean} isRunning -- whether attempt is being executed
 * @property {number} target -- target number of cameras
 * @property {generator} pendingGen -- currently running generator
 * @property {number} pendingTimer -- timer id for running generator
 * @property {array} lastSamples -- array of sample for last added camera
 * @property {number} lastiOpTime -- timestamp of last operation
 * @property {number} stage -- one of: NOT_STARTED, GET_FPS, TESTING, DONE
 * @property {map} noFps -- map of counters to keep track of no stat cameras
 * @method addOutFps -- add camera output FPS sample
 * @method addInFps -- add camera input FPS sample
 * @method hasOutFps -- returrns presence of FPS samples for the cam
 * @method addCpu -- add CPU sample
 * @method targetCams -- add/remove cameras to match target number
 * @method finaliseCams -- run operations to finalise camera removal/addition
 * @method seek -- remove half of last camera number
 * @method clearCpu -- clear CPU samples 
 * @method handle -- collection of handlers
 * @method nextState -- advance attempt stage
 * @method resetMetrics -- reset samples and deviation history
 */
class Attempt {
  constructor(options, handlers) {
    this.NOT_STARTED = -1;
    this.GET_FPS = 0;
    this.TESTING = 1;
    this.DONE = 2;

    this.options = options;
    this.samples = new SampleStore(options.fpsLen);
    this.streamFps = new SampleStore(options.fpsLen);
    this.fps = 0;
    this.cpuSamples = [];
    this.calmFails = 0;
    this.camId = 0;
    this.camHistory = [];
    this.ffHistory = [{count: 0, ff: true}];
    this.lastDev = Infinity;
    this.lastCalmTime = Date.now();
    this.ignoreCPU = false; //this.options.lastCount === 0 ? false : true;
    this.target = -1;
    this.pendingGen = (function* (){})();
    this.pendingTimer = -1;
    this.pendingGen.return();
    this.stage = this.NOT_STARTED;
    this.noFps = timing;
    /**
     * @namespace
     * @member add
     * @member remove
     * @member teardown
     */
    this.handle = handlers;
    this.streamFps.init(0);

    if (this.options.lastCount) {
      this.camHistory.push(this.options.lastCount);
      this.ffHistory.unshift({count: this.options.lastCount, ff: true});
    }
  }
  /**
   * Add FPS sample for camera
   *
   * @param {number} id -- camera Id
   * @param {number} fps -- FPS sample
   * @returns
   */
  addOutFps(id, fps) {
    const failPeriod = this.noFps.elapsed(id);
    const isRelevant = id <= this.count;
    let failed = !(fps > 0) && isRelevant;

    this.samples.add(id, fps);

    if (failed && failPeriod > this.options.timeout) {
      /** Reinit camera */
      log(`Re-init ${id} fails for {cyan-fg}${this.noFps.elapsedString(id)}{/}`);
      this.handle.reinit(id);
      failed = false;
    }
    if (failed && !failPeriod) {
      this.noFps.init(id);
    }
    if (!failed) {
      this.noFps.remove(id);
    }
  }
  hasOutFps(id) {
    return this.samples.has(id);
  }
  get lastSamples() {
    return this.samples.get(this.camId);
  }
  addCpu(cpu) {
    if (isFinite(cpu)) {
      this.cpuSamples.push(cpu);
      this.cpuSamples = this.cpuSamples.slice(-this.options.cpuLen);
    }
  }
  /**
   * @returns
   */
  clearCpu() {
    this.cpuSamples.length = 0;
  }
  /**
   * Get CPU usage statistic 
   * @return {object} min/mean/max
   */
  get cpu() {
    return {
      min: min(this.cpuSamples),
      mean: mean(this.cpuSamples),
      max: max(this.cpuSamples),
    }
  }
  get fpsIn() {
    return this.fps;
  }
  get fpsOut() {
    return this.samples.median;
  }
  addFpsIn(fps) {
    const {fpsThreshold} = this.options;
    if (fps <= fpsThreshold) {
      return;
    }
    this.streamFps.add(0, fps);
    const {isComplete, mad, median} = this.streamFps;
    const devThreshold = this.lastDev * GOLDEN_RATIO_;

    log(`median: {cyan-fg}${(median).toFixed(2)}\t` +
      `dev: {cyan-fg}${mad.toFixed(3)}{/} ⦔${devThreshold.toFixed(3)}\t` +
        `n: {cyan-fg}${this.streamFps.all.length}{/}`);

    if (isComplete && mad < this.options.fpsThreshold &&
	(mad > devThreshold)) {
      this.fps = median;
      return;
    }
    this.lastDev = isComplete ? mad : this.lastDev;
  }
  get hasEnoughCpu() {
    return this.cpuSamples.length == this.options.cpuLen;
  }
  get hasEnoughSamples() {
    return this.samples.isComplete;
  }
  get isCalm() {
      const {mad, median} = this.samples;
      const minimising = mad < this.lastDev;
      const acceptable = mad < this.options.fpsThreshold;

      this.lastDev = mad;
      return !minimising && acceptable;
  }
  get count() {
    return this.camId;
  }
  get estimate() {
    const camsCount = this.count;
    const usage = this.cpu.mean;
    const cpuThreshold = this.options.cpuThreshold * GOLDEN_RATIO;
    const specificUsage = usage / camsCount;
    const estimated = Math.round(cpuThreshold / specificUsage);

    return estimated;
  }
  get hasFullFps() {
    const fpsMedian = this.fpsOut;
    const delta = Math.abs(fpsMedian - this.fpsIn);
    const value = delta < this.options.fpsThreshold;

    return value;
  }
  get hasSaneFps() {
    return !this.hasEnoughSamples ||
      this.fpsOut > this.fpsIn * GOLDEN_RATIO;
  }
  get isRunning() {
    return this.stage == this.TESTING; 
  }
  
  /**
   * Set stage number if specified or increment it.
   * @param {number} stage -- stage to set
   * @returns
   */
  nextStage(stage) {
    if (stage > this.NOT_STARTED && stage <= this.DONE) {
      this.stage = stage;
    }
    if (arguments.length === 0) {
      this.stage += 1;
    }
  }
  targetCams(target) {
    let id = this.camId;

    this.pendingGen.return();
    this.target = target;

    if (target == 0) {
      this.handle.teardown('Stream failure');
    }

    log(`» {white-fg}${target}{/}`);
    switch (Math.sign(target - this.count)) {
      case 1:
	this.pendingGen = (function* () {
	  this.hasPendingGen = true;
	  for (id += 1; id <= this.target; id += 1) {
	    /** ADD */
	    this.samples.init(id);
	    this.handle.add(id);
	    this.camId = id;
	    this.lastOpTime = Date.now();
	    //log(`+${this.camId}`);
	    /**/
	    yield;
	  }
	  this.finaliseCams();
        }.bind(this))();
        break;
      case -1:
	this.pendingGen = (function* () {
	  this.hasPendingGen = true;
	  for (id; id > this.target && id > 1; id -= 1) {
	    /** REMOVE */
	    this.samples.delete(id);
	    this.handle.remove(id);
	    this.camId = id - 1;
	    this.lastOpTime = Date.now();
	    //log(`-${this.camId}`);
	    /**/
	    yield;
	  }
	  this.finaliseCams();
	}.bind(this))();
        break;
      case 0:
        this.nextStage(this.DONE);
        log(`${this.fpsOut.toFixed(2)}/${this.fpsIn.toFixed(2)}`);
        this.handle.teardown();
        return;
      default:
        break;
    }

    this.pendingGen.next();
    this.resetMetrics();
  }
  finaliseCams() {
    clearTimeout(this.pendingTimer);
    this.hasPendingGen = false;
    this.target = this.camId;
    this.resetMetrics();

    if (this.camId != this.camHistory[this.camHistory.length - 1]) {
      this.camHistory.push(this.camId);
    }
  }
  seek(hasFullFps) {
    const camHist3 = this.camHistory.slice(-3);
    const ffLast = this.ffHistory[0].ff;
    const ffNow = hasFullFps;

    this.ffHistory.unshift({count: this.count, ff: ffNow});
    
    let target = this.count;
    let diff = camHist3
      .slice(-2)
      .reduceRight((r, v) => Math.abs(r - v));
    let isRepeated =
      this.ffHistory.length > 3 &&
      this.ffHistory.slice(0, 3)
	.map(v => v.ff)
	.reduce((r, v) => r == v);

    if (ffNow != ffLast) {
      diff /= 2;
    }
    if(isRepeated) {
      const diffHist = this.camHistory
	.map((c, idx, hist) => Math.abs(c - hist[idx - 1]) | 0);
      const maxDiff = Math.max.apply(null, diffHist);

      diff = Math.min(maxDiff, diff * GOLDEN_RATIO_) + 1;
    }

    const lastSuccess = this.ffHistory.find(v => v.ff);

    this.ignoreCPU = true;
    target += ffNow ? diff : -diff;
    target = Math.floor(target);
    target = Math.max(target, lastSuccess.count);

    log(
	'Seek ' + (ffNow ? '{green-fg}' : '{red-fg}') +
	this.fpsOut.toFixed(2) + '{/}'
    );
    this.targetCams(target); 
  }
  resetMetrics() {
    this.samples.reset();
    this.clearCpu();
    this.lastDev = Infinity;
    this.calmFails = 0;
  }
}
/** 
 * @class
 *
 * @param {object} options -- experiment options
 * @property {string} start -- start time fetched from tested server
 * @property {string} elapsed -- time spent for single stream test
 * @property {number} startCount -- number of cameras to start attempt with
 * @property {string} stream -- RTSP stream URI
 * @property {object} streamAttr -- RTSP stream attributes (parsed)
 * @property {array} attempts -- experiment attempts
 * @property {Attempt} attempt -- current test Attempt
 * @property {number} numAttempt -- number of completed Attempts
 * @property {number} cpu -- mean CPU usage over Attempts
 * @property {number} cams -- mean maximum camera number over Attempts
 * @property {number} camsDispersion -- standard deviation of maximum number across Attempts
 * @property {number} fps -- mean FPS over Attempts
 * @property {boolean} isPending -- needs more Attempts to complete
 * @property {object} handlers -- provided handlers storage
 * @method newAttempt -- create new test Attempt
 * @method getAttempt -- gets attempt by index
 * @method invalidAtmp -- remove last Attempt
 * @method dropCount -- calculate startCount according to dropRatio
 */
class Experiment {
  constructor(options) {
    /**
     * @namespace
     * @member {number} fpsLen -- length of FPS sample window
     * @member {number} cpuLen -- length of CPU usage sample window
     * @member {number} fpsTolerance -- tolerance for FPS deviation
     * @member {number} cpuTolerance -- tolerance for CPU deviation
     * @member {number} dropRatio -- relative decrease of startCount for next iteration
     * @member {number} fpsThreshold -- threshold of FPS acceptability 
     * @member {number} cpuThreshold -- threshold of CPU high load
     * @member {number} validateCount -- number of Attempts that
     *                                   must be completed to finish Experiment
     * @member {number} maxFails -- maximum number of various fails
     * @member {number} monitorId -- Monitor Id used by test
     * @member {object} cam -- camera parameters
     * @member {regexp} metricRe -- regexp to match stat parameter
     * @member {number} lastCount -- number of cameras on last attempt
     */
    this.options = options || {};
    this.start = '';
    this.elapsed = '';
    this.streamUri = '';
    this._sattr = {};
    this.attempts = [];
    this.startCount = 1;
    this.fails = 0;
    this.handlers = {}; 
  }
  newAttempt() {
    this.options.lastCount = this.attempt ? this.attempt.count : 0;

    this.attempts.push(new Attempt(this.options, this.handlers));
  }
  getAttempt(idx) {
    const len = this.attempts.length;
    if (idx < 0) {
      idx += len;
    }
    if (idx >= 0 && idx <= len) {
      return this.attempts[idx];
    } else {
      return undefined;
    }
  }
  get attempt() {
    return this.getAttempt(-1);
  }
  invalidAtmp() {
    this.attempts.pop();
  }
  set stream(uri) {
    this.streamUri = uri;
    if (uri){
      this._sattr = parseUri(uri);
    }
  }
  get stream() {
    return this.streamUri;
  }
  get streamAttr() {
    return this._sattr;
  }
  dropCount() {
    this.startCount = Math.trunc((this.attempt.count || 1) * this.options.dropRatio) || 1;
  }
  get isPending() {
    const {length} = this.attempts;
    return length !== 0 && length < this.options.validateCount;
  }
  get cams() {
    return Math.round(mean(this.attempts.map(a => a.count)));
  }
  get camsDispersion() {
    return stdDev(this.attempts.map(a => a.count));
  }
  get cpu() {
    return mean(this.attempts.map(a => a.cpu.mean));
  }
  get fps() {
    return mean(this.attempts.map(a => a.fpsIn));
  }
  get score() {
    const width = parseInt(this.streamAttr.width);
    const height = parseInt(this.streamAttr.height);
    const cams = this.cams;
    const fps = this.fps;
    const cpu = this.cpu;

    return (width * height * cams * fps) / (Math.pow(2, 20) * cpu);
  }

}

module.exports = {
  Attempt,
  Experiment,
};
