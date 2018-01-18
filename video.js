'use strict';
const IqClient = require('iq-node').Client;
const video = new IqClient({regex: true}); 

const GRABPARAMS = {
  auth: '',
  brand: '',
  chan: 0,
  codec: '',
  drives: 'A:\\',
  flags: '',
  format: 'PAL',
  int_obj_id: 1,
  ip: '',
  ip_port: 80,
  mode: 1,
  model: '',
  name: '',
  objname: '',
  parent_id: '',
  password: '',
  resolution: '',
  type: 'RTSP',
  useconfigurebyweb: 1,
  user: '',
  username: '',
  watchdog: 0,
};
const CAMPARAMS = {
  'AUDIO.mic_id.count': 0,
  activity: '',
  additional_info: '',
  alarm_rec: 1,
  arch_days: 0,
  armed: 1,
  audio_type: '',
  blinding: 0,
  bosch_ptz_protocol: '',
  bright: 5,
  bt: 0,
  color: 1,
  compression: 2,
  compressor: '',
  config_id: '',
  contrast: 5,
  decoder: 0,
  decompressor: '',
  disabled: 0,
  flags: '',
  fps: 0,
  hot_rec_period: 0,
  hot_rec_time: 0,
  ifreg: 8,
  int_obj_id: '',
  manual: 1,
  mask0: '',
  mask1: '',
  mask2: '',
  mask3: '',
  mask4: '',
  mask: '',
  md_contrast: 8,
  md_mode: 0,
  md_size: 5,
  motion: 7,
  multistreaming_mode: 0,
  mux: 0,
  name: '',
  objid: '',
  objname: '',
  parent_id: '',
  password_crc: '',
  pre_rec_time: 0,
  priority: '',
  proc_time: 0,
  rec_priority: 0,
  region_id: '',
  resolution: 0,
  rotate: 0,
  rotateAngle: 0,
  sat_u: 5,
  source_folder: '',
  stream_alarm: '',
  stream_analitic: '',
  stream_archive: '',
  stream_client: '',
  telemetry_id: '',
  type: '',
  yuv: '',
};
const MONITORPARAMS = {
  antialiasing: 0,
  enable: 1,
  h: 100,
  monitor_ch: '',
  monitor_cw: '',
  name: '',
  objname: '',
  overlay: 2,
  panel: 1,
  parent_id: 1,
  w: 100,
  x: 0,
  y: 0,
};

module.exports = {
  connect(options) {
    this.host = options.host;
    this.slave_id = [this.host].join('.');
    this.connected = false;
    return video.connect(Object.assign({}, options, {port: 'video', host: this.host}));
  },
  disconnect() {
    video.disconnect();
  },
  stats(interval) {
    video.on(/IQ-CONNECTED/,
      () => video.sendReact({
        type: 'STATISTIC',
        action: 'START',
        params: {
          interval: interval || 1,
          slave_id: this.slave_id,
        }
      }));
  },
  statsStop() {
    video.sendReact({
      type: 'STATISTIC',
      action: 'STOP',
      params: {
        slave_id: this.slave_id,
      }
    });
  },
  requestStats() {
    video.sendReact({
      type: 'STATISTIC',
      action: 'GET',
      params: {
        slave_id: this.slave_id,
      }
    });
  },
  onregex(re, fn) {
    video.on(re, fn);
  },
  offregex(re) {
    video.off(re);
  },
  onstats(fn) {
    this.offstats();
    video.on({type: 'STATISTIC', action: 'SET'}, fn);
  },
  offstats() {
    video.off({type: 'STATISTIC', action: 'SET'});
  },
  onconnect(fn) {
    video.on(/IQ-CONNECTED/, fn);
  },
  ondisconnect(fn) {
    video.on(/IQ-DISCONNECTED/, fn);
  },
  deleteObjs(type, id) {
    video.sendReact({
      type,
      id: id || '',
      action: 'DELETE',
    });
  },
  setupMonitor(id, params) {
    this.monitorId = id;
    const name = `Monitor ${id}`;
    video.sendReact({
      type: 'MONITOR',
      id,
      action: 'SETUP',
      params: Object.assign({}, MONITORPARAMS, {
        name,
        objname: name,
      }, params)
    });
    video.sendReact({
      type: 'MONITOR',
      id,
      action: 'ACTIVATE',
    });
  },
  deleteMonitor(id) {
    this.clearMonitor(id);
    video.sendReact({
      type: 'MONITOR',
      id,
      action: 'DEACTIVATE',
    });
  },
  clearMonitor(id) {
    video.sendReact({
      type: 'MONITOR',
      id,
      action: 'REMOVE_ALL',
    });
  },
  setupIpCam(id, address, opts) {
    const name = `Cam ${id}`;
    video.sendReact({
      type: 'GRABBER',
      id,
      action: 'SETUP',
      params: Object.assign({}, GRABPARAMS, {
        ip: address,
        int_obj_id: id,
        parent_id: this.host,
        name,
        objname: name,
      }, opts)
    });
    video.sendReact({
      type: 'CAM',
      id,
      action: 'SETUP',
      params: Object.assign({}, CAMPARAMS, {
        int_obj_id: id,
        parent_id: id,
        name,
        objname: name,
      })
    });
    video.sendReact({
      type: 'CAM',
      id,
      action: 'REC',
    });
  },
  removeIpCam(id) {
    video.sendReact({
      type: 'CAM',
      id,
      action: 'DELETE',
    });
    video.sendReact({
      type: 'GRABBER',
      id,
      action: 'DELETE',
    });
  },
  showCam(cam, id) {
    video.sendReact({
      type: 'MONITOR',
      id,
      action: 'ADD_SHOW',
      params: {
        cam,
        slave_id: this.slave_id,
  //       stream_id: cam + '.1',
      }
    });
  },
  hideCam(cam, id) {
    video.sendReact({
      type: 'MONITOR',
      id,
      action: 'REMOVE',
      params: {
        cam,
  //       stream_id: cam + '.1',
      }
    });
  },
  startVideo(cam, id) {
    video.sendReact({
      type: 'CAM',
      id: cam,
      action: 'START_VIDEO',
      params: {
        direct_connect: 0,
        slave_id: this.slave_id, 
      },
    });
  },
};
