#!/usr/bin/node
'use strict';
const fs = require('fs');
const uuid = require('uuid');
const nconf = require('nconf');
const iidk = require('./iidk');
const video = require('./video');
const timing = require('./timing');
const dash = require('./dashboard');

/** Suite tools */
const {Attempt, Experiment} = require('./suite');
const {
  fetchHostname, fetchBoardInfo, fetchOSInfo,
  fetchCPUInfo, fetchDate,
  fetchCPU, fetchMem,
} = require('./wsutils');
const {report, getId} = require('./utils');

/* Initialize parameters */
nconf.argv()
  nconf.argv()
  .file({file: './config.json'});

const IP = nconf.get('ip');
const IIDK_ID = nconf.get('iidk');
const MONITOR = nconf.get('monitor');
const STREAM = nconf.get('stream');
const STREAM_PATH = nconf.get('stream-list');
const STAT_INTERVAL = nconf.get('interval');
const STAT_TIMEOUT = STAT_INTERVAL * 5;
const CPU_INTERVAL = nconf.get('cpu-interval');
const CPU_THRESHOLD = nconf.get('cpu-threshold');
const CPU_READY = nconf.get('cpu-ready-threshold');
const CPU_SAMPLES = nconf.get('cpu-samples');
const FPS_THRESHOLD = nconf.get('fps-threshold');
const FPS_SAMPLES = nconf.get('fps-samples');
const FREEMB_THRESHOLD = nconf.get('freemb-threshold');
const stopOnExit = nconf.get('stop');
const REC_PATH = nconf.get('rec');
const INIT_COUNT = nconf.get('cams');
const REPORT_PATH = nconf.get('report-path');
const VALIDATE_COUNT = nconf.get('validate');
const DROP_RATIO = 1 - nconf.get('drop');
const MAX_FAILS = nconf.get('monitor-fails');

/* General constants */
const VIDEO = 'video.run core';
const OK = true;
const FAILED = false;

/* @global */
const streams = [];
let host = '';
let fileStream;
let streamIdx = 0;
let ex = new Experiment();

timing.init('global');

process.on('exit', () => {
  if (stopOnExit) {
    iidk.stopModule(VIDEO);
  } 
});
process.on('uncaughtException', (err) => {
  stderr('Caught exception:', err);
});
process.on('unhandledRejection', (reason, p) => {
  stderr('Unhandled Rejection at: Promise', p, 'reason: ', reason.stack);
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
.then(() => stderr('Fetching platform description'))
.then(() => {
  return Promise.all([fetchHostname(), fetchBoardInfo(), fetchOSInfo(), fetchCPUInfo()])
    .then(([hostname, board, {osName, ramSize}, processor]) => {
      const dateString = new Date().toISOString();
      const path = REPORT_PATH + '/' + (`${hostname}_${processor}_${dateString}.tsv`).replace(/[^A-Za-z0-9-_.]/g, '_'); 

      dash.showHostInfo(IP, hostname);

      /** @global */
      host = hostname;
      fileStream = fs.createWriteStream(path);

      fileStream.write(`OS\t${osName}\n`);
      fileStream.write(`CPU\t${processor}\n`);
      fileStream.write(`Board\t${board}\n`);
      fileStream.write(`RAM\t${ramSize.toFixed(2)}GB\n`);
      fileStream.write(`Attempts\t${VALIDATE_COUNT}\n`);
      fileStream.write(`Stat. interval\t${STAT_INTERVAL}\n`);
      fileStream.write(`CPU usage samples\t${CPU_SAMPLES}\n`);
      fileStream.write(`FPS samples\t${FPS_SAMPLES}\n`);
      fileStream.write(`FPS threshold\t${FPS_THRESHOLD}\n`);
      fileStream.write(`Vendor\tFormat\tWidth\tHeight\tFPS\tFPS(input)\tMax.cameras\tσ\tCPU\tScore\tStart time\tElapsed time\n`);
    });
})
.then(() => iidk.connect({ip: IP, host, iidk: IIDK_ID, reconnect: true}))
.then(() => video.connect({ip: IP, host, reconnect: true}))
.catch(r => stderr(r));

iidk.onconnect(bootstrap);
iidk.onconnect(() => stderr('IIDK connected'));
iidk.ondisconnect(() => streamIdx -= 1);
iidk.ondisconnect(() => stderr('IIDK disconnected'));

function bootstrap() {
  const stream = streams[streamIdx];
  streamIdx += 1;
  if (!stream) {
    stderr('Done!');
    process.exit();
  }

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
    refRe: /GRABBER.*Receive/,
    metricRe: /*/FileRecorder.*OUT/,*/ /CAM.*OUT/,
  });
  ex.stream = stream;
  ex.handlers = {
    add(id) { 
      video.setupIpCam(id, stream, {drives: REC_PATH});
    },
    remove(id) {
      video.hideCam(id, ex.options.monitorId);
      video.removeIpCam(id);
    },
    teardown,
    stats() {
      pollStats(0);
    }
  };
  timing.init('stream');
  fetchDate().then(d => ex.start = d);
  dash.showExInfo();
  dash.showProgress(streams, streamIdx, timing);
  initTest();
  stderr('Commence testing');
}

