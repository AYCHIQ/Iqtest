'use strict';
const blessed = require('blessed');

const screen = blessed.screen({
  smartCSR: true,
});
const exInfo = blessed.box({
  left: 0,
  top: 1,
  content: 'stream info',
  width: '50%',
  height: 4,
  scrollable: 'alwaysScroll',
  tags: true,
  style: {
    fg: 'green',
  }
});
const progressBar = blessed.ProgressBar({
  left: 0,
  top: 0,
  width: '100%',
  height: 1,
  pch: '▄',
});
const progressBox = blessed.box({
  right: 0,
  top: 1,
  content: 'progress',
  tags: false,
  width: 40,
  height: 4,
});
const attemptInfo = blessed.box({
  left: 0,
  top: 5,
  tags: true,
  width: 40,
  height: 9, 
});
const statTimestamp = blessed.box({
  left:0,
  top: 15,
  tags: false,
  width: 40,
  height: 1,
});
const hostInfo = blessed.box({
  right: 0,
  widht: 17,
  height: 4, 
});
const logBox = blessed.Log({
  left: 0,
  top: 17,
  content: 'log',
  width: '100%',
  height: 'shrink',
  scrollable: 'alwaysScroll',
  tags: true,
});
screen.title = 'Intellect Platform Tester';
screen.append(exInfo);
screen.append(progressBar);
screen.append(progressBox);
screen.append(attemptInfo);
screen.append(hostInfo);
screen.append(statTimestamp);
screen.append(logBox);

function log(msg) {
  logBox.log(msg);
};

function showExInfo(e) {
  if (!e) {
    exInfo.pushLine('');
    return;
  }
  const s = e.streamAttr;
  const counts = e.attempts.map(a => a.count);
  
  exInfo.popLine();
  exInfo.pushLine(`${s.vendor} ${s.format} ${s.width}x${s.height}@${s.fps}fps{|}${counts}`);
  exInfo.setScrollPerc(100);
}

function showAttemptInfo(a, progressStr) {
  attemptInfo.setContent([
      ['fps in:', a.fpsIn.toFixed(2)].join('{|}'),
      ['count:', a.count.toString()].join('{|}'),
      ['target:', a.target.toString()].join('{|}'),
      ['history:', a.camHistory.slice(-4).toString()].join('{|}'),
      ['S:', a.lastSamples.map(s => s.toFixed(2))].join('{|}'),
      ['dev:', a.lastDev.toFixed(3)].join('{|}'),
      ['fps m:', a.fpsOut.toFixed(3)].join('{|}'),
      ['threshold:', a.options.fpsThreshold.toFixed(3)].join('{|}'),
      ['CPU:', a.cpuSamples].join('{|}'),
  ].join('\n'));
}

function showStatTs() {
  statTimestamp.setContent([
    'last stat at:', (new Date()).toLocaleTimeString('de-DE')
  ].join('{|}'));
}

function showProgress(streams, streamIdx, timing) {
  const doneStreams = streamIdx - 1;
  const rate = timing.elapsed('global') / doneStreams;
  const estimatedMs = (streams.length - doneStreams) * rate;

  progressBar.setProgress((streamIdx / streams.length) * 100);
  progressBox.setContent([
    ['Elapsed time:', timing.elapsedString('global')].join('{|}'),
    ['Remaining time:', timing.getTimeString(estimatedMs)].join('{|}'),
    ['Stream:', streamIdx + '/' + streams.length].join('{|}'),
  ].join('\n'));
}

function showHostInfo(ip, host) {
  hostInfo.setContent([
    ['Host:', host].join('{|}'),
    ['IP:', ip].join('{|}'),
  ]);
}

/**
 * Returns a string of processor usage values
 * @param {Attempt} attempt - attempt to get usage values from
 * @returns {string} string of following format: min%…mean%…max%
 */
function processorUsageString(attempt) {
  const cpuUsage = attempt.cpu;
  const min = cpuUsage.min;
  const mean = cpuUsage.mean;
  const max = cpuUsage.max;

  return `${min}%…${mean}%…${max}%`;
}

setInterval(() => screen.render(), 1000);

module.exports = {
  log,
  showExInfo,
  showAttemptInfo,
  showHostInfo,
  showStatTs,
  showProgress,
}
