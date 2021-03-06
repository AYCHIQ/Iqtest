'use strict';
const IqClient = require('iq-node').Client;
const iidk = new IqClient();
const TIMEOUT = 30000;
const KEEPALIVE = 30000;


module.exports = {
  keepAliveTimer: null,
  resetKATimer() {
    clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = setTimeout(() =>
        iidk.sendEvent({type: 'ACTIVEX', action: 'GET_LIST'}), KEEPALIVE);
  },
  connect(options) {
    this.host = options.host;
    return iidk.connect(Object.assign({port: 'iidk'}, options))
      .then(this.resetKATimer.bind(this));
  },
  onconnect(fn) {
    iidk.on({type: 'IQ', action: 'IQ-CONNECTED'}, () => {
      fn();
    });
  },
  ondisconnect(fn) {
    iidk.on({type: 'IQ', action: 'IQ-DISCONNECTED'}, () => {
      fn();
    });
  },
  restartModules() {
    iidk.sendEvent({
      type: 'SLAVE',
      id: this.host,
      action: 'RUN_SLAVES',
    });
    this.resetKATimer();
  },
  startModule(module) {
    const startReact = {
      type: 'SLAVE',
      id: this.host,
      action: 'EXECUTE_SET',
      params: {
        command: module,
      }
    };
    const executeComplete = {type: 'SLAVE', action: 'EXECUTE_COMPLETE'};
    const timer = setInterval(() => iidk.sendCoreReact(startReact), TIMEOUT);
    return new Promise((resolve, reject) => {
      iidk.on(executeComplete, (msg) => {
        if (msg.params.command.includes(module)) {
          clearInterval(timer);
          iidk.off(executeComplete);
          resolve();
        }
      });
      iidk.sendCoreReact(startReact);
      this.resetKATimer();
    });
  },
  stopModule(module) {
    const stopReact = {
      type: 'SLAVE',
      id: this.host,
      action: 'TERMINATE_SET',
      params: {
        command: module,
      }
    };
    const terminateComplete = {type: 'SLAVE', action: 'TERMINATE_COMPLETE'};
    const timer = setInterval(iidk.sendCoreReact, TIMEOUT, stopReact);
    return new Promise((resolve, reject) => {
      iidk.on(terminateComplete, function(msg) {
        if (msg.params.command.includes(module)) {
          clearInterval(timer);
          iidk.off(terminateComplete);
          resolve();
        }
      });
      iidk.sendCoreReact(stopReact);
      this.resetKATimer();
    });
  },
  updateObj(objtype, objid, settings) {
    let params = Object.assign(settings, {
      objtype,
      objid,
    });
    iidk.sendEvent({
      type: 'CORE',
      action: 'UPDATE_OBJECT',
      params,
    });
    this.resetKATimer();
  },
  cleanupArch(drive) {
    iidk.sendCoreReact({
      id: '',
      type: 'SLAVE',
      action: 'CREATE_PROCESS',
      params: {
	command_line: `cmd /C del /Q /S ${drive}\VIDEO && rd /Q /S ${drive}\VIDEO`,
      }
    });
    return new Promise(function (resolve, reject) {
      setTimeout(resolve, 1e3);
    });
  },
  onattach(fn) {
    iidk.on({action: 'ATTACH'}, fn);
    iidk.on({action: 'DETACH'}, fn);
  },
  on() {
    iidk.on.apply(iidk, arguments);
  },
  off() {
    iidk.off.apply(iidk, arguments);
  }
};
