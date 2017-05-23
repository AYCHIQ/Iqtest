#!/usr/bin/node
'use strict';
const fs = require('fs');
const uuid = require('uuid');
const nconf = require('nconf');
const iidk = require('./iidk');
const video = require('./video');
const timing = require('./timing');
const dash = require('./dashboard');

/* Initialize parameters */
nconf.argv()
  nconf.argv()
  .file({file: './config.json'});

const IP = nconf.get('ip');
const WSAUTH = nconf.get('wsauth');
const IIDK_ID = nconf.get('iidk');
const MONITOR = nconf.get('monitor');
const HEADLESS = nconf.get('headless');
const STREAM = nconf.get('stream');
const STREAM_PATH = nconf.get('stream-list');
const STAT_INTERVAL_FAST = nconf.get('fast-interval');
const STAT_INTERVAL = nconf.get('interval');
const CALM_TIMEOUT = nconf.get('calm-timeout') * 1e3;
const STAT_TIMEOUT = CALM_TIMEOUT / 10;
const GEN_INTERVAL = nconf.get('gen-interval');
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
const MAX_FAILS = nconf.get('fails');

/** Suite tools */
const {Attempt, Experiment} = require('./suite');
const {
  fetchHostname, fetchBoardInfo, fetchOSInfo,
  fetchCPUInfo, fetchDate,
  fetchCPU, fetchMem,
} = require('./wsutils')({ip: IP, auth: WSAUTH});
const {report, getId, debounce, throttle} = require('./utils');
const getResources = () => Promise.all([fetchCPU(), fetchMem()]);

/* General constants */
const VIDEO = 'video.run core';
const OK = true;
const FAILED = false;
const HIRES = true;

