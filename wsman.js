'use strict';
const http = require('http');
const uuid = require('uuid');
const builder = require('xmlbuilder');
const xmldoc = require('xmldoc');

const OK = 'OK';

function pull(options) {
    const hostname = options.hostname;
    const port = options.port; 
    const resource = options.resource;
    const auth = options.auth;
    const accumulator = options.accumulator;
    const responseData = options.data;
    const resolve = options.resolve;
    const reject = options.reject;

    const host = [hostname, port].join(':');
    const xml = new xmldoc.XmlDocument(responseData);
    const pullResponse = xml.descendantWithPath('s:Body.n:PullResponse.n:Items');
    const isEnd = xml.descendantWithPath('s:Body.n:PullResponse.n:EndOfSequence');
    const isError = xml.valueWithPath('s:Body.s:Fault.s:Code.s:Subcode.s:Value');
    if (pullResponse) {
        accumulator.push(pullResponse.firstChild.children.reduce((reduc, el) => {
            reduc[el.name.split(':')[1]] = el.val;
            return reduc;
        }, {}));
    }
    if (isEnd) {
        resolve(accumulator, OK);
        return;
    }
    const ctxId = xml.valueWithPath('s:Body.n:EnumerateResponse.n:EnumerationContext') ||
        xml.valueWithPath('s:Body.n:PullResponse.n:EnumerationContext');
    if (isError) {
        reject(accumulator, isError);
        return;
    }
    const pullBody = builder.create({
        's:Envelope': {
            '@xmlns:s': 'http://www.w3.org/2003/05/soap-envelope',
            '@xmlns:wsa': 'http://schemas.xmlsoap.org/ws/2004/08/addressing',
            '@xmlns:wsman': 'http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd',
            '@xmlns:wsen': 'http://schemas.xmlsoap.org/ws/2004/09/enumeration',
            's:Header': {
                'wsa:Action': {'@s:mustUnderstand': 'true', '#text': 'http://schemas.xmlsoap.org/ws/2004/09/enumeration/Pull'},
                'wsa:To': {'@s:mustUnderstand': 'true', '#text': `http://${host}:5985/wsman`},
                'wsman:ResourceURI': {'@s:mustUnderstand': 'true', '#text': `http://schemas.microsoft.com/wbem/wsman/1/wmi/root/cimv2/${resource}`},
                'wsa:MessageID': {'@s:mustUnderstand': 'true', '#text': `uuid:${uuid.v1()}`},
                'wsa:ReplyTo': {
                    'wsa:Address': 'http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous',
                }
            },
            's:Body': {
                'wsen:Pull': {
                    'wsen:EnumerationContext': ctxId,
                },
            }
        }
    }).end();
    const pullOptions = {
        auth,
        port,
        hostname,
        method: 'POST',
        path: '/wsman',
        headers: {
            'Content-Type': 'application/soap+xml;charset=UTF-8',
            'Content-Length': pullBody.length
        }
    };
    const pullReq = http.request(pullOptions);
    pullReq.on('response', (res) => {
        let data = '';
        if (res.statusCode !== 200) {
            reject(accumulator, res.statusCode);
        }
        res.on('data', (chunk) => {
            data += chunk;
        });
        res.on('end', () => pull({
            data,
            hostname,
            port,
            auth,
            accumulator,
            resolve,
            reject,
        }));
    });
    pullReq.end(pullBody);
}
exports.enumerate = function enumerate (options) {
    const DEFAULT_PORT = 5985;
    const hostname = options.ip;
    const port = options.port || DEFAULT_PORT;
    const host = [hostname, port].join(':');
    const resource = options.resource;
    const auth = options.auth;

    return new Promise((resolve, reject) => {
        const accumulator = [];
        const enumBody = builder.create({
            's:Envelope': {
                '@xmlns:s': 'http://www.w3.org/2003/05/soap-envelope',
                '@xmlns:wsa': 'http://schemas.xmlsoap.org/ws/2004/08/addressing',
                '@xmlns:wsman': 'http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd',
                '@xmlns:wsen': 'http://schemas.xmlsoap.org/ws/2004/09/enumeration',
                's:Header': {
                    'wsa:Action': {'@s:mustUnderstand': 'true', '#text': 'http://schemas.xmlsoap.org/ws/2004/09/enumeration/Enumerate'},
                    'wsa:To': {'@s:mustUnderstand': 'true', '#text': `http://${host}/wsman`},
                    'wsman:ResourceURI': {'@s:mustUnderstand': 'true', '#text': `http://schemas.microsoft.com/wbem/wsman/1/wmi/root/cimv2/${resource}`},
                    'wsa:MessageID': {'@s:mustUnderstand': 'true', '#text': `uuid:${uuid.v1()}`},
                    'wsa:ReplyTo': {
                        'wsa:Address': 'http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous',
                    }
                },
                's:Body': {
                    'wsen:Enumerate': {},
                }
            }
        }).end();
        const enumOptions = {
            auth,
            port,
            hostname,
            method: 'POST',
            path: '/wsman',
            headers: {
                'Content-Type': 'application/soap+xml;charset=UTF-8',
                'Content-Length': enumBody.length
            }
        };
        const enumReq = http.request(enumOptions);
        enumReq.on('response', (res) => {
            let data = '';
            if (res.statusCode !== 200) {
                reject(accumulator, res.statusCode);
            }
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => pull({
                data,
                hostname,
                port,
                auth,
                accumulator,
                resolve,
                reject,
            }));
        });
        enumReq.on('error', (err) => reject(accumulator, err));
        enumReq.end(enumBody);
    });
}
