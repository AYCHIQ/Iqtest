'use strict';
const fs = require('fs');
const uuid = require('uuid');
const _ = require('lodash');
const nconf = require('nconf');
const iidk = require('./iidk');
const video = require('./video');
const wsman = require('./wsman');
const timing = require('./timing');
const dash = require('./dashboard');

/* Math utils */
const {
  sum, min, max,
  mean, median, stdDev, mad
} = require('./mathutils.js');

/* Initialize parameters */
nconf.argv()
  nconf.argv()
  .file({file: './config.json'});

const HOST = nconf.get('host');
const IP = nconf.get('ip');
const IIDK_ID = nconf.get('iidk');
const WSMAN_AUTH = nconf.get('wsauth');
const MONITOR = nconf.get('monitor');
const STREAM = nconf.get('stream');
const STREAM_PATH = nconf.get('stream-list');
const STAT_INTERVAL = nconf.get('interval');
const STAT_TIMEOUT = (STAT_INTERVAL + 10) * 1000;
const CPU_THRESHOLD = nconf.get('cpu-threshold');
const CPU_READY = nconf.get('cpu-ready-threshold');
const CPU_SAMPLES = nconf.get('cpu-samples');
const CPU_INTERVAL = nconf.get('cpu-interval');
const FPS_THRESHOLD = nconf.get('fps-threshold');
const FPS_SAMPLES = nconf.get('fps-samples');
const stopOnExit = nconf.get('stop');
const REC_PATH = nconf.get('rec');
const INIT_COUNT = nconf.get('cams');
const REPORT_PATH = nconf.get('report-path');
const VALIDATE_COUNT = nconf.get('validate');
const DROP_RATIO = 1 - nconf.get('drop');
const MAX_FAILS = nconf.get('monitor-fails');

/* General constants */
const VIDEO = 'video.run core';
const FAILED = false;
const WS = {
  Board: 'Win32_BaseBoard',
  OS: 'Win32_OperatingSystem',
  LocalTime: 'Win32_LocalTime',
  Processor: 'Win32_Processor',
  ProcessorPerf: 'Win32_PerfFormattedData_PerfOS_Processor',
  Process: 'Win32_Process',
}

/* Global variables */
const streams = [];
let fileStream;

/**
 * @class
 * @param {object} options -- attempt options
 * @property {map} monitorFps -- FPS displayed in monitor
 * @property {number} fpsIn -- calculated input FPS
 * @property {array} cpuSamples -- last CPU usage samples
 * @property {number} monitorFails -- number of time we suspected failure
 * @property {number} calmFails -- number of time samples were not calm
 * @property {number} count -- number of added cameras
 * @property {object} cpu -- returns min, mean, max CPU usage
 * @property {number} camsQuota -- number of cameras we can safely add
 * @property {number} camId -- recent camera Id
 * @property {array} camHistory -- history of camera numbers since begining 
 * @property {array} ffHistory -- history of fullFps calculation
 * @property {number} lastDev -- recent deviation value 
 * @property {boolean} ignoreCPU -- whether we exceeded CPU limit
 *                                  and should ignore CPU usage
 * @property {boolean} hasEnoughFps -- whether we have enough FPS samples
 * @property {boolean} hasEnoughCpu -- whether we have enough CPU usage samples
 * @property {boolean} isCalm -- whether system metrics have stabilised
 * @property {boolean} hasFullFps -- calculate whether system renders all frames it receives
 * @property {array} streamFps -- FPS series of input video stream
 * @property {number} fps -- input FPS calculated value
 * @method addOutFps -- add camera FPS sample
 * @method addCpu -- add CPU sample
 * @method targetCams -- add/remove cameras to match target number
 * @method seek -- remove half of last camera number
 * @method clearCpu -- clear CPU samples 
 * @method {number} fpsOut -- mean output FPS
 */