video.onconnect(warmUp);
video.onconnect(() => stderr('Video connected'));
video.ondisconnect(() => stderr('Video disconnected'));

function initTest () {
  ex.newAttempt();
  timing.init('test');
  return iidk.stopModule(VIDEO).then(() => iidk.startModule(VIDEO))
    .then(warmUp)
    .catch(r => stderr(r));
}
/**
 * Make sure system is ready
 * @returns {Promise}
 */
function chkSysReady(readyUsage) {
  let fails =  0;
  return new Promise((resolve, reject) => {
    stderr('Waiting for CPU');
    pollUsage((cpu, freemb) => {
      stderr(`{cyan-fg}${cpu}{/}`);
      if (cpu < readyUsage) {
        stderr('CPU OK');
        resolve();
        return false;
      }
      if (cpu > readyUsage && ++fails > MAX_FAILS) {
        reject('Settling too long');
        return false;
      }
      return true;
    });
  });
}

/**
 * Capture input stream FPS
 * @returns {Promise}
 */
function captureFps() {
  const testCamId = 1;

  stderr('Determining FPS');
  ex.handlers.add(testCamId);
  return new Promise((resolve, reject) => {
    pollStats(0);
    video.onstats((msg) => {
      if (ex.attempt.fpsIn === 0 && ex.options.refRe.test(msg.id)) {
        const fps = parseFloat(msg.params.fps);
        ex.attempt.addFpsIn(fps);
      }
      if (ex.attempt.fpsIn !== 0) {
        video.offstats();
        ex.handlers.remove(testCamId);
        stderr(`FPS: ${ex.attempt.fpsIn.toFixed(2)}`);
        resolve();
        return;
      }
      pollStats(ex.options.interval);
    });
  });
}

function warmUp() {
  stderr('Warming up...');
  chkSysReady(CPU_READY).then(captureFps).then(runTest)
    .catch(teardown);
}