/* @global */
const streams = [];
let host = '';
let fileStream;
let streamIdx = 0;
let restartTimerId = -1;
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
.then(() => {
  stderr('Fetching platform description');
  return Promise.all([fetchHostname(), fetchBoardInfo(), fetchOSInfo(), fetchCPUInfo()])
    .then(([hostname, board, {osName, ramSize}, processor]) => {
      const dateString = new Date().toISOString();
      const path = REPORT_PATH + '/' + 
	(`${hostname}_${processor}_${dateString}.tsv`)
	.replace(/[^A-Za-z0-9-_.]/g, '_'); 

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
.catch(stderr);

iidk.onconnect(function () {
  stderr('IIDK connected');
  if (ex.isPending) {
    teardown('Lost connection during Attempt');
  } else {
    bootstrap();
  }
});
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
    genInterval: GEN_INTERVAL,
    maxFails: MAX_FAILS,
    timeout: STAT_TIMEOUT,
    monitorId: MONITOR,
    refRe: /GRABBER.*Receive/,
    metricRe: HEADLESS ? /FileRecorder.*OUT/ : /CAM.*OUT/,
    isHeadless: HEADLESS,
  });
  ex.stream = stream;
  ex.handlers = {
    add(id) { 
      video.setupIpCam(id, stream, {drives: REC_PATH});
      !ex.options.isHeadless && video.showCam(id, ex.options.monitorId);
    },
    remove(id) {
      !ex.options.isHeadless && video.hideCam(id, ex.options.monitorId);
      video.removeIpCam(id);
    },
    reinit(id) {
      const evt = {id, action: 'DETACH'};

      iidk.on(evt, function () {
	setTimeout(this.add, GEN_INTERVAL, id);
	iidk.off(evt);
      }.bind(this));
      this.remove(id);
    },
    teardown,
  };
  timing.init('stream');
  fetchDate().then(d => ex.start = d);
  dash.showExInfo();
  dash.showProgress(streams, streamIdx, timing);
  stderr('Commence testing');
  initTest();
}

video.onconnect(function() {
  clearTimeout(restartTimerId);
  stderr('Video connected');
  warmUp();
});
video.ondisconnect(function() {
  clearTimeout(restartTimerId);
  restartTimerId = setTimeout(restartModule, CALM_TIMEOUT, VIDEO);
});

function initTest() {
  ex.newAttempt();
  timing.init('test');
  return restartModule(VIDEO);
}
function restartModule(module) {
  stderr('Restarting video…');
  return iidk.stopModule(module)
    .then(() => iidk.cleanupArch(REC_PATH))
    .then(() => iidk.startModule(module))
    .catch(stderr);
}
/**
 * Make sure system is ready
 * @returns {Promise}
 */
function chkSysReady(readyUsage) {
  let fails = 0;
  return new Promise((resolve, reject) => {
    stderr('Waiting for CPU');
    pollUsage(function(cpu, freemb) {
      stderr(`CPU {cyan-fg}${cpu}%{/}`);
      if (cpu < readyUsage) {
        stderr('CPU OK');
        resolve();
        return false;
      }
      if (cpu > readyUsage && ++fails > MAX_FAILS) {
	stderr('CPU usage still higher than acceptable');
	restartModule(VIDEO);
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

  return new Promise(function (resolve, reject) {
    setTimeout(reject, CALM_TIMEOUT, "FPS is inconsistent");
    fastPollStats();
    video.onregex(ex.options.refRe, function (msg) {
      if (ex.attempt.fpsIn === 0) {
        const fps = parseFloat(msg.params.fps);

        ex.attempt.addFpsIn(fps);
      }
      if (ex.attempt.fpsIn !== 0) {
        ex.handlers.remove(testCamId);
        stderr(`FPS: ${ex.attempt.fpsIn.toFixed(2)}`);
	video.offregex(ex.options.refRe);	
        resolve();
        return;
      }
      dash.showAttemptInfo(ex.attempt);
      pollStats();
    });
  });
}

function warmUp() {
  const {GET_FPS, TESTING} = ex.attempt;
  switch (ex.attempt.stage) {
    case TESTING:
      teardown('Lost connection during attempt');
      return;
    case GET_FPS:
      fastPollStats();
      return;
    default:
      clearTimeout(ex.calcTimerId);
      ex.attempt.nextStage(GET_FPS);
  }
  stderr('Warming up...');
  chkSysReady(CPU_READY).then(captureFps).then(runTest)
    .catch(teardown);
}

iidk.onattach(function (msg) {
    /**
     * Sanity check
     * If current camera statistics indicates FPS add next one
     */
    const attempt = ex.attempt;
    const {hasPendingGen, hasEnoughCpu/*, count, target*/} = attempt;
    //const isTargetCam = count == target;
    //const isLastCam = count == id;
    //const hasFps = fps > 0;

    /** Fast poll if target not reached yet */
    //isTargetCam ? pollStats() : fastPollStats();

    //if (hasPendingGen && 
    //  (/*(isLastCam && hasFps) || */count == 0)) {

    const {fpsOut, hasSaneFps} = attempt;
    const {cpuThreshold} = attempt.options;
    const {cpu} = attempt;
    /**
     * Stop adding estimated cameras if CPU is overloaded
     * or FPS doesn't pass sanity check
     */
    if ((hasEnoughCpu && cpu.mean > cpuThreshold) || !hasSaneFps) {
      stderr(
	  `Sanity alert {grey-fg}CPU:${cpu.mean.toFixed(2)}% ` +
	  `FPS: ${fpsOut.toFixed(2)}{/}`
	  );
      attempt.finaliseCams();
    }
    /**
     * Initiate next iteratation
     */
    attempt.pendingGen.next()
    //}
});

function runTest() {
  /**
   * Commence Test, when we are ready
   */
  /** SETUP */
  !ex.options.isHeadless && video.setupMonitor(ex.attempt.options.monitorId);
  /**/
  video.offregex(ex.options.metricRe);
  {
    const attempt = ex.attempt;

    attempt.nextStage(attempt.TESTING);
    attempt.clearCpu();
    attempt.targetCams(ex.startCount);
  }
  dash.showExInfo(ex);
  stderr('Testing stage');

  onstats(function (msg) {
    const id = parseInt(getId(msg.id));
    const fps = parseFloat(msg.params.fps);

    ex.attempt.addOutFps(id, fps);
    pollStats();
  });

  function calculate() {
    const attempt = ex.attempt;
    let shouldPass = attempt.hasPendingGen;

    clearTimeout(ex.calcTimerId);

    dash.showProgress(streams, streamIdx, timing);
    dash.showAttemptInfo(attempt);

    const {hasEnoughCpu, hasEnoughSamples, cpu} = attempt;
    const shouldCalculate = !shouldPass && hasEnoughCpu;
    const isCalm = shouldCalculate && hasEnoughSamples && attempt.isCalm;
    const hasFullFps = shouldCalculate && attempt.hasFullFps;

    /** Check CPU load */
    if (shouldCalculate && cpu.mean > attempt.options.cpuThreshold) {
      stderr(
	'CPU load is higher than allowed ' +
	`{grey-fg}${cpu.mean.toFixed(2)} > ` +
	`${attempt.options.cpuThreshold}{/}`
      );
      attempt.seek(FAILED);
      shouldPass = true;
    }

    /**
     *  Cameras has stable FPS means iteration is complete 
     **/
    if (!shouldPass && isCalm && attempt.ignoreCPU) {
      attempt.seek(hasFullFps);
      shouldPass = true;
    }

    /** 
     * Add more cameras to saturate CPU,
     */
    const estimateByCPU = isCalm && !attempt.ignoreCPU && hasFullFps;
    const n = estimateByCPU ? attempt.estimate : -Infinity; 

    /** Make sure that estimated number is higher than actual */
    if (!shouldPass && estimateByCPU && n > attempt.count) {
      stderr(`Estimation {gray-fg}${n}{/}`);
      attempt.targetCams(n);
      shouldPass = true;
    } 
    if (!shouldPass && estimateByCPU && n <= attempt.count) {
      stderr(`Estimated less than current {gray-fg}${n}{/}`);
      attempt.seek(OK);
      shouldPass = true;
    }
    
    /**
     * We exceeded limit, and must seek to find it
     */
    if (!shouldPass && isCalm && !hasFullFps) {
      stderr(`Estimation overreached (fps: {gray-fg}${attempt.fpsOut.toFixed(2)}{/})`);
      attempt.seek(FAILED);
      shouldPass = true;
    }

    const calmPeriod = (Date.now() - attempt.lastOpTime);

    ///**
    // * Don't have enought samples for too long
    // */
    //if (shouldCalculate && hasEnoughSamples &&
    //    calmPeriod > CALM_TIMEOUT / 2) {
    //  stderr('Takes too long to collect enough samples');
    //  attempt.seek(FAILED);
    //  shouldPass = true;
    //}

    /**
     * FPS is settling down too long, presumably system is overloaded
     */
    if (shouldCalculate && hasEnoughSamples && !isCalm &&
	calmPeriod > CALM_TIMEOUT) {
      stderr('Takes too long for FPS samples to settle');
      attempt.seek(FAILED);
      shouldPass = true;
    }
    ex.calcTimerId = setTimeout(calculate, GEN_INTERVAL);
  }

  fastPollStats();
  calculate();

  pollUsage(function(cpu, freeMB) {
    ex.attempt.addCpu(cpu);
    if (freeMB < FREEMB_THRESHOLD) {
      stderr('Not enough memory to continue');
      teardown();
    }
    dash.showAttemptInfo(ex.attempt);

    return ex.attempt.isRunning;
  });
}

function teardown(err) {
  const testTime = timing.elapsedString('test');
  const {count, fpsOut} = ex.attempt;
  const {stage, GET_FPS, TESTING} = ex.attempt;

  clearTimeout(ex.calcTimerId);
  video.offregex(ex.options.refRe);	
  video.offregex(ex.options.metricRe);

  /** Failed to determine FPS */  
  if (stage == GET_FPS) {
    exFinalise(ex);
    stderr(err);

    return;    
  }

  ///** Make sure data makes sense */
  //if (stage == TESTING && count == 0 || fpsOut == 0) {
  //  err = 'Data is invalid!';
  //}
  
  if (count < ex.startCount) {
    err = 'Final count lower than initial';
  }

  /** Skip stream if test keeps failing */
  if (err && (++ex.fails > MAX_FAILS)) {
    stderr('Skipping faulty stream');
    exFinalise(ex);

    return;
  };
  
  /** Invalidate last result and restart */
  if (err) {
    ex.invalidAtmp();
    stderr(err);
    initTest();

    return;
  }
  /** Re-run test to get enough validation points */
  ex.dropCount();
  stderr(`Max: ${count}, finished in ${testTime}`);
  if (ex.isPending) {
    ex.maxCount = count;
    initTest();
  } else {
    exFinalise(ex);
  }
  return;
}

function exFinalise(ex) {
  ex.elapsed = timing.elapsedString('stream');
  stdout(report(ex));
  bootstrap();
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
function onstats(fn) {
  video.onregex(ex.options.metricRe, function (msg) {
    checkStatRTT();
    ex.attempt.stattimeL = timing.elapsed('stat');
    dash.showStatTs();
    fn(msg);
  })
}
const checkStatRTT = throttle(function () {
  ex.attempt.stattime1 = timing.elapsed('stat');
}, STAT_INTERVAL);
const pollStats = debounce(function () {
  timing.init('stat', HIRES);
  video.requestStats();
}, STAT_INTERVAL);
const fastPollStats = debounce(function () {
  timing.init('stat', HIRES);
  video.requestStats();
}, STAT_INTERVAL_FAST);
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
    timerId = setTimeout(function () {
      timing.init('poll', HIRES);
      Promise.all([fetchCPU(), fetchMem()])
        .then(resources => {
	 ex.attempt.wstime = timing.elapsed('poll');
          const shouldPoll = cb.apply(null, resources);
          if (shouldPoll) {
            poll(cb);
          }
        })
        .catch(reason => {
          poll(cb);
        })
      }, CPU_INTERVAL);
  }
})();