class Attempt {
  constructor(options) {
    this.options = options;
    this.monitorFps = new Map();
    this.streamFps = [];
    this.fps = 0;
    this.cpuSamples = [];
    this.monitorFails = 0;
    this.calmFails = 0;
    this.camId = 0;
    this.camHistory = [this.options.lastCount];
    this.ffHistory = [true];
    this.lastDev = Infinity;
    this.ignoreCPU = this.options.lastCount === 0 ? false : true;
  }
  /**
   * Add FPS sample for camera
   *
   * @param {number} id -- camera Id
   * @param {number} fps -- FPS sample
   * @returns
   */
  addOutFps(id, fps) {
    if (this.monitorFps.has(+id)) {
      let samples = this.monitorFps.get(+id);
      samples.push(fps);
      this.monitorFps.set(+id, samples.slice(-this.options.fpsLen));
    }
    this.monitorFails = 0;
  }
  addCpu(cpu) {
    if (isFinite(cpu)) {
      this.cpuSamples.push(parseFloat(cpu));
    }
    this.cpuSamples = this.cpuSamples.slice(-this.options.cpuLen);
  }
  /**
   * @returns
   */
  clearCpu() {
    this.cpuSamples = [];
  }
  /**
   * Get CPU usage statistic 
   * @return {object} min/mean/max
   */
  get cpu() {
    const cmin = min(this.cpuSamples);
    const cmean = median(this.cpuSamples);
    const cmax = max(this.cpuSamples);

    return {
      min: isFinite(cmin) ? cmin : undefined,
      mean: isFinite(cmean) ? cmean : undefined,
      max: isFinite(cmax) ? cmax : undefined,
    }
  }
  get fpsIn() {
    return this.fps;
  }
  set fpsIn(fps) {
    if (fps > 0) {
      this.streamFps.push(fps);
      this.streamFps = this.streamFps.slice(-this.options.fpsLen);
      /** Trace */
      stderr('{cyan-fg}' + this.streamFps.map(f => f.toFixed(2)).join(' ') + '{/}');
      stderr(`FPS: ${median(this.streamFps).toFixed(2)}\tMAD: ${mad(this.streamFps).toFixed(3)}`);
      /** */
      const dev = mad(this.streamFps);
      if (this.streamFps.length === this.options.fpsLen &&
          dev > this.lastDev) {
        this.fps = median(this.streamFps);
      }
      this.lastDev = dev;
    }
  }
  /**
   * Get mean output FPS
   * @param {number} id -- camera Id
   * @returns {number}
   */
  fpsOut(id) {
    if (id) {
      return mean(this.monitorFps.get(+id));
    } else {
      return Array.from(this.monitorFps).reduce((r, kv) => r.concat(kv[1]), []);
    }
  }
  get hasEnoughFps() {
    return this.monitorFps.get(+id).length === this.options.fpsLen;
  }
  get hasEnoughCpu() {
    return this.cpuSamples.length === this.options.cpuLen;
  }
  get isCalm() {
    const allFpsOut = this.fpsOut();
    const allHaveEnoughFps = allFpsOut.length === (this.monitorFps.size * this.options.fpsLen);
    const dev = mad(allFpsOut);
    const minimising = dev < this.lastDev;
    
    this.lastDev = dev;
    //if (allHaveEnoughFps) {
    //  this.calmFails = 0;
    //} else {
    //  this.calmFails += 1;
    //}
    return allHaveEnoughFps && !minimising;
  }
  get count() {
    return this.camId;
  }
  get camsQuota() {
    const camsCount = this.count;
    const usage = this.cpu.mean;
    const cpuThreshold = this.options.cpuThreshold;
    const specificUsage = usage / camsCount;
    const estimated = cpuThreshold / specificUsage;
    const diff = estimated - camsCount;
    
    let quota = camsCount + Math.round(Math.log(Math.pow(diff, 5)));

    return quota;
  }
  get hasFullFps() {
    //const allFpsOut = Array.from(this.monitorFps).map(kv => mean(kv[1]));
    const allFpsOut = this.fpsOut();
    const delta = (median(allFpsOut.map(f => Math.abs(f - this.fpsIn))));
    const value = delta <= this.options.fpsThreshold;

    return value;
  }
  targetCams(target) {
    let id = this.camId;

    switch (Math.sign(target - this.count)) {
      case 1:
        stderr('+');
        for (id += 1; id <= target; id += 1) {
          video.setupIpCam(id, ex.stream, ex.options.cam);
          video.showCam(id, this.options.monitorId);
          this.monitorFps.set(id, []);
          this.camId = id;
        }
        this.clearCpu();
        break;
      case -1:
        stderr('-');
        if (target < 1) {
          teardown('Stream failure');
        }
        for (id; id > target && id > 1; id -= 1) {
          video.hideCam(id, this.options.monitorId);
          video.removeIpCam(id);
          this.monitorFps.delete(id);
          this.camId = id - 1;
        }
        this.clearCpu();
        break;
      case 0:
        teardown();
        return;
        break;
      default:
        break;
    }
    this.camHistory.push(target);
    /** Reset calm metrics */
    this.monitorFps.forEach(resetSample);
    this.lastDev = Infinity;
    this.calmFails = 0;
    stderr(`=${this.count}`);
  }
  seek(isOK = !FAILED) {
    const camHist3 = this.camHistory.slice(-3);
    const ffLast = this.ffHistory[this.ffHistory.length - 1];
    const ffNow = isOK ? this.hasFullFps : FAILED;
    let target = camHist3[camHist3.length - 1];
    let diff = camHist3.slice(-2).reduce((r, v) => Math.abs(r - v), 0);

    this.ffHistory.push(ffNow);
    if (ffNow !== ffLast) {
      diff = Math.floor(diff / 2);
    }
    /** 
     * If last failed and difference is zero, we still fail
     * and must reiterate 
     */
    //if (diff === 0 && ffNow === FAILED) {
    //  diff += 1;
    //}
    this.ignoreCPU = true;
    target += ffNow ? diff : -diff;

    stderr('S');
    this.targetCams(target); 
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
     * @member {number} interval -- statistics interval
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
  }
  newAttempt() {
    this.options.lastCount = this.attempt ? this.attempt.count : 0;
    this.attempts.push(new Attempt(this.options));
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
    return this.attempts.length < this.options.validateCount;
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
let streamIdx = 0;
let timer = null;
let cpuTimer = null;
let ex = new Experiment();

timing.init('global');

process.on('exit', () => {
  if (stopOnExit) {
    iidk.stopModule(VIDEO);
  } 
});
process.on('uncaughtException', (err) => {
  logError(`\n${progressTime()}\nCaught exception:`, err);
});
process.on('unhandledRejection', (reason, p) => {
  logError(`\n${progressTime()}\nUnhandled Rejection at: Promise `, p, 'reason: ', reason.stack);
});

/* Prepare video stream URI */
new Promise ((resolve, reject) => {
  fs.access(STREAM_PATH, fs.R_OK, (err) => {
    if (err) {
      streams.push(STREAM);
      resolve();
    } else {
      fs.readFile(STREAM_PATH, 'utf8', (errRead, data) => {
        if (errRead) {
          reject(`${STREAM_PATH} read error`);
        } else {
          data.trim().split('\n').forEach((s) => streams.push(s));
          resolve();
        }
      });
    }
  });
})
.then(() => {
  /* Get system info */
  let board = '';
  let processor = '';
  let osName= '';
  let ramSize = 0;
  const deferBoardInfo = wsman.enumerate({ip: IP, resource: WS.Board, auth: WSMAN_AUTH})
    .then((items) => board = `${items[0].Manufacturer} ${items[0].Product}`)
    .catch(stderr);
  const deferOSInfo = wsman.enumerate({ip: IP, resource: WS.OS, auth: WSMAN_AUTH})
    .then((items) => {
      osName = items[0].Caption;
      ramSize = items[0].TotalVisibleMemorySize / Math.pow(2, 20);
    })
    .catch(stderr);
  const deferCPUInfo = wsman.enumerate({ip: IP, resource: WS.Processor, auth: WSMAN_AUTH})
    .then((items) => processor = items[0].Name)
    .catch(stderr);

  video.stats(STAT_INTERVAL);
  
  Promise.all([deferOSInfo, deferCPUInfo])
    .then(() => {
      const dateString = new Date().toISOString();
      const path = REPORT_PATH + '/' + (`${HOST}_${processor}_${dateString}.tsv`).replace(/[^A-Za-z0-9-_.]/g, '_'); 
      
      fileStream = fs.createWriteStream(path);
      return fileStream;
    })
    .then(() => {
      stdout(`OS\t${osName}\n`);
      stdout(`CPU\t${processor}\n`);
      stdout(`Board\t${board}\n`);
      stdout(`RAM\t${ramSize.toFixed(2)}GB\n`);
      stdout(`Attempts\t${VALIDATE_COUNT}\n`);
      stdout(`Stat. interval\t${STAT_INTERVAL}\n`);
      stdout(`CPU usage samples\t${CPU_SAMPLES}\n`);
      stdout(`FPS samples\t${FPS_SAMPLES}\n`);
      stdout(`FPS threshold\t${FPS_THRESHOLD}\n`);
      stdout(`Vendor\tFormat\tWidth\tHeight\tFPS\tFPS(input)\tMax.cameras\tσ\tCPU\tScore\tStart time\tElapsed time\n`);

      iidk.connect({ip: IP, host: HOST, iidk: IIDK_ID, reconnect: true});
    })
    .catch(stderr);

})
.catch(stderr);

iidk.onconnect(() => bootstrap());
iidk.onconnect(() => stderr('IIDK connected'));
iidk.ondisconnect(() => streamIdx -= 1);
iidk.ondisconnect(() => stderr('IIDK ondisconnect'));

function bootstrap() {
  ex = new Experiment({
    fpsLen: FPS_SAMPLES,
    cpuLen: CPU_SAMPLES,
    dropRatio: DROP_RATIO,
    fpsThreshold: FPS_THRESHOLD,
    cpuThreshold: CPU_THRESHOLD,
    validateCount: VALIDATE_COUNT,
    maxFails: MAX_FAILS,
    monitorId: MONITOR,
    interval: STAT_INTERVAL,
    cam: {
      drives: REC_PATH,
    },
    metricRe: /CAM.*OUT/,
  });
  ex.stream = streams[streamIdx];
  streamIdx += 1;
  timing.init('stream');
  wsman.enumerate({ip: IP, resource: WS.LocalTime, auth: WSMAN_AUTH})
    .then(items => {
      const d = items[0];
      ex.start = `${d.Year}-` +
        `${timing.toDoubleDigit(d.Month)}-` +
        `${timing.toDoubleDigit(d.Day)} ` +
        `${timing.toDoubleDigit(d.Hour)}:` +
        `${timing.toDoubleDigit(d.Minute)}:` +
        `${timing.toDoubleDigit(d.Second)}`;
    })
    .catch(stderr);
  if (ex.stream) {
    initTest();
  } else {
    stderr('Done!\n');
    process.exit();
  }
  dash.showExInfo();
  dash.showProgress(streams, streamIdx, timing);
}

video.onconnect(() => warmUp());
video.onconnect(() => stderr('Video connected'));
video.ondisconnect(() => stderr('Video disconnected'));

function initTest () {
  ex.newAttempt();
  timing.init('test');
  return iidk.stopModule(VIDEO)
    .then(() => iidk.startModule(VIDEO))
    .then(() => video.connect({ip: IP, host: HOST, reconnect: true}))
    .catch(stderr);
}
function resetTimer () {
  clearTimeout(timer);
  timer = setTimeout(teardown, STAT_TIMEOUT, 'Statistics timeout');
}
/**
 * Make sure system is ready
 * @returns {Promise}
 */
function chkSysReady() {
  return new Promise((resolve, reject) => {
    let checkId = -1;
    
    checkId = setInterval(() => fetchCPU().then(cpu => {
      if (cpu < CPU_READY) {
        stderr('\nCPU OK\t');
        clearInterval(checkId);
        resolve();
      }
    }).catch(stderr), CPU_INTERVAL);
  });
}

/**
 * Capture input stream FPS
 * @returns {Promise}
 */
function captureFps() {
  const testCamId = 1;

  video.setupIpCam(testCamId, ex.stream);
  return new Promise((resolve, reject) => {
    video.onstats((msg) => {
      if (ex.attempt.fpsIn === 0 && /GRABBER.*Receive/.test(msg.id)) {
        const fps = parseFloat(msg.params.fps);

        ex.attempt.fpsIn = fps;
      }
      if (ex.attempt.fpsIn !== 0) {
        video.offstats();
        video.removeIpCam(testCamId);
        stderr(`FPS: ${ex.attempt.fpsIn.toFixed(2)}\n`);
        resolve();
      }
    });
  });
}

function warmUp() {
  chkSysReady().then(captureFps).then(runTest).catch(stderr);
}

function runTest() {
  /**
   * Commence Test, when we are ready
   */
  video.setupMonitor(MONITOR);
  ex.attempt.targetCams(ex.startCount);
  dash.showExInfo(ex);

  video.onstats((msg) => {
    if (ex.options.metricRe.test(msg.id)) {
      const id = getId(msg.id);
      const fps = parseFloat(msg.params.fps);
      const isCurrentCam = id === ex.attempt.camId.toString();

      if (fps === -1) {
        return;
      }
      ex.attempt.addOutFps(id, fps);
      if (isCurrentCam && ex.attempt.hasEnoughCpu) {
        if (ex.attempt.isCalm) {
          /* Cameras has stable FPS -> iteration is complete */
          if (ex.attempt.ignoreCPU) {
            ex.attempt.seek();
          }
          /** 
           * Add more cameras to saturate CPU,
           */
          else if (ex.attempt.hasFullFps) {
            let n = ex.attempt.camsQuota;

            stderr('E');
            ex.attempt.targetCams(n);
          } 
          /**
           * We exceeded limit, and must seek to find it
           */
          else {
            ex.attempt.seek(FAILED);
          }
        }
        /**
         * FPS is settling down too long, presumably system is overloaded
         */
        else if (ex.attempt.calmFails > ex.options.maxFails) {
          stderr('F');
          ex.attempt.seek(FAILED);
        }
      }
      dash.showAttemptInfo(ex.attempt);
    }
  });
  cpuTimer = setInterval(() => fetchCPU().then((cpu) => ex.attempt.addCpu(cpu)), CPU_INTERVAL);
}

function fetchCPU() {
  return wsman.enumerate({ip: IP, resource: WS.ProcessorPerf, auth: WSMAN_AUTH})
    .then((items) => {
      const usageArr = items.filter((u) => u.Name === '_Total')
        .map((u) => (100 - u.PercentIdleTime));
      return usageArr[0];
    })
  .catch((items, error) => stderr(`\nFailed to fetch CPU usage\n`));
};

function teardown(err) {
  const testTime = timing.elapsedString('test');

  clearInterval(cpuTimer);
  ex.dropCount();
  video.offstats();
  if (err) {
    streamIdx -= 1;
    ex.invalidAtmp();
    stderr(err);
    initTest();
    return;
  }
  /* Re-run test to get enough validation points */
  stderr(`\nMax: ${ex.attempt.count}, finished in ${testTime}\n`);
  if (ex.isPending) {
    ex.maxCount = ex.attempt.count;
    initTest();
  } else {
    ex.elapsed = timing.elapsedString('stream');
    stdout(report(ex));
    bootstrap();
  }
  return;
}

/**
 * Extract stream information encoded in filename
 * within RTSP URI.
 * Vendor+Name_H264_800x600_30.ts ->
 * {
 *  vendor: Vendor Name,
 *  format: H264,
 *  width: 800,
 *  height: 600,
 *  fps: 30
 * }
 * @params {string}
 * returns {object}
 */
function parseUri(uri) {
  const locationRe = /location=([^`]+).+?!/;
  const keys = ['vendor', 'format', 'width', 'height', 'fps'];
  if (locationRe.test(uri)) {
    return locationRe.exec(uri)[1] //get "location=..." fragment
      .replace(/.+\//, '') //remove folder ".../"
      .replace(/\..*/, '') //remove extension ".*"
      .replace(/\+/g, ' ')
      .replace(/_/g, '\t')
      .replace(/(\d+)x(\d+)/g, '$1\t$2') //split WxH
      .split('\t')
      .reduce((r, val, idx) => {
          r.res[r.keys[idx]] = val;
            return r;
      }, {res: {}, keys})
      .res;
  } else {
    return {
      vendor: uri,
    };
  }
}

/**
 * Format experiment report
 * @param {Experiment} e
 * @returns {string}
 */
function report(e) {
  const s = e.streamAttr;
  const vendor = s.vendor;
  const format = s.format;
  const width = s.width;
  const height = s.height;
  const sfps = s.fps;
  const cpu = e.cpu.toFixed(2);
  const fps = e.fps.toFixed(2);
  const cams = e.cams;
  const sigma = e.camsDispersion.toFixed(2);
  const score = e.score.toFixed(2);
  const start = e.start;
  const elapsed = e.elapsed;

  return `${vendor}\t${format}\t${width}\t${height}\t` +
    `${sfps}\t${fps}\t${cams}\t${sigma}\t${cpu}\t` +
    `${score}\t${start}\t${elapsed}\n`;
}

/**
 * Clear samples
 * @param {object} value
 * @param {object} key
 * @param {map} m
 */
function resetSample (value, key, m) {
  m.set(key, []);
}

/**
 * Extract id from message id string
 * @param {string} msgId -- message id string (e.g. [MONITOR][1][CAM][10][OUT])
 * @returns {string} id
 */
function getId(msgId) {
  return /([0-9]+)[^0-9]*$/.exec(msgId)[1];
}

function stdout(m) {
  fileStream.write(m);
}

function stderr(e) {
  Array.prototype.forEach.call(arguments, a => {
    if (a instanceof Error) {
      dash.logError(a.message);
      dash.logError(a.stack);
    } else {
      dash.logError(a);
    }
  });
}