function runTest() {
  const attempt = ex.attempt;
  /**
   * Commence Test, when we are ready
   */
  /** SETUP */
  video.setupMonitor(attempt.options.monitorId);
  /**/
  attempt.clearCpu();
  attempt.targetCams(ex.startCount);
  dash.showExInfo(ex);

  video.onstats((msg) => {
    dash.showStatTs();
    if (!attempt.hasPendingGen) {
      pollStats(ex.options.interval);
    }
    const isMetric = ex.options.metricRe.test(msg.id);
    const isReference = ex.options.refRe.test(msg.id);
    const id = isMetric || isReference ? parseInt(getId(msg.id)) : -1;
    const fps = isMetric ? parseFloat(msg.params.fps) : -1;
    const count = isReference ? parseInt(msg.params.count) : -1;
    const isCurrentCam = id === attempt.target;

    if (isMetric && fps > 0) {
      attempt.addOutFps(id, fps);
      dash.showProgress(streams, streamIdx, timing);
    }
    if (isMetric && fps <= 0) {
      return;
    }

    const shouldCalculate = isMetric && isCurrentCam && attempt.hasEnoughCpu;
    const isCalm = shouldCalculate ? attempt.isCalm : false;
    const hasFullFps = shouldCalculate ? attempt.hasFullFps : false;
    const isReady = shouldCalculate && isCalm;

    /**
     *  Cameras has stable FPS means iteration is complete 
     **/
    if (isReady && attempt.ignoreCPU) {
      attempt.seek(hasFullFps);
      return;
    }

    /** 
     * Add more cameras to saturate CPU,
     */
    const estimateByCPU = isReady && !attempt.ignoreCPU && hasFullFps;
    const n = estimateByCPU ? attempt.estimate : -Infinity; 

    /** Make sure that estimated number is higher than actual */
    if (estimateByCPU && n > attempt.count) {
      stderr(`Estimation {gray-fg}${n}{/}`);
      attempt.targetCams(n);
      return;
    } 
    if (estimateByCPU && n <= attempt.count) {
      stderr(`Estimated less than current {gray-fg}${n}{/}`);
      attempt.seek(OK);
      return;
    }

    /**
     * We exceeded limit, and must seek to find it
     */
    if (isReady && !hasFullFps) {
      stderr(`Estimation overreached (fps: {gray-fg}${attempt.samples.median.toFixed(2)}{/})`);
      attempt.seek(FAILED);
      return;
    }

    /**
     * FPS is settling down too long, presumably system is overloaded
     */
    if (shouldCalculate && !isCalm && attempt.calmFails > ex.options.maxFails) {
      stderr('Samples too random');
      attempt.seek(FAILED);
      return;
    }
    if ((isReference && !attempt.hasOutFps(id))) {
      video.showCam(id, attempt.options.monitorId);
      return;
    }
    //(isMetric && count === 0)
    //video.hideCam(id, attempt.options.monitorId);
  });
  pollStats(ex.options.interval);
  pollUsage((cpu, freeMB) => {
    attempt.addCpu(cpu);
    dash.showAttemptInfo(attempt);
    if (freeMB < FREEMB_THRESHOLD) {
      stderr('Not enough memory to continue');
      teardown();
    }
    /**
     * Stop adding estimated cameras if CPU is overloaded
     */
    if (attempt.target > attempt.count && 
        cpu > attempt.options.cpuThreshold) {
      stderr(`(${cpu}% = ${attempt.count})`);
      attempt.pendingGen.return();
      attempt.finaliseCams();
    }
    attempt.pendingGen.next();

    /** Update display */
    dash.showAttemptInfo(attempt);

    return attempt.isRunning;
  });
}

function teardown(err) {
  const testTime = timing.elapsedString('test');

  ex.dropCount();
  video.offstats();
  /** Make sure data makes sense */
  if (ex.attempt.count === 1 && ex.attempt.samples.median === 0) {
    err = 'Data is invalid!';
  }
  if (err) {
    streamIdx -= 1;
    ex.invalidAtmp();
    stderr(err);
    initTest();
    return;
  }
  /** Re-run test to get enough validation points */
  stderr(`Max: ${ex.attempt.count}, finished in ${testTime}`);
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


function stdout(m) {
  fileStream.write(m);
}

function stderr(e) {
  Array.prototype.forEach.call(arguments, a => {
    if (a instanceof Error) {
      dash.log(a.message);
      dash.log(a.stack);
    } else {
      dash.log(a);
    }
  });
}
const pollStats = (function () {
  let timerId = null;
  return function (delay) {
    clearTimeout(timerId);
    timerId = setTimeout(() => video.requestStats(), delay);
  }
})();
const pollUsage = (function () {
  let timerId = null;
  /**
   * Poll resource usage after delay and call function to process it
   * @param {number} interval -- poll interval
   * @param {function} cb -- callback function, must return boolean:
   *                          true: continue polling
   *                          false: stop polling
   * @returns {number} timer id
   */
  return function poll(cb) {
    clearTimeout(timerId);
    timerId = setTimeout(() =>
      Promise.all([fetchCPU(), fetchMem()])
        .then(resources => {
          const shouldPoll = cb.apply(null, resources);
          if (shouldPoll) {
            poll(cb);
          }
        })
        .catch(reason => {
          poll(cb);
        }), CPU_INTERVAL);
  }
})();
