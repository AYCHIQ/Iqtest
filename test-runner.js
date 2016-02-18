'use strict';
const fs = require('fs');
const uuid = require('uuid');
const _ = require('lodash');
const nconf = require('nconf');
const iidk = require('./iidk');
const video = require('./video');
const wsman = require('./wsman');

const MonitorFps = new Map();
const GrabberFps = new Map();
const log = (e) => {
  console.log(e)
  process.exit();
};

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
const TOLERANCE = nconf.get('tolerance');
const THRESHOLD_RATIO = nconf.get('thresholdRatio');
const A = nconf.get('alpha');
const stopOnExit = nconf.get('stop');
const INIT_COUNT = nconf.get('cams');

const VIDEO = 'video.run core';
const WS = {
  Processor: 'Win32_Processor',
  ProcessorPerf: 'Win32_PerfFormattedData_Counters_ProcessorInformation',
  Process: 'Win32_Process',
}

let processorUsage = [];

process.on('exit', () => {
  if (stopOnExit) {
    iidk.stopModule(VIDEO);
  } 
});
iidk.connect({ip: IP, host: HOST, iidk: IIDK_ID})
  .then(() => iidk.stopModule(VIDEO))
  .then(() => iidk.startModule(VIDEO))
  .then(() => video.connect({ip: IP, host: HOST}))
  .then(runTest)
  .catch(log);
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
    .then((items) => board = `${items[0].Manufacturer} ${items[0].Product}`);
  const deferOSInfo = wsman.enumerate({ip: IP, resource: WS.OS, auth: WSMAN_AUTH})
    .then((items) => {
      osName = items[0].Caption;
      ramSize = items[0].TotalVisibleMemorySize / Math.pow(1024, 2);
    });
  const deferCPUInfo = wsman.enumerate({ip: IP, resource: WS.Processor, auth: WSMAN_AUTH})
    .then((items) => processor = items[0].Name);
  /* Connect to IIDK */
  const deferIIDK = iidk.connect({ip: IP, host: HOST, iidk: IIDK_ID});

  Promise.all([deferOSInfo, deferCPUInfo, deferIIDK])
    .then(() => {
      console.log(`OS:\t${osName}`);
      console.log(`CPU:\t${processor}`);
      console.log(`Board:\t${board}`);
      console.log(`RAM:\t${ramSize.toFixed(2)}GB`);
    })
    .then(() => bootstrap())
    .catch(log);

})
.catch(log);

function runTest() {
  /**
   * Commence Test
   */
  const options = {
    host: HOST,
    src: STREAM,
  };
  const  gen = genRTSP(options);
  let nextId = gen.next().value;
  let i = 0;
  /* Create initial number of cameras if defined */
  for (i; i < INIT_COUNT; i += 1) {
    nextId = gen.next().value;
  }
  video.onstats((msg) => {
    if (/GRABBER.*Receive/.test(msg.id)) {
      let id = /\d+/.exec(msg.id)[0];
      let fps = parseFloat(msg.params.fps);
      GrabberFps.set(id, fps);
      if (!MonitorFps.has(id)) {
        video.showCam(id, MONITOR);
      }
    }
  });
  video.onstats((msg) => {
    if (/MONITOR.*CAM.*IN/.test(msg.id)) {
      let id = /\[CAM]\[(\d+)]/.exec(msg.id)[1];
      let fps = parseFloat(msg.params.fps);
      if (fps !== 0) {
        let input = GrabberFps.get(id);
        let oldFps = MonitorFps.has(id) ?  MonitorFps.get(id) : input;
        let delta = fps - oldFps;
        let avg = oldFps + A * delta;
        let isCalm = Math.abs(delta / input) < TOLERANCE;
        MonitorFps.set(id, avg);
        if (isCalm) {
          /* Added camera has stable FPS -> iteration is complete */
          if (id === nextId.toString()) {
            console.log(`Cams (CPU%):\t${GrabberFps.size} (${processorUsageString()})`);
            processorUsage = [];
            /* Add next camera */ 
            nextId = gen.next().value;
          }
          if (!hasFullFps(id)) {
            video.offstats();
            console.log(`Failed @ ${GrabberFps.size}\n ${processorUsageString()}`);
            process.exit();
          }
        }
      }
    }
  });
  video.onstats((msg) => {
    if (/MONITOR/.test(msg.id) && msg.id.includes(nextId.toString())) {
      /* Fetch processor usage */
      wsman.enumerate({ip: IP, resource: WS.ProcessorPerf, auth: WSMAN_AUTH})
        .then((items) => {
          const usage = items.filter((u) => u.Name === '_Total')
            //.map((u) => u.PercentProcessorTime);
            //.map((u) => u.PercentProcessorUtility);
            .map((u) => (100 - u.PercentIdleTime));
          processorUsage.push(parseFloat(usage)); 
        });
    }
  });
  video.setupMonitor(MONITOR);
  video.statsStart(STAT_INTERVAL);
  console.log(`RTSP:\t${STREAM}`);
  wsman.enumerate({ip: IP, resource: WS.Processor, auth: WSMAN_AUTH})
    .then((items) => {
      const processor = items[0].Name;
      console.log(`CPU:\t${processor}`);
    });
}

function hasFullFps(id) {
  let ratio = 1.0;
  let ret = true;

  let input = GrabberFps.get(id);
  let output = MonitorFps.get(id);
  if (!!input && !!output) {
    ratio = output / input;
    if (THRESHOLD_RATIO > ratio) {
      // console.log('%d:\t%d (%d/%dfps)',
      //     id, (ratio*100).toFixed(2),
      //     output.toFixed(2), input.toFixed(2));
      ret = false;
    }
  }
  return ret;
}

function* genRTSP(options) {
  let id = 0;
  while (true) {
    id += 1;
    video.setupIpCam(id, STREAM);
    yield id;
  }
}

function processorUsageString() {
  let median = medianWin(processorUsage); 
  let min = Math.min.apply(null, processorUsage);
  let max = Math.max.apply(null, processorUsage);
  // let arith = aMean(processorUsage).toFixed(2);
  // let geom = gMean(processorUsage).toFixed(2);
  //return `min: ${min}, max: ${max}, arithmetic: ${arith}, geometric: ${geom}, median ${median}`;
  return `${min}% ${median}% ${max}%`;
}

function formatUri(uri) {
  const locationRe = /location=(.+?).!/;
  if (locationRe.test(uri)) {
    return locationRe.exec(uri)[1];
  } else {
    return uri;
  }
}

function aMean(arr) {
  const sum = arr.reduce((sum, val) => sum += val, 0);
  return sum / arr.length;
}
function gMean(arr) {
  const product = arr.reduce((p, val) => p *= val > 0 ? val : 1, 1);
  return Math.pow(product, 1 / arr.length);
}

function medianWin(arr) {
  switch (arr.length) {
    case 0:
      return undefined;
    case 1:
      return arr[0];
    case 2:
      return (arr[0] + arr[1]) / 2;
    default: {
      const len1_3 = arr.length / 3;
      let win1_2 = 0;
      let win = [];
      let mA = 0;
      let mB = 0;

      arr.sort(function (a,b) { return a - b; });
      win = arr.slice(Math.floor(len1_3), Math.ceil(2*len1_3));
      win1_2 = win.length / 2;
      mA = Math.ceil(win1_2);
      mB = mA === win1_2 ? mA + 1 : mA ;
      return  (win[mA-1] + win[mB-1]) / 2;
    }
  }
}
